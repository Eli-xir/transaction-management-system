"""Cookie sessions and bounded login throttling.

The throttle is per process and uses the connection's client address. Multiple
workers/instances need a shared limiter at the trusted proxy for a global limit.
"""
import math
import os
import threading
import time
from collections import OrderedDict, deque
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel

from api_dependencies import COOKIE, DB, session_id, session_user
from db import password_hash, password_matches
from models import Login
from service import require


class LoginRateLimiter:
    """A sliding window with bounded memory, safe across synchronous workers."""

    def __init__(self, limit=20, window_seconds=60, max_clients=4096):
        self.limit = limit
        self.window_seconds = window_seconds
        self.max_clients = max_clients
        self._clients = OrderedDict()
        self._lock = threading.Lock()

    def check(self, address):
        with self._lock:
            now = time.monotonic()
            attempts = self._clients.pop(address, deque())
            while attempts and attempts[0] <= now - self.window_seconds:
                attempts.popleft()
            self._clients[address] = attempts
            while len(self._clients) > self.max_clients:
                self._clients.popitem(last=False)
            if len(attempts) >= self.limit:
                retry = max(1, math.ceil(attempts[0] + self.window_seconds - now))
                raise HTTPException(429, 'Too many login attempts. Please wait a minute and try again.',
                                    headers={'Retry-After': str(retry)})
            attempts.append(now)


login_limiter = LoginRateLimiter()
DUMMY_HASH = password_hash('no-account')
router = APIRouter(prefix='/api/session', tags=['Session'])


class SessionResponse(BaseModel):
    userId: str
    role: Literal['admin', 'user']


def login_rate_limit(request: Request):
    # Uvicorn/proxy configuration owns trusted forwarding. Never parse XFF here.
    login_limiter.check(request.client.host if request.client else 'unknown')


def session_view(actor):
    return {'userId': str(actor['user_id']), 'role': 'admin' if actor['user_role_id'] == 1 else 'user'} if actor else None


@router.get('', response_model=SessionResponse | None)
def current_session(request: Request, db: DB):
    return session_view(session_user(db, request))


@router.post('', response_model=SessionResponse, dependencies=[Depends(login_rate_limit)])
def sign_in(value: Login, request: Request, response: Response, db: DB):
    # Hold credentials stable until the new session is committed. A password
    # reset/deactivation then updates this row and revokes the committed session.
    user = db.execute('SELECT * FROM users WHERE is_active AND user_name=%s FOR SHARE', (value.username,)).fetchone()
    if not user and value.username.lower() == 'admin':
        user = db.execute('SELECT * FROM users WHERE is_active AND user_role_id=1 ORDER BY user_id LIMIT 1 FOR SHARE').fetchone()
    valid = password_matches(value.password, user['password_hash'] if user else DUMMY_HASH)
    require(user and valid, 'Incorrect username or password.', 401)
    db.execute('DELETE FROM sessions WHERE session_id=%s OR expiry_date<=now()', (session_id(request),))
    sid = db.execute('INSERT INTO sessions(user_id) VALUES (%s) RETURNING session_id', (user['user_id'],)).fetchone()['session_id']
    db.commit()
    response.set_cookie(COOKIE, str(sid), max_age=7*24*60*60, httponly=True, samesite='strict',
                        secure=os.getenv('COOKIE_SECURE', 'false').lower() == 'true', path='/')
    return session_view(user)


@router.delete('')
def sign_out(request: Request, response: Response, db: DB):
    db.execute('DELETE FROM sessions WHERE session_id=%s', (session_id(request),))
    db.commit()
    response.delete_cookie(COOKIE, path='/')
    return {'applied': True}
