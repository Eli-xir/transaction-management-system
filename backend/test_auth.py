import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import HTTPException, Response
from starlette.requests import Request

import auth
from models import Login


def request(headers=()):
    return Request({'type': 'http', 'headers': list(headers), 'client': ('198.51.100.1', 1234)})


class AuthTests(unittest.TestCase):
    def test_login_commits_before_setting_cookie_and_locks_credentials(self):
        user_id, sid = uuid4(), uuid4()
        db = Mock()
        db.execute.return_value.fetchone.side_effect = [
            {'user_id': user_id, 'user_role_id': 2, 'password_hash': 'hash'}, {'session_id': sid}]
        response = Mock()
        response.set_cookie.side_effect = lambda *args, **kwargs: self.assertTrue(db.commit.called)
        with patch('auth.password_matches', return_value=True), patch.dict('os.environ', {'COOKIE_SECURE': 'true'}):
            result = auth.sign_in(Login(username='Ali', password='secret'), request(), response, db)
        self.assertEqual(result, {'userId': str(user_id), 'role': 'user'})
        self.assertIn('FOR SHARE', db.execute.call_args_list[0].args[0])
        response.set_cookie.assert_called_once_with(auth.COOKIE, str(sid), max_age=604800, httponly=True,
                                                    samesite='strict', secure=True, path='/')

    def test_admin_alias_uses_locked_lookup_and_local_cookie_still_works(self):
        db = Mock()
        db.execute.return_value.fetchone.side_effect = [None,
            {'user_id': uuid4(), 'user_role_id': 1, 'password_hash': 'hash'}, {'session_id': uuid4()}]
        response = Response()
        with patch('auth.password_matches', return_value=True), patch.dict('os.environ', {'COOKIE_SECURE': 'false'}):
            result = auth.sign_in(Login(username='admin', password='secret'), request(), response, db)
        self.assertEqual(result['role'], 'admin')
        self.assertIn('FOR SHARE', db.execute.call_args_list[1].args[0])
        self.assertIn('HttpOnly', response.headers['set-cookie'])
        self.assertNotIn('Secure', response.headers['set-cookie'])

    def test_failed_login_does_not_create_session_or_cookie(self):
        db, response = Mock(), Mock()
        db.execute.return_value.fetchone.return_value = None
        with patch('auth.password_matches', return_value=False) as verify:
            with self.assertRaises(HTTPException) as caught:
                auth.sign_in(Login(username='missing', password='secret'), request(), response, db)
        self.assertEqual(caught.exception.status_code, 401)
        verify.assert_called_once_with('secret', auth.DUMMY_HASH)
        self.assertEqual(db.execute.call_count, 1)
        db.commit.assert_not_called()
        response.set_cookie.assert_not_called()

    def test_failed_commit_does_not_set_cookie(self):
        db, response = Mock(), Mock()
        db.execute.return_value.fetchone.side_effect = [
            {'user_id': uuid4(), 'user_role_id': 2, 'password_hash': 'hash'}, {'session_id': uuid4()}]
        db.commit.side_effect = RuntimeError('commit failed')
        with patch('auth.password_matches', return_value=True), self.assertRaisesRegex(RuntimeError, 'commit failed'):
            auth.sign_in(Login(username='Ali', password='secret'), request(), response, db)
        response.set_cookie.assert_not_called()

    def test_logout_commits_before_removing_cookie(self):
        db, response = Mock(), Mock()
        response.delete_cookie.side_effect = lambda *args, **kwargs: self.assertTrue(db.commit.called)
        self.assertEqual(auth.sign_out(request(), response, db), {'applied': True})
        response.delete_cookie.assert_called_once_with(auth.COOKIE, path='/')

    def test_rate_limit_expires_and_returns_retry_after(self):
        limiter = auth.LoginRateLimiter(limit=2)
        with patch('auth.time.monotonic', return_value=100):
            limiter.check('client')
            limiter.check('client')
            with self.assertRaises(HTTPException) as caught:
                limiter.check('client')
        self.assertEqual(caught.exception.status_code, 429)
        self.assertEqual(caught.exception.headers, {'Retry-After': '60'})
        with patch('auth.time.monotonic', return_value=160):
            limiter.check('client')

    def test_rate_limit_is_bounded_and_client_addresses_are_separate(self):
        limiter = auth.LoginRateLimiter(limit=1, max_clients=2)
        for address in ['a', 'b', 'c']:
            limiter.check(address)
        self.assertEqual(list(limiter._clients), ['b', 'c'])
        with self.assertRaises(HTTPException):
            limiter.check('c')

    def test_parallel_attempts_do_not_exceed_limit(self):
        limiter = auth.LoginRateLimiter(limit=20)
        def attempt(_):
            try:
                limiter.check('same-client')
                return True
            except HTTPException:
                return False
        with ThreadPoolExecutor(max_workers=12) as executor:
            self.assertEqual(sum(executor.map(attempt, range(60))), 20)

    def test_untrusted_forwarded_header_does_not_change_rate_limit_key(self):
        with patch.object(auth.login_limiter, 'check') as check:
            auth.login_rate_limit(request([(b'x-forwarded-for', b'203.0.113.8')]))
        check.assert_called_once_with('198.51.100.1')


if __name__ == '__main__':
    unittest.main()
