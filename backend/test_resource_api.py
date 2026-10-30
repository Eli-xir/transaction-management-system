"""HTTP contracts and authorization, using a request-scoped database double.

Accounting rules have their own tests; these exercise FastAPI dependency ordering,
resource-to-command translation, response status, and failure handling.
"""
import unittest
from decimal import Decimal
from unittest.mock import Mock, patch
from uuid import UUID

import psycopg
from fastapi.testclient import TestClient

import main
from api_dependencies import database

ADMIN = UUID('00000000-0000-0000-0000-000000000001')
USER = UUID('00000000-0000-0000-0000-000000000002')
EXTERNAL = UUID('00000000-0000-0000-0000-000000000003')
CONTRACT = UUID('00000000-0000-0000-0000-000000000004')
PROFILE = {'user_name': 'Ali', 'description': '', 'contacts': []}
INPUT = {'amount': '123.45', 'headId': 7, 'description': 'Receipt'}
CONTRACT_INPUT = {'name': 'Build', 'totalAmount': '1000', 'creditUserIds': [str(EXTERNAL)]}
HOME_ORDER = ['attachments', 'users', 'company', 'statement', 'heads', 'credit', 'debit']
USER_RESOURCE = {'user_id': str(USER), **PROFILE, 'is_active': True, 'is_pinned': False, 'role': 'user'}
EXTERNAL_RESOURCE = {'credit_user_id': str(EXTERNAL), **PROFILE, 'is_active': True, 'is_pinned': False}
CONTRACT_RESOURCE = {'id': str(CONTRACT), 'name': 'Build', 'description': '', 'totalAmount': 1000,
                     'isActive': True, 'revision': 7, 'creditUserIds': [str(EXTERNAL)]}


def transaction_resource(identifier='12'):
    return {'id': identifier, 'amount': 5, 'userId': str(USER), 'createdBy': str(ADMIN),
            'createdAt': '2026-10-30T01:00:00+00:00', 'creditUserId': None, 'headId': 7,
            'description': 'Receipt', 'transactionTypeId': 1, 'active': True, 'headPath': 'Expenses',
            'contractId': None, 'contractName': '', 'attachments': [], 'versions': []}


class ResourceApiTests(unittest.TestCase):
    def test_admin_user_bill_route_keeps_url_identity_lock_audit_and_commit(self):
        saved = {**transaction_resource(), 'createdBy': str(USER)}
        with patch('resources.record_user_bill', return_value=saved) as record:
            response = self.request('POST', f'/api/users/{USER}/bills', {'input': INPUT})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertEqual(self.events, ['write-lock', 'authenticate', 'commit'])
        record.assert_called_once()
        self.assertEqual(record.call_args.args[:3], (self.db, self.actor, USER))
        self.assertEqual(record.call_args.args[3].headId, 7)
        self.assertEqual(response.json()['createdBy'], str(USER))

    def test_regular_user_cannot_use_admin_bill_route_even_for_their_own_account(self):
        self.actor = {'user_role_id': 2, 'user_id': USER}
        response = self.request('POST', f'/api/users/{USER}/bills', {'input': INPUT})
        self.assertEqual(response.status_code, 403)
        self.db.commit.assert_not_called()

    def test_admin_bill_route_cannot_override_identity_or_report_success_after_commit_failure(self):
        response = self.request('POST', f'/api/users/{USER}/bills', {'input': INPUT, 'userId': str(ADMIN)})
        self.assertEqual(response.status_code, 422)
        self.db.commit.assert_not_called()
        self.db.commit.side_effect = psycopg.OperationalError('private database error')
        with patch('resources.record_user_bill', return_value=transaction_resource()), self.assertLogs('cashbook.api', level='ERROR'):
            response = self.request('POST', f'/api/users/{USER}/bills', {'input': INPUT})
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('private database error', response.text)

    def setUp(self):
        self.actor = {'user_role_id': 1, 'user_id': ADMIN, 'home_order': HOME_ORDER}
        self.events = []
        self.db = Mock()
        self.db.execute.side_effect = self.query
        self.db.commit.side_effect = lambda: self.events.append('commit')

        def override():
            yield self.db

        main.app.dependency_overrides[database] = override
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.addCleanup(main.app.dependency_overrides.clear)

    def query(self, sql, params=()):
        result = Mock()
        if 'pg_advisory_xact_lock' in sql:
            self.events.append('read-lock' if '_shared' in sql else 'write-lock')
        elif 'FROM sessions s JOIN users' in sql:
            self.events.append('authenticate')
            result.fetchone.return_value = self.actor
        elif 'SELECT revision FROM head_revision' in sql:
            result.fetchone.return_value = {'revision': 7}
        elif 'pg_current_snapshot()' in sql:
            result.fetchone.return_value = {'snapshot': '10:10:'}
        else:
            self.fail(f'Unexpected database query in transport test: {sql}')
        return result

    def request(self, method, path, body=None, headers=None):
        self.events.clear()
        self.db.commit.reset_mock()
        return self.client.request(method, path, json=body, headers={'X-Cashbook': '1', **(headers or {})})

    def check_headers(self, response):
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        self.assertRegex(response.headers['x-request-id'], r'^[a-f0-9]{32}$')

    def snapshot(self):
        return {'users': [USER_RESOURCE], 'permissions': {str(USER): [7]},
                'heads': [{'head_id': 7}], 'headRevision': 7, 'homeOrder': HOME_ORDER}

    def test_read_resource_routes_parse_and_lock_before_authentication(self):
        user = USER_RESOURCE
        external = EXTERNAL_RESOURCE
        contract = CONTRACT_RESOURCE
        routes = [
            ('/api/state', 'main.state', self.snapshot()),
            (f'/api/state?userId={USER}', 'main.overview', {'balance': 1}),
            ('/api/users', 'resources.users', [user]),
            (f'/api/users/{USER}', 'resources.users', [user]),
            (f'/api/users/{USER}/overview', 'resources.overview', {'balance': 1}),
            (f'/api/users/{USER}/permissions', 'resources.state', self.snapshot()),
            ('/api/external-users', 'resources.external_users', [external]),
            (f'/api/external-users/{EXTERNAL}', 'resources.external_users', [external]),
            ('/api/contracts', 'resources.list_contracts', [contract]),
            (f'/api/contracts/{CONTRACT}', 'resources.list_contracts', [contract]),
            ('/api/transactions', 'resources.ledger', [transaction_resource()]),
            ('/api/transactions/12', 'resources.ledger', [transaction_resource()]),
            ('/api/heads', 'resources.heads', [{'head_id': 7}]),
        ]
        for path, target, result in routes:
            with self.subTest(path=path), patch(target, return_value=result) as read:
                response = self.request('GET', path)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(self.events[:2], ['read-lock', 'authenticate'])
                read.assert_called_once()
                self.check_headers(response)
        response = self.request('GET', '/api/preferences/home-order')
        self.assertEqual(response.json(), {'homeOrder': HOME_ORDER})
        self.assertEqual(self.events[:2], ['read-lock', 'authenticate'])

    def test_command_resource_routes_dispatch_identity_and_commit(self):
        routes = [
            ('POST', '/api/users', {'profile': PROFILE, 'password': 'initial'}, 'user', 'create', None),
            ('PUT', f'/api/users/{USER}/profile', PROFILE, 'user', 'profile', ('userId', USER)),
            ('PUT', f'/api/users/{USER}/password', {'password': 'new'}, 'user', 'password', ('userId', USER)),
            ('PUT', f'/api/users/{USER}/status', {'active': False}, 'user', 'deactivate', ('userId', USER)),
            ('PUT', f'/api/users/{USER}/pin', {'pinned': True}, 'user', 'pin', ('userId', USER)),
            ('DELETE', f'/api/users/{USER}', None, 'user', 'delete', ('userId', USER)),
            ('PUT', f'/api/users/{USER}/permissions', {'ids': [7, -9]}, 'permissions', None, ('userId', USER)),
            ('POST', '/api/transactions/bills', {'input': INPUT}, 'transaction', 'submit', ('userId', ADMIN)),
            ('POST', '/api/transactions/credits', {'userId': str(USER), 'input': INPUT}, 'transaction', 'credit', ('userId', USER)),
            ('PUT', '/api/transactions/12', {'input': INPUT, 'expectedVersion': 4, 'contractId': str(CONTRACT)}, 'transaction', 'edit', ('id', 12)),
            ('PUT', '/api/transactions/12/status', {'active': True, 'expectedVersion': 4}, 'transaction', 'reactivate', ('id', 12)),
            ('DELETE', '/api/transactions/12?expectedVersion=4', None, 'transaction', 'delete', ('id', 12)),
            ('POST', '/api/heads/batch', {'revision': 7, 'changes': [{'op': 'active', 'head_id': 7, 'is_active': False}]}, 'heads', None, None),
            ('PUT', '/api/preferences/home-order', {'ids': HOME_ORDER}, 'homeOrder', None, None),
        ]
        for method, path, body, operation, action, identity in routes:
            if operation == 'transaction':
                result = {'id': '12', 'applied': True} if action == 'submit' else transaction_resource()
            else:
                result = {'data': self.snapshot(), 'user': USER_RESOURCE} if action == 'create' else self.snapshot()
            with self.subTest(method=method, path=path), patch('commands.apply_change', return_value=result) as apply:
                response = self.request(method, path, body)
                expected = 204 if method == 'DELETE' or path.endswith('/password') else 201 if method == 'POST' and path != '/api/heads/batch' else 200
                self.assertEqual(response.status_code, expected, response.text)
                value = apply.call_args.args[2]
                self.assertEqual(value.op, operation)
                if action:
                    self.assertEqual(value.action, action)
                if identity:
                    self.assertEqual(getattr(value, identity[0]), identity[1])
                if operation == 'transaction' and body and 'input' in body:
                    self.assertEqual(value.input.amount, Decimal('123.45'))
                if '/transactions/12' in path:
                    self.assertEqual(value.expectedVersion, 4)
                self.assertEqual(self.events, ['write-lock', 'authenticate', 'commit'])
                self.check_headers(response)
                if expected == 204:
                    self.assertEqual(response.content, b'')

    def test_external_user_routes_dispatch_specific_commands(self):
        routes = [
            ('POST', '/api/external-users', PROFILE, 'create'),
            ('PUT', f'/api/external-users/{EXTERNAL}/profile', PROFILE, 'edit'),
            ('PUT', f'/api/external-users/{EXTERNAL}/status', {'active': False}, 'deactivate'),
            ('PUT', f'/api/external-users/{EXTERNAL}/pin', {'pinned': True}, 'pin'),
            ('DELETE', f'/api/external-users/{EXTERNAL}', None, 'delete'),
        ]
        for method, path, body, action in routes:
            with self.subTest(path=path), patch('resources.change_credit_user', return_value=EXTERNAL) as change, \
                    patch('resources.external_users', return_value=[EXTERNAL_RESOURCE]):
                response = self.request(method, path, body)
                self.assertEqual(response.status_code, 204 if method == 'DELETE' else 201 if method == 'POST' else 200, response.text)
                value = change.call_args.args[2]
                self.assertEqual(value.op, 'creditUser')
                self.assertEqual(value.action, action)
                self.assertEqual(value.creditUserId, None if action == 'create' else EXTERNAL)
                self.assertEqual(self.events, ['write-lock', 'authenticate', 'commit'])

    def test_contract_routes_keep_revision_and_links(self):
        routes = [
            ('POST', '/api/contracts', CONTRACT_INPUT, 'create'),
            ('PUT', f'/api/contracts/{CONTRACT}?expectedRevision=7', CONTRACT_INPUT, 'edit'),
            ('PUT', f'/api/contracts/{CONTRACT}/status', {'active': False, 'expectedRevision': 7}, 'archive'),
            ('DELETE', f'/api/contracts/{CONTRACT}?expectedRevision=7', None, 'delete'),
        ]
        for method, path, body, action in routes:
            with self.subTest(path=path), patch('resources.change_contract', return_value=CONTRACT) as change, \
                    patch('resources.list_contracts', return_value=[CONTRACT_RESOURCE]):
                response = self.request(method, path, body)
                self.assertEqual(response.status_code, 204 if method == 'DELETE' else 201 if method == 'POST' else 200, response.text)
                value = change.call_args.args[2]
                self.assertEqual(value.action, action)
                self.assertEqual(value.contractId, None if action == 'create' else CONTRACT)
                self.assertEqual(value.expectedRevision, None if action == 'create' else 7)
                if value.input:
                    self.assertEqual(value.input.creditUserIds, [EXTERNAL])
                self.assertEqual(self.events, ['write-lock', 'authenticate', 'commit'])

    def test_legacy_commands_share_lock_service_and_commit(self):
        with patch('commands.apply_change', return_value={'applied': True}) as apply:
            response = self.request('POST', '/api/changes', {'op': 'transaction', 'action': 'edit',
                'id': 12, 'expectedVersion': 4, 'input': INPUT})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(apply.call_args.args[2].id, 12)
        self.assertEqual(self.events, ['write-lock', 'authenticate', 'commit'])

    def test_regular_users_cannot_read_admin_resources_or_change_other_accounts(self):
        self.actor = {'user_role_id': 2, 'user_id': USER}
        reads = ['/api/users', f'/api/users/{ADMIN}', '/api/external-users', f'/api/external-users/{EXTERNAL}',
                 '/api/contracts', f'/api/contracts/{CONTRACT}', '/api/preferences/home-order',
                 f'/api/users/{ADMIN}/overview', f'/api/users/{ADMIN}/permissions', f'/api/state?userId={ADMIN}',
                 f'/api/transactions?userId={ADMIN}']
        for path in reads:
            with self.subTest(path=path):
                response = self.request('GET', path)
                self.assertEqual(response.status_code, 403, response.text)
        writes = [
            ('POST', '/api/users', {'profile': PROFILE, 'password': 'initial'}),
            ('PUT', f'/api/users/{USER}/profile', PROFILE),
            ('PUT', f'/api/users/{USER}/password', {'password': 'new'}),
            ('PUT', f'/api/users/{USER}/status', {'active': False}),
            ('PUT', f'/api/users/{USER}/pin', {'pinned': True}),
            ('DELETE', f'/api/users/{USER}', None),
            ('PUT', f'/api/users/{USER}/permissions', {'ids': [7]}),
            ('POST', '/api/external-users', PROFILE),
            ('PUT', f'/api/external-users/{EXTERNAL}/profile', PROFILE),
            ('PUT', f'/api/external-users/{EXTERNAL}/status', {'active': False}),
            ('PUT', f'/api/external-users/{EXTERNAL}/pin', {'pinned': True}),
            ('DELETE', f'/api/external-users/{EXTERNAL}', None),
            ('POST', '/api/contracts', CONTRACT_INPUT),
            ('PUT', f'/api/contracts/{CONTRACT}?expectedRevision=7', CONTRACT_INPUT),
            ('PUT', f'/api/contracts/{CONTRACT}/status', {'active': False, 'expectedRevision': 7}),
            ('DELETE', f'/api/contracts/{CONTRACT}?expectedRevision=7', None),
            ('POST', '/api/transactions/credits', {'userId': str(USER), 'input': INPUT}),
            ('PUT', '/api/transactions/12', {'input': INPUT, 'expectedVersion': 4}),
            ('PUT', '/api/transactions/12/status', {'active': False, 'expectedVersion': 4}),
            ('DELETE', '/api/transactions/12?expectedVersion=4', None),
            ('POST', '/api/heads/batch', {'revision': 7, 'changes': []}),
            ('PUT', '/api/preferences/home-order', {'ids': HOME_ORDER}),
            ('POST', '/api/changes', {'op': 'user', 'action': 'delete', 'userId': str(USER)}),
        ]
        for method, path, body in writes:
            with self.subTest(path=path):
                response = self.request(method, path, body)
                self.assertEqual(response.status_code, 403, response.text)
                self.db.commit.assert_not_called()

    def test_regular_transaction_reads_are_scoped_and_history_free(self):
        self.actor = {'user_role_id': 2, 'user_id': USER}
        with patch('resources.ledger', return_value=[transaction_resource()]) as read:
            response = self.request('GET', '/api/transactions')
            self.assertEqual(response.status_code, 200)
            read.assert_called_once_with(self.db, USER, credits_only=True, limit=101, offset=0)
        with patch('resources.ledger', return_value=[]) as read:
            response = self.request('GET', '/api/transactions/99')
            self.assertEqual(response.status_code, 404)
            read.assert_called_once_with(self.db, USER, credits_only=True, transaction_id=99)
        with patch('resources.overview', return_value={'balance': 5}) as read:
            response = self.request('GET', f'/api/users/{USER}/overview')
            self.assertEqual(response.status_code, 200)
            read.assert_called_once_with(self.db, USER)

    def test_transaction_pagination_is_bounded_and_next_offset_is_explicit(self):
        with patch('resources.ledger', return_value=[transaction_resource(str(i)) for i in range(4)]) as read:
            response = self.request('GET', '/api/transactions?limit=3&offset=9')
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json(), {'items': [transaction_resource(str(i)) for i in range(3)],
                'limit': 3, 'offset': 9, 'nextOffset': 12})
            read.assert_called_once_with(self.db, None, limit=4, offset=9)
        with patch('resources.ledger', return_value=[transaction_resource('1')]):
            response = self.request('GET', '/api/transactions?limit=3&offset=9')
            self.assertIsNone(response.json()['nextOffset'])
        for suffix in ['limit=0', 'limit=501', 'offset=-1', 'offset=2147483648']:
            with self.subTest(query=suffix), patch('resources.ledger') as read:
                response = self.request('GET', f'/api/transactions?{suffix}')
                self.assertEqual(response.status_code, 422)
                read.assert_not_called()

    def test_normal_user_bill_submission_uses_authenticated_user_only(self):
        self.actor = {'user_role_id': 2, 'user_id': USER}
        with patch('commands.apply_change', return_value={'id': '12', 'applied': True}) as apply:
            response = self.request('POST', '/api/transactions/bills', {'input': INPUT})
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(apply.call_args.args[2].userId, USER)
        with patch('commands.apply_change') as apply:
            response = self.request('POST', '/api/transactions/bills', {'input': INPUT, 'userId': str(ADMIN)})
            self.assertEqual(response.status_code, 422)
            apply.assert_not_called()

    def test_expired_session_denies_queued_reads_and_writes_after_lock(self):
        self.actor = None
        for method, path, body in [('GET', '/api/users', None),
                ('POST', '/api/changes', {'op': 'homeOrder', 'ids': HOME_ORDER})]:
            with self.subTest(method=method), patch('commands.apply_change') as apply:
                response = self.request(method, path, body)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(self.events, ['read-lock' if method == 'GET' else 'write-lock', 'authenticate'])
                apply.assert_not_called()
                self.db.commit.assert_not_called()
                self.check_headers(response)

    def test_validation_rejects_invalid_ids_revisions_amounts_and_extra_fields_without_secret_echo(self):
        secret = 'secret-password-must-never-appear'
        routes = [
            ('GET', '/api/users/not-a-uuid', None),
            ('GET', '/api/transactions/0', None),
            ('GET', '/api/transactions/2147483648', None),
            ('PUT', '/api/transactions/12', {'input': INPUT, 'expectedVersion': 0}),
            ('DELETE', '/api/transactions/12', None),
            ('DELETE', '/api/transactions/12?expectedVersion=-1', None),
            ('PUT', f'/api/contracts/{CONTRACT}?expectedRevision=-1', CONTRACT_INPUT),
            ('POST', '/api/transactions/bills', {'input': {'amount': '-1'}}),
            ('POST', '/api/transactions/bills', {'input': {'amount': 'NaN'}}),
            ('POST', '/api/transactions/bills', {'input': {'amount': '1.234'}}),
            ('POST', '/api/users', {'profile': PROFILE, 'password': secret * 100}),
            ('POST', '/api/users', {'profile': PROFILE, 'password': secret, 'role': 'admin'}),
            ('PUT', f'/api/users/{USER}/permissions', {'ids': [2147483648]}),
        ]
        for method, path, body in routes:
            with self.subTest(path=path):
                response = self.request(method, path, body)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertNotIn(secret, response.text)
                for detail in response.json()['detail']:
                    self.assertNotIn('input', detail)
                self.db.commit.assert_not_called()
                self.check_headers(response)

    def test_commit_failures_never_return_success_or_database_details(self):
        self.db.commit.side_effect = psycopg.OperationalError('password=internal-database-secret')
        for method, path, body, target, value in [
            ('PUT', '/api/preferences/home-order', {'ids': HOME_ORDER}, 'commands.apply_change', {}),
            ('POST', '/api/external-users', PROFILE, 'resources.change_credit_user', EXTERNAL),
            ('POST', '/api/contracts', CONTRACT_INPUT, 'resources.change_contract', CONTRACT),
        ]:
            with self.subTest(path=path), patch(target, return_value=value), \
                    patch('resources.external_users', return_value=[EXTERNAL_RESOURCE]), \
                    patch('resources.list_contracts', return_value=[CONTRACT_RESOURCE]), \
                    self.assertLogs('cashbook.api', level='ERROR'):
                response = self.request(method, path, body)
                self.assertEqual(response.status_code, 503)
                self.assertNotIn('internal-database-secret', response.text)
                self.check_headers(response)

    def test_csrf_rejection_precedes_database_and_has_safe_headers(self):
        for headers in [{'X-Cashbook': ''}, {'Sec-Fetch-Site': 'cross-site'}]:
            response = self.request('PUT', '/api/preferences/home-order', {'ids': HOME_ORDER}, headers)
            self.assertEqual(response.status_code, 403)
            self.assertEqual(self.events, [])
            self.check_headers(response)

    def test_function_scoped_database_teardown_failure_cannot_send_success(self):
        def failed_commit():
            yield self.db
            raise psycopg.OperationalError('teardown-private-secret')

        main.app.dependency_overrides[database] = failed_commit
        with patch('resources.users', return_value=[]), self.assertLogs('cashbook.api', level='ERROR'):
            response = self.request('GET', '/api/users')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('teardown-private-secret', response.text)
        self.check_headers(response)

    def test_unhandled_error_is_generic_and_carries_request_id(self):
        with patch('resources.users', side_effect=RuntimeError('internal-secret')), \
                self.assertLogs('cashbook.api', level='ERROR'):
            response = self.request('GET', '/api/users')
        self.assertEqual(response.status_code, 500)
        self.assertNotIn('internal-secret', response.text)
        self.check_headers(response)

    def test_public_resources_filter_unexpected_private_database_fields(self):
        for path, target, row in [
            ('/api/users', 'resources.users', USER_RESOURCE),
            ('/api/external-users', 'resources.external_users', EXTERNAL_RESOURCE),
            ('/api/contracts', 'resources.list_contracts', CONTRACT_RESOURCE),
            ('/api/transactions', 'resources.ledger', transaction_resource()),
        ]:
            with self.subTest(path=path), patch(target, return_value=[{**row, 'password_hash': 'private-secret'}]):
                response = self.request('GET', path)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertNotIn('private-secret', response.text)
                self.assertNotIn('password_hash', response.text)


if __name__ == '__main__':
    unittest.main()
