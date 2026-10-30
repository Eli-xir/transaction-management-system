import unittest
from decimal import Decimal
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import HTTPException
from contracts import change_contract, validate_receipt
from models import ContractChange, TransactionChange
from service import revise, transaction_change


class ContractTests(unittest.TestCase):
    def setUp(self):
        # These isolate the legacy adapter; receipt persistence is covered by
        # real database tests, not the adapter's synthetic SQL result objects.
        for target, value in [('receipts.metadata', None), ('receipts.allocations', []), ('receipts.returned', Decimal(0))]:
            mock = patch(target, return_value=value)
            mock.start()
            self.addCleanup(mock.stop)

    def test_direct_receipt_assignment_is_one_version_checked_against_remaining(self):
        target, payer, admin_id = uuid4(), uuid4(), uuid4()
        db = Mock()
        entry = {'transaction_id': 12, 'current_version_id': 4, 'contract_id': None,
                 'credit_user_id': payer, 'is_active': True, 'user_id': admin_id, 'created_by_user_id': admin_id, 'name': 'Contract'}
        db.execute.return_value.fetchone.return_value = entry
        change = TransactionChange(op='transaction', action='edit', id=12, expectedVersion=4, contractId=target,
                                   input={'amount': '400', 'description': 'Existing receipt', 'headId': None})
        with patch('service.validate_receipt') as validate, patch('service.revise') as write, \
                patch('service.account', return_value={'user_role_id': 1}), patch('service.ledger', return_value=[{'id': '12'}]):
            transaction_change(db, {'user_role_id': 1, 'user_id': admin_id}, change)
            validate.assert_called_once_with(db, target, payer, Decimal('400'), 12)
            write.assert_called_once()
            self.assertEqual(write.call_args.args[1]['contract_id'], target)
            self.assertEqual(write.call_args.args[4].description, 'Existing receipt')
            self.assertFalse(any('INSERT INTO transactions' in call.args[0] for call in db.execute.call_args_list))

    def test_assignment_rejects_normal_users_inactive_receipts_stale_edits_and_other_contracts(self):
        target, payer, old = uuid4(), uuid4(), uuid4()
        cases = [
            ({'credit_user_id': None}, 'only apply'),
            ({'is_active': False}, 'Reactivate'),
            ({'current_version_id': 5}, 'entry changed'),
            ({'contract_id': old}, 'already belongs'),
        ]
        for overrides, message in cases:
            db = Mock()
            db.execute.return_value.fetchone.return_value = {
                'transaction_id': 12, 'current_version_id': 4, 'contract_id': None,
                'credit_user_id': payer, 'is_active': True, **overrides}
            change = TransactionChange(op='transaction', action='edit', id=12, expectedVersion=4, contractId=target,
                                       input={'amount': '400'})
            with patch('service.revise') as write, self.assertRaisesRegex(HTTPException, message):
                transaction_change(db, {'user_role_id': 1}, change)
            write.assert_not_called()

    def test_assignment_failure_cannot_save_a_new_version(self):
        db = Mock()
        target, payer = uuid4(), uuid4()
        db.execute.return_value.fetchone.return_value = {'transaction_id': 12, 'current_version_id': 4,
            'contract_id': None, 'credit_user_id': payer, 'is_active': True}
        change = TransactionChange(op='transaction', action='edit', id=12, expectedVersion=4,
                                   contractId=target, input={'amount': '400'})
        for message in ['receipt exceeds remaining', 'user is not linked', 'contract is archived']:
            with patch('service.validate_receipt', side_effect=HTTPException(400, message)), patch('service.revise') as write:
                with self.assertRaisesRegex(HTTPException, message):
                    transaction_change(db, {'user_role_id': 1}, change)
                write.assert_not_called()

    def test_versions_snapshot_contract_and_name_without_rewriting_old_history(self):
        for target in [None, uuid4()]:
            db = Mock()
            def query(sql, params):
                result = Mock()
                if sql.startswith('SELECT * FROM transaction_versions'):
                    result.fetchone.return_value = {'category_name': ''}
                elif sql.startswith('SELECT name FROM contracts'):
                    result.fetchone.return_value = {'name': 'Contract at time of edit'}
                elif 'INSERT INTO transaction_versions' in sql:
                    result.fetchone.return_value = {'version_id': 5}
                return result
            db.execute.side_effect = query
            from models import TransactionInput
            with patch('service.path', return_value=''):
                revise(db, {'transaction_id': 12, 'current_version_id': 4, 'contract_id': target,
                            'is_active': True, 'head_id': None}, uuid4(), 'Edited', TransactionInput(amount='400'), [])
            insert = next(call for call in db.execute.call_args_list if 'INSERT INTO transaction_versions' in call.args[0])
            self.assertEqual(insert.args[1][-2:], (target, 'Contract at time of edit' if target else ''))
            update = next(call for call in db.execute.call_args_list if call.args[0].startswith('UPDATE transactions'))
            self.assertEqual(update.args[1][-2:], (target, 12))
            self.assertFalse(any(call.args[0].startswith('UPDATE transaction_versions') for call in db.execute.call_args_list))

    def test_contract_and_payer_are_checked_under_lock_without_capping_overpayment(self):
        db = Mock()
        db.execute.return_value.fetchone.side_effect = [
            {'is_active': True, 'total_amount': Decimal('1000')}, {'linked': True}, {'amount': Decimal('700')}]
        validate_receipt(db, 'contract', 'payer', Decimal('3000'), 42)
        self.assertIn('FOR UPDATE', db.execute.call_args_list[0].args[0])
        self.assertEqual(db.execute.call_args_list[1].args[1], ('contract', 'payer'))
        self.assertEqual(len(db.execute.call_args_list), 2)

    def test_unlinked_archived_and_zero_receipts_are_rejected(self):
        for active, linked, amount, message in [
            (True, False, '1', 'not linked'),
            (False, True, '1', 'Reactivate'), (True, True, '0', 'greater than zero')]:
            db = Mock()
            db.execute.return_value.fetchone.side_effect = [
                {'is_active': active, 'total_amount': Decimal('1000')}, {'linked': 1} if linked else None,
                {'amount': Decimal('700')}]
            with self.assertRaisesRegex(HTTPException, message):
                validate_receipt(db, 'contract', 'payer', Decimal(amount))

    def test_contract_changes_require_admin_and_current_revision(self):
        db = Mock()
        change = ContractChange(op='contract', action='archive', contractId=uuid4(), expectedRevision=1)
        with self.assertRaises(HTTPException) as caught:
            change_contract(db, {'user_role_id': 2}, change)
        self.assertEqual(caught.exception.status_code, 403)
        db.execute.assert_not_called()
        db.execute.return_value.fetchone.return_value = {'revision': 2}
        with self.assertRaises(HTTPException) as caught:
            change_contract(db, {'user_role_id': 1}, change)
        self.assertEqual(caught.exception.status_code, 409)

    def test_receipt_reactivation_revalidates_remaining_before_writing(self):
        db = Mock()
        db.execute.return_value.fetchone.side_effect = [
            {'transaction_id': 12, 'current_version_id': 4, 'contract_id': 'c', 'credit_user_id': 'p', 'is_active': False},
            {'transaction_type_id': 1},
            {'transaction_amount': Decimal('400')}]
        change = TransactionChange(op='transaction', action='reactivate', id=12, expectedVersion=4)
        with patch('service.validate_receipt', side_effect=HTTPException(400, 'exceeds')) as validate, patch('service.revise') as revise:
            with self.assertRaises(HTTPException):
                transaction_change(db, {'user_role_id': 1}, change)
            validate.assert_called_once_with(db, 'c', 'p', Decimal('400'), 12)
            revise.assert_not_called()

    def test_many_users_share_one_contract_amount(self):
        payer1, payer2, contract_id = uuid4(), uuid4(), uuid4()
        db = Mock()
        db.execute.return_value.fetchall.return_value = [
            {'credit_user_id': payer1, 'is_active': True}, {'credit_user_id': payer2, 'is_active': True}]
        db.execute.return_value.fetchone.return_value = {'contract_id': contract_id}
        change_contract(db, {'user_role_id': 1}, ContractChange(op='contract', action='create', input={
            'name': 'Shared', 'totalAmount': '1000', 'creditUserIds': [payer1, payer2]}))
        inserts = [call.args for call in db.execute.call_args_list if call.args[0].startswith('INSERT')]
        self.assertEqual(inserts[0][1], ('Shared', '', Decimal('1000')))
        self.assertEqual([args[1] for args in inserts[1:]], [(contract_id, payer1), (contract_id, payer2)])

    def test_edit_cannot_unlink_receipt_history_even_when_contract_is_overpaid(self):
        payer1, payer2, contract_id = uuid4(), uuid4(), uuid4()
        for total, message in [('100', 'cannot be unlinked'), ('1000', 'cannot be unlinked')]:
            db = Mock()
            db.execute.return_value.fetchone.side_effect = [{'revision': 1}, {'history': True}]
            db.execute.return_value.fetchall.side_effect = [
                [{'credit_user_id': payer1}, {'credit_user_id': payer2}], [{'credit_user_id': payer1, 'is_active': True}]]
            change = ContractChange(op='contract', action='edit', contractId=contract_id, expectedRevision=1,
                                    input={'name': 'Shared', 'totalAmount': total, 'creditUserIds': [payer1]})
            with self.assertRaisesRegex(HTTPException, message):
                change_contract(db, {'user_role_id': 1}, change)
            self.assertFalse(any(call.args[0].startswith(('UPDATE', 'DELETE', 'INSERT')) for call in db.execute.call_args_list))


if __name__ == '__main__':
    unittest.main()
