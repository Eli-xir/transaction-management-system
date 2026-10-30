import unittest
from unittest.mock import Mock
from fastapi import HTTPException
from models import HomeOrderChange
from service import apply_change


class HomeOrderTests(unittest.TestCase):
    base = ['attachments', 'users', 'company', 'statement', 'heads', 'credit', 'debit']
    actor = {'user_role_id': 1, 'user_id': 'admin'}

    def test_old_and_new_clients_can_save_their_order(self):
        for ids in [self.base, ['payable', 'receivable'] + self.base, ['contracts', 'payable', 'receivable'] + self.base,
                    ['user-credit', 'contracts', 'payable', 'receivable'] + self.base]:
            db = Mock()
            result = apply_change(db, self.actor, HomeOrderChange(op='homeOrder', ids=ids), 'session')
            self.assertEqual(result['homeOrder'], ids)
            db.execute.assert_called_once()

    def test_incomplete_and_duplicate_orders_are_rejected_before_writing(self):
        for ids in [self.base + ['payable'], self.base + ['payable', 'payable']]:
            db = Mock()
            with self.assertRaises(HTTPException):
                apply_change(db, self.actor, HomeOrderChange(op='homeOrder', ids=ids), 'session')
            db.execute.assert_not_called()

    def test_non_admin_cannot_save_home_order(self):
        db = Mock()
        with self.assertRaises(HTTPException) as caught:
            apply_change(db, {'user_role_id': 2}, HomeOrderChange(op='homeOrder', ids=self.base), 'session')
        self.assertEqual(caught.exception.status_code, 403)
        db.execute.assert_not_called()
