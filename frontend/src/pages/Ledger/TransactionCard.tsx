import { AttachmentExport } from './AttachmentExport';
import { useCallback, useState } from 'react';
import type { AdminUser, Contract, CreditUser, Head, PortionDetails, ReceiptAllocation, Transaction, TransactionInput } from '../Admin/types';
import { Dialog } from '../Admin/components/Dialog';
import { AttachmentInput } from '../Admin/components/AttachmentInput';
import { cashbookApi } from '../../data/cashbookApi';
import { ReceiptContractPicker } from '../Admin/components/ReceiptContractPicker';
import { direction, headPath, historyOf, money } from './ledgerModel';
import './Ledger.css';
import { adminPayableLabel } from '../Admin/utils/adminPayable';
import { ReceiptAllocationEditor, ReceiptDetails } from './ReceiptAllocations';
import { receiptAllocations, portionValues } from './receiptModel';

export function TransactionCard({ entry, admin = false, company = false, heads = [], users = [], creditUsers = [], contracts = [], transactions = [], initialUserId = '', onClose, onChanged }: {
  transactions?: Transaction[];
  contracts?: Contract[];
  entry?: Transaction; admin?: boolean; company?: boolean; heads?: Head[]; users?: AdminUser[]; creditUsers?: CreditUser[];
  initialUserId?: string; onClose: () => void; onChanged?: () => Promise<void>;
}) {
  const [current, setCurrent] = useState(entry);
  const [editing, setEditing] = useState(!entry);
  const [contractId, setContractId] = useState('');
  const [portionDetails, setPortionDetails] = useState<Record<string, PortionDetails>>(entry?.portionDetails ?? {});
  const [customBusy, setCustomBusy] = useState(false);
  const [allocations, setAllocations] = useState<ReceiptAllocation[]>(() => entry ? receiptAllocations(entry) : []);
  const [input, setInput] = useState<TransactionInput>(() => entry ? {
    amount: entry.amount, headId: entry.headId, description: entry.description ?? '', attachments: entry.attachments,
    transactionTypeId: entry.transactionTypeId ?? 1,
  } : { amount: 0, headId: heads.find((head) => head.is_active && head.is_transactionable)?.head_id ?? 0,
    description: '', attachments: [], transactionTypeId: 1 });
  const [userId, setUserId] = useState(initialUserId);
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const handlePortionBusy = useCallback((kind: 'image' | 'voice', value: boolean) => {
    setCustomBusy(value); (kind === 'image' ? setImageBusy : setVoiceBusy)(value);
  }, []);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const locked = busy || imageBusy || voiceBusy;
  const shown = current?.focusedPortionKey ? portionValues(current, current.focusedPortionKey) : current;
  const userName = (id: string) => users.find((user) => user.user_id === id)?.user_name ?? 'Unavailable account';
  const entryUserName = (item: Transaction) => item.creditUserId
    ? creditUsers.find((user) => user.credit_user_id === item.creditUserId)?.user_name ?? 'Unavailable external user'
    : company && users.some((user) => user.user_id === item.userId && user.role === 'admin') ? 'Source not recorded' : userName(item.userId);
  const path = (id: number | null, saved?: string) => id === null ? '—' : saved || headPath(heads, id);
  async function save() {
    setBusy(true); setError('');
    try {
      const saved = current
        ? current.receiptKey && !current.receiptParentId
          ? await cashbookApi.editReceipt(current.id, input, historyOf(current).at(-1)!.versionId, allocations, portionDetails)
          : await cashbookApi.editTransaction(current.id, input, historyOf(current).at(-1)!.versionId, contractId || undefined)
        : await cashbookApi.creditUser(userId, input);
      setCurrent({ ...saved, focusedPortionKey: current?.focusedPortionKey }); setEditing(false); setContractId('');
      await onChanged?.();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not save.'); }
    finally { setBusy(false); }
  }
  async function action(action: 'deactivate' | 'reactivate' | 'delete') {
    if (!current) return;
    setBusy(true); setError('');
    try {
      const saved = await cashbookApi.transactionAction(current.id, action, historyOf(current).at(-1)!.versionId);
      if (saved) setCurrent(saved);
      setDeleting(false); await onChanged?.(); if (!saved) onClose();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not update.'); }
    finally { setBusy(false); }
  }
  return <Dialog title={current ? `${direction(current, company) === 'credit' ? 'Credit' : 'Debit'} · ${money(current.amount)}` : 'Credit a user'} onClose={onClose} busy={locked}>
    {current?.focusedPortionKey && <p>Viewing this portion’s details. Edit opens the receipt and its portions.</p>}
    {current && adminPayableLabel(current) && <p role="status">{adminPayableLabel(current)}</p>}
    {current?.contractId && <p>Contract: <strong>{contracts.find((contract) => contract.id === current.contractId)?.name ?? current.contractId}</strong></p>}
    {current?.receiptKey && !editing && <ReceiptDetails entry={current} contracts={contracts} />}
    {editing && admin ? <form className="flex-col gap-md" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <fieldset className="field flex-col gap-md" disabled={locked}>
        {!current && <label className="field"><span>User</span><select required value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">Choose user</option>{users.filter((user) => user.is_active && user.role !== 'admin').map((user) => <option key={user.user_id} value={user.user_id}>{user.user_name}</option>)}
        </select></label>}
        <label className="field"><span>Amount</span><input type="number" min="0" max="999999999999.99" step="0.01" required value={Number.isNaN(input.amount) ? '' : input.amount}
          onChange={(event) => setInput({ ...input, amount: event.target.valueAsNumber })} /></label>
        {input.headId !== null && <label className="field"><span>Head</span><select required value={input.headId ?? 0} onChange={(event) => setInput({ ...input, headId: Number(event.target.value) })}>
          <option value="0" disabled>Choose a head</option>
          {!heads.some((head) => head.head_id === input.headId && head.is_active && head.is_transactionable) && input.headId !== 0 && <option value={input.headId} disabled>Choose an active transactionable head</option>}
          {heads.filter((head) => head.is_active && head.is_transactionable).map((head) => <option key={head.head_id} value={head.head_id}>{headPath(heads, head.head_id)}</option>)}
        </select></label>}

        {current?.creditUserId && !current.receiptKey && !current.contractId && <div className="flex-col gap-sm">
          <h3>Contract</h3>
          <p>{contractId ? `Assign to: ${contracts.find((contract) => contract.id === contractId)?.name ?? 'Contract unavailable'}` : 'Direct credit'}</p>
          {current.active ? <>
            <ReceiptContractPicker contracts={contracts} transactions={transactions} payerId={current.creditUserId} amount={input.amount} selectedId={contractId} onSelect={setContractId} />
            {contractId && <button type="button" className="btn" onClick={() => setContractId('')}>Keep as direct credit</button>}
          </> : <p>Reactivate this receipt before assigning it to a contract.</p>}
        </div>}
<label className="field"><span>Description</span><textarea aria-label="Description" maxLength={4000} value={input.description ?? ''} onChange={(event) => setInput({ ...input, description: event.target.value })} /></label>
      </fieldset>
      {current?.receiptKey && !current.receiptParentId && <ReceiptAllocationEditor entry={current} amount={input.amount} contracts={contracts} values={allocations} onChange={setAllocations} input={input} details={portionDetails} onDetailsChange={setPortionDetails} locked={locked} busy={busy} imageBusy={imageBusy} voiceBusy={voiceBusy} onBusyChange={handlePortionBusy} />}
      {(['image', 'voice'] as const).map((kind) => <section key={kind} className="flex-col gap-sm">
        <h3>{kind === 'image' ? 'Images' : 'Voice notes'}</h3>
        <div inert={busy || customBusy || (kind === 'image' ? voiceBusy : imageBusy)} className={busy || (kind === 'image' ? voiceBusy : imageBusy) ? 'ledger-attachment-disabled' : ''}>
          <AttachmentInput kind={kind} items={input.attachments.filter((item) => item.kind === kind)}
            onBusyChange={kind === 'image' ? setImageBusy : setVoiceBusy}
            onChange={(items) => setInput((previous) => ({ ...previous, attachments: [...previous.attachments.filter((item) => item.kind !== kind), ...items] }))} />
        </div>
      </section>)}
      <div className="flex-row justify-end gap-sm">
        <button type="button" className="btn" disabled={locked} onClick={() => current ? setEditing(false) : onClose()}>Cancel</button>
        <button className="btn btn--primary" disabled={locked}>{busy ? 'Saving…' : current ? 'Save new version' : 'Apply credit'}</button>
      </div>
    </form> : current && <>
      {admin && <AttachmentExport items={shown!.attachments} />}
      <dl className="review-details">
        <dt>Date/time</dt><dd>{new Date(current.createdAt).toLocaleString()}</dd>
        {admin && <><dt>User</dt><dd>{entryUserName(current)}</dd><dt>Entered by</dt><dd>{userName(current.createdBy)}</dd></>}
        {current.headId !== null && <><dt>Head</dt><dd>{path(current.headId, current.headPath)}</dd></>}
        <dt>Description</dt><dd>{shown!.description || '—'}</dd>
        <dt>Type</dt><dd>{current.receiptParentId ? 'Receipt return' : 'General'}</dd>
        {admin && <><dt>Status</dt><dd>{current.active ? 'Active' : 'Deactivated'}</dd></>}
      </dl>
      {(['image', 'voice'] as const).map((kind) => <section key={kind} className="flex-col gap-sm">
        <h3>{kind === 'image' ? 'Images' : 'Voice notes'}</h3>
        <AttachmentInput exportable={admin} kind={kind} items={shown!.attachments.filter((item) => item.kind === kind)} />
      </section>)}
      {admin && <div className="flex-row flex-wrap gap-sm">
        {!current.receiptParentId && <button className="btn" disabled={locked} onClick={() => { setInput({ amount: current.amount, headId: current.headId, description: current.description ?? '', attachments: current.attachments, transactionTypeId: current.transactionTypeId ?? 1 }); setContractId(''); setAllocations(receiptAllocations(current)); setPortionDetails(current.portionDetails ?? {}); setEditing(true); }}>Edit</button>}
        <button className="btn" disabled={locked} onClick={() => void action(current.active ? 'deactivate' : 'reactivate')}>{current.active ? 'Deactivate' : 'Reactivate'}</button>
        {!current.receiptParentId && <button className="btn btn--danger" disabled={locked} onClick={() => setDeleting(true)}>Delete</button>}
      </div>}
    </>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {deleting && <div className="flex-col gap-sm"><p>Permanently delete this transaction and its edit trail?</p><div className="flex-row gap-sm">
      <button className="btn" disabled={locked} onClick={() => setDeleting(false)}>Keep entry</button>
      <button className="btn btn--danger" disabled={locked} onClick={() => void action('delete')}>Confirm delete</button>
    </div></div>}
    {admin && current && <section className="flex-col gap-sm"><h3>Edit trail</h3>
      {[...historyOf(current)].reverse().map((version) => <details key={version.versionId} className="ledger-version">
        <summary>{version.action} · {money(version.amount)} · {new Date(version.recordedAt).toLocaleString()}</summary>
        <p className="hint">By {userName(version.editorId)} · {version.active ? 'Active' : 'Deactivated'}</p>
        <p>{current.creditUserId ? `Contract: ${version.contractId ? version.contractName || contracts.find((contract) => contract.id === version.contractId)?.name || version.contractId : 'Direct credit'}` : path(version.headId, version.headPath)} · {version.description}</p>
        {!!Object.keys(version.portionDetails ?? {}).length && <details><summary>Customized portion details</summary>{Object.entries(version.portionDetails ?? {}).map(([key, fields]) => <section key={key}><p>{key === 'direct' ? 'Direct receipt' : key === 'profit' ? 'Company profit' : contracts.find(c => `contract:${c.id}` === key)?.name ?? 'Contract'} · {fields.description == null ? 'Using receipt description' : fields.description || 'Empty description'}</p>{(['images','voice'] as const).map(kind => fields[kind] != null && <AttachmentInput key={kind} kind={kind === 'images' ? 'image' : 'voice'} items={fields[kind]!} />)}</section>)}</details>}
        {!!version.allocations?.length && <ul>{version.allocations.map((a, i) => <li key={i}>{a.kind === 'profit' ? 'Company profit' : a.contractName} · {money(a.amount)}</li>)}</ul>}
        {(['image', 'voice'] as const).map((kind) => <AttachmentInput key={kind} kind={kind} items={version.attachments.filter((item) => item.kind === kind)} />)}
      </details>)}
    </section>}
    <button className="btn" disabled={locked} onClick={onClose}>Close</button>
  </Dialog>;
}
