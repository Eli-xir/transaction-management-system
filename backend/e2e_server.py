"""Run the real API against an explicitly disposable LOCAL browser-test database.

Requires CASHBOOK_E2E_DATABASE_URL pointing to an empty cashbook_e2e* database.
Never reads the normal DATABASE_URL and never stores files in application uploads.
"""
import os
from pathlib import Path
from tempfile import TemporaryDirectory

import psycopg
from psycopg.conninfo import conninfo_to_dict


def serve():
    url = os.environ.get('CASHBOOK_E2E_DATABASE_URL', '')
    if not url:
        raise RuntimeError('Set CASHBOOK_E2E_DATABASE_URL to an empty disposable local database.')
    settings = conninfo_to_dict(url)
    if settings.get('host') not in ('localhost', '127.0.0.1', '::1') or not settings.get('dbname', '').startswith('cashbook_e2e'):
        raise RuntimeError('Browser tests require a local database named cashbook_e2e*.')
    address = '::1' if settings['host'] == '::1' else '127.0.0.1'
    # Rebuild with a pinned address so environment/service settings cannot redirect it.
    settings['hostaddr'] = address
    pinned_url = psycopg.conninfo.make_conninfo(**settings)
    with psycopg.connect(pinned_url, connect_timeout=5) as connection:
        if connection.execute("SELECT count(*) FROM information_schema.tables WHERE table_schema='public'").fetchone()[0]:
            raise RuntimeError('Browser tests require an empty database; existing data was not changed.')
    os.environ['DATABASE_URL'] = pinned_url
    os.environ['ADMIN_PASSWORD'] = os.environ.get('CASHBOOK_E2E_ADMIN_PASSWORD', 'api-e2e-admin-password')
    os.environ['COOKIE_SECURE'] = 'false'
    os.environ['CASHBOOK_S3_BUCKET'] = ''
    import db
    import storage
    import attachments
    import main
    import uvicorn
    with TemporaryDirectory(prefix='cashbook-browser-uploads-') as directory:
        db.UPLOADS = storage.UPLOADS = attachments.UPLOADS = Path(directory)
        storage.BUCKET = ''
        uvicorn.run(main.app, host='127.0.0.1', port=8000, log_level='warning')


if __name__ == '__main__':
    serve()
