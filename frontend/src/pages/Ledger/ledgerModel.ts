import type { FiltersState, Head, Transaction, TransactionRevision } from '../Admin/types';
import { buildHeadTree } from '../Admin/utils/headTree.ts';

export const money = (amount: number) => `PKR ${(amount === 0 ? 0 : amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
export const roundMoney = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;
export const isCompanyTransaction = (entry: Transaction) => entry.transactionTypeId !== 2 && (entry.transactionTypeId === 3 || !!entry.creditUserId || entry.userId !== entry.createdBy);
export const direction = (entry: Transaction, company = false) => company
  ? entry.creditUserId ? 'credit' : 'debit'
  : entry.createdBy === entry.userId ? 'debit' : 'credit';
export const creditUserScope = (id: string) => `credit:${id}`;
export const matchesUserScope = (entry: Transaction, scope: string) => scope === 'all' ||
  (scope.startsWith('credit:') ? entry.creditUserId === scope.slice(7) : entry.userId === scope && !entry.creditUserId);
export const matchesContractScope = (entry: Transaction, id?: string) => !id || (id === '__none__' ? !entry.contractId : entry.contractId === id);
export function accountTotals(entries: Transaction[]) {
  let totalReceived = 0, totalBillPayment = 0;
  for (const entry of entries) {
    if (!entry.active) continue;
    if (direction(entry) === 'credit') totalReceived = roundMoney(totalReceived + entry.amount);
    else totalBillPayment = roundMoney(totalBillPayment + entry.amount);
  }
  return { totalReceived, totalBillPayment, remainingPayable: roundMoney(totalBillPayment - totalReceived) };
}
export function headPath(heads: Head[], id: number | null) {
  if (id === null) return '—';
  const names: string[] = [], seen = new Set<number>();
  let head = heads.find((item) => item.head_id === id);
  while (head && !seen.has(head.head_id)) {
    seen.add(head.head_id); names.unshift(head.head_name);
    head = heads.find((item) => item.head_id === head?.parent_head_id);
  }
  return names.join(' / ') || 'Unavailable head';
}
export function historyOf(entry: Transaction): TransactionRevision[] {
  return entry.versions?.length ? entry.versions : [{
    versionId: `${entry.id}-initial`, recordedAt: entry.createdAt, editorId: entry.createdBy,
    action: 'Created', amount: entry.amount, headId: entry.headId, description: entry.description,
    transactionTypeId: entry.transactionTypeId, attachments: entry.attachments, active: entry.active,
    headPath: entry.headPath,
    contractId: entry.contractId,
  }];
}
export type LedgerOrder = 'by-time' | 'credit-first' | 'debit-first' | 'by-head';
export function headBranchIds(heads: Head[], headId: number | null | undefined): Set<number> | null {
  if (headId == null) return null;
  const children = new Map<number, number[]>();
  for (const head of heads) {
    if (head.parent_head_id !== null) children.set(head.parent_head_id, [...(children.get(head.parent_head_id) ?? []), head.head_id]);
  }
  const ids = new Set<number>(), pending = [headId];
  while (pending.length) {
    const id = pending.pop()!;
    if (ids.has(id)) continue;
    ids.add(id); pending.push(...(children.get(id) ?? []));
  }
  return ids;
}
export function dateRangeLabel(filters: FiltersState) {
  return [
    filters.dateFrom || filters.timeFrom ? `From: ${[filters.dateFrom, filters.timeFrom].filter(Boolean).join(' ')}` : '',
    filters.dateTo || filters.timeTo ? `To: ${[filters.dateTo, filters.timeTo].filter(Boolean).join(' ')}` : '',
  ].filter(Boolean).join(' · ');
}
export function invalidDateRange(filters: FiltersState) {
  return !!(filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo)
    || filters.dateFrom === filters.dateTo && !!filters.timeFrom && !!filters.timeTo && filters.timeFrom > filters.timeTo;
}
export function ledgerReport(entries: Transaction[], filters: FiltersState, order: LedgerOrder, heads: Head[] = [], company = false) {
  const entryDirection = (entry: Transaction) => direction(entry, company);
  const day = (value: string) => {
    const d = new Date(value);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const time = (value: string) => {
    const d = new Date(value);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const beforeStart = (entry: Transaction) => !!filters.dateFrom && (day(entry.createdAt) < filters.dateFrom
    || day(entry.createdAt) === filters.dateFrom && !!filters.timeFrom && time(entry.createdAt) < filters.timeFrom);
  const signed = (entry: Transaction) => entryDirection(entry) === 'credit' ? entry.amount : -entry.amount;
  const branch = headBranchIds(heads, filters.headId);
  const account = entries.filter((entry) => entry.active && (company || filters.showAdminPayable !== false || ![2, 3].includes(entry.transactionTypeId ?? 1)) && matchesContractScope(entry, filters.contractId) && (!company || isCompanyTransaction(entry)) && matchesUserScope(entry, filters.userScope)
    && (!branch || (entry.headId !== null && branch.has(entry.headId))) && (!filters.description || (entry.description ?? '').toLowerCase().includes(filters.description.toLowerCase())));
  const selected = account.filter((entry) => filters.direction === 'both' || entryDirection(entry) === filters.direction);
  const opening = selected.filter(beforeStart).reduce((sum, entry) => roundMoney(sum + signed(entry)), 0);
  const period = selected.filter((entry) => !beforeStart(entry) && (!filters.dateTo || day(entry.createdAt) <= filters.dateTo)
    && (!filters.timeFrom || !!filters.dateFrom || time(entry.createdAt) >= filters.timeFrom)
    && (!filters.timeTo || (!!filters.dateTo && day(entry.createdAt) < filters.dateTo) || time(entry.createdAt) <= filters.timeTo));
  const headOrder = new Map<number, number>();
  if (order === 'by-head') {
    const visit = (nodes: ReturnType<typeof buildHeadTree>) => {
      for (const node of nodes) {
        headOrder.set(node.head_id, headOrder.size);
        visit(node.children);
      }
    };
    visit(buildHeadTree(heads));
  }
  period.sort((a, b) => {
    if (order === 'by-head') {
      const rank = (id: number | null) => id === null ? heads.length : headOrder.get(id) ?? heads.length;
      const difference = rank(a.headId) - rank(b.headId);
      if (difference) return difference;
    }
    if ((order === 'credit-first' || order === 'debit-first') && entryDirection(a) !== entryDirection(b)) return entryDirection(a) === (order === 'credit-first' ? 'credit' : 'debit') ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
  });
  let balance = opening;
  const rows = period.map((entry) => ({ entry, balance: balance = roundMoney(balance + signed(entry)) }));
  const credit = period.filter((entry) => entryDirection(entry) === 'credit').reduce((sum, entry) => roundMoney(sum + entry.amount), 0);
  const debit = period.filter((entry) => entryDirection(entry) === 'debit').reduce((sum, entry) => roundMoney(sum + entry.amount), 0);
  const totals = accountTotals(account.filter((entry) => !filters.dateTo || day(entry.createdAt) <= filters.dateTo));
  return { rows, opening, credit, debit, closing: balance, ...totals };
}
