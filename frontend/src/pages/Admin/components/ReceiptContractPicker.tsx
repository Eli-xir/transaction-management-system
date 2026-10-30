import { useState } from 'react';
import type { Contract, Transaction } from '../types';
import { contractBalance } from '../utils/contractBalances';
import { money } from '../../Ledger/ledgerModel';
import { Icon } from '../../../Icon';

export function ReceiptContractPicker({ contracts, transactions, payerId, selectedId, onSelect }: {
  contracts: Contract[]; transactions: Transaction[]; payerId: string; amount: number;
  selectedId?: string; onSelect: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const visible = contracts.filter((contract) => contract.creditUserIds.includes(payerId)
    && `${contract.name} ${contract.description}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));
  return <div className="flex-col gap-md">
    <label className="field"><span>Search contracts</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <div className="user-card-list">{visible.map((contract) => {
      const remaining = contractBalance(contract, transactions).remaining;
      const unavailable = !contract.isActive;
      return <button type="button" className="home-card home-card--blue" key={contract.id} disabled={unavailable} aria-pressed={selectedId === contract.id} onClick={() => onSelect(contract.id)}>
        <Icon size={36}><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4" /></Icon>
        <span className="home-card-title">{contract.name}</span><strong>{money(Math.abs(remaining))} {remaining < 0 ? 'payable' : 'remaining'}</strong>
        {unavailable && <small>Archived</small>}
      </button>;
    })}</div>
    {!visible.length && <p role="status">No linked contracts match.</p>}
  </div>;
}
