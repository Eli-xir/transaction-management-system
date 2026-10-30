import { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { AttachmentInput } from './AttachmentInput';
import { cashbookApi } from '../../../data/cashbookApi';
import { money } from '../../Ledger/ledgerModel';
import type { Attachment, Contract } from '../types';

export function PaymentDialog({ userId, name, creditUserId, contract, remaining, onClose, onRefresh, onDirtyChange, onBusyChange }: {
  userId: string; name: string; creditUserId: string; contract: Contract; remaining: number;
  onClose: () => void; onRefresh: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [discard, setDiscard] = useState(false);
  const dirty = !saved && !!(amount || description || attachments.length);
  const locked = busy || imageBusy || voiceBusy;
  const valid = /^\d+(\.\d{1,2})?$/.test(amount) && Number(amount) > 0 && Number(amount) <= 999999999999.99;
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(locked); return () => onBusyChange(false); }, [locked, onBusyChange]);
  function close() { if (locked) return; if (dirty) setDiscard(true); else onClose(); }
  async function submit() {
    if (!valid || locked || saved) return;
    setBusy(true); setError('');
    try {
      await cashbookApi.creditUser(userId, { amount: Number(amount), description, attachments, headId: null }, creditUserId, contract.id);
      setSaved(true); onDirtyChange(false);
      await onRefresh(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save the payment.'); }
    finally { setBusy(false); }
  }
  return <Dialog title={`Receive payment · ${name}`} onClose={close} busy={locked}>
    <p>Contract: <strong>{contract.name}</strong></p>
    <p>Contract {remaining < 0 ? 'payable' : 'remaining'}: <strong>{money(Math.abs(remaining))}</strong></p>
    {saved ? <><p role="status">Payment saved. If the balances did not refresh, close this window and press Refresh.</p><button className="btn" onClick={onClose}>Close</button></> : <form className="flex-col gap-md" onSubmit={(event) => { event.preventDefault(); if (valid) { if (review) void submit(); else setReview(true); } }}>
      {review ? <dl className="review-details"><dt>Received from</dt><dd>{name}</dd><dt>Amount</dt><dd>{money(Number(amount))}</dd><dt>Description</dt><dd>{description || '—'}</dd><dt>Attachments</dt><dd>{attachments.length}</dd></dl> : <>
        <label className="field"><span>Amount (PKR)</span><input required type="number" inputMode="decimal" min="0.01" max="999999999999.99" step="0.01" value={amount} disabled={locked} onChange={(event) => setAmount(event.target.value)} /></label>
        <label className="field"><span>Description</span><textarea maxLength={4000} value={description} disabled={locked} onChange={(event) => setDescription(event.target.value)} /></label>
        <div>{(['image', 'voice'] as const).map((kind) => <section key={kind} inert={busy || (kind === 'image' ? voiceBusy : imageBusy)}><h3>{kind === 'image' ? 'Images' : 'Voice notes'}</h3><AttachmentInput kind={kind} items={attachments.filter((item) => item.kind === kind)} onBusyChange={kind === 'image' ? setImageBusy : setVoiceBusy}
          onChange={(items) => setAttachments((current) => [...current.filter((item) => item.kind !== kind), ...items])} /></section>)}</div>
      </>}
      <div className="flex-row flex-wrap gap-sm"><button type="button" className="btn" disabled={locked} onClick={close}>Cancel</button>
        {review && <button type="button" className="btn" disabled={locked} onClick={() => setReview(false)}>Back to edit</button>}
        <button className="btn" disabled={!valid || locked}>{busy ? 'Saving…' : review ? 'Confirm receipt' : 'Review payment'}</button></div>
    </form>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {discard && <div className="flex-col gap-sm"><p>Discard this payment draft?</p><div className="flex-row gap-sm"><button className="btn" onClick={() => setDiscard(false)}>Keep editing</button><button className="btn" onClick={onClose}>Discard</button></div></div>}
  </Dialog>;
}
