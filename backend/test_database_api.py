r"""Real HTTP/accounting integration against an EMPTY disposable local database.

PowerShell, from backend/ (test-only example credentials):
  docker run --name cashbook-api-test -d -p 127.0.0.1:55439:5432 `
    -e POSTGRES_USER=cashbook_test -e POSTGRES_PASSWORD=cashbook_test `
    -e POSTGRES_DB=cashbook_test postgres:17
  $env:CASHBOOK_TEST_DATABASE_URL='postgresql://cashbook_test:cashbook_test@127.0.0.1:55439/cashbook_test'
  .\.venv\Scripts\python.exe -m unittest test_database_api -v
  docker rm -f cashbook-api-test
  Remove-Item Env:CASHBOOK_TEST_DATABASE_URL

Skipped unless explicitly configured. Refuses nonlocal, non-test-named, or
nonempty databases. Creates the normal schema and sample data; never resets a
database or reads DATABASE_URL. All upload paths use a temporary directory.
"""
import os
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import psycopg
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

import db
import main

TEST_URL = os.getenv('CASHBOOK_TEST_DATABASE_URL', '')
ADMIN_PASSWORD = 'integration-admin-password'
USER_PASSWORD = 'integration-user-password'


@unittest.skipUnless(TEST_URL, 'Set CASHBOOK_TEST_DATABASE_URL to an empty disposable local test database.')
class DatabaseApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        settings = conninfo_to_dict(TEST_URL)
        if settings.get('host') not in ('127.0.0.1', 'localhost', '::1') or not settings.get('dbname', '').startswith('cashbook_test'):
            raise RuntimeError('Integration tests require a local database named cashbook_test*.')

        def connect_test():
            # Pin the actual network destination too; PGHOSTADDR must not
            # silently redirect an explicitly local test URL elsewhere.
            local_address = '::1' if settings['host'] == '::1' else '127.0.0.1'
            return psycopg.connect(TEST_URL, hostaddr=local_address, row_factory=dict_row, connect_timeout=5)

        cls.connect_test = staticmethod(connect_test)
        with connect_test() as connection:
            count = connection.execute("SELECT count(*) AS count FROM information_schema.tables WHERE table_schema='public'").fetchone()['count']
            if count:
                raise RuntimeError('Integration tests require a completely empty database; no data was changed.')
        stack = ExitStack()
        cls.addClassCleanup(stack.close)
        uploads = Path(stack.enter_context(TemporaryDirectory(prefix='cashbook-api-test-')))
        stack.enter_context(patch('db.connect', side_effect=connect_test))
        stack.enter_context(patch('api_dependencies.connect', side_effect=connect_test))
        for target in ('db.UPLOADS', 'storage.UPLOADS', 'attachments.UPLOADS'):
            stack.enter_context(patch(target, uploads))
        stack.enter_context(patch('storage.BUCKET', ''))
        stack.enter_context(patch.dict(os.environ, {'ADMIN_PASSWORD': ADMIN_PASSWORD, 'COOKIE_SECURE': 'false'}))
        db.initialize()
        # Deliberately avoid TestClient lifespan: initialization above uses only
        # the explicit isolated connection, never the configured application DB.
        cls.admin = TestClient(main.app)
        cls.user = TestClient(main.app)
        stack.callback(cls.admin.close)
        stack.callback(cls.user.close)

    def call(self, client, method, path, body=None, expected=200):
        response = client.request(method, path, json=body, headers={'X-Cashbook': '1'})
        self.assertEqual(response.status_code, expected, f'{method} {path}: {response.text}')
        return response.json() if response.content else None

    def test_resource_and_legacy_accounting_flows_preserve_permissions_and_history(self):
        admin = self.call(self.admin, 'POST', '/api/session', {'username': 'admin', 'password': ADMIN_PASSWORD})
        self.assertEqual(admin['role'], 'admin')
        admin_id = admin['userId']
        profile = {'user_name': 'Integration worker', 'description': 'Test profile', 'contacts': ['03000000000']}
        worker = self.call(self.admin, 'POST', '/api/users', {'profile': profile, 'password': USER_PASSWORD}, 201)
        worker_id = worker['user_id']
        self.assertNotIn('password_hash', worker)
        self.assertEqual(self.call(self.admin, 'GET', f'/api/users/{worker_id}')['contacts'], profile['contacts'])
        self.call(self.user, 'POST', '/api/session', {'username': profile['user_name'], 'password': USER_PASSWORD})

        external = self.call(self.admin, 'POST', '/api/external-users', {'user_name': 'Integration payer'}, 201)
        external_id = external['credit_user_id']
        contract_input = {'name': 'Integration contract', 'totalAmount': '1000', 'creditUserIds': [external_id]}
        contract = self.call(self.admin, 'POST', '/api/contracts', contract_input, 201)
        contract_id = contract['id']
        self.assertEqual(contract['creditUserIds'], [external_id])
        self.call(self.user, 'GET', '/api/contracts', expected=403)
        self.call(self.user, 'GET', '/api/external-users', expected=403)
        self.call(self.user, 'GET', f'/api/users/{admin_id}/overview', expected=403)

        tree = self.call(self.admin, 'POST', '/api/heads/batch', {'revision': 0, 'changes': [
            {'op': 'create', 'temp_id': -1, 'head_name': 'Integration project', 'parent_head_id': None},
            {'op': 'create', 'temp_id': -2, 'head_name': 'Integration expense', 'parent_head_id': -1, 'is_transactionable': True},
        ]})
        root_id = next(h['head_id'] for h in tree['heads'] if h['parent_head_id'] is None)
        head_id = next(h['head_id'] for h in tree['heads'] if h['parent_head_id'] == root_id)
        self.assertEqual(tree['revision'], 1)
        self.call(self.admin, 'POST', '/api/heads/batch', {'revision': 0, 'changes': []}, 409)
        # Failure after an INSERT must roll back the entire draft and revision.
        self.call(self.admin, 'POST', '/api/heads/batch', {'revision': 1, 'changes': [
            {'op': 'create', 'temp_id': -1, 'head_name': 'Must roll back', 'parent_head_id': None},
            {'op': 'move', 'head_id': head_id, 'new_parent_id': 2147483647},
        ]}, 400)
        self.assertEqual(self.call(self.admin, 'GET', '/api/heads'), tree)
        bill = {'amount': '250', 'headId': head_id, 'description': 'Worker bill'}
        self.call(self.user, 'POST', '/api/transactions/bills', {'input': bill}, 403)
        self.call(self.admin, 'PUT', f'/api/users/{worker_id}/permissions', {'ids': [root_id]})
        visible = self.call(self.user, 'GET', '/api/heads')
        self.assertEqual({h['head_id'] for h in visible['heads']}, {root_id, head_id})
        submitted = self.call(self.user, 'POST', '/api/transactions/bills', {'input': bill}, 201)
        bill_id = submitted['id']
        advance = self.call(self.admin, 'POST', '/api/transactions/credits',
                            {'userId': worker_id, 'input': {'amount': '600', 'headId': head_id}}, 201)
        self.assertIsNone(advance['headId'], 'Existing direct admin-payment logic must be preserved')
        user_entries = self.call(self.user, 'GET', '/api/transactions')['items']
        self.assertEqual([row['id'] for row in user_entries], [advance['id']])
        self.assertFalse(user_entries[0].get('versions'), 'Regular users must not receive edit history')
        self.call(self.user, 'GET', f'/api/transactions/{bill_id}', expected=404)
        overview = self.call(self.admin, 'GET', f'/api/users/{worker_id}/overview')
        self.assertEqual((overview['totalReceived'], overview['totalBillPayment'], overview['balance']), (600, 250, 350))

        receipt_body = {'userId': admin_id, 'creditUserId': external_id, 'contractId': contract_id,
                        'input': {'amount': '400', 'description': 'First receipt'}}
        receipt = self.call(self.admin, 'POST', '/api/transactions/credits', receipt_body, 201)
        self.call(self.admin, 'POST', '/api/transactions/credits',
                  {**receipt_body, 'input': {'amount': '700'}}, 400)
        self.call(self.user, 'POST', '/api/transactions/credits', receipt_body, 403)
        direct = self.call(self.admin, 'POST', '/api/transactions/credits',
                           {'userId': admin_id, 'creditUserId': external_id, 'input': {'amount': '200'}}, 201)
        old_version = int(direct['versions'][-1]['versionId'])
        assigned = self.call(self.admin, 'PUT', f"/api/transactions/{direct['id']}",
                             {'expectedVersion': old_version, 'contractId': contract_id, 'input': {'amount': '200'}})
        self.assertEqual([v['contractId'] for v in assigned['versions']], [None, contract_id])
        self.assertEqual(assigned['versions'][-1]['action'], 'Assigned to contract')
        self.assertEqual(assigned['versions'][0]['contractName'], '')
        self.assertEqual(assigned['versions'][-1]['contractName'], contract_input['name'])
        self.call(self.admin, 'PUT', f"/api/transactions/{direct['id']}",
                  {'expectedVersion': old_version, 'input': {'amount': '100'}}, 409)
        self.call(self.admin, 'PUT', f'/api/contracts/{contract_id}?expectedRevision=1',
                  {**contract_input, 'totalAmount': '500'}, 400)
        renamed = self.call(self.admin, 'PUT', f'/api/contracts/{contract_id}?expectedRevision=1',
                            {**contract_input, 'name': 'Renamed contract'})
        self.assertEqual(renamed['revision'], 2)
        self.call(self.admin, 'PUT', f'/api/contracts/{contract_id}?expectedRevision=1', contract_input, 409)
        preserved = self.call(self.admin, 'GET', f"/api/transactions/{direct['id']}")
        self.assertEqual(preserved['versions'][-1]['contractName'], contract_input['name'])

        # Two simultaneous receipts compete for one shared remaining amount:
        # exactly one can consume300 of the400 left.
        def concurrent_credit(_):
            return self.admin.post('/api/transactions/credits', headers={'X-Cashbook': '1'},
                                   json={**receipt_body, 'input': {'amount': '300'}}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(concurrent_credit, range(2))), [201, 400])

        legacy = self.call(self.admin, 'GET', '/api/state')
        self.assertEqual(len(legacy['transactions']), 5)
        self.assertEqual(sum(t['amount'] for t in legacy['transactions'] if t['contractId'] == contract_id), 900)
        self.assertEqual(self.call(self.admin, 'GET', '/api/transactions?limit=2')['nextOffset'], 2)
        changed = self.call(self.admin, 'POST', '/api/changes', {'op': 'creditUser', 'action': 'pin',
                            'creditUserId': external_id, 'pinned': True})
        self.assertTrue(next(u for u in changed['creditUsers'] if u['credit_user_id'] == external_id)['is_pinned'])
        normal_state = self.call(self.user, 'GET', '/api/state')
        self.assertEqual((normal_state['transactions'], normal_state['creditUsers'], normal_state['contracts']), ([], [], []))
        self.assertEqual([u['user_id'] for u in normal_state['users']], [worker_id])

        self.call(self.admin, 'PUT', f'/api/users/{worker_id}/password', {'password': 'replacement-password'}, 204)
        self.call(self.user, 'GET', '/api/state', expected=401)
        self.assertIsNone(self.call(self.user, 'GET', '/api/session'))
        self.call(self.user, 'POST', '/api/session', {'username': profile['user_name'], 'password': USER_PASSWORD}, 401)
        self.call(self.user, 'POST', '/api/session', {'username': profile['user_name'], 'password': 'replacement-password'})
        self.call(self.admin, 'PUT', f'/api/users/{worker_id}/status', {'active': False})
        self.call(self.user, 'GET', '/api/state', expected=401)
        self.call(self.admin, 'DELETE', '/api/session')
        self.assertIsNone(self.call(self.admin, 'GET', '/api/session'))
        self.call(self.admin, 'GET', '/api/users', expected=401)


if __name__ == '__main__':
    unittest.main()
