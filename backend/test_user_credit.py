"""Admin bill entry preserves existing accounting classification and real authorship."""
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import HTTPException

from models import TransactionInput
from service import record_user_bill


class UserCreditTests(unittest.TestCase):
    def setUp(self):
        self.admin_id, self.user_id = uuid4(), uuid4()
        self.actor = {'user_role_id': 1, 'user_id': self.admin_id}
        self.user = {'user_id': self.user_id, 'user_role_id': 2, 'is_active': True}
        self.value = TransactionInput(amount='125.50', headId=7, description='Bill entered by admin')

    def test_only_administrators_can_record_a_bill_for_another_user(self):
        db = Mock()
        with self.assertRaises(HTTPException) as caught:
            record_user_bill(db, {'user_role_id': 2, 'user_id': self.user_id}, self.user_id, self.value)
        self.assertEqual(caught.exception.status_code, 403)
        db.execute.assert_not_called()

    def test_missing_inactive_and_admin_targets_cannot_receive_user_bills(self):
        for row, status in [(None, 404), ({**self.user, 'is_active': False}, 400),
                            ({**self.user, 'user_role_id': 1}, 400)]:
            with self.subTest(row=row):
                db = Mock()
                db.execute.return_value.fetchone.return_value = row
                with self.assertRaises(HTTPException) as caught:
                    record_user_bill(db, self.actor, self.user_id, self.value)
                self.assertEqual(caught.exception.status_code, status)
                self.assertEqual(db.execute.call_count, 1)

    def test_bill_uses_owner_for_existing_balances_and_admin_for_audit_history(self):
        db = Mock()
        entry = {'transaction_id': 12}
        db.execute.return_value.fetchone.return_value = entry
        with patch('service.account', return_value=self.user), patch('service.validate_input', return_value=[4]) as validate, \
                patch('service.revise') as revise, patch('service.ledger', return_value=[{'id': '12'}]) as read:
            self.assertEqual(record_user_bill(db, self.actor, self.user_id, self.value), {'id': '12'})
        validate.assert_called_once_with(db, self.actor, self.value, self.user_id, submission=True)
        self.assertEqual(db.execute.call_args.args[1], (7, self.user_id, self.user_id))
        revise.assert_called_once_with(db, entry, self.admin_id, 'Recorded by admin', self.value, [4])
        read.assert_called_once_with(db, self.user_id, transaction_id=12)
        self.assertEqual(self.value.headId, 7, 'A bill must retain its head, unlike a direct payment')

    def test_head_must_be_active_transactionable_and_assigned_to_the_target(self):
        cases = [(None, [], 400), ({'is_active': False, 'is_transactionable': True}, [7], 400),
                 ({'is_active': True, 'is_transactionable': False}, [7], 400),
                 ({'is_active': True, 'is_transactionable': True}, [], 403)]
        for head, assigned, status in cases:
            with self.subTest(head=head, assigned=assigned):
                db = Mock()
                db.execute.return_value.fetchone.return_value = head
                with patch('service.account', return_value=self.user), patch('service.user_permissions', return_value=assigned), \
                        patch('service.revise') as revise, self.assertRaises(HTTPException) as caught:
                    record_user_bill(db, self.actor, self.user_id, self.value)
                self.assertEqual(caught.exception.status_code, status)
                revise.assert_not_called()
                self.assertFalse(any('INSERT INTO transactions' in call.args[0] for call in db.execute.call_args_list))

    def test_zero_amount_is_not_a_bill(self):
        db = Mock()
        db.execute.return_value.fetchone.return_value = {'is_active': True, 'is_transactionable': True}
        with patch('service.account', return_value=self.user), self.assertRaises(HTTPException):
            record_user_bill(db, self.actor, self.user_id, TransactionInput(amount=0, headId=7))
        self.assertFalse(any('INSERT INTO transactions' in call.args[0] for call in db.execute.call_args_list))
