import { Icon } from '../../../Icon';
import { useEffect, useRef, useState } from 'react';
import type { AdminUser, Attachment, Contract, CreditUser, Head, Transaction, UserOverview } from '../types';
import { ReceiptContractPicker } from './ReceiptContractPicker';
import { permittedHeads } from '../utils/permissions';
import { cashbookApi } from '../../../data/cashbookApi';
import { AttachmentInput } from './AttachmentInput';
import { Dialog } from './Dialog';
import { TransactionCard } from '../../Ledger/TransactionCard';
import { creditDocument } from '../../Ledger/ledgerExport';
import { ReportActions } from '../../Ledger/ReportActions';
import { creditUserScope, ledgerReport, money } from '../../Ledger/ledgerModel';
import { adminPayableBalance } from '../utils/adminPayable';

type Screen = 'home' | 'heads' | 'contracts' | 'images' | 'voice' | 'description' | 'review';
const ignoreChange = (_value: boolean) => {};

export function UserPreview({ user, heads, assigned, pending, onClose, preview = true, adminCredit = false, creditUser, transactionLabel = 'Credit', onSubmitted, onRefresh,
  onDirtyChange = ignoreChange, onBusyChange = ignoreChange, adminBill = false, adminPayable }: {
  user: AdminUser; heads: Head[]; assigned: number[]; pending: boolean; onClose: () => void;
  preview?: boolean;
  adminCredit?: boolean;
  adminBill?: boolean;
  adminPayable?: 'add' | 'pay';
  creditUser?: CreditUser;
  transactionLabel?: string;
  onRefresh?: () => Promise<void>;
  onSubmitted?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [ledgerOpen, showLedger] = useState(false);
  const swipeStart = useRef<{ x: number; y: number; id: number } | null>(null);
  const swiped = useRef(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [openedCredit, setOpenedCredit] = useState<Transaction | null>(null);
  const [overview, setOverview] = useState<UserOverview | null>(null);
  const [contractData, setContractData] = useState<{ contracts: Contract[]; transactions: Transaction[] }>({ contracts: [], transactions: [] });
  const [contractId, setContractId] = useState('');
  const linkedContracts = contractData.contracts.filter((contract) => contract.creditUserIds.includes(creditUser?.credit_user_id ?? ''));
  const selectedContract = linkedContracts.find((contract) => contract.id === contractId);
  const [screen, setScreen] = useState<Screen>('home');
  const adminEntry = adminCredit || adminBill || !!adminPayable;
  const directEntry = adminCredit || !!adminPayable;
  const [amount, setAmount] = useState(preview && !adminEntry ? '1000' : '');
  const [search, setSearch] = useState('');
  const [description, setDescription] = useState('');
  const [path, setPath] = useState<number[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(true);
  const previewOnly = preview && !adminEntry;
  const visible = adminCredit ? heads.filter((head) => head.is_active) : permittedHeads(heads, assigned);
  const headId = path.at(-1);
  const selectedHead = visible.find((head) => head.head_id === headId);
  const visibleIds = new Set(visible.map((head) => head.head_id));
  const children = visible.filter((head) => headId === undefined
    ? head.parent_head_id === null || !visibleIds.has(head.parent_head_id)
    : head.parent_head_id === headId).sort((a, b) => a.head_name.localeCompare(b.head_name));
  const amountValid = amount.trim() !== '' && Number.isSafeInteger(Number(amount)) && Number(amount) > 0 && Number(amount) <= 999999999999;
  const validContract = !contractId || !!selectedContract?.isActive;
  const validPersonal = adminPayable !== 'pay' || Number(amount) <= (overview?.balance ?? 0);
  const valid = amountValid && validContract && validPersonal && (directEntry || !!selectedHead?.is_transactionable);
  const dirty = !previewOnly && (amount !== '' || description !== '' || attachments.length > 0 || screen !== 'home');
  const locked = busy || attachmentBusy;
  const title = screen === 'heads'
    ? selectedHead?.head_name ?? (headId === undefined ? 'Choose a head' : 'Head unavailable')
    : screen === 'contracts' ? 'Choose a contract' : screen === 'images' ? 'Images' : screen === 'voice' ? 'Voice notes' : screen === 'description' ? 'Description' : 'Review transaction';
  const choices = children.filter((head) => `${head.head_name} ${head.head_description ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
    .map((head) => ({ id: head.head_id, name: head.head_name, image: head.image_url }));

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(locked); }, [locked, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    let ignore = false;
    setRefreshing(true);
    const request = adminPayable ? cashbookApi.ledger().then(({ transactions }) => {
      const balance = adminPayableBalance(transactions, user.user_id);
      return { balance, totalReceived: 0, totalBillPayment: balance, remainingPayable: balance, credits: [] };
    }) : creditUser ? cashbookApi.ledger().then(({ transactions, contracts = [] }) => {
      if (!ignore) setContractData({ transactions, contracts });
      const report = ledgerReport(transactions, { dateFrom: '', dateTo: '', direction: 'both',
        userScope: creditUserScope(creditUser.credit_user_id) }, 'by-time', [], true);
      return { balance: report.closing, totalReceived: report.credit, totalBillPayment: report.debit,
        remainingPayable: -report.closing, credits: [] };
    }) : cashbookApi.userOverview(user.user_id);
    request.then((data) => {
      if (!ignore) { setOverview(data); setError(''); }
    }).catch((error) => { if (!ignore) setError(error instanceof Error ? error.message : 'Could not load your balance.'); })
      .finally(() => { if (!ignore) setRefreshing(false); });
    return () => { ignore = true; };
  }, [user.user_id, creditUser?.credit_user_id, reload, adminPayable]);

  function go(next: Screen) { setSearch(''); setError(''); setScreen(next); }
  function back() {
    if (locked) return;
    if (screen === 'heads' && path.length) { setPath((current) => current.slice(0, -1)); setSearch(''); setError(''); }
    else go(screen === 'heads' || screen === 'contracts' ? 'home'
      : screen === 'images' ? directEntry ? creditUser && linkedContracts.length ? 'contracts' : 'home' : 'heads' : screen === 'voice' ? 'images' : screen === 'description' ? 'voice' : 'description');
  }
  async function submit() {
    if (previewOnly || !valid || pending || !user.is_active || locked) return;
    setBusy(true); setError('');
    try {
      const input = { amount: Number(amount), description, headId: directEntry ? null : headId!, attachments };
      if (adminPayable === 'add') await cashbookApi.addAdminPayable(user.user_id, input);
      else if (adminPayable === 'pay') await cashbookApi.payAdminPayable(user.user_id, input);
      else if (adminBill) await cashbookApi.recordUserBill(user.user_id, input);
      else if (adminCredit) await cashbookApi.creditUser(user.user_id, input, creditUser?.credit_user_id, contractId || undefined);
      else await cashbookApi.submitTransaction(user.user_id, input);
      setScreen('home'); setAmount(''); setDescription(''); setPath([]); setAttachments([]); setContractId(''); setSuccess(true);
      setReload((value) => value + 1);
      await onSubmitted?.();
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not submit. Your input has been kept.'); }
    finally { setBusy(false); }
  }
  function updateAttachments(kind: Attachment['kind'], items: Attachment[]) {
    setAttachments((current) => [...current.filter((item) => item.kind !== kind), ...items]);
  }

  return <div className="user-preview flex-col gap-md">
    <header className="preview-toolbar flex-row items-center justify-between gap-sm">
      <span className="hint text-muted">{adminEntry ? `${transactionLabel} · ${creditUser?.user_name ?? user.user_name}` : preview ? `Preview · ${user.user_name}` : 'Cashbook'}</span>
      <div className="flex-row items-center gap-sm">
      <button className="btn" disabled={locked || refreshing} onClick={async () => {
        setRefreshing(true);
        try { await onRefresh?.(); setReload((value) => value + 1); }
        catch (error) { setError((error as Error).message); setRefreshing(false); }
      }}>
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      <button className="btn" disabled={locked}
        onClick={() => !preview && dirty ? setConfirmLogout(true) : onClose()}
        aria-label={creditUser ? 'Back to external users' : adminEntry ? 'Close transaction workflow' : preview ? 'Close user preview' : 'Logout'}
        title={creditUser ? 'Back to external users' : adminEntry ? 'Close transaction workflow' : preview ? 'Exit preview' : 'Logout'}>
        {creditUser ? '← External users' : adminEntry ? 'Close' : preview ? 'Exit preview' : 'Logout'}
      </button>
      </div>
    </header>
    {previewOnly && <p role="status" className="hint">Preview only. Uploads and transaction submission are disabled.</p>}
    {pending && <p role="status" className="hint">Preview includes unapplied permissions.</p>}
    {!user.is_active && <p role="status">This account is deactivated and cannot transact.</p>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {!overview ? <>
      <p role="status">{error ? 'Balance unavailable.' : 'Loading balance…'}</p>
      {error && <button className="btn" disabled={refreshing} onClick={() => setReload((value) => value + 1)}>Retry</button>}
    </> : <div className={adminEntry ? '' : `user-swipe${ledgerOpen ? ' user-swipe--ledger' : ''}`}
      onPointerDown={(event) => {
        swiped.current = false;
        swipeStart.current = null;
        if (adminEntry || !event.isPrimary || event.pointerType === 'mouse' ||
          (event.target as HTMLElement).closest('input, textarea, select, audio')) return;
        swipeStart.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
      }}
      onPointerMove={(event) => {
        const start = swipeStart.current;
        if (!start || start.id !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dy) > 20 && Math.abs(dy) > Math.abs(dx)) swipeStart.current = null;
        else if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
          showLedger(dx > 0);
          swiped.current = true;
          swipeStart.current = null;
        }
      }}
      onPointerUp={() => { swipeStart.current = null; }}
      onPointerCancel={() => { swipeStart.current = null; }}
      onClickCapture={(event) => {
        if (swiped.current) { event.preventDefault(); event.stopPropagation(); swiped.current = false; }
      }}>
      <section inert={!adminEntry && ledgerOpen} aria-hidden={!adminEntry && ledgerOpen}
        className="user-pane user-workspace flex-col gap-md" aria-label="User screen" aria-busy={locked}>
      {!adminEntry && <div className="flex-row items-center justify-between gap-sm">
        <button className="btn" onClick={() => showLedger(true)}>← Your ledger</button>
        {screen === 'home' && <span className="hint text-muted">Swipe right</span>}
      </div>}
      {screen !== 'home' && <header className="user-screen-header flex-row items-center gap-sm">
        <button className="btn user-back" disabled={locked} onClick={back} aria-label="Back" title="Back">←</button>
        <h2>{title}</h2>
      </header>}
      {screen === 'home' && <>
        {success && <p role="status">{creditUser ? 'Credit recorded successfully.' : 'Transaction sent successfully.'}</p>}
        <article className="user-card-panel home-card--gold balance-card flex-col gap-sm">
          <h2>{adminPayable ? 'Admin payable remaining' : creditUser ? `${creditUser.user_name} · Balance` : adminBill ? 'User’s total bills' : adminCredit ? user.role === 'admin' ? 'Company balance' : 'User’s total credits' : 'Remaining balance'}</h2>
          <p className="balance-value"><span>{money(adminBill ? overview.totalBillPayment : adminCredit && user.role !== 'admin' ? overview.totalReceived : overview.balance)}</span></p>
        </article>
        <form className="flex-col gap-md" onSubmit={(event) => {
          event.preventDefault();
          if (amountValid && validPersonal && user.is_active) { setSuccess(false); go(directEntry ? creditUser && linkedContracts.length ? 'contracts' : 'images' : 'heads'); }
        }}>
          <label className="user-card-panel home-card--blue field amount-card">
            <span>Enter amount (PKR)</span>
            <input type="text" inputMode="numeric" pattern="[0-9]+" maxLength={12} required value={amount}
              onChange={(event) => { if (/^\d*$/.test(event.target.value)) setAmount(event.target.value); }} placeholder="0" aria-label="Enter amount in PKR" />
          </label>
          {!validPersonal && <p role="alert">The payment exceeds the remaining Admin payable amount.</p>}
          <button className="btn btn--primary user-next" disabled={!amountValid || !validPersonal || !user.is_active}>Next</button>
        </form>
      </>}
      {screen === 'contracts' && creditUser && <>
        <ReceiptContractPicker contracts={linkedContracts} transactions={contractData.transactions} payerId={creditUser.credit_user_id} amount={Number(amount)} selectedId={contractId}
          onSelect={(id) => { setContractId(id); go('images'); }} />
        <button className="btn user-next" onClick={() => { setContractId(''); go('images'); }}>Skip · Direct credit</button>
      </>}
      {(screen === 'heads') && <>
        {screen === 'heads' && selectedHead?.is_transactionable &&
          <button className="btn btn--primary user-next" disabled={!user.is_active || !amountValid}
            onClick={() => go('images')}>Make a new transaction</button>}
        {children.length > 0 && <input type="search" name="workflow-head-search" autoComplete="off"
          aria-label="Search heads" placeholder="Search heads…" value={search} onChange={(event) => setSearch(event.target.value)} />}
        {children.length > 0 && choices.length === 0 && <p className="text-muted">No matching heads.</p>}
        <div className="user-card-list">
          {choices.map((item, index) => <button key={item.id} className={`home-card home-card--${['blue', 'gold', 'green', 'purple'][index % 4]}`} onClick={() => {
            setPath((current) => [...current, item.id]); setSearch(''); setError('');
          }}>
            <span className="user-card-art" aria-hidden="true">
              {item.image ? <img src={item.image} alt="" /> :
                <Icon size={46}>
                  <path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z" />
                </Icon>}
            </span>
            <span className="user-card-label">{item.name}</span>
          </button>)}
        </div>
        {screen === 'heads' && !children.length && !selectedHead?.is_transactionable &&
          <p className="text-muted empty-state">{headId === undefined ? 'No heads available yet.' : 'No transactions or subheads available here.'}</p>}
      </>}
      {(screen === 'images' || screen === 'voice') && <>
        <div className="user-card-panel flex-col gap-md">
          <p className="hint text-muted">Optional</p>
          <AttachmentInput key={screen} kind={screen === 'images' ? 'image' : 'voice'}
            items={attachments.filter((item) => item.kind === (screen === 'images' ? 'image' : 'voice'))}
            onChange={previewOnly ? undefined : (items) => updateAttachments(screen === 'images' ? 'image' : 'voice', items)} onBusyChange={setAttachmentBusy} />
        </div>
        <button className="btn btn--primary user-next" disabled={locked} onClick={() => go(screen === 'images' ? 'voice' : 'description')}>
          {attachments.some((item) => item.kind === (screen === 'images' ? 'image' : 'voice')) ? 'Next' : 'Skip'}
        </button>
      </>}
      {screen === 'description' && <>
        <div className="user-card-panel"><label className="field"><span>Description (optional)</span><textarea maxLength={4000} value={description} onChange={(event) => setDescription(event.target.value)} /></label></div>
        <button className="btn btn--primary user-next" onClick={() => go('review')}>Review transaction</button>
      </>}
      {screen === 'review' && <>
        <div className="user-card-panel flex-col gap-md">
          <dl className="review-details">
            {adminEntry && <><dt>{adminBill ? 'Recorded for' : creditUser ? 'Received from' : 'Recipient'}</dt><dd>{creditUser?.user_name ?? user.user_name}</dd></>}
            {creditUser && <><dt>Contract</dt><dd>{contractId ? selectedContract?.name ?? 'Contract unavailable' : 'Direct credit'}</dd></>}
            <dt>Amount</dt><dd>{money(Number(amount))}</dd>
            <dt>Description</dt><dd>{description || '—'}</dd>
            {!directEntry && <><dt>Head</dt><dd>{selectedHead?.head_name ?? 'Head no longer available'}</dd></>}
            {adminPayable && <><dt>Entry type</dt><dd>{adminPayable === 'add' ? 'Admin payable added' : 'Admin payable paid'}</dd></>}
          </dl>
          {!valid && <p role="alert">{adminCredit ? 'Go back and check the amount.' : 'Go back and check the amount and head.'}</p>}
          {!validContract && <p role="alert">Go back and choose an active contract, or skip for a direct credit.</p>}
        </div>
        {(['image', 'voice'] as const).map((kind) => attachments.some((item) => item.kind === kind) &&
          <div className="user-card-panel flex-col gap-sm" key={kind}>
            <h3>{kind === 'image' ? 'Images' : 'Voice notes'}</h3>
            <AttachmentInput kind={kind} items={attachments.filter((item) => item.kind === kind)} />
          </div>)}
        <button className="btn btn--primary user-next" disabled={previewOnly || locked || !valid || pending || !user.is_active}
          onClick={submit}>{busy ? 'Recording…' : adminPayable === 'add' ? 'Add Admin payable' : adminPayable === 'pay' ? 'Record Admin payable payment' : adminBill ? 'Record user credit' : creditUser ? 'Record credit' : 'Send transaction'}</button>
      </>}
      </section>
      {!adminEntry && <section inert={!ledgerOpen} aria-hidden={!ledgerOpen}
        className="user-pane user-pane--ledger user-workspace flex-col gap-md" aria-label="Your credits ledger">
        <header className="flex-row items-center justify-between gap-sm">
          <h2>Your ledger</h2>
          <button className="btn" onClick={() => showLedger(false)}>Transaction →</button>
        </header>
        <div className="flex-row flex-wrap gap-sm">
          <ReportActions getReport={() => creditDocument(overview, user.user_name)} />
        </div>
        <dl className="user-card-panel flex-col gap-md">
          <div><dt>Total received</dt><dd className="credit-amount">{money(overview.totalReceived)}</dd></div>
          <div><dt>Total paid</dt><dd>{money(overview.totalBillPayment)}</dd></div>
          <div><dt>Remaining balance</dt><dd className="credit-amount">{money(overview.balance)}</dd></div>
        </dl>
        {!overview.credits.length && <p className="text-muted empty-state">No credits received yet.</p>}
        {overview.credits.map((credit) => <button key={credit.id} className="user-card-panel credit-card flex-col gap-sm" onClick={() => setOpenedCredit(credit)}>
          <div className="flex-row items-center justify-between gap-sm">
            <span>Credit received</span>
            <strong className="credit-amount">+{money(credit.amount)}</strong>
          </div>
          <time className="hint text-muted" dateTime={credit.createdAt}>{new Date(credit.createdAt).toLocaleString()}</time>
          {(credit.headPath || credit.description) && <span className="hint text-muted">{[credit.headPath, credit.description].filter(Boolean).join(' · ')}</span>}
          {credit.attachments.length > 0 && <span className="hint">{credit.attachments.length} attachments</span>}
        </button>)}
      </section>}
    </div>}
    {openedCredit && <TransactionCard key={openedCredit.id} entry={openedCredit} heads={heads}
      onClose={() => setOpenedCredit(null)} />}
    {confirmLogout && <Dialog title="Discard draft and log out?" onClose={() => setConfirmLogout(false)}>
      <p>Your transaction has not been sent yet.</p>
      <div className="flex-row justify-end gap-sm">
        <button className="btn" onClick={() => setConfirmLogout(false)}>Keep editing</button>
        <button className="btn btn--primary" onClick={onClose}>Discard and log out</button>
      </div>
    </Dialog>}
  </div>;
}
