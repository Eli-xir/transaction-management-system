"""Versioned attribution of external receipts and compensating cash returns.

Callers hold the resource Writer lock. Allocation edits and returns additionally
lock their original receipt and check its version, so stale screens cannot spend
the same unallocated money twice.
"""
from decimal import Decimal
import secrets
import string
from typing import Literal
from uuid import UUID

from pydantic import Field

from models import Model, RecordId, TransactionInput


class Allocation(Model):
    kind: Literal['contract', 'profit']
    contractId: UUID | None = None
    amount: Decimal = Field(gt=0, le=999999999999.99, max_digits=18, decimal_places=2, allow_inf_nan=False)


class EditReceipt(Model):
    expectedVersion: RecordId
    input: TransactionInput
    allocations: list[Allocation] = Field(max_length=200)


def allocations(db, version_id):
    return db.execute('SELECT * FROM receipt_allocations WHERE version_id=%s ORDER BY position', (version_id,)).fetchall()


def metadata(db, entry):
    if not entry.get('credit_user_id'):
        return entry
    row = db.execute("SELECT * FROM receipt_allocations WHERE transaction_id=%s AND kind IN ('receipt','return')", (entry['transaction_id'],)).fetchone()
    if row:
        entry.update(receipt_key=row['receipt_key'], receipt_parent_id=row['parent_receipt_id'])
    return entry


def register(db, entry, parent_id=None):
    if parent_id:
        db.execute("INSERT INTO receipt_allocations(transaction_id,kind,parent_receipt_id) VALUES (%s,'return',%s)", (entry['transaction_id'], parent_id))
        entry['receipt_parent_id'] = parent_id
    else:
        while True:
            key = ''.join(secrets.choice(string.ascii_uppercase + string.digits) for _ in range(8))
            if not db.execute('SELECT 1 FROM receipt_allocations WHERE receipt_key=%s', (key,)).fetchone():
                break
        db.execute("INSERT INTO receipt_allocations(transaction_id,kind,receipt_key) VALUES (%s,'receipt',%s)", (entry['transaction_id'], key))
        entry['receipt_key'] = key


def returned(db, receipt_id, excluding=None):
    return db.execute('''SELECT COALESCE(sum(v.transaction_amount),0) AS amount
        FROM transactions t JOIN transaction_versions v ON v.version_id=t.current_version_id
        JOIN receipt_allocations r ON r.transaction_id=t.transaction_id AND r.kind='return'
        WHERE r.parent_receipt_id=%s AND t.is_active
        AND (%s::integer IS NULL OR t.transaction_id<>%s)''', (receipt_id, excluding, excluding)).fetchone()['amount']


def copy_allocations(db, entry, version_id, amount, values=None):
    """Every version carries an allocation snapshot, including status changes."""
    from service import require
    if not entry.get('credit_user_id') or entry.get('receipt_parent_id'):
        return
    if values is None:
        values = allocations(db, entry['current_version_id']) if entry['current_version_id'] else []
        if not entry['current_version_id'] and entry.get('contract_id'):
            name = db.execute('SELECT name FROM contracts WHERE contract_id=%s', (entry['contract_id'],)).fetchone()['name']
            values = [dict(kind='contract', contract_id=entry['contract_id'], contract_name=name, amount=amount)]
    require(sum((v['amount'] for v in values), Decimal(0)) + returned(db, entry['transaction_id']) <= amount,
            'Allocations and returns exceed the receipt amount. Reduce the allocations first.')
    for index, value in enumerate(values):
        db.execute('INSERT INTO receipt_allocations(transaction_id,version_id,position,kind,contract_id,contract_name,amount) VALUES (%s,%s,%s,%s,%s,%s,%s)',
                   (entry['transaction_id'], version_id, index, value['kind'], value['contract_id'], value['contract_name'], value['amount']))


def original(db, actor, receipt_id, expected):
    from service import admin, require
    admin(actor)
    entry = db.execute('SELECT * FROM transactions WHERE transaction_id=%s FOR UPDATE', (receipt_id,)).fetchone()
    if entry:
        metadata(db, entry)
    require(entry and entry.get('credit_user_id') and entry.get('receipt_key') and not entry.get('receipt_parent_id'), 'Choose an external-user receipt.', 404)
    require(entry['current_version_id'] == expected, 'This receipt changed. Close and reopen it before continuing.', 409)
    return entry


def edit(db, actor, receipt_id, value):
    from service import ledger, require, revise, validate_input
    from contracts import validate_receipt
    entry = original(db, actor, receipt_id, value.expectedVersion)
    ids = validate_input(db, actor, value.input, entry['user_id'], direct=True)
    rows, seen = [], set()
    old_rows = allocations(db, entry['current_version_id'])
    old_contract_amounts = {r['contract_id']: r['amount'] for r in old_rows if r['contract_id']}
    for allocation in value.allocations:
        require((allocation.kind == 'contract') == (allocation.contractId is not None), 'Choose a contract for each contract allocation.')
        key = (allocation.kind, allocation.contractId)
        require(key not in seen, 'Combine amounts for the same contract or company profit into one allocation.')
        seen.add(key)
        name = ''
        if allocation.contractId:
            # Archived existing attributions may be retained, but not newly assigned.
            validate_receipt(db, allocation.contractId, entry['credit_user_id'], allocation.amount,
                             allow_archived=allocation.amount <= old_contract_amounts.get(allocation.contractId, Decimal(0)))
            name = db.execute('SELECT name FROM contracts WHERE contract_id=%s', (allocation.contractId,)).fetchone()['name']
        rows.append(dict(kind=allocation.kind, contract_id=allocation.contractId, contract_name=name, amount=allocation.amount))
    require(entry['is_active'] or [(r['kind'], r['contract_id'], r['amount']) for r in rows] == [(r['kind'], r['contract_id'], r['amount']) for r in old_rows],
            'Reactivate this receipt before changing its allocations.')
    # The legacy field is only meaningful for a receipt allocated entirely to one contract.
    entry['contract_id'] = rows[0]['contract_id'] if len(rows) == 1 and rows[0]['kind'] == 'contract' and rows[0]['amount'] == value.input.amount else None
    revise(db, entry, actor['user_id'], 'Receipt and allocations edited', value.input, ids, allocation_values=rows)
    result = ledger(db, transaction_id=receipt_id)[0]
    db.commit()
    return result


def guard_change(db, entry, change):
    """Returns are immutable compensating entries; their status remains auditable."""
    from service import require
    if entry.get('receipt_parent_id'):
        require(change.action in ('deactivate', 'reactivate'), 'Return entries cannot be edited or deleted. Deactivate an incorrect return instead.')
        if change.action == 'reactivate':
            parent = db.execute('SELECT * FROM transactions WHERE transaction_id=%s FOR UPDATE', (entry['receipt_parent_id'],)).fetchone()
            require(parent['is_active'], 'Reactivate the original receipt first.')
            amount = db.execute('SELECT transaction_amount FROM transaction_versions WHERE version_id=%s', (parent['current_version_id'],)).fetchone()['transaction_amount']
            child_amount = db.execute('SELECT transaction_amount FROM transaction_versions WHERE version_id=%s', (entry['current_version_id'],)).fetchone()['transaction_amount']
            require(sum((r['amount'] for r in allocations(db, parent['current_version_id'])), Decimal(0)) + returned(db, parent['transaction_id'], entry['transaction_id']) + child_amount <= amount,
                    'This return exceeds the receipt’s available unallocated money.')
    else:
        if change.action == 'reactivate':
            from contracts import validate_receipt
            for allocation in allocations(db, entry['current_version_id']):
                if allocation['contract_id']:
                    validate_receipt(db, allocation['contract_id'], entry['credit_user_id'], allocation['amount'])
        if change.action in ('delete', 'deactivate'):
            require(not returned(db, entry['transaction_id']), 'Deactivate the linked returns before deactivating this receipt.')
        if change.action == 'delete':
            require(not db.execute("SELECT 1 FROM receipt_allocations WHERE parent_receipt_id=%s AND kind='return'", (entry['transaction_id'],)).fetchone(),
                    'This receipt has return history. Deactivate it instead.')
