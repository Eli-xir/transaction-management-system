import { useCallback, useState } from 'react';
import type { Contract, ReceiptAllocation, Transaction, TransactionInput, PortionDetails } from '../Admin/types';
import { AttachmentInput } from '../Admin/components/AttachmentInput';
import { money } from './ledgerModel';
import { receiptAllocations, unallocatedAmount } from './receiptModel';

export function ReceiptAllocationEditor({ entry, amount, contracts, values, onChange, input, details, onDetailsChange, locked, busy, imageBusy, voiceBusy, onBusyChange }: {
  input: TransactionInput; details: Record<string, PortionDetails>; onDetailsChange: (value: Record<string, PortionDetails>) => void;
  locked: boolean; busy: boolean; imageBusy: boolean; voiceBusy: boolean; onBusyChange: (kind: 'image' | 'voice', value: boolean) => void;
  entry: Transaction; amount: number; contracts: Contract[]; values: ReceiptAllocation[]; onChange: (values: ReceiptAllocation[]) => void;
}) {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState('');
  const [customizing, setCustomizing] = useState(entry.focusedPortionKey ?? '');
  const linked = contracts.filter((c) => c.creditUserIds.includes(entry.creditUserId ?? '') && (c.isActive || values.some((a) => a.contractId === c.id)));
  const unallocated = unallocatedAmount(amount, values, entry.returnedAmount);
  const available = linked.filter((c) => c.isActive && !values.some((a) => a.contractId === c.id) && `${c.name} ${c.description}`.toLowerCase().includes(search.toLowerCase()));
  return <section className="flex-col gap-sm" aria-label="Receipt allocations">
    <fieldset disabled={locked} className="field flex-col gap-sm"><h3>Allocate this receipt</h3>
    <p className="hint">Split the receipt across linked contracts and company profit. Each portion uses receipt details until you customize it.</p>
    {values.map((allocation, index) => <div key={`${allocation.kind}:${allocation.contractId ?? ''}`} className="receipt-allocation-row flex-row flex-wrap items-center gap-sm">
      <label className="field"><span>{allocation.kind === 'profit' ? 'Company profit' : linked.find((c) => c.id === allocation.contractId)?.name ?? allocation.contractName ?? 'Contract'}</span>
        <input aria-label={`Allocation amount ${index + 1}`} type="number" inputMode="decimal" required min="0.01" max="999999999999.99" step="0.01" value={Number.isNaN(allocation.amount) ? '' : allocation.amount}
          onChange={(event) => onChange(values.map((a, i) => i === index ? { ...a, amount: event.target.valueAsNumber } : a))} /></label>
      <button type="button" className="btn" aria-label={`Remove allocation ${index + 1}`} onClick={() => { onChange(values.filter((_, i) => i !== index)); const key = allocation.kind === 'contract' ? `contract:${allocation.contractId}` : 'profit'; const next = { ...details }; delete next[key]; onDetailsChange(next); if (customizing === key) setCustomizing(''); }}>Remove</button>
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
    <h3>Details for each portion</h3>
    {[...values.map(a => ({ key: a.kind === 'contract' ? `contract:${a.contractId}` : 'profit', label: a.kind === 'profit' ? 'Company profit' : linked.find(c => c.id === a.contractId)?.name ?? a.contractName ?? 'Contract' })), ...(unallocated > 0 ? [{ key: 'direct', label: 'Direct receipt' }] : [])].map(part => <button type="button" className="btn" key={part.key} aria-expanded={customizing === part.key} onClick={() => setCustomizing(customizing === part.key ? '' : part.key)}>{part.label} · {Object.values(details[part.key] ?? {}).some(v => v != null) ? 'Customized details' : 'Uses receipt details'}</button>)}
    </fieldset>
    {customizing && <PortionEditor key={customizing} value={details[customizing] ?? {}} input={input} locked={locked} busy={busy} imageBusy={imageBusy} voiceBusy={voiceBusy} onBusyChange={onBusyChange} onChange={value => onDetailsChange({ ...details, [customizing]: value })} />}

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

function PortionEditor({ value, input, locked, busy, imageBusy, voiceBusy, onBusyChange, onChange }: {
  value: PortionDetails; input: TransactionInput; locked: boolean; busy: boolean; imageBusy: boolean; voiceBusy: boolean;
  onBusyChange: (kind: 'image' | 'voice', value: boolean) => void; onChange: (value: PortionDetails) => void;
}) {
  const [ownKind, setOwnKind] = useState<'image' | 'voice' | null>(null);
  const imageChanged = useCallback((value: boolean) => { setOwnKind(previous => value ? 'image' : previous === 'image' ? null : previous); onBusyChange('image', value); }, [onBusyChange]);
  const voiceChanged = useCallback((value: boolean) => { setOwnKind(previous => value ? 'voice' : previous === 'voice' ? null : previous); onBusyChange('voice', value); }, [onBusyChange]);
  return <section className="disclosure flex-col gap-sm" aria-label="Portion details editor">
    <p>Changes here apply only to this portion. Other fields continue using receipt details.</p>
    <label className="field"><span>Portion description</span><textarea aria-label="Portion description" disabled={locked} maxLength={4000} value={value.description ?? input.description ?? ''} onChange={e => onChange({ ...value, description: e.target.value })} /></label>
    <div className="flex-row items-center gap-sm"><small>{value.description == null ? 'Using receipt description' : 'Own description'}</small>{value.description != null && <button type="button" className="btn" disabled={locked} onClick={() => onChange({ ...value, description: null })}>Use receipt description</button>}</div>
    {(['image', 'voice'] as const).map(kind => {
      const field = kind === 'image' ? 'images' : 'voice';
      const items = value[field] ?? input.attachments.filter(a => a.kind === kind);
      return <section className="flex-col gap-sm" key={kind}>
        <h4>Portion {kind === 'image' ? 'images' : 'voice notes'}</h4>
        <div className="flex-row items-center gap-sm"><small>{value[field] == null ? 'Using receipt attachments' : 'Own attachments'}</small>{value[field] != null && <button type="button" className="btn" disabled={locked} onClick={() => onChange({ ...value, [field]: null })}>Use receipt {kind === 'image' ? 'images' : 'voice notes'}</button>}</div>
        <div inert={busy || ((imageBusy || voiceBusy) && ownKind !== kind)}><AttachmentInput kind={kind} items={items} onBusyChange={kind === 'image' ? imageChanged : voiceChanged} onChange={items => onChange({ ...value, [field]: items })} /></div>
      </section>;
    })}
  </section>;
}
