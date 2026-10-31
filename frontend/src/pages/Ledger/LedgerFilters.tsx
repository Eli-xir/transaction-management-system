import { useState } from 'react';
import type { AdminUser, Contract, CreditUser, FiltersState, Head } from '../Admin/types';
import { UserPicker } from '../Admin/components/UserPicker';
import { Dialog } from '../Admin/components/Dialog';
import { creditUserScope, invalidDateRange } from './ledgerModel';

export function LedgerFilters({ column, filters, heads, users, contracts = [], creditUsers = [], onChange, includeTime = false }: {
  contracts?: Contract[];
  includeTime?: boolean; column: string; filters: FiltersState; heads: Head[]; users: AdminUser[]; creditUsers?: CreditUser[]; onChange: (filters: FiltersState) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const selected = heads.find((h) => h.head_id === filters.headId);
  const active = column === 'Contract' ? !!filters.contractId : column === 'Head' ? filters.headId != null : column === 'User' ? filters.userScope !== 'all'
    : column === 'Description' ? !!filters.description : !!(filters.dateFrom || filters.dateTo || filters.timeFrom || filters.timeTo);
  function update(patch: Partial<FiltersState>) { onChange({ ...filters, ...patch }); }
  const today = new Date();
  const date = (year: number, month: number, day: number) => {
    const value = new Date(year, month, day);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  };
  const y = today.getFullYear(), m = today.getMonth(), d = today.getDate();
  const end = date(y, m, d);
  const ranges = [
    { label: 'Today', dateFrom: end, dateTo: end },
    { label: 'Yesterday', dateFrom: date(y, m, d - 1), dateTo: date(y, m, d - 1) },
    { label: 'Last 7 days', dateFrom: date(y, m, d - 6), dateTo: end },
    { label: 'This month', dateFrom: date(y, m, 1), dateTo: end },
    { label: 'Last month', dateFrom: date(y, m - 1, 1), dateTo: date(y, m, 0) },
    { label: 'This year', dateFrom: date(y, 0, 1), dateTo: end },
    { label: 'All dates', dateFrom: '', dateTo: '' },
  ];
  return <>
    <button className={`column-filter${active ? ' column-filter--active' : ''}`} onClick={() => { setOpen(true); setSearch(''); }}>{column === 'Head' && selected ? `Head · ${selected.head_name}` : column} ▾</button>
    {open && <Dialog title={`Filter · ${column}`} closeOnOutside={column === 'Head' || column === 'Contract'} onClose={() => setOpen(false)}>
      {column === 'Contract' ? <div className="flex-col gap-sm">
        <input type="search" aria-label="Search contracts" placeholder="Search contracts" value={search} onChange={(event) => setSearch(event.target.value)} />
        <div className="filter-choices">
          <button className="btn" aria-pressed={!filters.contractId} onClick={() => update({ contractId: undefined })}>All contracts</button>
          <button className="btn" aria-pressed={filters.contractId === '__none__'} onClick={() => update({ contractId: '__none__' })}>Direct receipts</button>
          <button className="btn" aria-pressed={filters.contractId === '__profit__'} onClick={() => update({ contractId: '__profit__' })}>Company profit</button>
          {contracts.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(search.toLowerCase())).map((item) =>
            <button className="btn" key={item.id} aria-pressed={filters.contractId === item.id} onClick={() => update({ contractId: item.id })}>{item.name}{!item.isActive && ' · Archived'}</button>)}
        </div>
      </div> : column === 'Head' ? <div className="flex-col gap-sm">
        <p>{selected?.head_name ?? 'All heads'}</p>
        <div className="flex-row gap-sm">
          <button className="btn" onClick={() => update({ headId: null })}>All heads</button>
          {selected && <button className="btn" onClick={() => update({ headId: selected.parent_head_id })}>↑ Parent</button>}
        </div>
        <input type="search" aria-label="Search heads" placeholder="Search heads or descriptions" value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="filter-choices">{heads.filter((h) => h.parent_head_id === (filters.headId ?? null) && `${h.head_name} ${h.head_description ?? ''}`.toLowerCase().includes(search.toLowerCase())).map((h) =>
          <button className="btn" key={h.head_id} onClick={() => update({ headId: h.head_id })}>{h.head_name}{h.head_description && <small>{h.head_description}</small>}</button>)}
        {!heads.some((h) => h.parent_head_id === filters.headId) && selected && <p>No subheads.</p>}</div>
      </div> : column === 'User' ? <UserPicker users={[...users, ...creditUsers.map((item) => ({
        user_id: creditUserScope(item.credit_user_id), user_name: item.user_name,
        description: item.description ? `External user · ${item.description}` : 'External user',
        contacts: item.contacts, is_active: true,
      }))]} value={filters.userScope} all onChange={(userScope) => { update({ userScope }); setOpen(false); }} />
        : column === 'Description' ? <label className="field"><span>Search descriptions</span><input type="search" value={filters.description ?? ''} onChange={(e) => update({ description: e.target.value })} /></label>
        : <div className="flex-col gap-md">
          <div className="date-presets" role="group" aria-label="Quick date ranges">{ranges.map(({ label, dateFrom, dateTo }) =>
            <button type="button" className="btn" key={label} aria-pressed={filters.dateFrom === dateFrom && filters.dateTo === dateTo}
              onClick={() => { update({ dateFrom, dateTo, timeFrom: '', timeTo: '' }); setOpen(false); }}>{label}</button>)}</div>
          <fieldset className="field"><legend>Custom dates</legend><div className="date-range-fields">
            {(['dateFrom', 'dateTo'] as const).map((key) => <label className="field" key={key}><span>{key === 'dateFrom' ? 'From' : 'To'}</span>
              <input type="date" value={filters[key]} min={key === 'dateTo' ? filters.dateFrom || undefined : undefined}
                max={key === 'dateFrom' ? filters.dateTo || undefined : undefined} onChange={(e) => update({ [key]: e.target.value })} /></label>)}
          </div>
          {includeTime && <div className="date-range-fields">{(['timeFrom', 'timeTo'] as const).map((key) =>
            <label className="field" key={key}><span>{key === 'timeFrom' ? 'From time' : 'To time'}</span>
              <input type="time" value={filters[key] ?? ''} onChange={(event) => update({ [key]: event.target.value })} /></label>)}
          </div>}
          </fieldset>
          {invalidDateRange(filters) && <p className="text-error" role="alert">From date/time must be on or before To.</p>}
        </div>}
      <div className="flex-row justify-end gap-sm">
        <button className="btn" onClick={() => { update(column === 'Contract' ? { contractId: undefined } : column === 'Head' ? { headId: null } : column === 'User' ? { userScope: 'all' } : column === 'Description' ? { description: '' } : { dateFrom: '', dateTo: '', timeFrom: '', timeTo: '' }); if (column !== 'Head' && column !== 'Contract') setOpen(false); }}>Clear</button>
        <button className="btn btn--primary" onClick={() => setOpen(false)}>Done</button>
      </div>
    </Dialog>}
  </>;
}
