import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '../src/pages/Admin/types.ts';
import { adminPayableBalance, adminPayableLabel } from '../src/pages/Admin/utils/adminPayable.ts';
import { ledgerReport, isCompanyTransaction } from '../src/pages/Ledger/ledgerModel.ts';
import { outstandingBalances } from '../src/pages/Admin/utils/outstandingBalances.ts';
const entry = (id: string, amount: number, kind: number, active = true): Transaction => ({ id, amount, transactionTypeId: kind,
  active, userId: 'u', createdBy: kind === 2 ? 'u' : 'admin', headId: null, attachments: [], createdAt: '2026-10-20T10:00:00Z' });
const filters = { dateFrom: '', dateTo: '', userScope: 'u', direction: 'both' as const };
test('personal additions are ledger only and payments are company debits exactly once', () => {
  const added = entry('a', 1000, 2), paid = entry('p', 300, 3);
  assert.equal(adminPayableBalance([added, paid, entry('inactive', 9999, 2, false)], 'u'), 700);
  assert.equal(isCompanyTransaction(added), false);
  assert.equal(isCompanyTransaction(paid), true);
  const report = ledgerReport([added, paid], filters, 'by-time', [], true);
  assert.equal(report.debit, 300); assert.equal(report.credit, 0); assert.equal(report.closing, -300);
  assert.equal(ledgerReport([added, paid], { ...filters, showAdminPayable: false }, 'by-time', [], true).debit, 300,
    'A user-statement display toggle must never hide actual company payments');
  assert.equal(adminPayableLabel(added), 'Admin payable added');
  assert.equal(adminPayableLabel(paid), 'Admin payable paid');
});
test('statement toggle hides both sides and recomputes opening balances and totals', () => {
  const items = [entry('a', 1000, 2), entry('p', 300, 3), entry('normal', 50, 1)];
  assert.equal(ledgerReport(items, filters, 'by-time').closing, -650);
  const hidden = ledgerReport(items, { ...filters, showAdminPayable: false }, 'by-time');
  assert.deepEqual(hidden.rows.map(({ entry }) => entry.id), ['normal']);
  assert.equal(hidden.closing, 50);
  const opening = ledgerReport(items, { ...filters, showAdminPayable: false, dateFrom: '2026-10-21' }, 'by-time');
  assert.equal(opening.opening, 50);
});
test('personal obligations do not contaminate ordinary Receivable and Payable cards', () => {
  const users = [{ user_id: 'u', user_name: 'User', role: 'user' as const, is_active: true }];
  assert.deepEqual(outstandingBalances(users, [entry('a', 1000, 2), entry('p', 300, 3)]), []);
  assert.equal(outstandingBalances(users, [entry('a', 1000, 2), entry('p', 300, 3), entry('normal', 50, 1)])[0].amount, 50);
});
