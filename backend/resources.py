"""Resource API. Routes authorize, validate and delegate to existing accounting rules.

The legacy /changes adapter uses the same rules and lock/commit boundaries.
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Query, Request, Response

from api_dependencies import DB, Reader, Writer
from commands import execute
from contracts import change_contract, list_contracts
from models import (
    ContractChange, ContractInput, CreditUserChange, HeadsChange, HomeOrderChange,
    PermissionsChange, Profile, TransactionChange, UserChange,
)
from resource_models import (
    ContractStatus, CreateCredit, CreateTransaction, CreateUser, EditTransaction,
    HeadBatch, HomeOrder, Permissions, RecordId, Revision, SetActive, SetPassword,
    SetPinned, TransactionStatus,
)
from queries import external_users, one, permission_rules, users
from responses import (UserResource, ExternalUserResource, ContractResource, TransactionResource,
                       TransactionPage, SubmissionResource)
from receipts import EditReceipt, edit as edit_receipt
from service import admin, change_credit_user, heads, ledger, overview, require, state, record_user_bill

router = APIRouter(prefix='/api')


@router.put('/receipts/{receipt_id}/allocations', response_model=TransactionResource, tags=['External receipts'])
def receipt_allocations(receipt_id: RecordId, value: EditReceipt, db: DB, actor: Writer):
    return edit_receipt(db, actor, receipt_id, value)


def own_account(actor, user_id):
    require(actor['user_role_id'] == 1 or actor['user_id'] == user_id,
            'You can only view your own ledger.', 403)


@router.get('/users', response_model=list[UserResource], tags=['Users'])
def list_users(db: DB, actor: Reader):
    admin(actor)
    return users(db)


@router.get('/users/{user_id}', response_model=UserResource, tags=['Users'])
def read_user(user_id: UUID, db: DB, actor: Reader):
    own_account(actor, user_id)
    if actor['user_role_id'] != 1:
        # Match the existing regular-user snapshot: own minimal profile, no
        # contact directory and no password/session fields.
        return {'user_id': str(actor['user_id']), 'user_name': actor['user_name'],
                'description': actor.get('description', ''), 'is_active': actor['is_active'],
                'is_pinned': actor.get('is_pinned', False), 'role': 'user', 'contacts': []}
    return one(users(db, user_id), 'user_id', user_id, 'This user no longer exists.')


@router.get('/permissions', response_model=dict[str, dict[str, list[int]]], tags=['Permissions'])
def list_permissions(db: DB, actor: Reader):
    admin(actor)
    return {'permissions': permission_rules(db)}


@router.get('/transaction-types', response_model=list[dict], tags=['Transactions'])
def transaction_types(actor: Reader):
    return [{'id': 1, 'name': 'General'}]


@router.get('/users/{user_id}/overview', tags=['Users'])
def user_overview(user_id: UUID, db: DB, actor: Reader):
    own_account(actor, user_id)
    return overview(db, user_id)


@router.post('/users', status_code=201, response_model=UserResource, tags=['Users'])
def create_user(value: CreateUser, request: Request, db: DB, actor: Writer):
    return execute(db, actor, UserChange(op='user', action='create', **value.model_dump()), request)['user']


def update_user(db, actor, request, user_id, action, **fields):
    result = execute(db, actor, UserChange(op='user', action=action, userId=user_id, **fields), request)
    return one(result['users'], 'user_id', user_id, 'This user no longer exists.')


@router.put('/users/{user_id}/profile', response_model=UserResource, tags=['Users'])
def user_profile(user_id: UUID, value: Profile, request: Request, db: DB, actor: Writer):
    return update_user(db, actor, request, user_id, 'profile', profile=value)


@router.put('/users/{user_id}/password', status_code=204, tags=['Users'])
def user_password(user_id: UUID, value: SetPassword, request: Request, db: DB, actor: Writer):
    execute(db, actor, UserChange(op='user', action='password', userId=user_id, password=value.password), request)
    return Response(status_code=204)


@router.put('/users/{user_id}/status', response_model=UserResource, tags=['Users'])
def user_status(user_id: UUID, value: SetActive, request: Request, db: DB, actor: Writer):
    return update_user(db, actor, request, user_id, 'reactivate' if value.active else 'deactivate')


@router.put('/users/{user_id}/pin', response_model=UserResource, tags=['Users'])
def user_pin(user_id: UUID, value: SetPinned, request: Request, db: DB, actor: Writer):
    return update_user(db, actor, request, user_id, 'pin' if value.pinned else 'unpin')


@router.delete('/users/{user_id}', status_code=204, tags=['Users'])
def delete_user(user_id: UUID, request: Request, db: DB, actor: Writer):
    execute(db, actor, UserChange(op='user', action='delete', userId=user_id), request)
    return Response(status_code=204)


@router.get('/users/{user_id}/permissions', tags=['Permissions'])
def read_permissions(user_id: UUID, db: DB, actor: Reader):
    own_account(actor, user_id)
    # Regular users receive effective rules, exactly as in /state.
    result = state(db, actor)
    require(any(u['user_id'] == str(user_id) for u in result['users']), 'This user no longer exists.', 404)
    return {'userId': str(user_id), 'ids': result['permissions'].get(str(user_id), [])}


@router.put('/users/{user_id}/permissions', tags=['Permissions'])
def set_permissions(user_id: UUID, value: Permissions, request: Request, db: DB, actor: Writer):
    result = execute(db, actor, PermissionsChange(op='permissions', userId=user_id, ids=value.ids), request)
    return {'userId': str(user_id), 'ids': result['permissions'].get(str(user_id), [])}


@router.get('/external-users', response_model=list[ExternalUserResource], tags=['External users'])
def list_external_users(db: DB, actor: Reader):
    admin(actor)
    return external_users(db)


@router.get('/external-users/{user_id}', response_model=ExternalUserResource, tags=['External users'])
def read_external_user(user_id: UUID, db: DB, actor: Reader):
    admin(actor)
    return one(external_users(db, user_id), 'credit_user_id', user_id, 'This external user no longer exists.')


def save_external(db, actor, action, user_id=None, **fields):
    saved_id = change_credit_user(db, actor, CreditUserChange(op='creditUser', action=action, creditUserId=user_id, **fields))
    result = None if action == 'delete' else one(external_users(db, saved_id), 'credit_user_id', saved_id, 'This external user no longer exists.')
    db.commit()
    return result


@router.post('/external-users', status_code=201, response_model=ExternalUserResource, tags=['External users'])
def create_external_user(value: Profile, db: DB, actor: Writer):
    return save_external(db, actor, 'create', profile=value)


@router.put('/external-users/{user_id}/profile', response_model=ExternalUserResource, tags=['External users'])
def external_profile(user_id: UUID, value: Profile, db: DB, actor: Writer):
    return save_external(db, actor, 'edit', user_id, profile=value)


@router.put('/external-users/{user_id}/status', response_model=ExternalUserResource, tags=['External users'])
def external_status(user_id: UUID, value: SetActive, db: DB, actor: Writer):
    return save_external(db, actor, 'reactivate' if value.active else 'deactivate', user_id)


@router.put('/external-users/{user_id}/pin', response_model=ExternalUserResource, tags=['External users'])
def external_pin(user_id: UUID, value: SetPinned, db: DB, actor: Writer):
    return save_external(db, actor, 'pin', user_id, pinned=value.pinned)


@router.delete('/external-users/{user_id}', status_code=204, tags=['External users'])
def delete_external_user(user_id: UUID, db: DB, actor: Writer):
    save_external(db, actor, 'delete', user_id)
    return Response(status_code=204)


@router.get('/contracts', response_model=list[ContractResource], tags=['Contracts'])
def read_contracts(db: DB, actor: Reader):
    admin(actor)
    return list_contracts(db)


@router.get('/contracts/{contract_id}', response_model=ContractResource, tags=['Contracts'])
def read_contract(contract_id: UUID, db: DB, actor: Reader):
    admin(actor)
    return one(list_contracts(db), 'id', contract_id, 'This contract no longer exists.')


def save_contract(db, actor, action, contract_id=None, revision=None, value=None):
    saved_id = change_contract(db, actor, ContractChange(op='contract', action=action,
        contractId=contract_id, expectedRevision=revision, input=value))
    result = None if action == 'delete' else one(list_contracts(db), 'id', saved_id, 'This contract no longer exists.')
    db.commit()
    return result


@router.post('/contracts', status_code=201, response_model=ContractResource, tags=['Contracts'])
def create_contract(value: ContractInput, db: DB, actor: Writer):
    return save_contract(db, actor, 'create', value=value)


@router.put('/contracts/{contract_id}', response_model=ContractResource, tags=['Contracts'])
def edit_contract(contract_id: UUID, value: ContractInput, expectedRevision: Annotated[Revision, Query()], db: DB, actor: Writer):
    return save_contract(db, actor, 'edit', contract_id, expectedRevision, value)


@router.put('/contracts/{contract_id}/status', response_model=ContractResource, tags=['Contracts'])
def contract_status(contract_id: UUID, value: ContractStatus, db: DB, actor: Writer):
    return save_contract(db, actor, 'reactivate' if value.active else 'archive', contract_id, value.expectedRevision)


@router.delete('/contracts/{contract_id}', status_code=204, tags=['Contracts'])
def delete_contract(contract_id: UUID, expectedRevision: Annotated[Revision, Query()], db: DB, actor: Writer):
    save_contract(db, actor, 'delete', contract_id, expectedRevision)
    return Response(status_code=204)


@router.get('/transactions', response_model=TransactionPage, response_model_exclude_unset=True, tags=['Transactions'])
def read_transactions(db: DB, actor: Reader, userId: UUID | None = None,
                      limit: Annotated[int, Query(ge=1, le=500)] = 100,
                      offset: Annotated[int, Query(ge=0, le=2147483647)] = 0):
    if actor['user_role_id'] != 1:
        own_account(actor, userId or actor['user_id'])
        entries = ledger(db, actor['user_id'], credits_only=True, limit=limit+1, offset=offset)
    else:
        entries = ledger(db, userId, limit=limit+1, offset=offset)
    return {'items': entries[:limit], 'limit': limit, 'offset': offset,
            'nextOffset': offset+limit if len(entries) > limit else None}


@router.get('/transactions/{transaction_id}', response_model=TransactionResource, response_model_exclude_unset=True, tags=['Transactions'])
def read_transaction(transaction_id: RecordId, db: DB, actor: Reader):
    # Filtering precedes serialization: regular users never see submitted bills/history.
    entries = ledger(db, transaction_id=transaction_id) if actor['user_role_id'] == 1 else ledger(
        db, actor['user_id'], credits_only=True, transaction_id=transaction_id)
    return one(entries, 'id', transaction_id, 'This transaction no longer exists.')


@router.post('/transactions/bills', status_code=201, response_model=SubmissionResource, tags=['Transactions'])
def submit_bill(value: CreateTransaction, request: Request, db: DB, actor: Writer):
    return execute(db, actor, TransactionChange(op='transaction', action='submit', userId=actor['user_id'], input=value.input), request)


@router.post('/transactions/credits', status_code=201, response_model=TransactionResource, tags=['Transactions'])
def create_credit(value: CreateCredit, request: Request, db: DB, actor: Writer):
    return execute(db, actor, TransactionChange(op='transaction', action='credit', **value.model_dump()), request)


@router.post('/users/{user_id}/bills', status_code=201, response_model=TransactionResource, tags=['Transactions'])
def record_bill_for_user(user_id: UUID, value: CreateTransaction, db: DB, actor: Writer):
    """Admin-only bill entry for an active normal user, using their assigned heads."""
    result = record_user_bill(db, actor, user_id, value.input)
    db.commit()
    return result


@router.post('/users/{user_id}/admin-payable', status_code=201, response_model=TransactionResource, tags=['Admin payable'])
def add_admin_payable(user_id: UUID, value: CreateTransaction, db: DB, actor: Writer):
    from personal_payable import record
    result = record(db, actor, user_id, value.input)
    db.commit()
    return result


@router.post('/users/{user_id}/admin-payable/payments', status_code=201, response_model=TransactionResource, tags=['Admin payable'])
def pay_admin_payable(user_id: UUID, value: CreateTransaction, db: DB, actor: Writer):
    from personal_payable import record
    result = record(db, actor, user_id, value.input, payment=True)
    db.commit()
    return result


@router.put('/transactions/{transaction_id}', response_model=TransactionResource, tags=['Transactions'])
def edit_transaction(transaction_id: RecordId, value: EditTransaction, request: Request, db: DB, actor: Writer):
    return execute(db, actor, TransactionChange(op='transaction', action='edit', id=transaction_id, **value.model_dump()), request)


@router.put('/transactions/{transaction_id}/status', response_model=TransactionResource, tags=['Transactions'])
def transaction_status(transaction_id: RecordId, value: TransactionStatus, request: Request, db: DB, actor: Writer):
    return execute(db, actor, TransactionChange(op='transaction', action='reactivate' if value.active else 'deactivate',
        id=transaction_id, expectedVersion=value.expectedVersion), request)


@router.delete('/transactions/{transaction_id}', status_code=204, tags=['Transactions'])
def delete_transaction(transaction_id: RecordId, expectedVersion: Annotated[RecordId, Query()], request: Request, db: DB, actor: Writer):
    execute(db, actor, TransactionChange(op='transaction', action='delete', id=transaction_id, expectedVersion=expectedVersion), request)
    return Response(status_code=204)


@router.get('/heads', tags=['Heads'])
def read_heads(db: DB, actor: Reader):
    visible = heads(db) if actor['user_role_id'] == 1 else state(db, actor)['heads']
    return {'heads': visible, 'revision': db.execute('SELECT revision FROM head_revision').fetchone()['revision']}


@router.post('/heads/batch', tags=['Heads'])
def change_heads(value: HeadBatch, request: Request, db: DB, actor: Writer):
    # A tree draft needs one atomic batch so moves/merges/temp IDs and undo stay coherent.
    result = execute(db, actor, HeadsChange(op='heads', **value.model_dump()), request)
    return {'heads': result['heads'], 'revision': result['headRevision']}


@router.get('/preferences/home-order', tags=['Preferences'])
def read_home_order(actor: Reader):
    admin(actor)
    return {'homeOrder': actor.get('home_order', [])}


@router.put('/preferences/home-order', tags=['Preferences'])
def save_home_order(value: HomeOrder, request: Request, db: DB, actor: Writer):
    return execute(db, actor, HomeOrderChange(op='homeOrder', ids=value.ids), request)
