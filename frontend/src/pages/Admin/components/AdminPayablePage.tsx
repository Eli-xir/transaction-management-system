import { useState } from 'react';
import type { AdminUser, Head, Transaction } from '../types';
import { adminPayableBalance } from '../utils/adminPayable';
import { matchesUser } from '../utils/userProfile';
import { money } from '../../Ledger/ledgerModel';
import { HomeCard } from './HomeCard';
import { AdminDebitFlow } from './AdminDebitFlow';
import { Icon } from '../../../Icon';

export function AdminPayablePage({ users, heads, transactions, onBack, onStatement, onRefresh, onDirtyChange, onBusyChange }: {
  users: AdminUser[]; heads: Head[]; transactions: Transaction[]; onBack: () => void;
  onStatement: (id: string) => void; onRefresh: () => Promise<void>;
  onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('highest');
  const [entry, setEntry] = useState<{ mode: 'personal-add' | 'personal-pay'; id: string } | null>(null);
  const accounts = users.filter((user) => user.role !== 'admin').map((user) => ({ user, amount: adminPayableBalance(transactions, user.user_id) })).filter(({ amount }) => amount > 0);
  const visible = accounts.filter(({ user }) => matchesUser(user, search) && (status === 'all' || user.is_active === (status === 'active')))
    .sort((a, b) => (sort === 'name' ? 0 : b.amount - a.amount) || a.user.user_name.localeCompare(b.user.user_name));
  if (entry) return <AdminDebitFlow key={`${entry.mode}:${entry.id}`} users={users} heads={heads} transactions={transactions}
    mode={entry.mode} initialUserId={entry.id} returnToSource onClose={() => setEntry(null)} onSubmitted={onRefresh} onDirtyChange={onDirtyChange} onBusyChange={onBusyChange} />;
  return <section className="flex-col gap-md">
    <header className="flex-row flex-wrap gap-sm items-center"><button className="btn" onClick={onBack}>← Back to Home</button><h1>Admin payable</h1>
      <button className="btn" onClick={() => setEntry({ mode: 'personal-add', id: '' })}>Add Admin payable</button></header>
    <div className="flex-row flex-wrap gap-sm" role="group" aria-label="Admin payable filters">
      <label className="field"><span>Search users</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
      <label className="field"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="highest">Highest amount first</option><option value="name">Name A–Z</option></select></label>
      <button className="btn" onClick={() => { setSearch(''); setStatus('all'); setSort('highest'); }}>Clear filters</button>
    </div>
    <p>Total Admin payable · <strong>{money(accounts.reduce((sum, item) => sum + item.amount, 0))}</strong></p>
    <div className="home-cards">{visible.map(({ user, amount }) => <HomeCard key={user.user_id} title={user.user_name} amount={money(amount)} description={user.description}
      detail={user.is_active ? 'Admin payable' : 'Inactive user'} accountType="user" icon={<Icon size={42}><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></Icon>} tone="gold" onClick={() => onStatement(user.user_id)}
      actions={<div className="flex-row flex-wrap gap-sm"><button className="btn" onClick={() => onStatement(user.user_id)}>View statement</button>
        <button className="btn" disabled={!user.is_active} onClick={() => setEntry({ mode: 'personal-pay', id: user.user_id })}>Pay Admin payable</button>
        <button className="btn" disabled={!user.is_active} onClick={() => setEntry({ mode: 'personal-add', id: user.user_id })}>Increase amount</button></div>} />)}</div>
    {!visible.length && <p>No Admin payable balances match. Settled users are excluded.</p>}
  </section>;
}
