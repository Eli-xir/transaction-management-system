"""Exercise legacy backfill without changing any existing domain table."""
import os
import unittest
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from psycopg.rows import dict_row

URL = os.getenv('CASHBOOK_TEST_DATABASE_URL', '')


@unittest.skipUnless(URL, 'Requires a disposable local cashbook_test database.')
class ReceiptMigrationTests(unittest.TestCase):
    def test_old_receipts_and_history_backfill_into_one_new_table(self):
        settings = conninfo_to_dict(URL)
        if settings.get('host') not in ('127.0.0.1', 'localhost', '::1') or not settings.get('dbname', '').startswith('cashbook_test'):
            raise RuntimeError('Migration tests require a local cashbook_test database.')
        schema = f'receipt_test_{uuid4().hex}'
        with psycopg.connect(URL, hostaddr='::1' if settings['host'] == '::1' else '127.0.0.1', row_factory=dict_row, connect_timeout=5) as connection:
            try:
                connection.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
                connection.execute(sql.SQL('SET LOCAL search_path TO {},public').format(sql.Identifier(schema)))
                connection.execute('''CREATE TABLE schema_version(version integer PRIMARY KEY);
                    INSERT INTO schema_version VALUES (11);
                    CREATE TABLE transactions(transaction_id integer PRIMARY KEY, credit_user_id uuid);
                    CREATE TABLE contracts(contract_id uuid PRIMARY KEY);
                    CREATE TABLE transaction_versions(version_id integer PRIMARY KEY, transaction_id integer,
                        contract_id uuid,contract_name text,transaction_amount numeric(18,2));''')
                payer, contract = uuid4(), uuid4()
                connection.execute('INSERT INTO contracts VALUES (%s)', (contract,))
                connection.execute('INSERT INTO transactions VALUES (1,%s),(2,%s),(3,NULL)', (payer, payer))
                connection.execute('''INSERT INTO transaction_versions VALUES
                    (1,1,NULL,'',100),(2,1,%s,'Old project name',100),(3,2,%s,'Project',50),(4,3,NULL,'',25)''', (contract, contract))
                def snapshot():
                    return {table: connection.execute(sql.SQL('SELECT * FROM {} ORDER BY 1').format(sql.Identifier(table))).fetchall()
                            for table in ('transactions', 'contracts', 'transaction_versions')}
                before = snapshot()
                connection.execute((Path(__file__).parent.parent / 'database/migrations/012_receipt_allocations.sql').read_text())
                self.assertEqual(snapshot(), before)
                rows = connection.execute('SELECT * FROM receipt_allocations ORDER BY record_id').fetchall()
                roots = [r for r in rows if r['kind'] == 'receipt']
                self.assertEqual([r['transaction_id'] for r in roots], [1, 2])
                self.assertEqual(len({r['receipt_key'] for r in roots}), 2)
                for row in roots:
                    self.assertRegex(row['receipt_key'], r'^[A-Z0-9]{8}$')
                allocated = [r for r in rows if r['kind'] == 'contract']
                self.assertEqual([(r['version_id'], r['amount'], r['contract_name']) for r in allocated], [(2, 100, 'Old project name'), (3, 50, 'Project')])
                self.assertEqual(connection.execute('SELECT max(version) AS version FROM schema_version').fetchone()['version'], 12)
            finally:
                # Roll back the entire private schema; never reset shared tables.
                connection.rollback()
