import type { ReceiptAllocation, Transaction } from '../Admin/types.ts';

// Older saved snapshots remain readable before a refresh supplies allocations.
export function receiptAllocations(entry: Pick<Transaction, 'allocations' | 'creditUserId' | 'contractId' | 'amount' | 'receiptParentId'>): ReceiptAllocation[] {
  return entry.allocations ?? (entry.creditUserId && entry.contractId && !entry.receiptParentId
    ? [{ kind: 'contract', contractId: entry.contractId, amount: entry.amount }] : []);
}

export function contractAmount(entry: Transaction, contractId: string) {
  return receiptAllocations(entry).filter((item) => item.kind === 'contract' && item.contractId === contractId)
    .reduce((sum, item) => sum + Math.round(item.amount * 100), 0) / 100;
}

export function unallocatedAmount(amount: number, allocations: ReceiptAllocation[], returned = 0) {
  return (Math.round(amount * 100) - allocations.reduce((sum, a) => sum + Math.round(a.amount * 100), 0) - Math.round(returned * 100)) / 100;
}

export function contractStatementEntries(entries: Transaction[], contractId: string) {
  return entries.filter((entry) => contractAmount(entry, contractId) > 0)
    .map((entry) => ({ ...portionValues(entry, `contract:${contractId}`), sourcePortionKey: `contract:${contractId}`, amount: contractAmount(entry, contractId) }));
}

export function portionValues(entry: Transaction, key: string): Transaction {
  const custom = entry.portionDetails?.[key];
  if (!custom) return entry;
  return { ...entry, description: custom?.description ?? entry.description,
    attachments: [...(custom?.images ?? entry.attachments.filter(a => a.kind === 'image')), ...(custom?.voice ?? entry.attachments.filter(a => a.kind === 'voice'))] };
}

// Display portions of one receipt; never persist additional cash transactions.
export function receiptStatementEntries(entries: Transaction[]) {
  return entries.flatMap((entry): Transaction[] => {
    if (!entry.creditUserId || entry.receiptParentId) return [entry];
    const allocations = receiptAllocations(entry);
    const remaining = unallocatedAmount(entry.amount, allocations);
    const parts = [...allocations, ...(remaining > 0 ? [{ kind: 'direct' as const, amount: remaining }] : [])];
    if (!parts.length) return [entry];
    return parts.map((part, index) => ({ ...portionValues(entry, part.kind === 'contract' ? `contract:${part.contractId}` : part.kind),
      sourcePortionKey: part.kind === 'contract' ? `contract:${part.contractId}` : part.kind,
      id: parts.length > 1 ? `${entry.id}:part:${index}` : entry.id, sourceTransactionId: parts.length > 1 ? entry.id : undefined,
      amount: part.amount, contractId: part.kind === 'contract' ? part.contractId : null,
      allocations: part.kind === 'direct' ? [] : [part], returnedAmount: 0 }));
  });
}

export function allocationLabel(entry: Transaction, contractName: (id?: string | null) => string) {
  if (entry.receiptParentId) return 'Unallocated return';
  if (!entry.creditUserId) return '';
  const items = receiptAllocations(entry);
  const labels = items.map((item) => item.kind === 'profit' ? 'Company profit' : contractName(item.contractId));
  if (unallocatedAmount(entry.amount, items, entry.returnedAmount) > 0) labels.push('Direct receipt');
  return labels.join(' · ') || 'Direct receipt';
}
