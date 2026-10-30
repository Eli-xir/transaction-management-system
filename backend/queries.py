"""Public resource serializers. Never return authentication/database rows directly."""
from service import require


def users(db, user_id=None):
    where, params = (' WHERE user_id=%s', (user_id,)) if user_id else ('', ())
    rows = db.execute('SELECT user_id,user_name,description,is_active,is_pinned,user_role_id FROM users'
                      + where + ' ORDER BY user_role_id,user_name,user_id', params).fetchall()
    contacts = db.execute('SELECT user_id,contact_no FROM contacts' + where + ' ORDER BY contact_id', params).fetchall()
    return [{'user_id': str(u['user_id']), 'user_name': u['user_name'], 'description': u['description'],
             'is_active': u['is_active'], 'is_pinned': u['is_pinned'],
             'role': 'admin' if u['user_role_id'] == 1 else 'user',
             'contacts': [c['contact_no'] for c in contacts if c['user_id'] == u['user_id']]}
            for u in rows]


def external_users(db, user_id=None):
    where, params = (' WHERE credit_user_id=%s', (user_id,)) if user_id else ('', ())
    rows = db.execute('SELECT credit_user_id,user_name,description,contacts,is_active,is_pinned FROM credit_users'
                      + where + ' ORDER BY user_name,credit_user_id', params).fetchall()
    return [{'credit_user_id': str(u['credit_user_id']), 'user_name': u['user_name'], 'description': u['description'],
             'contacts': u['contacts'], 'is_active': u['is_active'], 'is_pinned': u['is_pinned']} for u in rows]


def one(rows, field, value, message):
    result = next((row for row in rows if row[field] == str(value)), None)
    require(result is not None, message, 404)
    return result


def permission_rules(db):
    """Explicit signed grants for the administrator permission editor."""
    result = {}
    for row in db.execute('SELECT user_id,head_id,allowed FROM user_head_permissions ORDER BY user_id,head_id').fetchall():
        result.setdefault(str(row['user_id']), []).append(row['head_id'] if row['allowed'] else -row['head_id'])
    return result
