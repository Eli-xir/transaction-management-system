import { useState } from 'react';
import type { Contract, Transaction } from '../types';
import { contractBalance } from '../utils/contractBalances';
import { Icon } from '../../../Icon';
import { HomeCard } from './HomeCard';
import { matchesUser } from '../utils/userProfile';
import { type BalanceCategory, type OutstandingUser } from '../utils/outstandingBalances';
import { money, roundMoney } from '../../Ledger/ledgerModel';

export function OutstandingPage({ category, entries, onBack, onStatement, onPay, contracts = [], transactions = [], onContract }: {
  contracts?: Contract[]; transactions?: Transaction[]; onContract?: (id: string) => void; onPay?: (id: string) => void;
  category: BalanceCategory; entries: OutstandingUser[]; onBack: () => void; onStatement: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState('highest');
  const [kind, setKind] = useState('all');
  const accounts = [
    ...entries.filter((entry) => entry.category === category).map((entry) => ({ ...entry, kind: 'user' as const })),
    ...contracts.map((contract) => ({
      user: { user_id: contract.id, user_name: contract.name, description: contract.description, is_active: contract.isActive },
      amount: contractBalance(contract, transactions).remaining * (category === 'payable' ? -1 : 1), kind: 'contract' as const,
    })).filter((entry) => entry.amount > 0),
  ];
  const total = (items: typeof accounts) => items.reduce((sum, item) => roundMoney(sum + item.amount), 0);
  const visible = accounts.filter(({ user, kind: entryKind }) => matchesUser(user, search) && (kind === 'all' || kind === entryKind)
    && (status === 'all' || user.is_active === (status === 'active')))
    .sort((a, b) => (sort === 'name' ? 0 : sort === 'lowest' ? a.amount - b.amount : b.amount - a.amount)
      || a.user.user_name.localeCompare(b.user.user_name) || a.user.user_id.localeCompare(b.user.user_id));
  const title = category === 'receivable' ? 'Receivable' : 'Payable';
  return <section className="flex-col gap-md">
    <header className="flex-row flex-wrap items-center gap-sm">
      <button className="btn" onClick={onBack}>← Back to Home</button><h1>{title}</h1>
    </header>
    <div className="flex-row flex-wrap items-center gap-sm" role="group" aria-label={`${title} filters`}>
      <label className="field"><span>Search users or contracts</span><input type="search" placeholder="Name, contact or description" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
      <label className="field"><span>Type</span><select aria-label={`${title} type`} value={kind} onChange={(event) => setKind(event.target.value)}><option value="all">Users & contracts</option><option value="user">Users</option><option value="contract">Contracts</option></select></label>
      <label className="field"><span>Status</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All statuses</option><option value="active">Active</option><option value="inactive">Inactive / archived</option></select></label>
      <label className="field"><span>Sort by</span><select value={sort} onChange={(event) => setSort(event.target.value)}><option value="highest">Highest amount first</option><option value="lowest">Lowest amount first</option><option value="name">Name A–Z</option></select></label>
      <button className="btn" disabled={!search && status === 'all' && sort === 'highest' && kind === 'all'} onClick={() => { setSearch(''); setStatus('all'); setSort('highest'); setKind('all'); }}>Clear filters</button>
    </div>
    <dl className="ledger-totals">
      <div><dt>Total {title.toLowerCase()}</dt><dd>{money(total(accounts))}</dd></div>
      <div><dt>Showing</dt><dd>{visible.length} / {accounts.length}</dd></div>
      <div><dt>Matching amount</dt><dd>{money(total(visible))}</dd></div>
    </dl>
    <div className="home-cards">{visible.map(({ user, amount, kind: entryKind }) => <HomeCard key={`${entryKind}:${user.user_id}`}
      title={user.user_name} description={user.description} detail={entryKind === 'contract' ? `${user.is_active ? 'Contract' : 'Archived contract'} · ${title}` : user.is_active ? 'Active user' : 'Inactive user'} amount={money(amount)}
      tone={entryKind === 'contract' ? 'blue' : category === 'receivable' ? 'green' : 'gold'} accountType={entryKind === 'user' ? 'user' : undefined}
      icon={<Icon size={42}>{entryKind === 'contract' ? <path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4" /> : <><circle cx="12" cy="8" r="4" /><path d="M4 21v-2a8 8 0 0 1 16 0v2" /></>}</Icon>}
      onClick={() => entryKind === 'contract' ? onContract?.(user.user_id) : onStatement(user.user_id)} actions={<div className="flex-row flex-wrap gap-sm">{entryKind === 'contract' ? <button className="btn" onClick={() => onContract?.(user.user_id)}>View contract</button> : <button className="btn" onClick={() => onStatement(user.user_id)}>View statement</button>}
        {entryKind === 'user' && category === 'payable' && onPay && <button className="btn" disabled={!user.is_active} title={user.is_active ? 'Record a payment to this user' : 'Reactivate this user before paying'} onClick={() => onPay(user.user_id)}>Pay user</button>}</div>} />)}</div>
    {!visible.length && <p role="status" className="text-muted">{accounts.length ? 'No balances match these filters.' : `No ${title.toLowerCase()} balances. Zero balances are excluded.`}</p>}
  </section>;
}
