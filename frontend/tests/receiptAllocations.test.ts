import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Transaction } from '../src/pages/Admin/types.ts';
import { contractBalance, contractContributions } from '../src/pages/Admin/utils/contractBalances.ts';
import { ledgerReport, direction } from '../src/pages/Ledger/ledgerModel.ts';
import { allocationLabel, contractStatementEntries, receiptStatementEntries } from '../src/pages/Ledger/receiptModel.ts';

const root: Transaction = { id: '1', userId: 'admin', createdBy: 'admin', creditUserId: 'payer', headId: null,
  amount: 1000, receiptKey: 'AB12CD34', active: true, createdAt: '2026-10-20T12:00:00Z', attachments: [], returnedAmount: 100,
  allocations: [{ kind: 'contract', contractId: 'a', amount: 300 }, { kind: 'contract', contractId: 'b', amount: 200 }, { kind: 'profit', amount: 250 }] };
const refund: Transaction = { ...root, id: '2', amount: 100, receiptParentId: '1', allocations: [], returnedAmount: 0, createdAt: '2026-10-21T12:00:00Z' };
const normal: Transaction = { ...root, id: '3', creditUserId: null, userId: 'worker', receiptKey: null, amount: 50, allocations: [] };
const entries = [root, refund, normal];
const filters = { dateFrom: '', dateTo: '', userScope: 'all', direction: 'both' as const };

test('Company and external statements count a split receipt once and its return once', () => {
  const report = ledgerReport(entries, filters, 'by-time', [], true);
  assert.equal(report.credit, 1000);
  assert.equal(report.debit, 150);
  assert.equal(report.closing, 850);
  const external = ledgerReport(entries, { ...filters, userScope: 'credit:payer' }, 'by-time', [], true);
  assert.equal(external.credit, 1000);
  assert.equal(external.debit, 100);
  assert.equal(direction(refund, true), 'debit');
  assert.equal(direction(refund), 'debit');
});

test('Contract statements use allocated portions while contributions and payable retain overpayments', () => {
  const contract = { id: 'a', name: 'A', description: '', totalAmount: 200, creditUserIds: ['payer'], revision: 1, isActive: true };
  assert.deepEqual(contractBalance(contract, entries), { received: 300, remaining: -100 });
  assert.deepEqual([...contractContributions('a', entries)], [['payer', 300]]);
  const report = ledgerReport(contractStatementEntries(entries, 'a'), { ...filters, contractId: 'a' }, 'by-time', [], true);
  assert.deepEqual(report.rows.map(({ entry }) => [entry.id, entry.amount]), [['1', 300]]);
  assert.equal(report.credit, 300);
  assert.equal(root.amount, 1000);
  const later = ledgerReport(contractStatementEntries(entries, 'a'), { ...filters, dateFrom: '2026-10-22' }, 'by-time', [], true);
  assert.equal(later.opening, 300);
});

test('Receipt search groups original and returns, is case insensitive, and only affects Company Statement', () => {
  const grouped = ledgerReport(entries, { ...filters, receiptKey: 'ab12cd34' }, 'by-time', [], true);
  assert.deepEqual(grouped.rows.map(({ entry }) => entry.id), ['1', '2']);
  assert.equal(grouped.closing, 900);
  assert.equal(ledgerReport(entries, { ...filters, receiptKey: 'ZZZZZZZZ' }, 'by-time', [], true).rows.length, 0);
  assert.equal(ledgerReport(entries, { ...filters, receiptKey: 'ZZZZZZZZ' }, 'by-time').rows.length, 3);
});

test('Unallocated and company-profit filters find partial receipts and omit returns and normal payments', () => {
  for (const contractId of ['__none__', '__profit__']) {
    const report = ledgerReport(entries, { ...filters, contractId }, 'by-time', [], true);
    assert.deepEqual(report.rows.map(({ entry }) => entry.id), ['1']);
  }
  assert.equal(allocationLabel(root, (id) => id ?? ''), 'a · b · Company profit · Direct receipt');
  assert.equal(allocationLabel(refund, () => ''), 'Unallocated return');
  const settled = { ...root, returnedAmount: 250 };
  assert.equal(ledgerReport([settled], { ...filters, contractId: '__none__' }, 'by-time', [], true).rows.length, 0);
});

test('Deactivating receipts removes contract attribution and company cash without affecting other users', () => {
  const inactive = { ...root, active: false };
  assert.equal(contractContributions('a', [inactive, normal]).size, 0);
  assert.equal(ledgerReport([inactive, normal], filters, 'by-time', [], true).closing, -50);
});


test('Split rows preserve the full receipt, direct remainder, shared evidence and original edit target', () => {
  const rows = receiptStatementEntries([root, refund, normal]);
  assert.deepEqual(rows.slice(0, 4).map(r => r.amount), [300, 200, 250, 250]);
  assert.equal(new Set(rows.map(r => r.id)).size, rows.length);
  assert.ok(rows.slice(0, 4).every(r => r.sourceTransactionId === root.id && r.attachments === root.attachments));
  const report = ledgerReport(rows, filters, 'by-time', [], true);
  assert.equal(report.credit, 1000);
  assert.equal(report.debit, 150);
  assert.equal(report.closing, 850);
  assert.deepEqual(receiptStatementEntries([normal]), [normal]);
});
