import { useState } from 'react';
import type { AdminUser, Contract, CreditUser, FiltersState, Head, Transaction } from '../types';
import { contractBalance, contractContributions } from '../utils/contractBalances';
import { matchesUser } from '../utils/userProfile';
import { money } from '../../Ledger/ledgerModel';
import { Ledger } from '../../Ledger/Ledger';
import { HomeCard } from './HomeCard';
import { ContractEditor } from './ContractEditor';
import { PaymentDialog } from './PaymentDialog';
import { cashbookApi } from '../../../data/cashbookApi';
import { Icon } from '../../../Icon';

export function ContractDetails({ contract, transactions, creditUsers, users, heads, adminId, backLabel, onBack, onDeleted, onRefresh, onDirtyChange, onBusyChange }: {
  backLabel: string;
  contract: Contract; transactions: Transaction[]; creditUsers: CreditUser[]; users: AdminUser[]; heads: Head[]; adminId: string;
  onBack: () => void; onDeleted: () => void; onRefresh: () => Promise<void>; onDirtyChange: (dirty: boolean) => void; onBusyChange: (busy: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [payer, setPayer] = useState<CreditUser | null>(null);
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState<string | null>(null);
  const [filters, setFilters] = useState<FiltersState>({ dateFrom: '', dateTo: '', userScope: 'all', direction: 'both' });
  const [action, setAction] = useState<'archive' | 'reactivate' | 'delete' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const totals = contractBalance(contract, transactions);
  const contributions = contractContributions(contract.id, transactions);
  const linked = creditUsers.filter((user) => contract.creditUserIds.includes(user.credit_user_id));
  const visible = linked.filter((user) => matchesUser(user, search) && (status === 'all' || user.is_active === (status === 'active')));
  async function applyAction() {
    if (!action || busy) return;
    setBusy(true); onBusyChange(true); setError('');
    try {
      await cashbookApi.contractAction(contract.id, contract.revision, action);
      await onRefresh(); setAction(null);
      if (action === 'delete') onDeleted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update the contract.'); }
    finally { setBusy(false); onBusyChange(false); }
  }
  return <section className="flex-col gap-md">
    <header className="flex-row flex-wrap items-center gap-sm"><button className="btn" disabled={busy} onClick={statement !== null ? () => setStatement(null) : onBack}>← {statement !== null ? 'Back to contract' : backLabel}</button><h1>{contract.name}</h1></header>
    {contract.description && <p>{contract.description}</p>}
    {!contract.isActive && <p>Archived contract · Receipts are disabled until reactivated.</p>}
    <dl className="ledger-totals"><div><dt>Contract amount</dt><dd>{money(contract.totalAmount)}</dd></div><div><dt>Total received</dt><dd>{money(totals.received)}</dd></div><div><dt>{totals.remaining < 0 ? 'Overpaid · Payable' : 'Remaining receivable'}</dt><dd>{money(Math.abs(totals.remaining))}</dd></div></dl>
    {statement !== null ? <Ledger key={`${contract.id}:${statement}`} contract={contract} contractUserId={statement || undefined} company filters={filters} onFilterChange={setFilters}
      revision={0} users={users} heads={heads} onChanged={onRefresh} onDirtyChange={onDirtyChange} /> : <>
      <div className="flex-row flex-wrap gap-sm"><button className="btn" onClick={() => setEditing(true)}>Edit contract / linked users</button><button className="btn" onClick={() => setStatement('')}>View contract statement</button>
        <button className="btn" disabled={busy} onClick={() => setAction(contract.isActive ? 'archive' : 'reactivate')}>{contract.isActive ? 'Archive' : 'Reactivate'}</button>
        <button className="btn" disabled={busy} onClick={() => setAction('delete')}>Delete contract</button></div>
      <div className="flex-row flex-wrap items-center gap-sm"><label className="field"><span>Search linked users</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
        <label className="field"><span>User status</span><select aria-label="Linked user status" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All linked users</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <button className="btn" onClick={() => { setSearch(''); setStatus('all'); }}>Clear filters</button></div>
      <p>Each user’s amount is their total paid toward this contract.</p>
      <div className="home-cards">{visible.map((user) => <HomeCard key={user.credit_user_id} title={user.user_name} description={user.description} detail={user.is_active ? 'Linked external user' : 'Inactive external user'} accountType="external" tone="blue"
        amount={`${money(contributions.get(user.credit_user_id) ?? 0)} paid`}
        icon={<Icon size={42}><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></Icon>}
        onClick={() => { if (user.is_active && contract.isActive) setPayer(user); else setStatement(user.credit_user_id); }}
        actions={<div className="flex-row flex-wrap gap-sm"><button className="btn" onClick={() => setStatement(user.credit_user_id)}>View statement</button>
          <button className="btn" disabled={!user.is_active || !contract.isActive} onClick={() => setPayer(user)}>Receive payment</button></div>} />)}</div>
      {!visible.length && <p role="status">No linked users match these filters.</p>}
    </>}
    {action && <div className="disclosure flex-col gap-sm"><p>{action === 'delete' ? 'Delete this contract? Only contracts with no receipt history can be deleted.' : action === 'archive' ? 'Archive this contract? Its history and outstanding amount will remain visible, but new receipts will be disabled.' : 'Reactivate this contract to accept payments?'}</p><div className="flex-row gap-sm"><button className="btn" disabled={busy} onClick={() => setAction(null)}>Cancel</button><button className="btn" disabled={busy} onClick={() => void applyAction()}>{busy ? 'Saving…' : 'Confirm'}</button></div></div>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {editing && <ContractEditor contract={contract} users={creditUsers} onClose={() => setEditing(false)} onRefresh={onRefresh} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />}
    {payer && <PaymentDialog userId={adminId} name={payer.user_name} creditUserId={payer.credit_user_id} contract={contract} remaining={totals.remaining} onClose={() => setPayer(null)} onRefresh={onRefresh} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />}
  </section>;
}
