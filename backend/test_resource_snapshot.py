"""Resource assembly guards and minimal regular-user bootstrap data."""
import os
import unittest
from unittest.mock import Mock, patch
from uuid import UUID

import psycopg
from fastapi import HTTPException
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row
from starlette.requests import Request

import main
from api_dependencies import database, reader
from queries import permission_rules

ADMIN = UUID('00000000-0000-0000-0000-000000000001')
USER = UUID('00000000-0000-0000-0000-000000000002')
TEST_URL = os.getenv('CASHBOOK_TEST_DATABASE_URL', '')


class ResourceSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.actor = {'user_role_id': 1, 'user_id': ADMIN}
        self.snapshot = '10:10:'
        self.db = Mock()
        self.db.execute.side_effect = self.query
        main.app.dependency_overrides[database] = lambda: self.db
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.addCleanup(main.app.dependency_overrides.clear)

    def query(self, sql, params=()):
        result = Mock()
        if 'pg_advisory_xact_lock' in sql:
            pass
        elif 'FROM sessions s JOIN users' in sql:
            result.fetchone.return_value = self.actor
        elif 'pg_current_snapshot()' in sql:
            result.fetchone.return_value = {'snapshot': self.snapshot}
        else:
            self.fail(f'Unexpected database query: {sql}')
        return result

    def test_resource_reads_return_actor_bound_snapshot_and_accept_it_on_next_read(self):
        first = self.client.get('/api/transaction-types')
        self.assertEqual(first.status_code, 200)
        token = first.headers['x-cashbook-snapshot']
        self.assertEqual(token, f'{ADMIN}:10:10:')
        second = self.client.get('/api/transaction-types', headers={'X-Cashbook-Snapshot': token})
        self.assertEqual(second.status_code, 200)
        self.assertEqual(second.headers['x-cashbook-snapshot'], token)
        self.assertEqual(second.json(), [{'id': 1, 'name': 'General'}])

    def test_changed_snapshot_rejects_read_before_resource_query_with_explicit_retry_header(self):
        token = self.client.get('/api/transaction-types').headers['x-cashbook-snapshot']
        self.snapshot = '11:11:'
        with patch('resources.list_contracts') as read:
            response = self.client.get('/api/contracts', headers={'X-Cashbook-Snapshot': token})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.headers['x-cashbook-retry-read'], '1')
        self.assertEqual(response.headers['x-cashbook-snapshot'], f'{ADMIN}:11:11:')
        read.assert_not_called()

    def test_new_login_cannot_reuse_previous_actor_snapshot(self):
        token = self.client.get('/api/transaction-types').headers['x-cashbook-snapshot']
        self.actor = {'user_role_id': 2, 'user_id': USER}
        response = self.client.get('/api/transaction-types', headers={'X-Cashbook-Snapshot': token})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.headers['x-cashbook-retry-read'], '1')

    def test_expired_session_is_not_misreported_as_retryable_snapshot_conflict(self):
        self.actor = None
        response = self.client.get('/api/transaction-types', headers={'X-Cashbook-Snapshot': 'old'})
        self.assertEqual(response.status_code, 401)
        self.assertNotIn('x-cashbook-retry-read', response.headers)

    def test_regular_self_profile_matches_old_minimal_snapshot_without_sensitive_fields(self):
        self.actor = {'user_role_id': 2, 'user_id': USER, 'user_name': 'Worker', 'is_active': True,
                      'description': 'Details', 'is_pinned': True, 'password_hash': 'secret', 'contacts': ['private']}
        with patch('resources.users') as directory:
            response = self.client.get(f'/api/users/{USER}')
            forbidden = self.client.get(f'/api/users/{ADMIN}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'user_id': str(USER), 'user_name': 'Worker', 'description': 'Details',
                                         'is_active': True, 'is_pinned': True, 'role': 'user', 'contacts': []})
        self.assertEqual(forbidden.status_code, 403)
        directory.assert_not_called()

    def test_permission_directory_requires_admin_and_returns_signed_rules(self):
        with patch('resources.permission_rules', return_value={str(USER): [7, -8]}) as rules:
            response = self.client.get('/api/permissions')
            self.assertEqual(response.json(), {'permissions': {str(USER): [7, -8]}})
            rules.assert_called_once_with(self.db)
            self.actor = {'user_role_id': 2, 'user_id': USER}
            response = self.client.get('/api/permissions')
            self.assertEqual(response.status_code, 403)
            self.assertEqual(rules.call_count, 1)

    def test_permission_query_retains_denials_and_users_without_loading_full_state(self):
        db = Mock()
        db.execute.return_value.fetchall.return_value = [
            {'user_id': ADMIN, 'head_id': 3, 'allowed': True},
            {'user_id': USER, 'head_id': 7, 'allowed': True},
            {'user_id': USER, 'head_id': 8, 'allowed': False},
        ]
        self.assertEqual(permission_rules(db), {str(ADMIN): [3], str(USER): [7, -8]})
        db.execute.assert_called_once()

    def test_mutation_does_not_enforce_or_emit_read_snapshot(self):
        with patch('commands.apply_change', return_value={'homeOrder': []}):
            response = self.client.post('/api/changes', headers={'X-Cashbook': '1', 'X-Cashbook-Snapshot': 'old'},
                                       json={'op': 'homeOrder', 'ids': ['attachments', 'users', 'company', 'statement', 'heads', 'credit', 'debit']})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('x-cashbook-snapshot', response.headers)


@unittest.skipUnless(TEST_URL, 'Set CASHBOOK_TEST_DATABASE_URL for real PostgreSQL snapshot checks.')
class PostgresSnapshotTests(unittest.TestCase):
    def test_read_only_tokens_remain_stable_and_actual_writes_invalidate_them(self):
        settings = conninfo_to_dict(TEST_URL)
        if settings.get('host') not in ('127.0.0.1', 'localhost', '::1') or not settings.get('dbname', '').startswith('cashbook_test'):
            self.fail('Snapshot checks require an explicitly local test database.')
        address = '::1' if settings['host'] == '::1' else '127.0.0.1'
        actor = {'user_id': USER, 'user_role_id': 2}
        def request(token=None):
            return Request({'type': 'http', 'headers': [(b'x-cashbook-snapshot', token.encode())] if token else []})
        # Only a temporary connection-local table is written; no application
        # schema, seeded fixture or external object storage is accessed here.
        with psycopg.connect(TEST_URL, hostaddr=address, row_factory=dict_row, connect_timeout=5) as db:
            db.execute('CREATE TEMP TABLE resource_snapshot_check (value integer)')
            db.commit()
            with patch('api_dependencies.session_user', return_value=actor):
                first = request()
                reader(first, db)
                token = first.state.resource_snapshot
                db.commit()
                second = request(token)
                reader(second, db)
                self.assertEqual(second.state.resource_snapshot, token)
                db.commit()
                db.execute('INSERT INTO resource_snapshot_check VALUES (1)')
                db.commit()
                with self.assertRaises(HTTPException) as conflict:
                    reader(request(token), db)
                self.assertEqual(conflict.exception.status_code, 409)
                self.assertEqual(conflict.exception.headers['X-Cashbook-Retry-Read'], '1')


if __name__ == '__main__':
    unittest.main()
