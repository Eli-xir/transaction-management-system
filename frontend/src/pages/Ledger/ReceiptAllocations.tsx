import { useState } from 'react';
import type { Contract, ReceiptAllocation, Transaction } from '../Admin/types';
import { cashbookApi } from '../../data/cashbookApi';
import { historyOf, money } from './ledgerModel';
import { receiptAllocations, unallocatedAmount } from './receiptModel';

export function ReceiptAllocationEditor({ entry, amount, contracts, values, onChange }: {
  entry: Transaction; amount: number; contracts: Contract[]; values: ReceiptAllocation[]; onChange: (values: ReceiptAllocation[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const linked = contracts.filter((c) => c.creditUserIds.includes(entry.creditUserId ?? '') && (c.isActive || values.some((a) => a.contractId === c.id)));
  const unallocated = unallocatedAmount(amount, values, entry.returnedAmount);
  const available = linked.filter((c) => c.isActive && !values.some((a) => a.contractId === c.id) && `${c.name} ${c.description}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="flex-col gap-sm" aria-label="Receipt allocations">
    <h3>Allocate this receipt</h3>
    <p className="hint">Split the receipt across linked contracts and company profit. Attachments stay with this receipt.</p>
    {values.map((allocation, index) => <div key={`${allocation.kind}:${allocation.contractId ?? ''}`} className="receipt-allocation-row flex-row flex-wrap items-center gap-sm">
      <label className="field"><span>{allocation.kind === 'profit' ? 'Company profit' : linked.find((c) => c.id === allocation.contractId)?.name ?? allocation.contractName ?? 'Contract'}</span>
        <input aria-label={`Allocation amount ${index + 1}`} type="number" inputMode="decimal" required min="0.01" max="999999999999.99" step="0.01" value={Number.isNaN(allocation.amount) ? '' : allocation.amount}
          onChange={(event) => onChange(values.map((a, i) => i === index ? { ...a, amount: event.target.valueAsNumber } : a))} /></label>
      <button type="button" className="btn" aria-label={`Remove allocation ${index + 1}`} onClick={() => onChange(values.filter((_, i) => i !== index))}>Remove</button>
    </div>)}
    <label className="field"><span>Search allocation contracts</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="flex-row flex-wrap items-end gap-sm">
      <label className="field"><span>Allocate to</span><select aria-label="Allocate to" value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose contract or company profit</option>
        {!values.some((a) => a.kind === 'profit') && <option value="__profit__">Company profit</option>}
        {available.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select></label>
      <button type="button" className="btn" disabled={!target || (target !== '__profit__' && !available.some((c) => c.id === target))} onClick={() => {
        onChange([...values, { kind: target === '__profit__' ? 'profit' : 'contract', contractId: target === '__profit__' ? null : target, amount: Math.max(0, unallocated) }]); setTarget('');
      }}>Add allocation</button>
    </div>
    <p role="status" className={unallocated < 0 ? 'text-error' : undefined}>{unallocated < 0 ? `Overallocated by ${money(-unallocated)}` : `Unallocated: ${money(unallocated)}`}</p>
    {!!entry.returnedAmount && <p>Already returned: {money(entry.returnedAmount)}</p>}
  </section>;
}

export function ReceiptDetails({ entry, contracts, transactions, busy, onReturn, onBusyChange }: {
  entry: Transaction; contracts: Contract[]; transactions: Transaction[]; busy: boolean;
  onReturn: () => Promise<void>; onBusyChange: (busy: boolean) => void;
}) {
  const [returning, setReturning] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const allocations = receiptAllocations(entry);
  const unallocated = unallocatedAmount(entry.amount, allocations, entry.returnedAmount);
  const returns = transactions.filter((t) => t.receiptParentId === entry.id);
  async function saveReturn() {
    if (busy || saved) return;
    onBusyChange(true); setError('');
    try {
      await cashbookApi.returnReceipt(entry.id, historyOf(entry).at(-1)!.versionId, Number(amount), description);
      setSaved(true);
      setReturning(false); await onReturn();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not record this return.'); }
    finally { onBusyChange(false); }
  }
  return <section className="flex-col gap-sm">
    <p>Receipt ID: <strong>{entry.receiptKey}</strong>{entry.receiptParentId ? ' · Unallocated return' : ` · Unallocated: ${money(unallocated)}`}</p>
    {!entry.receiptParentId && <>
      <details className="disclosure" open><summary>Show all allocations</summary>
        <dl className="review-details"><dt>Receipt amount</dt><dd>{money(entry.amount)}</dd>
          {allocations.map((a, i) => <div className="receipt-detail-item" key={i}><dt>{a.kind === 'profit' ? 'Company profit' : contracts.find((c) => c.id === a.contractId)?.name ?? a.contractName}</dt><dd>{money(a.amount)}</dd></div>)}
          <dt>Unallocated</dt><dd>{money(unallocated)}</dd><dt>Returned</dt><dd>{money(entry.returnedAmount ?? 0)}</dd>
        </dl>
        {returns.map((t) => <p key={t.id}>Return · {money(t.amount)} · {new Date(t.createdAt).toLocaleString()} · {t.active ? 'Active' : 'Deactivated'}</p>)}
      </details>
      {saved && <p role="status">Return recorded. Close and refresh if the balances have not updated.</p>}
      {entry.active && unallocated > 0 && !returning && !saved && <button type="button" className="btn" disabled={busy} onClick={() => setReturning(true)}>Return unallocated money</button>}
      {returning && <form className="flex-col gap-sm" onSubmit={(event) => { event.preventDefault(); void saveReturn(); }}>
        <p>This records a debit linked to this receipt. To return allocated money, remove its allocation first.</p>
        <label className="field"><span>Return amount</span><input required disabled={busy} type="number" inputMode="decimal" min="0.01" max={unallocated} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} /></label>
        <label className="field"><span>Return description</span><textarea disabled={busy} maxLength={4000} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
        <div className="flex-row flex-wrap gap-sm"><button type="button" className="btn" disabled={busy} onClick={() => setReturning(false)}>Cancel return</button><button className="btn btn--primary" disabled={busy || Number(amount) <= 0 || Number(amount) > unallocated}>Confirm return</button></div>
      </form>}
    </>}
    {error && <p role="alert" className="text-error">{error}</p>}
  </section>;
}
