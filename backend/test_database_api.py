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
        overpaid = self.call(self.admin, 'POST', '/api/transactions/credits',
                  {**receipt_body, 'input': {'amount': '700'}}, 201)
        self.call(self.admin, 'DELETE', f"/api/transactions/{overpaid['id']}?expectedVersion={overpaid['versions'][-1]['versionId']}", expected=204)
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
                  {**contract_input, 'totalAmount': '0'}, 422)
        renamed = self.call(self.admin, 'PUT', f'/api/contracts/{contract_id}?expectedRevision=1',
                            {**contract_input, 'name': 'Renamed contract'})
        self.assertEqual(renamed['revision'], 2)
        self.call(self.admin, 'PUT', f'/api/contracts/{contract_id}?expectedRevision=1', contract_input, 409)
        preserved = self.call(self.admin, 'GET', f"/api/transactions/{direct['id']}")
        self.assertEqual(preserved['versions'][-1]['contractName'], contract_input['name'])

        # Overpayment is now allowed; both receipts remain independent cash rows.
        def concurrent_credit(_):
            return self.admin.post('/api/transactions/credits', headers={'X-Cashbook': '1'},
                                   json={**receipt_body, 'input': {'amount': '300'}}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(concurrent_credit, range(2))), [201, 201])

        legacy = self.call(self.admin, 'GET', '/api/state')
        self.assertEqual(len(legacy['transactions']), 6)
        self.assertEqual(sum(t['amount'] for t in legacy['transactions'] if t['contractId'] == contract_id), 1200)
        self.assertEqual(self.call(self.admin, 'GET', '/api/transactions?limit=2')['nextOffset'], 2)
        changed = self.call(self.admin, 'POST', '/api/changes', {'op': 'creditUser', 'action': 'pin',
                            'creditUserId': external_id, 'pinned': True})
        self.assertTrue(next(u for u in changed['creditUsers'] if u['credit_user_id'] == external_id)['is_pinned'])
        normal_state = self.call(self.user, 'GET', '/api/state')
        self.assertEqual((normal_state['transactions'], normal_state['creditUsers'], normal_state['contracts']), ([], [], []))
        self.assertEqual([u['user_id'] for u in normal_state['users']], [worker_id])

        # Admin User credit records the user's bill with the admin's audit identity.
        bill_input = {'input': {'amount': '125', 'headId': head_id, 'description': 'Recorded for absent worker'}}
        self.call(self.admin, 'POST', '/api/transactions/bills', bill_input, 403)
        self.call(self.user, 'POST', f'/api/users/{worker_id}/bills', bill_input, 403)
        self.call(self.admin, 'POST', f'/api/users/{admin_id}/bills', bill_input, 400)
        self.call(self.admin, 'POST', f'/api/users/{worker_id}/bills', {'input': {'amount': '125', 'headId': None}}, 400)
        self.call(self.admin, 'POST', f'/api/users/{worker_id}/bills', {'input': {'amount': '125', 'headId': root_id}}, 400)
        unassigned = self.call(self.admin, 'POST', '/api/users', {
            'profile': {'user_name': 'Unassigned worker'}, 'password': USER_PASSWORD}, 201)
        self.call(self.admin, 'POST', f"/api/users/{unassigned['user_id']}/bills", bill_input, 403)
        admin_bill = self.call(self.admin, 'POST', f'/api/users/{worker_id}/bills', bill_input, 201)
        self.assertEqual(admin_bill['createdBy'], worker_id)
        self.assertEqual(admin_bill['headId'], head_id)
        self.assertEqual(admin_bill['versions'][0]['editorId'], admin_id)
        self.assertEqual(admin_bill['versions'][0]['action'], 'Recorded by admin')
        self.assertEqual(self.call(self.admin, 'GET', '/api/session')['userId'], admin_id)
        updated = self.call(self.admin, 'GET', f'/api/users/{worker_id}/overview')
        self.assertEqual((updated['totalReceived'], updated['totalBillPayment'], updated['balance']), (600, 375, 225))
        self.call(self.user, 'GET', f"/api/transactions/{admin_bill['id']}", expected=404)
        self.assertNotIn(admin_bill['id'], [t['id'] for t in self.call(self.user, 'GET', '/api/transactions')['items']])
        edited_bill = self.call(self.admin, 'PUT', f"/api/transactions/{admin_bill['id']}", {
            'expectedVersion': int(admin_bill['versions'][-1]['versionId']),
            'input': {'amount': '150', 'headId': head_id, 'description': 'Corrected bill'}})
        self.assertEqual(edited_bill['headId'], head_id)
        self.assertEqual(edited_bill['createdBy'], worker_id)
        self.assertEqual(self.call(self.admin, 'GET', f'/api/users/{worker_id}/overview')['totalBillPayment'], 400)

        # Personal liabilities affect the user's ledger, but only their payments move company cash.
        personal_url = f'/api/users/{worker_id}/admin-payable'
        before_company = self.call(self.admin, 'GET', f'/api/users/{admin_id}/overview')['balance']
        personal_input = {'input': {'amount': '1000', 'headId': None, 'description': 'Personal obligation'}}
        self.call(self.user, 'POST', personal_url, personal_input, 403)
        self.call(self.admin, 'POST', f'/api/users/{admin_id}/admin-payable', personal_input, 400)
        self.call(self.admin, 'POST', f'/api/users/{external_id}/admin-payable', personal_input, 404)
        self.call(self.admin, 'POST', personal_url, {'input': {'amount': '100', 'headId': head_id}}, 400)
        added = self.call(self.admin, 'POST', personal_url, personal_input, 201)
        self.assertEqual(added['transactionTypeId'], 2)
        self.assertIsNone(added['headId'])
        self.assertEqual(self.call(self.admin, 'GET', f'/api/users/{admin_id}/overview')['balance'], before_company)
        paid = self.call(self.admin, 'POST', personal_url+'/payments', {'input': {'amount': '300'}}, 201)
        self.assertEqual(paid['transactionTypeId'], 3)
        self.assertEqual(self.call(self.admin, 'GET', f'/api/users/{admin_id}/overview')['balance'], before_company-300)
        self.call(self.admin, 'POST', personal_url+'/payments', {'input': {'amount': '701'}}, 400)
        self.call(self.admin, 'POST', '/api/transactions/credits', {'userId': worker_id,
            'input': {'amount': '1', 'transactionTypeId': 2}}, 400)
        add_version = int(added['versions'][-1]['versionId'])
        self.call(self.admin, 'PUT', f"/api/transactions/{added['id']}/status", {'active': False, 'expectedVersion': add_version}, 400)
        self.call(self.admin, 'DELETE', f"/api/transactions/{added['id']}?expectedVersion={add_version}", expected=400)
        self.call(self.admin, 'PUT', f"/api/transactions/{added['id']}", {'expectedVersion': add_version,
            'input': {'amount': '200', 'transactionTypeId': 2}}, 400)
        pay_version = int(paid['versions'][-1]['versionId'])
        self.call(self.admin, 'PUT', f"/api/transactions/{paid['id']}", {'expectedVersion': pay_version,
            'input': {'amount': '1100', 'transactionTypeId': 3}}, 400)
        inactive = self.call(self.admin, 'PUT', f"/api/transactions/{paid['id']}/status", {'active': False, 'expectedVersion': pay_version})
        restored = self.call(self.admin, 'PUT', f"/api/transactions/{paid['id']}/status", {
            'active': True, 'expectedVersion': int(inactive['versions'][-1]['versionId'])})
        self.assertEqual([v['transactionTypeId'] for v in restored['versions']], [3, 3, 3])
        def personal_payment(_):
            return self.admin.post(personal_url+'/payments',
                headers={'X-Cashbook': '1'}, json={'input': {'amount': '600'}}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(personal_payment, range(2))), [201, 400])
        self.call(self.admin, 'POST', personal_url+'/payments', {'input': {'amount': '100'}}, 201)
        self.call(self.admin, 'POST', personal_url+'/payments', {'input': {'amount': '1'}}, 400)

        self.check_receipt_allocations(admin_id, external_id, worker_id)
        self.call(self.admin, 'PUT', f'/api/users/{worker_id}/password', {'password': 'replacement-password'}, 204)
        self.call(self.user, 'GET', '/api/state', expected=401)
        self.assertIsNone(self.call(self.user, 'GET', '/api/session'))
        self.call(self.user, 'POST', '/api/session', {'username': profile['user_name'], 'password': USER_PASSWORD}, 401)
        self.call(self.user, 'POST', '/api/session', {'username': profile['user_name'], 'password': 'replacement-password'})
        self.call(self.admin, 'PUT', f'/api/users/{worker_id}/status', {'active': False})
        self.call(self.admin, 'POST', f'/api/users/{worker_id}/bills', bill_input, 400)
        self.call(self.user, 'GET', '/api/state', expected=401)
        self.call(self.admin, 'DELETE', '/api/session')
        self.assertIsNone(self.call(self.admin, 'GET', '/api/session'))
        self.call(self.admin, 'GET', '/api/users', expected=401)

    def check_receipt_allocations(self, admin_id, payer_id, worker_id):
        """Cash, attribution, immutable links, concurrency and authorization together."""
        c1 = self.call(self.admin, 'POST', '/api/contracts', {'name': 'Split project one', 'totalAmount': '200', 'creditUserIds': [payer_id]}, 201)
        c2 = self.call(self.admin, 'POST', '/api/contracts', {'name': 'Split project two', 'totalAmount': '500', 'creditUserIds': [payer_id]}, 201)
        other_payer = self.call(self.admin, 'POST', '/api/external-users', {'user_name': 'Other receipt payer'}, 201)['credit_user_id']
        unlinked = self.call(self.admin, 'POST', '/api/contracts', {'name': 'Unlinked project', 'totalAmount': '100', 'creditUserIds': [other_payer]}, 201)
        upload = self.admin.post('/api/attachments', headers={'X-Cashbook': '1'}, data={'kind': 'image'},
            files={'file': ('shared-receipt.jpg', b'\xff\xd8\xff\xe0receipt', 'image/jpeg')})
        self.assertEqual(upload.status_code, 200, upload.text)
        before = self.call(self.admin, 'GET', f'/api/users/{admin_id}/overview')['balance']
        receipt_input = {'amount': '1000', 'description': 'One receipt shared across projects', 'attachments': [upload.json()]}
        root = self.call(self.admin, 'POST', '/api/transactions/credits', {'userId': admin_id, 'creditUserId': payer_id, 'input': receipt_input}, 201)
        key, rid = root['receiptKey'], root['id']
        self.assertRegex(key, r'^[A-Z0-9]{8}$')
        self.assertEqual(root['unallocatedAmount'], 1000)
        def version(entry):
            return int(entry['versions'][-1]['versionId'])
        values = [{'kind': 'contract', 'contractId': c1['id'], 'amount': '300'},
                  {'kind': 'contract', 'contractId': c2['id'], 'amount': '200'}, {'kind': 'profit', 'amount': '250'}]
        body = {'expectedVersion': version(root), 'input': receipt_input, 'allocations': values}
        url = f'/api/receipts/{rid}/allocations'
        self.call(self.user, 'PUT', url, body, 403)
        self.call(self.admin, 'PUT', f'/api/receipts/2147483647/allocations', body, 404)
        normal = self.call(self.admin, 'POST', '/api/transactions/credits', {'userId': worker_id, 'input': {'amount': '10'}}, 201)
        self.call(self.admin, 'PUT', f"/api/receipts/{normal['id']}/allocations", {**body, 'expectedVersion': version(normal)}, 404)
        self.assertIsNone(normal.get('receiptKey'))
        for invalid in [values + [{'kind': 'profit', 'amount': '1'}], [{'kind': 'profit', 'contractId': c1['id'], 'amount': '1'}],
                        [{'kind': 'contract', 'contractId': unlinked['id'], 'amount': '1'}], [{'kind': 'profit', 'amount': '1001'}]]:
            self.call(self.admin, 'PUT', url, {**body, 'allocations': invalid}, 400)
            self.assertEqual(version(self.call(self.admin, 'GET', f'/api/transactions/{rid}')), version(root))
        saved = self.call(self.admin, 'PUT', url, body)
        self.assertEqual(saved['receiptKey'], key)
        self.assertIsNone(saved['contractId'])
        self.assertEqual(saved['unallocatedAmount'], 250)
        self.assertEqual(saved['versions'][0]['allocations'], [])
        self.assertEqual(len(saved['allocations']), 3)
        self.assertEqual(saved['attachments'], root['attachments'])
        self.assertEqual(len(self.call(self.admin, 'GET', '/api/transactions')['items']),
                         len(self.call(self.admin, 'GET', '/api/state')['transactions']))
        self.call(self.admin, 'PUT', url, body, 409)
        self.call(self.admin, 'PUT', url, {**body, 'expectedVersion': version(saved), 'receiptKey': 'CHANGE01'}, 422)
        with self.connect_test() as connection:
            from contracts import received
            self.assertEqual(received(connection, c1['id']), 300)  # Contract is overpaid by100.
            self.assertEqual(received(connection, c2['id']), 200)
            # Only one table was introduced; existing transactions have no receipt columns.
            self.assertEqual(connection.execute("SELECT count(*) AS n FROM information_schema.columns WHERE table_name='transactions' AND column_name IN ('receipt_key','receipt_parent_id')").fetchone()['n'], 0)
        refund_body = {'expectedVersion': version(saved), 'amount': '200', 'description': 'Unused money returned'}
        self.call(self.user, 'POST', f'/api/receipts/{rid}/returns', refund_body, 403)
        self.call(self.admin, 'POST', f'/api/receipts/{rid}/returns', {**refund_body, 'amount': '251'}, 400)
        def refund(_):
            return self.admin.post(f'/api/receipts/{rid}/returns', headers={'X-Cashbook': '1'}, json=refund_body).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(refund, range(2))), [201, 409])
        root_after = self.call(self.admin, 'GET', f'/api/transactions/{rid}')
        self.assertEqual((root_after['amount'], root_after['returnedAmount'], root_after['unallocatedAmount']), (1000, 200, 50))
        grouped = [t for t in self.call(self.admin, 'GET', '/api/transactions')['items'] if t.get('receiptKey') == key]
        self.assertEqual(len(grouped), 2)
        child = next(t for t in grouped if t.get('receiptParentId'))
        self.assertEqual(child['receiptParentId'], rid)
        self.assertEqual(child['amount'], 200)
        self.assertEqual(child['allocations'], [])
        # Allocation edits never move money. Only receipt +1000, normal payment-10 and return-200 do.
        self.assertEqual(self.call(self.admin, 'GET', f'/api/users/{admin_id}/overview')['balance'], before + 790)
        self.call(self.admin, 'PUT', url, {**body, 'expectedVersion': version(root_after), 'input': {**receipt_input, 'amount': '900'}}, 400)
        self.call(self.admin, 'PUT', f'/api/transactions/{rid}/status', {'expectedVersion': version(root_after), 'active': False}, 400)
        self.call(self.admin, 'DELETE', f'/api/transactions/{rid}?expectedVersion={version(root_after)}', expected=400)
        self.call(self.admin, 'PUT', f"/api/transactions/{child['id']}", {'expectedVersion': version(child), 'input': {'amount': '1'}}, 400)
        inactive = self.call(self.admin, 'PUT', f"/api/transactions/{child['id']}/status", {'expectedVersion': version(child), 'active': False})
        self.assertEqual(self.call(self.admin, 'GET', f'/api/transactions/{rid}')['unallocatedAmount'], 250)
        filled = self.call(self.admin, 'PUT', url, {**body, 'expectedVersion': version(root_after), 'allocations': [*values[:2], {'kind': 'profit', 'amount': '500'}]})
        self.assertEqual(filled['unallocatedAmount'], 0)
        self.call(self.admin, 'PUT', f"/api/transactions/{child['id']}/status", {'expectedVersion': version(inactive), 'active': True}, 400)
        # Full contract allocation through the existing input path still works, and
        # history prevents unlink/deletion even after current allocations are moved.
        legacy = self.call(self.admin, 'POST', '/api/transactions/credits', {'userId': admin_id, 'creditUserId': payer_id, 'contractId': c2['id'], 'input': {'amount': '600'}}, 201)
        self.assertEqual(legacy['allocations'][0]['amount'], 600)
        self.assertEqual(legacy['unallocatedAmount'], 0)
        self.call(self.admin, 'PUT', f"/api/contracts/{c1['id']}?expectedRevision=1", {'name': c1['name'], 'totalAmount': '100', 'creditUserIds': [payer_id]})
        self.call(self.admin, 'PUT', f"/api/contracts/{c1['id']}?expectedRevision=2", {'name': c1['name'], 'totalAmount': '100', 'creditUserIds': [other_payer]}, 400)
        self.call(self.admin, 'DELETE', f"/api/contracts/{c1['id']}?expectedRevision=2", expected=400)
        # Undo/restore stays auditable and rechecks the available cash.
        off = self.call(self.admin, 'PUT', f'/api/transactions/{rid}/status', {'expectedVersion': version(filled), 'active': False})
        on = self.call(self.admin, 'PUT', f'/api/transactions/{rid}/status', {'expectedVersion': version(off), 'active': True})
        self.assertEqual(on['receiptKey'], key)
        self.assertEqual(on['allocations'], filled['allocations'])
        reduced = self.call(self.admin, 'PUT', url, {**body, 'expectedVersion': version(on), 'allocations': [*values[:2], {'kind': 'profit', 'amount': '300'}]})
        restored = self.call(self.admin, 'PUT', f"/api/transactions/{child['id']}/status", {'expectedVersion': version(inactive), 'active': True})
        self.assertEqual(restored['receiptKey'], key)
        self.assertEqual(self.call(self.admin, 'GET', f'/api/transactions/{rid}')['unallocatedAmount'], 0)
        # Archived contract attribution can be kept or reduced, but not increased.
        self.call(self.admin, 'PUT', f"/api/contracts/{c1['id']}/status", {'expectedRevision': 2, 'active': False})
        keep = self.call(self.admin, 'PUT', url, {**body, 'expectedVersion': version(reduced), 'allocations': [*values[:2], {'kind': 'profit', 'amount': '300'}]})
        self.call(self.admin, 'PUT', url, {**body, 'expectedVersion': version(keep), 'allocations': [{**values[0], 'amount': '301'}, values[1]]}, 400)


if __name__ == '__main__':
    unittest.main()
