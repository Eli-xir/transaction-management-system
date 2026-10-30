"""Personal amounts owed by the administrator; only payments move company cash."""
from decimal import Decimal


def remaining(db, user_id, excluding=None):
    return db.execute('''SELECT COALESCE(sum(CASE v.transaction_type_id
        WHEN 2 THEN v.transaction_amount WHEN 3 THEN -v.transaction_amount ELSE 0 END),0) AS amount
        FROM transactions t JOIN transaction_versions v ON v.version_id=t.current_version_id
        WHERE t.user_id=%s AND t.is_active AND (%s::integer IS NULL OR t.transaction_id<>%s)''',
        (user_id, excluding, excluding)).fetchone()['amount']


def checked_input(db, actor, user_id, value, kind):
    from service import require, validate_input
    require(value, 'Enter the transaction details.')
    require(value.headId is None, 'Admin payable entries are direct and cannot have a head.')
    require(value.amount > 0, 'Enter an amount greater than zero.')
    require(value.transactionTypeId in (1, kind), 'The transaction type cannot be changed.')
    ids = validate_input(db, actor, value, user_id, direct=True, allow_personal=True)
    return value.model_copy(update={'transactionTypeId': kind}), ids


def record(db, actor, user_id, value, payment=False):
    from service import admin, account, require, revise, ledger
    admin(actor)
    user = account(db, user_id, field=True)
    require(user['is_active'], 'Reactivate this user before recording an entry.')
    kind = 3 if payment else 2
    value, ids = checked_input(db, actor, user_id, value, kind)
    if payment:
        require(value.amount <= remaining(db, user_id), 'The payment exceeds the remaining Admin payable amount.')
    creator = actor['user_id'] if payment else user_id
    entry = db.execute('''INSERT INTO transactions(head_id,category_group_id,user_id,created_by_user_id,current_version_id)
        VALUES (NULL,NULL,%s,%s,0) RETURNING *''', (user_id, creator)).fetchone()
    revise(db, entry, actor['user_id'], 'Admin payable paid' if payment else 'Admin payable added', value, ids)
    return ledger(db, user_id, transaction_id=entry['transaction_id'])[0]


def change(db, actor, entry, value):
    from service import require, revise, ledger
    old = db.execute('SELECT * FROM transaction_versions WHERE version_id=%s', (entry['current_version_id'],)).fetchone()
    kind = old['transaction_type_id']
    require(value.contractId is None, 'Admin payable cannot be assigned to a contract.')
    proposed, ids = (checked_input(db, actor, entry['user_id'], value.input, kind)
                     if value.action == 'edit' else (None, None))
    active = entry['is_active'] if value.action == 'edit' else value.action == 'reactivate'
    amount = proposed.amount if proposed else old['transaction_amount']
    net = remaining(db, entry['user_id'], entry['transaction_id'])
    net += (amount if kind == 2 else -amount) if active else Decimal(0)
    require(net >= 0, 'This change would leave Admin payable payments above the amount owed. Adjust the payments first.')
    if value.action == 'delete':
        db.execute('DELETE FROM transactions WHERE transaction_id=%s', (entry['transaction_id'],))
        return None
    entry['is_active'] = active
    revise(db, entry, actor['user_id'], 'Edited' if proposed else 'Reactivated' if active else 'Deactivated', proposed, ids)
    return ledger(db, entry['user_id'], transaction_id=entry['transaction_id'])[0]
