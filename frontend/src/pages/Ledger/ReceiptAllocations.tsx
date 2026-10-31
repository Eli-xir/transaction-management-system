import { useState } from 'react';
import type { Contract, ReceiptAllocation, Transaction } from '../Admin/types';
import { money } from './ledgerModel';
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
    <p role="status" className={unallocated < 0 ? 'text-error' : undefined}>{unallocated < 0 ? `Overallocated by ${money(-unallocated)}` : `Remaining direct receipt: ${money(unallocated)}`}</p>
    {!!entry.returnedAmount && <p>Already returned: {money(entry.returnedAmount)}</p>}
  </section>;
}

export function ReceiptDetails({ entry, contracts }: { entry: Transaction; contracts: Contract[] }) {
  const allocations = receiptAllocations(entry);
  const remaining = unallocatedAmount(entry.amount, allocations, entry.returnedAmount);
  return <section className="flex-col gap-sm">
    <p>Receipt ID: <strong>{entry.receiptKey}</strong></p>
    {!entry.receiptParentId && allocations.length > 0 && <dl className="review-details">
      <dt>Receipt amount</dt><dd>{money(entry.amount)}</dd>
      {allocations.map((a, i) => <div className="receipt-detail-item" key={i}><dt>{a.kind === 'profit' ? 'Company profit' : contracts.find((c) => c.id === a.contractId)?.name ?? a.contractName}</dt><dd>{money(a.amount)}</dd></div>)}
      {remaining > 0 && <><dt>Direct receipt</dt><dd>{money(remaining)}</dd></>}
    </dl>}
  </section>;
}
