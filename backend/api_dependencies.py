"""Shared request transaction and authorization dependencies.

Lock before authentication so queued requests cannot act on a revoked session.
Keep the existing lock protocol until every writer can use finer-grained locks.
"""
from typing import Annotated
from uuid import UUID

import psycopg
from fastapi import Depends, HTTPException, Request

from db import connect
from service import require

COOKIE = 'cashbook_session'
LEDGER_LOCK = 724002


def database():
    # Commit/rollback and close BEFORE sending the response, including auth routes.
    with connect() as db:
        yield db


DB = Annotated[psycopg.Connection, Depends(database, scope='function')]


def session_id(request: Request):
    try:
        return UUID(request.cookies.get(COOKIE, ''))
    except (ValueError, TypeError):
        return None


def session_user(db, request: Request):
    return db.execute('''SELECT u.* FROM sessions s JOIN users u USING(user_id)
        WHERE s.session_id=%s AND s.expiry_date>now() AND u.is_active''', (session_id(request),)).fetchone()


def authenticated(request: Request, db: DB):
    actor = session_user(db, request)
    require(actor, 'Your session expired. Please log in again.', 401)
    return actor


Actor = Annotated[dict, Depends(authenticated)]


def reader(request: Request, db: DB):
    db.execute('SELECT pg_advisory_xact_lock_shared(%s)', (LEDGER_LOCK,))
    actor = authenticated(request, db)
    # Resource requests may span several pages/endpoints. Read-only transactions
    # do not allocate XIDs; any intervening committed writer changes this token.
    # Binding it to the actor also prevents combining data from different logins.
    snapshot = db.execute('SELECT pg_current_snapshot()::text AS snapshot').fetchone()['snapshot']
    request.state.resource_snapshot = f"{actor['user_id']}:{snapshot}"
    expected = request.headers.get('x-cashbook-snapshot')
    if expected is not None and expected != request.state.resource_snapshot:
        raise HTTPException(409, 'The cashbook changed while loading. Please refresh and try again.',
                            headers={'X-Cashbook-Retry-Read': '1'})
    return actor


def writer(request: Request, db: DB):
    db.execute('SELECT pg_advisory_xact_lock(%s)', (LEDGER_LOCK,))
    return authenticated(request, db)


Reader = Annotated[dict, Depends(reader)]
Writer = Annotated[dict, Depends(writer)]
