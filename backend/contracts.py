"""Contract totals are shared by all linked payers; attribution is saved in receipt versions."""
from fastapi import HTTPException


def require(condition, message, status=400):
    if not condition:
        raise HTTPException(status, message)


def received(db, contract_id, excluding=None):
    return db.execute('''SELECT COALESCE(sum(v.transaction_amount),0) AS amount
        FROM transactions t JOIN transaction_versions v ON v.version_id=t.current_version_id
        WHERE t.contract_id=%s AND t.is_active AND (%s::bigint IS NULL OR t.transaction_id<>%s)''',
        (contract_id, excluding, excluding)).fetchone()['amount']


def validate_receipt(db, contract_id, payer_id, amount, excluding=None):
    contract = db.execute('SELECT * FROM contracts WHERE contract_id=%s FOR UPDATE', (contract_id,)).fetchone()
    require(contract, 'This contract no longer exists.', 404)
    require(contract['is_active'], 'Reactivate this contract before recording a receipt.')
    require(db.execute('SELECT 1 FROM contract_users WHERE contract_id=%s AND credit_user_id=%s',
                       (contract_id, payer_id)).fetchone(), 'This external user is not linked to the contract.')
    require(amount > 0, 'Enter a receipt amount greater than zero.')
    remaining = contract['total_amount'] - received(db, contract_id, excluding)
    require(amount <= remaining, f'The receipt exceeds this contract’s remaining amount (PKR {remaining:,.2f}). Refresh and try again.')


def list_contracts(db):
    links = db.execute('SELECT * FROM contract_users ORDER BY credit_user_id').fetchall()
    return [{'id': str(row['contract_id']), 'name': row['name'], 'description': row['description'],
             'totalAmount': float(row['total_amount']), 'isActive': row['is_active'], 'revision': row['revision'],
             'creditUserIds': [str(link['credit_user_id']) for link in links if link['contract_id'] == row['contract_id']]}
            for row in db.execute('SELECT * FROM contracts ORDER BY name,contract_id').fetchall()]


def change_contract(db, actor, change):
    require(actor['user_role_id'] == 1, 'Admin access is required.', 403)
    creating = change.action == 'create'
    contract_id = change.contractId
    contract = None
    if not creating:
        contract = db.execute('SELECT * FROM contracts WHERE contract_id=%s FOR UPDATE', (change.contractId,)).fetchone()
        require(contract, 'This contract no longer exists.', 404)
        require(contract['revision'] == change.expectedRevision, 'This contract changed. Refresh before editing it.', 409)
    if change.action in ('create', 'edit'):
        value = change.input
        require(value, 'Enter the contract details.')
        ids = list(dict.fromkeys(value.creditUserIds))
        existing = set() if creating else {r['credit_user_id'] for r in db.execute(
            'SELECT credit_user_id FROM contract_users WHERE contract_id=%s', (change.contractId,)).fetchall()}
        users = db.execute('SELECT credit_user_id,is_active FROM credit_users WHERE credit_user_id=ANY(%s) FOR SHARE', (ids,)).fetchall()
        require(len(users) == len(ids), 'One of the external users no longer exists.')
        require(all(u['is_active'] or u['credit_user_id'] in existing for u in users), 'Only active external users can be newly linked.')
        if creating:
            contract_id = db.execute('INSERT INTO contracts(name,description,total_amount) VALUES (%s,%s,%s) RETURNING contract_id',
                                    (value.name, value.description, value.totalAmount)).fetchone()['contract_id']
        else:
            contract_id = change.contractId
            require(value.totalAmount >= received(db, contract_id), 'The contract amount cannot be less than payments already received.')
            removed = list(existing - set(ids))
            require(not db.execute('SELECT 1 FROM transactions WHERE contract_id=%s AND credit_user_id=ANY(%s) LIMIT 1',
                                   (contract_id, removed)).fetchone(), 'A user with receipt history cannot be unlinked. Keep them linked to preserve the statement.')
            db.execute('DELETE FROM contract_users WHERE contract_id=%s AND credit_user_id=ANY(%s)', (contract_id, removed))
            db.execute('UPDATE contracts SET name=%s,description=%s,total_amount=%s,revision=revision+1 WHERE contract_id=%s',
                       (value.name, value.description, value.totalAmount, contract_id))
        for user_id in ids:
            db.execute('INSERT INTO contract_users VALUES (%s,%s) ON CONFLICT DO NOTHING', (contract_id, user_id))
    elif change.action == 'delete':
        require(not db.execute('SELECT 1 FROM transactions WHERE contract_id=%s LIMIT 1', (change.contractId,)).fetchone(),
                'This contract has receipt history. Archive it instead.')
        db.execute('DELETE FROM contract_users WHERE contract_id=%s', (change.contractId,))
        db.execute('DELETE FROM contracts WHERE contract_id=%s', (change.contractId,))
    else:
        db.execute('UPDATE contracts SET is_active=%s,revision=revision+1 WHERE contract_id=%s',
                   (change.action == 'reactivate', change.contractId))
    return contract_id
