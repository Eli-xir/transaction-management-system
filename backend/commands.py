"""One commit boundary for both resource routes and the legacy command adapter."""
from api_dependencies import session_id
from service import apply_change


def execute(db, actor, value, request):
    result = apply_change(db, actor, value, session_id(request))
    # In particular, deferred transaction/version constraints must pass before 2xx.
    db.commit()
    return result
