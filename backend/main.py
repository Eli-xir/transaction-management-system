"""Cashbook application composition. Run: uvicorn main:app --reload."""
import logging
from contextlib import asynccontextmanager
from uuid import UUID, uuid4

import psycopg
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from api_dependencies import DB, Reader, Writer, database, authenticated, session_id
from attachments import router as attachment_router, download_attachment, export_attachments
from auth import router as session_router
from commands import execute
from db import initialize
from models import Change
from resources import router as resource_router
from service import overview, require, state

logger = logging.getLogger('cashbook.api')


@asynccontextmanager
async def lifespan(app):
    initialize()
    yield


app = FastAPI(title='Cashbook API', version='2.0.0', lifespan=lifespan,
              description='Resource APIs with a compatibility adapter for existing Cashbook clients.')


@app.middleware('http')
async def request_policy(request: Request, call_next):
    request.state.request_id = uuid4().hex
    mutating = request.method not in ('GET', 'HEAD', 'OPTIONS')
    if mutating and (request.headers.get('x-cashbook') != '1'
                     or request.headers.get('sec-fetch-site') == 'cross-site'):
        response = JSONResponse({'detail': 'Use the Cashbook application to make changes.'}, status_code=403)
    else:
        try:
            response = await call_next(request)
        except Exception:
            # No bodies, credentials, cookies or query strings are logged.
            logger.exception('Unhandled API error request_id=%s method=%s path=%s',
                             request.state.request_id, request.method, request.url.path)
            response = JSONResponse({'detail': 'Something went wrong. Please try again in a moment.'}, status_code=500)
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Request-ID'] = request.state.request_id
    snapshot = getattr(request.state, 'resource_snapshot', None)
    if snapshot is not None:
        response.headers['X-Cashbook-Snapshot'] = snapshot
    return response


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    # Validation errors can contain passwords. Keep detail/msg compatibility
    # without echoing any submitted input values.
    return JSONResponse({'detail': [{'loc': item['loc'], 'msg': item['msg'], 'type': item['type']}
                                    for item in error.errors()]}, status_code=422)


@app.exception_handler(psycopg.IntegrityError)
async def constraint_error(request, error):
    messages = {'unique_active_username': 'An active user already has that name.',
                'unique_live_sibling_head_name': 'A head with that name already exists under this parent.',
                'unique_live_head_name': 'A head with that name already exists.',
                'category_groups_category_group_name_key': 'That category already exists.'}
    return JSONResponse({'detail': messages.get(error.diag.constraint_name,
        'This change conflicts with existing records. Refresh and try again.')}, status_code=409)


@app.exception_handler(psycopg.OperationalError)
async def database_error(request, error):
    logger.error('Database unavailable request_id=%s', request.state.request_id)
    return JSONResponse({'detail': 'The service is temporarily unavailable. Please try again in a moment.'}, status_code=503)


@app.get('/api/state', tags=['Compatibility'])
def read_state(db: DB, actor: Reader, userId: UUID | None = None):
    """Existing frontend snapshot kept intact while resource APIs are introduced."""
    if userId is not None:
        require(actor['user_role_id'] == 1 or actor['user_id'] == userId, 'You can only view your own ledger.', 403)
        return overview(db, userId)
    return state(db, actor)


@app.post('/api/changes', tags=['Compatibility'])
def changes(value: Change, request: Request, db: DB, actor: Writer):
    """Legacy commands share resource rules, locks and commit boundaries."""
    return execute(db, actor, value, request)


app.include_router(session_router)
app.include_router(resource_router)
app.include_router(attachment_router)
