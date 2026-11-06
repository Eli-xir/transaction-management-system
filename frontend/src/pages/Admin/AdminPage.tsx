import { useState } from 'react';
import type { CashbookData, AdminUser, CreateUserInput, FiltersState, Head, StagedChange, UserAction, UserProfile } from './types';
import { HeadsTab } from './components/HeadsTab';
import { UsersTab } from './components/UsersTab';
import { PermissionChanges } from './components/PermissionChanges';
import { UserPreview } from './components/UserPreview';
import { UserPicker } from './components/UserPicker';
import { Dialog } from './components/Dialog';
import { AdminDebitFlow } from './components/AdminDebitFlow';
import { AdminPayablePage } from './components/AdminPayablePage';
import { adminPayableBalance } from './utils/adminPayable';
import { AdminCreditFlow } from './components/AdminCreditFlow';
import { UserCards } from './components/UserCards';
import { matchesUser } from './utils/userProfile';
import { CreditUserCards } from './components/CreditUserCards';
import { HomeNavigation } from './components/HomeNavigation';
import { OutstandingPage } from './components/OutstandingPage';
import { ContractList } from './components/ContractList';
import { ContractDetails } from './components/ContractDetails';
import { contractBalance } from './utils/contractBalances';
import { balanceTotal, outstandingBalances } from './utils/outstandingBalances';
import { usePermissionChanges } from './hooks/usePermissionChanges';
import { permissionDiff, permittedHeads } from './utils/permissions';
import { AttachmentsPage } from '../Ledger/AttachmentsPage';
import { Ledger } from '../Ledger/Ledger';
import { ledgerReport, money, roundMoney } from '../Ledger/ledgerModel';
import logo from '../../assets/logo.jpeg';
import './AdminPage.css';

interface AdminPageProps extends CashbookData {
  currentAdminUserId: string;
  onLogout: () => void;
  onRefresh: () => Promise<void>;
  onSubmitHeadChanges: (changes: StagedChange[]) => Promise<Head[]>;
  onSavePermissions: (userId: string, ids: number[]) => Promise<number[]>;
  onSaveProfile: (userId: string, profile: UserProfile) => Promise<void>;
  onCreateUser: (input: CreateUserInput) => Promise<AdminUser>;
  onChangePassword?: (userId: string, password: string) => Promise<void>;
  onUserAction?: (userId: string, action: UserAction) => Promise<void>;
}
const cards = [
  { id: 'admin-payable', title: 'Admin payable', icon: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h4', tone: 'gold' },
  { id: 'contracts', title: 'Contracts', icon: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h4', tone: 'blue' },
  { id: 'receivable', title: 'Receivable', icon: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', tone: 'green' },
  { id: 'payable', title: 'Payable', icon: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5', tone: 'gold' },
  { id: 'attachments', title: 'Attachments', icon: 'M21 11.5 12.5 20a6 6 0 0 1-8.5-8.5L13 2.5a4 4 0 0 1 5.5 5.5l-9 9a2 2 0 0 1-3-3L15 5', tone: 'blue' },
  { id: 'users', title: 'Users', icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0', tone: 'blue' },
  { id: 'company', title: 'Company Statement', icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M10 21v-4h4v4', tone: 'gold' },
  { id: 'statement', title: 'Users Statement', icon: 'M6 3h12v18H6zM9 7h6M9 11h6M9 15h2', tone: 'green' },
  { id: 'heads', title: 'Heads Management', icon: 'M3 6h6l2 2h10v12H3zM3 6V4h6l2 2M8 12h8M8 16h5', tone: 'purple' },
  { id: 'credit', title: 'Admin credit', icon: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', tone: 'green' },
  { id: 'user-credit', title: 'User debit', icon: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5', tone: 'green' },
  { id: 'debit', title: 'Admin debit', icon: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5', tone: 'gold' },
] as const;
type HeadMode = 'manage' | 'preview' | 'permissions';
type Page = 'home' | 'credit' | 'debit' | 'contract' | typeof cards[number]['id'];
export function AdminPage(props: AdminPageProps) {
  const { users, heads, permissions, currentAdminUserId } = props;
  const [page, setPage] = useState<Page>('home');
  const [contractId, setContractId] = useState('');
  const [contractFrom, setContractFrom] = useState<'contracts' | 'receivable' | 'payable'>('contracts');
  const [payUserId, setPayUserId] = useState('');
  const contracts = props.contracts ?? [];
  const selectedContract = contracts.find((contract) => contract.id === contractId);
  const [statementFrom, setStatementFrom] = useState<Page | null>(null);
  const [filters, setFilters] = useState<FiltersState>({ dateFrom: '', dateTo: '', userScope: 'all', direction: 'both' });
  const [selectedUserId, setSelectedUserId] = useState('');
  const [headMode, setHeadMode] = useState<HeadMode>('manage');
  const [headsFromUsers, setHeadsFromUsers] = useState(false);
  const [headDirty, setHeadDirty] = useState(false);
  const [userDirty, setUserDirty] = useState(false);
  const [ledgerDirty, setLedgerDirty] = useState(false);
  const [transactionDirty, setTransactionDirty] = useState(false);
  const [transactionBusy, setTransactionBusy] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null);
  const [revision, setRevision] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRefresh, setConfirmRefresh] = useState(false);
  const [notice, setNotice] = useState('');
  const [attachmentScope, setAttachmentScope] = useState('');
  const [debitShortcut, setDebitShortcut] = useState('');
  const [pinnedSearch, setPinnedSearch] = useState('');
  const [creditShortcut, setCreditShortcut] = useState<{ id: string; mode: 'transaction' | 'edit' } | null>(null);
  const [headPermission, setHeadPermission] = useState<{ head: Head; allow: boolean } | null>(null);
  const [permissionUsers, setPermissionUsers] = useState<string[]>([]);
  const editor = usePermissionChanges(permissions, heads);
  const selectableUsers = users.filter((u) => u.user_id !== currentAdminUserId && u.role !== 'admin');
  const selectedUser = selectableUsers.find((u) => u.user_id === selectedUserId);
  const permissionCandidates = headPermission ? selectableUsers.filter((user) => {
    const hasAccess = permittedHeads(heads, editor.ids(user.user_id)).some((head) => head.head_id === headPermission.head.head_id);
    return hasAccess !== headPermission.allow;
  }) : [];
  const preview = page === 'heads' && headMode === 'preview' && !!selectedUser;
  const dirty = headDirty || userDirty || editor.dirty || transactionDirty || ledgerDirty;
  const pinnedUsers = selectableUsers.filter((user) => user.is_active && user.is_pinned);
  const pinnedExternal = props.creditUsers.filter((user) => user.is_active && user.is_pinned);
  const totals = ledgerReport(props.transactions, { dateFrom: '', dateTo: '', userScope: 'all', direction: 'both' }, 'by-time', [], true);
  const outstanding = outstandingBalances(selectableUsers, props.transactions);
  const contractOutstanding = contracts.map((contract) => contractBalance(contract, props.transactions).remaining).filter((amount) => amount > 0);
  const contractPayable = contracts.map((contract) => -contractBalance(contract, props.transactions).remaining).filter((amount) => amount > 0);
  const homeCards = cards.map((card) => {
    if (card.id === 'admin-payable') return { ...card, amount: money(selectableUsers.reduce((sum, user) => sum + adminPayableBalance(props.transactions, user.user_id), 0)) };
    if (card.id === 'contracts') return { ...card, amount: money(contractOutstanding.reduce((sum, amount) => roundMoney(sum + amount), 0)), detail: `${contractOutstanding.length} outstanding contracts` };
    if (card.id !== 'receivable' && card.id !== 'payable') return card;
    const accounts = outstanding.filter((entry) => entry.category === card.id);
    const contractAmounts = card.id === 'receivable' ? contractOutstanding : contractPayable;
    const extra = contractAmounts.reduce((sum, amount) => roundMoney(sum + amount), 0);
    return { ...card, amount: money(roundMoney(balanceTotal(accounts) + extra)), detail: `${accounts.length} ${accounts.length === 1 ? 'user' : 'users'} · ${contractAmounts.length} contracts` };
  });
  const diff = permissionDiff(permissions[selectedUserId] ?? [], editor.ids(selectedUserId));
  function navigate(action: () => void) {
    if (transactionBusy) { setNotice('Finish the recording or current operation first.'); return; }
    const proceed = () => { setStatementFrom(null); setPayUserId(''); action(); };
    if (transactionDirty || ledgerDirty) setPendingNavigation(() => proceed);
    else proceed();
  }
  function openAttachments(scope: string) {
    navigate(() => { setAttachmentScope(scope); setPage('attachments'); });
  }
  function openContract(id: string, from: 'contracts' | 'receivable' | 'payable') {
    navigate(() => { setContractId(id); setContractFrom(from); setPage('contract'); });
  }
  function closeHeadView() {
    navigate(() => { setHeadMode('manage'); if (headsFromUsers) setPage('users'); });
  }
  function statement(userScope: string, headId = filters.headId, company = false) {
    navigate(() => { setStatementFrom(page); setFilters((f) => ({ ...f, userScope, headId, contractId: undefined })); setPage(company ? 'company' : 'statement'); setHeadMode('manage'); });
  }
  async function refresh() {
    setRefreshing(true); setNotice('');
    try {
      await props.onRefresh(); editor.reset(); setRevision((n) => n + 1);
      setHeadDirty(false); setUserDirty(false); setTransactionDirty(false); setLedgerDirty(false); setConfirmRefresh(false);
    } catch (error) { setNotice((error as Error).message); }
    finally { setRefreshing(false); }
  }
  return <main className="admin-page">
    <header className="admin-header">
      <button className="brand-home" onClick={() => navigate(() => { setPage('home'); setHeadMode('manage'); })}><img src={logo} alt="" /><span>Sohail Malik Architects<small>Cashbook</small></span></button>
      <div className="flex-row flex-wrap gap-sm">
        <button className="btn" onClick={() => navigate(() => { setPage('home'); setHeadMode('manage'); })}>Home</button>
        <button className="btn" disabled={refreshing || transactionBusy} onClick={() => dirty ? setConfirmRefresh(true) : void refresh()}>{refreshing ? 'Refreshing…' : 'Refresh'}</button>
        <button className="btn" onClick={() => navigate(props.onLogout)}>Logout</button>
      </div>
    </header>
    {notice && <p role="status">{notice}</p>}
    <section className="admin-home" hidden={page !== 'home'}>
      <h1>Overview</h1>
      <dl className="home-totals">{Object.entries({ Credits: totals.credit, Debits: totals.debit, Balance: totals.closing }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{money(value)}</dd></div>)}</dl>
      <HomeNavigation key={`${revision}:${props.homeOrder?.join(',')}`} cards={homeCards} order={props.homeOrder} onOpen={(id) => navigate(() => {
        setHeadMode('manage'); setHeadsFromUsers(false);
        if (id === 'company') setFilters((current) => ({ ...current, userScope: 'all', headId: null, contractId: undefined }));
        if (id === 'attachments') setAttachmentScope('');
        if (id === 'statement') setFilters((current) => ({ ...current, userScope: 'all', contractId: undefined }));
        if (id === 'credit') setCreditShortcut(null);
        if (id === 'debit') setDebitShortcut('');
        setPage(id as Page);
      })} />
      {!!(pinnedUsers.length || pinnedExternal.length) && <section className="pinned-credit-users flex-col gap-md">
        <h2>Pinned users</h2>
        <input type="search" className="credit-user-list" aria-label="Search pinned users" placeholder="Search name, contact or description"
          value={pinnedSearch} onChange={(event) => setPinnedSearch(event.target.value)} />
        <UserCards onAttachments={(user) => openAttachments(user.user_id)} users={pinnedUsers} search={pinnedSearch} onChanged={props.onRefresh}
          onOpen={(user) => navigate(() => { setDebitShortcut(user.user_id); setPage('debit'); })} />
        {![...pinnedUsers, ...pinnedExternal].some((user) => matchesUser(user, pinnedSearch)) && <p className="text-muted">No matching pinned users.</p>}
        <CreditUserCards onAttachments={(user) => openAttachments(`credit:${user.credit_user_id}`)} onStatement={(user) => statement(`credit:${user.credit_user_id}`, null, true)} users={pinnedExternal} search={pinnedSearch} onChanged={props.onRefresh}
          onOpen={(user) => navigate(() => { setCreditShortcut({ id: user.credit_user_id, mode: 'transaction' }); setPage('credit'); })}
          onEdit={(user) => navigate(() => { setCreditShortcut({ id: user.credit_user_id, mode: 'edit' }); setPage('credit'); })} />
      </section>}
    </section>
    <div className="admin-content">
      {page === 'admin-payable' && <AdminPayablePage users={users} heads={heads} transactions={props.transactions}
        onBack={() => navigate(() => setPage('home'))} onStatement={(id) => navigate(() => { setStatementFrom('admin-payable'); setFilters({ dateFrom: '', dateTo: '', userScope: id, direction: 'both', showAdminPayable: true }); setPage('statement'); })} onRefresh={props.onRefresh} onDirtyChange={setTransactionDirty} onBusyChange={setTransactionBusy} />}
      {(['receivable', 'payable'] as const).map((category) => <div key={category} hidden={page !== category || (category === 'payable' && !!payUserId)}>
        <OutstandingPage category={category} entries={outstanding} contracts={contracts} transactions={props.transactions} onContract={(id) => openContract(id, category)} onBack={() => navigate(() => setPage('home'))} onPay={setPayUserId}
          onStatement={(userScope) => navigate(() => {
            setStatementFrom(category);
            setFilters({ dateFrom: '', dateTo: '', userScope, direction: 'both' });
            setPage('statement');
          })} />
      </div>)}
      <div hidden={page !== 'contracts'}><ContractList contracts={contracts} transactions={props.transactions} onOpen={(id) => openContract(id, 'contracts')} onBack={() => navigate(() => setPage('home'))} /></div>
      {page === 'contract' && (selectedContract ? <ContractDetails key={contractId} contract={selectedContract} transactions={props.transactions} creditUsers={props.creditUsers} users={users} heads={heads} adminId={currentAdminUserId} backLabel={`Back to ${contractFrom === 'contracts' ? 'Contracts' : contractFrom === 'payable' ? 'Payable' : 'Receivable'}`}
        onBack={() => navigate(() => setPage(contractFrom))} onDeleted={() => setPage(contractFrom)} onRefresh={props.onRefresh} onDirtyChange={setTransactionDirty} onBusyChange={setTransactionBusy} /> : <div><p>This contract is no longer available.</p><button className="btn" onClick={() => navigate(() => setPage(contractFrom))}>← Back to {contractFrom === 'contracts' ? 'Contracts' : contractFrom === 'payable' ? 'Payable' : 'Receivable'}</button></div>)}
      {page === 'payable' && payUserId && <AdminDebitFlow key={payUserId} initialUserId={payUserId} returnToSource users={users} heads={heads}
        onClose={() => setPayUserId('')} onSubmitted={props.onRefresh} onDirtyChange={setTransactionDirty} onBusyChange={setTransactionBusy} />}
      <section className={`admin-controls flex-col gap-md${page === 'heads' ? ' admin-controls--heads' : ''}`} hidden={page !== 'users' && page !== 'heads'}>
        <h1>{page === 'heads' ? headsFromUsers ? selectedUser?.user_name : 'Heads Management' : 'Users'}</h1>
        {page === 'heads' && !headsFromUsers && <UserPicker users={selectableUsers} value={selectedUserId} onChange={(id) => navigate(() => { setSelectedUserId(id); if (!id) setHeadMode('manage'); })} />}
        {page === 'heads' && <div className="head-mode-switch" role="group" aria-label="Head view">
          {headsFromUsers && <button className="btn" onClick={closeHeadView}>← Back to users</button>}
          {([['manage', 'Manage Heads'], ['preview', 'User Preview'], ['permissions', 'Show Permissions']] as const).filter(([mode]) => !headsFromUsers || mode !== 'manage').map(([mode, label]) =>
            <button key={mode} className="btn" aria-pressed={page === 'heads' && headMode === mode}
              disabled={mode !== 'manage' && !selectedUser}
              onClick={() => headMode === mode ? closeHeadView() : navigate(() => setHeadMode(mode))}>{label}</button>)}
        </div>}
        <div hidden={page !== 'heads' || preview}>
          <div><HeadsTab key={revision} heads={heads} readOnly={headMode === 'permissions'} onPermissionChange={(head, allow) => {
              if (head.head_id < 0) { setNotice('Apply this new head first.'); return; }
              if (selectedUser) { editor.stageBranch(selectedUserId, head.head_id, allow); setNotice(''); }
            }} permissionIds={headMode === 'permissions' && selectedUser ? editor.ids(selectedUserId) : undefined} reservedIds={Object.values(permissions).flat().map(Math.abs)} onSubmitChanges={props.onSubmitHeadChanges} onDirtyChange={setHeadDirty}
            onHeadAction={(head, action) => {
              if (head.head_id < 0) { setNotice('Apply this new head first.'); return; }
              setHeadPermission({ head, allow: action === 'give' });
              setPermissionUsers([]); setNotice('');
            }} /></div>
          {selectedUser && headMode === 'permissions' && <PermissionChanges key={`${selectedUserId}:${revision}`} user={selectedUser} heads={heads} editor={editor} onSave={props.onSavePermissions} />}
          {headMode === 'manage' && selectableUsers.filter((user) => editor.get(user.user_id).history.length > 1).map((user) =>
            <PermissionChanges key={`${user.user_id}:${revision}`} user={user} heads={heads} editor={editor} onSave={props.onSavePermissions} />)}
        </div>
        <div hidden={page !== 'users'}><UsersTab onAttachments={openAttachments} key={revision} currentAdminUserId={currentAdminUserId} users={users} selectedUserId={selectedUserId}
          onSelect={(id) => navigate(() => { setSelectedUserId(id); if (!id) setHeadMode('manage'); })} onViewLedger={(id) => statement(id)} onCreateUser={props.onCreateUser} onSaveProfile={props.onSaveProfile}
          onOpenHeadView={(id, mode) => navigate(() => { setSelectedUserId(id); setHeadsFromUsers(true); setHeadMode(mode); setPage('heads'); })}
          onChangePassword={props.onChangePassword} onDirtyChange={setUserDirty} onAction={async (id, action) => {
            if (id === selectedUserId && transactionDirty) throw new Error('Finish or cancel this transaction draft first.');
            await props.onUserAction?.(id, action);
          }} /></div>
      </section>
      {preview && selectedUser ? <section className="admin-preview"><UserPreview key={`${selectedUserId}:${revision}`} user={selectedUser} onRefresh={props.onRefresh} heads={heads} assigned={editor.ids(selectedUserId)} pending={diff.granted.length + diff.revoked.length > 0}
        onDirtyChange={setTransactionDirty} onBusyChange={setTransactionBusy} onClose={closeHeadView} /></section>
        : (page === 'company' || page === 'statement') && <>
          {statementFrom && <button className="btn" onClick={() => navigate(() => setPage(statementFrom))}>← Back{statementFrom === 'receivable' ? ' to Receivable' : statementFrom === 'payable' ? ' to Payable' : statementFrom === 'admin-payable' ? ' to Admin payable' : ''}</button>}
          <Ledger key={`${revision}:${page}`} company={page === 'company'} filters={filters} onFilterChange={setFilters} revision={revision} heads={heads} users={users} onDirtyChange={setLedgerDirty}
            onChanged={props.onRefresh} /></>}
      {page === 'attachments' && <AttachmentsPage key={attachmentScope} initialScope={attachmentScope} users={users} creditUsers={props.creditUsers} heads={heads} />}
      {(page === 'debit' || page === 'user-credit') && <AdminDebitFlow key={`${page}:${revision}:${page === 'debit' ? debitShortcut : ''}`}
        initialUserId={page === 'debit' ? debitShortcut : ''} users={users} heads={heads} transactions={props.transactions} permissions={permissions} mode={page === 'user-credit' ? 'credit' : 'debit'}
        onClose={() => setPage('home')} onSubmitted={props.onRefresh}
        onDirtyChange={setTransactionDirty} onBusyChange={setTransactionBusy} />}
      {(page === 'credit' || statementFrom === 'credit') && users.find((user) => user.user_id === currentAdminUserId) && <div hidden={page !== 'credit'}>
        <AdminCreditFlow key={creditShortcut ? `${creditShortcut.mode}:${creditShortcut.id}` : 'menu'} admin={users.find((user) => user.user_id === currentAdminUserId)!}
          initialCreditUserId={creditShortcut?.mode === 'transaction' ? creditShortcut.id : ''}
          initialEditCreditUserId={creditShortcut?.mode === 'edit' ? creditShortcut.id : ''} creditUsers={props.creditUsers} heads={heads}
          onStatement={(user) => statement(`credit:${user.credit_user_id}`, null, true)}
          onClose={() => setPage('home')} onRefresh={props.onRefresh} onDirtyChange={setTransactionDirty} onBusyChange={setTransactionBusy} /></div>}
    </div>

    {headPermission && <Dialog title={`${headPermission.allow ? 'Give permission' : 'Revoke permission'} · ${headPermission.head.head_name}`} onClose={() => setHeadPermission(null)}>
      <p>Select users. This change includes all subheads.</p>
      <UserPicker users={permissionCandidates} selectedIds={permissionUsers} onChange={(id) => setPermissionUsers((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])} />
      {!permissionCandidates.length && <p className="text-muted">{headPermission.allow ? 'All users already have access to this head.' : 'No users have access to this head.'}</p>}
      <div className="flex-row justify-end gap-sm">
        <button className="btn" onClick={() => setHeadPermission(null)}>Cancel</button>
        <button className="btn btn--primary" disabled={!permissionUsers.length} onClick={() => {
          permissionCandidates.filter((user) => permissionUsers.includes(user.user_id)).forEach((user) => editor.stageBranch(user.user_id, headPermission.head.head_id, headPermission.allow));
          setHeadPermission(null); setPermissionUsers([]);
        }}>Stage changes{permissionUsers.length ? ` (${permissionUsers.length})` : ''}</button>
      </div>
    </Dialog>}
    {confirmRefresh && <Dialog title="Discard drafts and refresh?" onClose={() => setConfirmRefresh(false)} busy={refreshing}>
      <p>Refresh will discard unapplied edits and reload saved data.</p>
      <div className="flex-row justify-end gap-sm"><button className="btn" disabled={refreshing} onClick={() => setConfirmRefresh(false)}>Keep editing</button><button className="btn btn--primary" disabled={refreshing} onClick={refresh}>Refresh</button></div>
    </Dialog>}
    {pendingNavigation && <Dialog title="Discard the open transaction draft?" onClose={() => setPendingNavigation(null)}>
      <div className="flex-row justify-end gap-sm"><button className="btn" onClick={() => setPendingNavigation(null)}>Keep editing</button><button className="btn btn--primary" onClick={() => { pendingNavigation(); setPendingNavigation(null); setTransactionDirty(false); setLedgerDirty(false); }}>Discard and continue</button></div>
    </Dialog>}
  </main>;
}
