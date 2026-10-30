"""Cashbook rules. All mutations run in the caller's database transaction."""
import re

from fastapi import HTTPException

from db import password_hash
from contracts import change_contract, list_contracts, validate_receipt


def require(condition, message, status=400):
    if not condition:
        raise HTTPException(status, message)


def admin(actor):
    require(actor['user_role_id'] == 1, 'Admin access is required.', 403)


def account(db, user_id, field=False):
    row = db.execute('SELECT * FROM users WHERE user_id=%s', (user_id,)).fetchone()
    require(row, 'This user no longer exists.', 404)
    require(not field or row['user_role_id'] != 1, 'This action does not apply to the admin.')
    return row


def attachment(row):
    return {'id': str(row['attachment_id']), 'kind': 'image' if row['attachment_type_id'] == 1 else 'voice',
            'name': row['original_name'], 'url': f"/api/attachments/{row['attachment_id']}"}


def heads(db):
    rows = db.execute('SELECT * FROM heads WHERE NOT is_deleted ORDER BY head_id').fetchall()
    return [{**{k: v for k, v in row.items() if k != 'is_deleted'},
             'image_url': f"/api/attachments/{row['attachment_id']}" if row['attachment_id'] else None} for row in rows]


def effective_permissions(tree, rules):
    by_id = {h['head_id']: h for h in tree}
    decisions = {abs(i): i > 0 for i in rules}
    result = set()
    for head in tree:
        cursor, seen = head['head_id'], set()
        while cursor in by_id and cursor not in seen:
            seen.add(cursor)
            if cursor in decisions:
                if decisions[cursor]: result.add(head['head_id'])
                break
            cursor = by_id[cursor]['parent_head_id']
    return result


def user_permissions(db, user_id):
    rules = db.execute('SELECT head_id,allowed FROM user_head_permissions WHERE user_id=%s', (user_id,)).fetchall()
    return effective_permissions(heads(db), [r['head_id'] if r['allowed'] else -r['head_id'] for r in rules])


def path(db, head_id):
    by_id = {h['head_id']: h for h in db.execute('SELECT head_id,parent_head_id,head_name FROM heads').fetchall()}
    names, seen = [], set()
    while head_id in by_id and head_id not in seen:
        seen.add(head_id)
        node = by_id[head_id]
        names.insert(0, node['head_name'])
        head_id = node['parent_head_id']
    return ' / '.join(names)


def ledger(db, user_id=None, credits_only=False, *, limit=None, offset=0, transaction_id=None):
    conditions, params = [], []
    if user_id is not None:
        conditions.append('t.user_id=%s')
        params.append(user_id)
    if credits_only:
        conditions.append('t.created_by_user_id <> t.user_id AND t.is_active')
    if transaction_id is not None:
        conditions.append('t.transaction_id=%s')
        params.append(transaction_id)
    where = 'WHERE ' + ' AND '.join(conditions) if conditions else ''
    paging = ''
    if limit is not None:
        paging = ' LIMIT %s OFFSET %s'
        params.extend((limit, offset))
    entries = db.execute(f'''SELECT t.*, r.receipt_key, r.parent_receipt_id AS receipt_parent_id,
        parent.receipt_key AS parent_receipt_key FROM transactions t
        LEFT JOIN receipt_allocations r ON r.transaction_id=t.transaction_id AND r.kind IN ('receipt','return')
        LEFT JOIN receipt_allocations parent ON parent.transaction_id=r.parent_receipt_id AND parent.kind='receipt'
        {where} ORDER BY t.created_at,t.transaction_id{paging}''', params).fetchall()
    ids = [row['transaction_id'] for row in entries]
    refund_totals = {row['parent_receipt_id']: row['amount'] for row in db.execute('''
        SELECT r.parent_receipt_id,sum(v.transaction_amount) AS amount
        FROM receipt_allocations r JOIN transactions t ON t.transaction_id=r.transaction_id
        JOIN transaction_versions v ON v.version_id=t.current_version_id
        WHERE r.kind='return' AND t.is_active AND r.parent_receipt_id=ANY(%s)
        GROUP BY r.parent_receipt_id''', (ids,)).fetchall()}
    versions = db.execute('SELECT * FROM transaction_versions WHERE transaction_id=ANY(%s) ORDER BY version_id', (ids,)).fetchall()
    if credits_only:
        current = {row['current_version_id'] for row in entries}
        versions = [v for v in versions if v['version_id'] in current]
    media = db.execute('''SELECT va.version_id,a.* FROM transaction_version_attachments va
        JOIN attachments a USING(attachment_id) WHERE va.version_id=ANY(%s) ORDER BY a.attachment_id''',
        ([v['version_id'] for v in versions],)).fetchall()
    by_version = {}
    for row in media:
        by_version.setdefault(row['version_id'], []).append(attachment(row))
    by_entry = {}
    allocation_rows = db.execute('SELECT * FROM receipt_allocations WHERE version_id=ANY(%s) ORDER BY position',
                                 ([v['version_id'] for v in versions],)).fetchall()
    by_allocation = {}
    allocated_amounts = {}
    for a in allocation_rows:
        allocated_amounts[a['version_id']] = allocated_amounts.get(a['version_id'], 0) + a['amount']
        by_allocation.setdefault(a['version_id'], []).append(dict(kind=a['kind'], contractId=str(a['contract_id']) if a['contract_id'] else None,
                                                                  contractName=a['contract_name'], amount=float(a['amount'])))
    for v in versions:
        by_entry.setdefault(v['transaction_id'], []).append({
            'versionId': str(v['version_id']), 'recordedAt': v['created_at'].isoformat(),
            'editorId': str(v['editor_id']), 'action': v['action'], 'amount': float(v['transaction_amount']),
            'headId': v['head_id'], 'description': v['description'], 'transactionTypeId': v['transaction_type_id'],
            'active': v['is_active'], 'headPath': v['head_path'],
            'contractId': str(v['contract_id']) if v.get('contract_id') else None,
            'contractName': v.get('contract_name', ''),
            'allocations': by_allocation.get(v['version_id'], []),
            'attachments': by_version.get(v['version_id'], [])})
    result = []
    version_amounts = {v['version_id']: v['transaction_amount'] for v in versions}
    for row in entries:
        history = by_entry[row['transaction_id']]
        current = next(v for v in history if v['versionId'] == str(row['current_version_id']))
        result.append({k: v for k, v in current.items() if k not in ('versionId', 'recordedAt', 'editorId', 'action')})
        result[-1].update(id=str(row['transaction_id']), userId=str(row['user_id']), createdBy=str(row['created_by_user_id']),
                          createdAt=row['created_at'].isoformat(), headId=row['head_id'], headPath=path(db, row['head_id']),
                          active=row['is_active'], creditUserId=str(row['credit_user_id']) if row['credit_user_id'] else None,
                          contractId=str(row['contract_id']) if row.get('contract_id') else None)
        if row.get('credit_user_id'):
            parent_id = row.get('receipt_parent_id')
            key = row.get('receipt_key')
            if parent_id:
                key = row['parent_receipt_key']
            refunded = refund_totals.get(row['transaction_id'], 0) if not parent_id else 0
            result[-1].update(receiptKey=key, receiptParentId=str(parent_id) if parent_id else None,
                              returnedAmount=float(refunded), unallocatedAmount=float(version_amounts[row['current_version_id']]-allocated_amounts.get(row['current_version_id'], 0)-refunded) if not parent_id else 0)
        if not credits_only:
            result[-1]['versions'] = history
    return result


def overview(db, user_id):
    user = account(db, user_id)
    if user['user_role_id'] == 1:
        amounts = db.execute('''SELECT
            COALESCE(sum(v.transaction_amount) FILTER (WHERE t.created_by_user_id=t.user_id AND r.record_id IS NULL),0) AS credits,
            COALESCE(sum(v.transaction_amount) FILTER (WHERE t.created_by_user_id<>t.user_id OR r.record_id IS NOT NULL),0) AS debits
            FROM transactions t JOIN transaction_versions v ON v.version_id=t.current_version_id
            LEFT JOIN receipt_allocations r ON r.transaction_id=t.transaction_id AND r.kind='return'
            WHERE t.is_active AND v.transaction_type_id<>2''').fetchone()
        credits, debits = float(amounts['credits']), float(amounts['debits'])
        return {'balance': credits-debits, 'totalReceived': credits, 'totalBillPayment': debits,
                'remainingPayable': debits-credits, 'credits': []}
    # Admin may inspect a deactivated account, but it cannot log in or submit.
    amounts = db.execute('''SELECT
        COALESCE(sum(v.transaction_amount) FILTER (WHERE t.created_by_user_id<>t.user_id),0) AS received,
        COALESCE(sum(v.transaction_amount) FILTER (WHERE t.created_by_user_id=t.user_id),0) AS bills
        FROM transactions t JOIN transaction_versions v ON v.version_id=t.current_version_id
        WHERE t.user_id=%s AND t.is_active''', (user['user_id'],)).fetchone()
    received, bills = amounts['received'], amounts['bills']
    return {'balance': float(received-bills), 'totalReceived': float(received), 'totalBillPayment': float(bills),
            'remainingPayable': float(bills-received), 'credits': list(reversed(ledger(db, user_id, True)))}


def state(db, actor):
    is_admin = actor['user_role_id'] == 1
    users = db.execute('SELECT user_id,user_name,description,is_active,is_pinned,user_role_id FROM users ORDER BY user_role_id,user_name').fetchall() if is_admin else [actor]
    contacts = db.execute('SELECT user_id,contact_no FROM contacts ORDER BY contact_id').fetchall() if is_admin else []
    profiles = []
    for u in users:
        profiles.append({'user_id': str(u['user_id']), 'user_name': u['user_name'], 'is_active': u['is_active'],
                         'is_pinned': u.get('is_pinned', False), 'description': u.get('description', ''), 'role': 'admin' if u['user_role_id'] == 1 else 'user',
                         'contacts': [c['contact_no'] for c in contacts if c['user_id'] == u['user_id']]})
    permissions = {}
    grants = db.execute('SELECT * FROM user_head_permissions' + ('' if is_admin else ' WHERE user_id=%s'),
                        () if is_admin else (actor['user_id'],)).fetchall()
    for grant in grants:
        permissions.setdefault(str(grant['user_id']), []).append(grant['head_id'] if grant['allowed'] else -grant['head_id'])
    visible = heads(db)
    if not is_admin:
        assigned = effective_permissions(visible, permissions.get(str(actor['user_id']), []))
        permissions[str(actor['user_id'])] = list(assigned)
        visible = [h for h in visible if h['is_active'] and h['head_id'] in assigned]
        allowed = {h['head_id'] for h in visible}
        visible = [{**h, 'parent_head_id': h['parent_head_id'] if h['parent_head_id'] in allowed else None} for h in visible]
    return {'heads': visible, 'users': profiles, 'permissions': permissions,
            'contracts': list_contracts(db) if is_admin else [],
            'homeOrder': actor.get('home_order', []),
            'creditUsers': [{'credit_user_id': str(row['credit_user_id']), 'user_name': row['user_name'],
                             'description': row['description'], 'contacts': row['contacts'],
                             'is_active': row['is_active'], 'is_pinned': row['is_pinned']}
                            for row in db.execute('SELECT * FROM credit_users ORDER BY user_name,credit_user_id').fetchall()] if is_admin else [],
            'transactions': ledger(db) if is_admin else [],
            'transactionTypes': [{'id': 1, 'name': 'General'}],
            'headRevision': db.execute('SELECT revision FROM head_revision').fetchone()['revision']}


def user_change(db, actor, change, session_id):
    admin(actor)
    creating = change.action == 'create'
    user = None if creating else account(db, change.userId)
    if change.action in ('create', 'profile'):
        require(change.profile, 'Enter a name and contacts.')
        profile = change.profile
        if creating:
            require(change.password and change.password.strip(), 'Enter an initial password.')
            user = db.execute('INSERT INTO users(user_name,password_hash,user_role_id,description) VALUES (%s,%s,2,%s) RETURNING *',
                              (profile.user_name, password_hash(change.password), profile.description)).fetchone()
        else:
            db.execute('UPDATE users SET user_name=%s,description=%s WHERE user_id=%s', (profile.user_name, profile.description, user['user_id']))
        db.execute('DELETE FROM contacts WHERE user_id=%s', (user['user_id'],))
        for contact in dict.fromkeys(profile.contacts):
            db.execute('INSERT INTO contacts(user_id,contact_no) VALUES (%s,%s)', (user['user_id'], contact))
    elif change.action in ('pin', 'unpin'):
        require(user['user_role_id'] != 1, 'Only regular users can be pinned here.')
        require(user['is_active'] or change.action == 'unpin', 'Reactivate this user before pinning.')
        db.execute('UPDATE users SET is_pinned=%s WHERE user_id=%s', (change.action == 'pin', user['user_id']))
    elif change.action == 'password':
        require(change.password and change.password.strip(), 'Enter a new password.')
        db.execute('UPDATE users SET password_hash=%s WHERE user_id=%s', (password_hash(change.password), user['user_id']))
        db.execute('DELETE FROM sessions WHERE user_id=%s AND session_id<>%s', (user['user_id'], session_id))
    else:
        require(user['user_role_id'] != 1, 'The admin account cannot be deleted or deactivated.')
        if change.action == 'delete':
            referenced = db.execute('''SELECT 1 FROM transactions WHERE user_id=%s OR created_by_user_id=%s
                UNION ALL SELECT 1 FROM transaction_versions WHERE editor_id=%s LIMIT 1''', (user['user_id'],)*3).fetchone()
            require(not referenced, 'This user has transaction history. Deactivate the account instead.')
            # Unused uploads can outlive their uploader; retain them for existing head/backup references.
            db.execute('UPDATE attachments SET uploaded_by=%s WHERE uploaded_by=%s', (actor['user_id'], user['user_id']))
            db.execute('DELETE FROM users WHERE user_id=%s', (user['user_id'],))
        else:
            active = change.action == 'reactivate'
            db.execute('''UPDATE users SET is_active=%s, is_pinned=CASE WHEN %s THEN is_pinned ELSE false END,
                last_activated_at=CASE WHEN %s THEN now() ELSE last_activated_at END,
                last_deactivated_at=CASE WHEN %s THEN last_deactivated_at ELSE now() END WHERE user_id=%s''',
                (active, active, active, active, user['user_id']))
            if not active:
                db.execute('DELETE FROM sessions WHERE user_id=%s', (user['user_id'],))
    saved = state(db, actor)
    return {'data': saved, 'user': next(u for u in saved['users'] if u['user_id'] == str(user['user_id']))} if creating else saved


def change_credit_user(db, actor, change):
    """Mutate one external user; serialization/commit belong to the caller."""
    admin(actor)
    user_id = change.creditUserId
    if change.action == 'create':
        require(change.profile, 'Enter the external user details.')
        profile = change.profile
        user_id = db.execute('INSERT INTO credit_users(user_name,description,contacts) VALUES (%s,%s,%s) RETURNING credit_user_id',
                   (profile.user_name, profile.description, list(dict.fromkeys(profile.contacts)))).fetchone()['credit_user_id']
    else:
        user = db.execute('SELECT * FROM credit_users WHERE credit_user_id=%s FOR UPDATE', (change.creditUserId,)).fetchone()
        require(user, 'This external user no longer exists.', 404)
        if change.action == 'reactivate':
            require(not user['is_active'], 'This external user is already active.')
            db.execute('UPDATE credit_users SET is_active=true WHERE credit_user_id=%s', (change.creditUserId,))
        else:
            require(user['is_active'], 'This external user is deactivated.', 404)
        if change.action == 'edit':
            require(change.profile, 'Enter the external user details.')
            profile = change.profile
            db.execute('UPDATE credit_users SET user_name=%s,description=%s,contacts=%s WHERE credit_user_id=%s',
                       (profile.user_name, profile.description, list(dict.fromkeys(profile.contacts)), change.creditUserId))
        elif change.action == 'pin':
            require(change.pinned is not None, 'Choose whether to pin this external user.')
            db.execute('UPDATE credit_users SET is_pinned=%s WHERE credit_user_id=%s', (change.pinned, change.creditUserId))
        elif change.action == 'deactivate':
            db.execute('UPDATE credit_users SET is_active=false,is_pinned=false WHERE credit_user_id=%s', (change.creditUserId,))
        elif change.action == 'delete':
            linked = db.execute('SELECT 1 FROM transactions WHERE credit_user_id=%s LIMIT 1', (change.creditUserId,)).fetchone()
            require(not linked, 'This external user has transactions. Deactivate it instead.')
            require(not db.execute('SELECT 1 FROM contract_users WHERE credit_user_id=%s LIMIT 1', (change.creditUserId,)).fetchone(),
                    'This external user is linked to a contract. Unlink them first or deactivate them.')
            db.execute('DELETE FROM credit_users WHERE credit_user_id=%s', (change.creditUserId,))
    return user_id


def credit_user_change(db, actor, change):
    change_credit_user(db, actor, change)
    return state(db, actor)


def validate_input(db, actor, value, user_id, submission=False, direct=False, allow_personal=False):
    require(value, 'Enter the transaction details.')
    require(allow_personal or value.transactionTypeId == 1, 'Use the Admin payable workflow for this entry.')
    if direct:
        # Older clients may still send a head; admin payments are always direct.
        value.headId = None
    else:
        head = db.execute('SELECT * FROM heads WHERE head_id=%s AND NOT is_deleted', (value.headId,)).fetchone()
        require(head and head['is_active'] and head['is_transactionable'], 'Choose an active transactionable head.')
    if submission:
        require(value.amount > 0, 'Enter an amount greater than zero.')
        require(value.headId in user_permissions(db, user_id), 'This head is not assigned to the user.', 403)
    ids = list(dict.fromkeys(int(a.id) for a in value.attachments))
    for aid in ids:
        row = db.execute('SELECT * FROM attachments WHERE attachment_id=%s', (aid,)).fetchone()
        require(row and (actor['user_role_id'] == 1 or row['uploaded_by'] == actor['user_id']), 'This attachment is unavailable.', 403)
        if actor['user_role_id'] != 1:
            require(not row['is_submitted'], 'This attachment was already submitted. Upload it again.')
    return ids


def revise(db, entry, editor_id, action, value=None, attachment_ids=None, *, allocation_values=None):
    old = db.execute('SELECT * FROM transaction_versions WHERE version_id=%s', (entry['current_version_id'],)).fetchone()
    head_id = value.headId if value else entry['head_id']
    category_id = None if value else entry['category_group_id']
    category_name = old['category_name'] if old else ''
    contract_id = entry.get('contract_id')
    contract_name = db.execute('SELECT name FROM contracts WHERE contract_id=%s', (contract_id,)).fetchone()['name'] if contract_id else ''
    version_id = db.execute('''INSERT INTO transaction_versions
        (transaction_id,transaction_amount,transaction_type_id,editor_id,action,head_id,category_group_id,is_active,head_path,category_name,description,contract_id,contract_name)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING version_id''',
        (entry['transaction_id'], value.amount if value else old['transaction_amount'], value.transactionTypeId if value else old['transaction_type_id'],
         editor_id, action, head_id, category_id, entry['is_active'], path(db, head_id), category_name, value.description if value else old['description'], contract_id, contract_name)).fetchone()['version_id']
    if entry.get('credit_user_id'):
        from receipts import copy_allocations, metadata, register
        if not entry['current_version_id'] and not entry.get('receipt_parent_id'):
            register(db, entry)
        elif entry['current_version_id']:
            metadata(db, entry)
        copy_allocations(db, entry, version_id, value.amount if value else old['transaction_amount'], allocation_values)
    if attachment_ids is None:
        attachment_ids = [r['attachment_id'] for r in db.execute('SELECT attachment_id FROM transaction_version_attachments WHERE version_id=%s', (entry['current_version_id'],)).fetchall()]
    for aid in attachment_ids:
        db.execute('INSERT INTO transaction_version_attachments VALUES (%s,%s)', (version_id, aid))
        db.execute('UPDATE attachments SET is_submitted=true WHERE attachment_id=%s', (aid,))
    db.execute('UPDATE transactions SET current_version_id=%s,head_id=%s,category_group_id=%s,is_active=%s,contract_id=%s WHERE transaction_id=%s',
               (version_id, head_id, category_id, entry['is_active'], contract_id, entry['transaction_id']))


def record_user_bill(db, actor, user_id, value):
    """Administrator records a normal user's bill without impersonating a session.

    Existing balances use created_by_user_id=user_id to identify bills. Preserve
    that discriminator and the user-facing attribution; version.editor_id
    retains the administrator's identity in the edit history.
    """
    admin(actor)
    user = account(db, user_id, field=True)
    require(user['is_active'], 'This account is deactivated.')
    ids = validate_input(db, actor, value, user_id, submission=True)
    entry = db.execute('''INSERT INTO transactions
        (head_id,category_group_id,user_id,created_by_user_id,current_version_id)
        VALUES (%s,NULL,%s,%s,0) RETURNING *''', (value.headId, user_id, user_id)).fetchone()
    revise(db, entry, actor['user_id'], 'Recorded by admin', value, ids)
    return ledger(db, user_id, transaction_id=entry['transaction_id'])[0]


def transaction_change(db, actor, change):
    submitting = change.action == 'submit'
    if submitting:
        require(actor['user_role_id'] != 1 and actor['user_id'] == change.userId,
                'Only the user can submit their own transaction. Admin preview cannot submit transactions.', 403)
    else:
        admin(actor)
    require(change.contractId is None or change.action == 'edit' or (change.action == 'credit' and change.creditUserId is not None),
            'Contracts only apply to receipts from external users.')
    if change.action in ('submit', 'credit'):
        user = account(db, change.userId)
        require(user['user_role_id'] != 1 or (not submitting and user['user_id'] == actor['user_id']),
                'Admin credits must be entered by the administrator.', 403)
        if user['user_role_id'] == 1:
            require(change.creditUserId, 'Select an external user.')
            require(db.execute('SELECT 1 FROM credit_users WHERE credit_user_id=%s AND is_active', (change.creditUserId,)).fetchone(),
                    'This external user no longer exists.', 404)
        else:
            require(change.creditUserId is None, 'External users only apply to Admin credits.')
        require(user['is_active'], 'This account is deactivated.')
        ids = validate_input(db, actor, change.input, user['user_id'], submitting, direct=not submitting)
        if change.contractId:
            validate_receipt(db, change.contractId, change.creditUserId, change.input.amount)
        entry = db.execute('''INSERT INTO transactions(head_id,category_group_id,user_id,created_by_user_id,credit_user_id,contract_id,current_version_id)
            VALUES (%s,%s,%s,%s,%s,%s,0) RETURNING *''', (change.input.headId, None, user['user_id'],
            actor['user_id'], change.creditUserId, change.contractId)).fetchone()
        revise(db, entry, actor['user_id'], 'Created', change.input, ids)
    else:
        entry = db.execute('SELECT * FROM transactions WHERE transaction_id=%s FOR UPDATE', (change.id,)).fetchone()
        require(entry, 'This transaction no longer exists.', 404)
        require(entry['current_version_id'] == change.expectedVersion, 'This entry changed. Close and reopen the card before editing.', 409)
        current_type = db.execute('SELECT transaction_type_id FROM transaction_versions WHERE version_id=%s', (entry['current_version_id'],)).fetchone().get('transaction_type_id', 1)
        if current_type in (2, 3):
            from personal_payable import change as change_personal
            return change_personal(db, actor, entry, change)
        if entry.get('credit_user_id'):
            from receipts import guard_change, metadata
            metadata(db, entry)
            guard_change(db, entry, change)
        assigning_contract = change.action == 'edit' and change.contractId is not None and not entry.get('contract_id')
        if change.action == 'edit' and change.contractId is not None:
            require(entry.get('credit_user_id'), 'Contracts only apply to receipts from external users.')
            require(entry.get('contract_id') in (None, change.contractId), 'This receipt already belongs to a contract.')
            require(entry['is_active'] or entry.get('contract_id') == change.contractId, 'Reactivate this receipt before assigning it to a contract.')
            entry['contract_id'] = change.contractId
        if entry.get('contract_id'):
            db.execute('SELECT contract_id FROM contracts WHERE contract_id=%s FOR UPDATE', (entry['contract_id'],))
            if change.action == 'edit' and entry['is_active']:
                require(change.input, 'Enter the transaction details.')
                validate_receipt(db, entry['contract_id'], entry['credit_user_id'], change.input.amount, entry['transaction_id'])
            elif change.action == 'reactivate':
                amount = db.execute('SELECT transaction_amount FROM transaction_versions WHERE version_id=%s',
                                    (entry['current_version_id'],)).fetchone()['transaction_amount']
                validate_receipt(db, entry['contract_id'], entry['credit_user_id'], amount, entry['transaction_id'])
        if change.action == 'delete':
            db.execute('DELETE FROM transactions WHERE transaction_id=%s', (change.id,))
            return None
        if change.action == 'edit':
            creator = account(db, entry['created_by_user_id'])
            ids = validate_input(db, actor, change.input, entry['user_id'], direct=creator['user_role_id'] == 1)
            allocation_values = None
            if assigning_contract:
                from receipts import allocations, returned
                require(not allocations(db, entry['current_version_id']) and not returned(db, entry['transaction_id']),
                        'Use the receipt allocation editor to change an allocated receipt.')
                name = db.execute('SELECT name FROM contracts WHERE contract_id=%s', (entry['contract_id'],)).fetchone()['name']
                allocation_values = [dict(kind='contract', contract_id=entry['contract_id'], contract_name=name, amount=change.input.amount)]
            revise(db, entry, actor['user_id'], 'Assigned to contract' if assigning_contract else 'Edited', change.input, ids, allocation_values=allocation_values)
        else:
            entry['is_active'] = change.action == 'reactivate'
            revise(db, entry, actor['user_id'], 'Reactivated' if entry['is_active'] else 'Deactivated')
    if submitting:
        return {'id': str(entry['transaction_id']), 'applied': True}
    return next(t for t in ledger(db, entry['user_id']) if t['id'] == str(entry['transaction_id']))


def backup_head(db, source, actor_id):
    tree = heads(db)
    stamp = db.execute('SELECT clock_timestamp() AS time').fetchone()['time'].strftime('%Y%m%d-%H%M%S-%f')
    suffix = f' Â· Backup {stamp}'
    copied, pending = {}, [source]
    while pending:
        old_id = pending.pop(0)
        head = next(h for h in tree if h['head_id'] == old_id)
        copied[old_id] = db.execute('''INSERT INTO heads
            (parent_head_id,attachment_id,head_name,head_description,is_active,is_transactionable)
            VALUES (%s,%s,%s,%s,false,%s) RETURNING head_id''',
            (None if old_id == source else copied[head['parent_head_id']], head['attachment_id'],
             head['head_name'][:160-len(suffix)] + suffix, head['head_description'], head['is_transactionable'])).fetchone()['head_id']
        pending.extend(h['head_id'] for h in tree if h['parent_head_id'] == old_id)
    for entry in db.execute('SELECT * FROM transactions WHERE head_id=ANY(%s) ORDER BY transaction_id', (list(copied),)).fetchall():
        new_id = db.execute('''INSERT INTO transactions
            (head_id,category_group_id,user_id,created_by_user_id,credit_user_id,current_version_id,is_active,created_at)
            VALUES (%s,%s,%s,%s,%s,0,false,%s) RETURNING transaction_id''',
            (copied[entry['head_id']], entry['category_group_id'], entry['user_id'], entry['created_by_user_id'],
             entry['credit_user_id'], entry['created_at'])).fetchone()['transaction_id']
        versions = db.execute('SELECT * FROM transaction_versions WHERE transaction_id=%s ORDER BY version_id', (entry['transaction_id'],)).fetchall()
        for version in versions:
            current = version['version_id'] == entry['current_version_id']
            new_head = copied.get(version['head_id'], version['head_id'])
            new_version = db.execute('''INSERT INTO transaction_versions
                (transaction_id,transaction_amount,transaction_type_id,created_at,editor_id,action,head_id,
                 category_group_id,is_active,head_path,category_name,description)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING version_id''',
                (new_id, version['transaction_amount'], version['transaction_type_id'], version['created_at'],
                 version['editor_id'], version['action'], new_head, version['category_group_id'],
                 version['is_active'],
                 path(db, new_head) if current else version['head_path'], version['category_name'], version['description'])).fetchone()['version_id']
            # Media is immutable and retained when originals are deleted, so references safely preserve every file.
            db.execute('''INSERT INTO transaction_version_attachments(version_id,attachment_id)
                SELECT %s,attachment_id FROM transaction_version_attachments WHERE version_id=%s''', (new_version, version['version_id']))
            if current:
                db.execute('UPDATE transactions SET current_version_id=%s WHERE transaction_id=%s', (new_version, new_id))
        duplicate = db.execute('SELECT * FROM transactions WHERE transaction_id=%s', (new_id,)).fetchone()
        revise(db, duplicate, actor_id, 'Backup created')


def head_changes(db, actor, change):
    admin(actor)
    revision = db.execute('SELECT revision FROM head_revision').fetchone()['revision']
    require(change.revision == revision, 'Heads changed in another session. Refresh before applying your edits.', 409)
    temporary = {}

    def resolve(value):
        if value is None:
            return None
        value = temporary.get(value, value)
        require(db.execute('SELECT 1 FROM heads WHERE head_id=%s AND NOT is_deleted', (value,)).fetchone(), 'This head no longer exists.')
        return value

    for item in change.changes:
        if item.op == 'create':
            require(item.temp_id not in temporary, 'Duplicate temporary head.')
            temporary[item.temp_id] = db.execute('INSERT INTO heads(head_name,parent_head_id,is_transactionable,head_description) VALUES (%s,%s,%s,%s) RETURNING head_id',
                (item.head_name, resolve(item.parent_head_id), item.is_transactionable, item.head_description)).fetchone()['head_id']
            continue
        source = resolve(item.source_head_id if item.op == 'merge' else item.head_id)
        if item.op == 'backup':
            backup_head(db, source, actor['user_id'])
        elif item.op == 'edit':
            aid = None
            if item.image_url:
                match = re.fullmatch(r'/api/attachments/([0-9]{1,10})', item.image_url)
                require(match, 'Upload a head image first.')
                aid = int(match.group(1))
                require(0 < aid <= 2147483647, 'Choose a valid image attachment.')
                require(db.execute('SELECT 1 FROM attachments WHERE attachment_id=%s AND attachment_type_id=1', (aid,)).fetchone(), 'Choose an image attachment.')
            db.execute('UPDATE heads SET head_name=%s,attachment_id=%s,is_transactionable=%s,head_description=COALESCE(%s,head_description) WHERE head_id=%s',
                       (item.head_name, aid, item.is_transactionable, item.head_description, source))
        elif item.op == 'active':
            ids = {source}
            if not item.is_active:
                tree = heads(db)
                while True:
                    expanded = ids | {h['head_id'] for h in tree if h['parent_head_id'] in ids}
                    if expanded == ids:
                        break
                    ids = expanded
            db.execute('UPDATE heads SET is_active=%s WHERE head_id=ANY(%s)', (item.is_active, list(ids)))
        elif item.op == 'delete':
            ids = {source}
            tree = heads(db)
            while True:
                expanded = ids | {h['head_id'] for h in tree if h['parent_head_id'] in ids}
                if expanded == ids:
                    break
                ids = expanded
            db.execute('DELETE FROM transactions WHERE head_id=ANY(%s)', (list(ids),))
            db.execute('UPDATE heads SET is_deleted=true,is_active=false WHERE head_id=ANY(%s)', (list(ids),))
        else:
            target = resolve(item.target_head_id if item.op == 'merge' else item.new_parent_id)
            cursor = target
            while cursor is not None:
                require(cursor != source, 'A head cannot be moved or merged into its own branch.')
                cursor = db.execute('SELECT parent_head_id FROM heads WHERE head_id=%s', (cursor,)).fetchone()['parent_head_id']
            if item.op == 'move':
                db.execute('UPDATE heads SET parent_head_id=%s WHERE head_id=%s', (target, source))
            else:
                if item.backup:
                    backup_head(db, source, actor['user_id'])
                for entry in db.execute('SELECT * FROM transactions WHERE head_id=%s', (source,)).fetchall():
                    entry['head_id'] = target
                    revise(db, entry, actor['user_id'], 'Head merged')
                db.execute('UPDATE heads SET is_deleted=true,is_active=false,parent_head_id=NULL WHERE head_id=%s', (source,))
                db.execute('UPDATE heads SET parent_head_id=%s WHERE parent_head_id=%s', (target, source))
    # Explicit rules stay attached to heads; inherited access follows the current tree.
    db.execute('UPDATE head_revision SET revision=revision+1')
    return state(db, actor)


def apply_change(db, actor, change, session_id):
    if change.op == 'contract':
        change_contract(db, actor, change)
        return state(db, actor)
    if change.op == 'transaction':
        return transaction_change(db, actor, change)
    admin(actor)
    if change.op == 'homeOrder':
        base_cards = {'attachments', 'users', 'company', 'statement', 'heads', 'credit', 'debit'}
        # Accept old clients during deployment; the frontend appends newly available cards.
        require(len(set(change.ids)) == len(change.ids) and set(change.ids) in (base_cards, base_cards | {'receivable', 'payable'}, base_cards | {'receivable', 'payable', 'contracts'}, base_cards | {'receivable', 'payable', 'contracts', 'user-credit'}, base_cards | {'receivable', 'payable', 'contracts', 'user-credit', 'admin-payable'}),
                'Include each Home card once.')
        db.execute('UPDATE users SET home_order=%s WHERE user_id=%s', (change.ids, actor['user_id']))
        return {'homeOrder': change.ids}
    if change.op == 'user':
        return user_change(db, actor, change, session_id)
    if change.op == 'creditUser':
        return credit_user_change(db, actor, change)
    if change.op == 'heads':
        return head_changes(db, actor, change)
    if change.op == 'permissions':
        account(db, change.userId, field=True)
        ids = list(set(change.ids))
        require(all(i != 0 and -i not in ids for i in ids), "Conflicting permission rules.")
        found = db.execute('SELECT head_id FROM heads WHERE head_id=ANY(%s)', ([abs(i) for i in ids],)).fetchall()
        require(len(found) == len(ids), 'One of these heads no longer exists.')
        db.execute('DELETE FROM user_head_permissions WHERE user_id=%s', (change.userId,))
        for head_id in ids:
            db.execute('INSERT INTO user_head_permissions(head_id,user_id,allowed) VALUES (%s,%s,%s)', (abs(head_id), change.userId, head_id > 0))
    return state(db, actor)
