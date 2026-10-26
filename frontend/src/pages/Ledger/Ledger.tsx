import type { ReactNode } from 'react';
import type { EvidenceRecord } from './attachmentReport';
import { useEffect, useRef, useState } from 'react';
import type { AdminUser, Contract, FiltersState, Head, Transaction } from '../Admin/types';
import { cashbookApi } from '../../data/cashbookApi';
import { dateRangeLabel, invalidDateRange, direction, headBranchIds, headPath, isCompanyTransaction, ledgerReport, matchesUserScope, matchesContractScope, money } from './ledgerModel';
import type { LedgerOrder } from './ledgerModel';
import { ReportActions } from './ReportActions';
import type { ReportDocument } from './ledgerExport';
import { TransactionCard } from './TransactionCard';
import './Ledger.css';
import { LedgerFilters } from './LedgerFilters';
import { selectedEntriesReport, toggleEntry } from './entrySelection';

export interface EntrySelection {
  active: boolean; ids: Set<string>; toggle: (id: string, shift?: boolean) => void;
}

type LedgerData = Awaited<ReturnType<typeof cashbookApi.ledger>>;
const filterKey = (filters: FiltersState) => JSON.stringify([
  filters.dateFrom, filters.dateTo, filters.userScope, filters.direction, filters.headId ?? null, filters.description ?? '', filters.timeFrom ?? '', filters.timeTo ?? '',
  filters.contractId ?? null,
]);
export function Ledger({ filters: suppliedFilters, revision, heads, users, onDirtyChange, onFilterChange, company = false, onChanged, attachmentReview, contract, contractUserId }: {
  contract?: Contract; contractUserId?: string;
  attachmentReview?: { render: (records: EvidenceRecord[], columns: string[], selection: EntrySelection) => ReactNode; export: (records: EvidenceRecord[], document: ReportDocument, selected?: boolean) => ReactNode };
  onChanged: () => Promise<void>; company?: boolean; onFilterChange: (filters: FiltersState) => void;
  filters: FiltersState; revision: number; heads: Head[]; users: AdminUser[]; onDirtyChange: (dirty: boolean) => void;
}) {
  const fixedScope = contract ? { contractId: contract.id, userScope: contractUserId ? `credit:${contractUserId}` : 'all' } : {};
  const contractColumn = !!contract || suppliedFilters.userScope.startsWith('credit:');
  const filters = { ...suppliedFilters, ...((company || contractColumn) ? { headId: null } : {}), ...(!contractColumn ? { contractId: undefined } : {}), ...fixedScope };
  const [data, setData] = useState<LedgerData | null>(null);
  const [order, setOrder] = useState<LedgerOrder>(attachmentReview ? 'by-head' : 'by-time');
  const groupDirections = order === 'credit-first' || order === 'debit-first';
  const [pagination, setPagination] = useState({ scope: '', page: 0 });
  const scope = filterKey(filters);
  const [selection, setSelection] = useState({ scope, active: false, ids: new Set<string>(), anchor: null as string | null, range: false });
  const selectionActive = selection.scope === scope && selection.active;
  const [draft, setDraft] = useState({ scope, filters });
  const draftFilters = draft.scope === scope ? draft.filters : filters;
  const pendingFilters = filterKey(draftFilters) !== scope;
  const invalidDraftDates = invalidDateRange(draftFilters);
  function stageFilters(next: FiltersState) {
    const changedUser = next.userScope !== draftFilters.userScope;
    setDraft({ scope, filters: { ...next, ...(changedUser ? { contractId: undefined } : {}), ...fixedScope } });
  }
  function applyFilters() {
    if (!pendingFilters || invalidDraftDates) return;
    onFilterChange(draftFilters);
    setSelection({ scope: filterKey(draftFilters), active: false, ids: new Set(), anchor: null, range: false });
    setPagination({ scope: filterKey(draftFilters), page: 0 });
  }
  const page = pagination.scope === scope ? pagination.page : 0;
  function setPage(next: number) { setPagination({ scope, page: next }); }
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<Transaction | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [showInactive, setShowInactive] = useState(false);
  useEffect(() => { onDirtyChange(selected !== null); return () => onDirtyChange(false); }, [selected, onDirtyChange]);
  useEffect(() => {
    let ignore = false;
    cashbookApi.ledger().then((result) => { if (!ignore) { setData(result); setError(''); } })
      .catch((error) => { if (!ignore) setError(error instanceof Error ? error.message : 'Could not load ledger.'); });
    return () => { ignore = true; };
  }, [revision, reload, heads, users]);
  async function refresh() { setData(await cashbookApi.ledger()); await onChanged(); }
  const reportHeads = data?.heads ?? heads;
  const entryDirection = (entry: Transaction) => direction(entry, company);
  const transactions = (data?.transactions ?? []).filter((entry) => company
    ? isCompanyTransaction(entry)
    : attachmentReview || !(data?.users ?? users).some((user) => user.user_id === entry.userId && user.role === 'admin'));
  const report = ledgerReport(transactions, filters, order, reportHeads, company);
  const selectedIds = new Set(selectionActive ? report.rows.filter(({ entry }) => selection.ids.has(entry.id)).map(({ entry }) => entry.id) : []);
  function toggleSelection(id: string, shift = false) {
    setSelection((current) => ({ ...current,
      ids: toggleEntry(current.ids, id, report.rows.map(({ entry }) => entry.id), current.anchor, shift || current.range),
      anchor: id, range: current.range && current.anchor === null,
    }));
  }
  const branch = headBranchIds(reportHeads, filters.headId);
  const pageCount = Math.max(1, Math.ceil(report.rows.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const lastEntry = useRef<HTMLTableRowElement>(null);
  const attachmentEnd = useRef<HTMLDivElement>(null);
  const [scrollLast, setScrollLast] = useState(0);
  useEffect(() => {
    if (scrollLast) {
      (lastEntry.current ?? attachmentEnd.current)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' });
    }
  }, [scrollLast]);
  const userName = (id: string) => id.startsWith('credit:')
    ? data?.creditUsers.find((user) => user.credit_user_id === id.slice(7))?.user_name ?? 'Unavailable external user'
    : data?.users.find((user) => user.user_id === id)?.user_name ?? 'Unavailable account';
  const openEntry = (entry: Transaction) => setSelected(entry);
  const entryUserName = (entry: Transaction) => entry.creditUserId
    ? data?.creditUsers.find((user) => user.credit_user_id === entry.creditUserId)?.user_name ?? 'Unavailable external user'
    : company && (data?.users ?? users).some((user) => user.user_id === entry.userId && user.role === 'admin')
      ? 'Source not recorded' : userName(entry.userId);
  const title = contract ? `${contract.name} · ${contractUserId ? userName(`credit:${contractUserId}`) : 'Contract statement'}` : company ? 'Company Statement' : filters.userScope === 'all' ? 'Users Statement' : userName(filters.userScope);
  const receivedLabel = `Total received by ${filters.userScope === 'all' ? 'users' : userName(filters.userScope)}`;
  const branchLabel = filters.headId == null ? '' : `${headPath(reportHeads, filters.headId)} · Includes subheads`;
  const dateLabel = dateRangeLabel(filters);
  const contractName = (id?: string | null) => !id || id === '__none__' ? 'No contract' : data?.contracts?.find((item) => item.id === id)?.name ?? contract?.name ?? 'Unavailable contract';
  const contractOptions = (data?.contracts ?? []).filter((item) => !filters.userScope.startsWith('credit:') || item.creditUserIds.includes(filters.userScope.slice(7)) || transactions.some((entry) => entry.contractId === item.id && matchesUserScope(entry, filters.userScope)));
  const subtitle = [branchLabel, filters.contractId ? `Contract: ${contractName(filters.contractId)}` : '', dateLabel, company && filters.userScope !== 'all' ? userName(filters.userScope) : '', filters.description ? `Description: ${filters.description}` : ''].filter(Boolean).join(' · ');
  const columns = ['Date/time', 'User', 'Entered by', contractColumn ? 'Contract' : 'Head', 'Description', 'Credit', 'Debit', 'Balance'];
  const entryCells = (entry: Transaction, balance: number): (string | number)[] => [
    new Date(entry.createdAt).toLocaleString(), entryUserName(entry), userName(entry.createdBy),
    contractColumn ? contractName(entry.contractId) : entry.headPath ?? headPath(data?.heads ?? [], entry.headId), [!contractColumn && entry.contractId ? `Contract: ${data?.contracts?.find((item) => item.id === entry.contractId)?.name ?? entry.contractId}` : '', entry.description ?? ''].filter(Boolean).join(' · '),
    entryDirection(entry) === 'credit' ? entry.amount : '', entryDirection(entry) === 'debit' ? entry.amount : '', balance,
  ];
  const totalCells = (label: string, balance: number, credit: number | string = '', debit: number | string = ''): (string | number)[] => [label, '', '', '', '', credit, debit, balance];
  function pageRows(index: number) {
    const start = index * pageSize, rows: { cells: (string | number)[]; entry?: Transaction }[] = [];
    const total = (label: string, balance: number, credit: string | number = '', debit: string | number = '') => rows.push({ cells: totalCells(label, balance, credit, debit) });
    total(index === 0 ? 'Balance brought forward' : 'Page brought forward', start ? report.rows[start - 1].balance : report.opening);
    report.rows.slice(start, start + pageSize).forEach(({ entry, balance }, offset) => {
      const position = start + offset, type = entryDirection(entry);
      if (groupDirections && (offset === 0 || entryDirection(report.rows[position - 1].entry) !== type)) {
        total(`${type === 'credit' ? 'Credits' : 'Debits'}${offset === 0 && start && entryDirection(report.rows[position - 1].entry) === type ? ' (continued)' : ''}`, balance - (type === 'credit' ? entry.amount : -entry.amount));
      }
      rows.push({ cells: entryCells(entry, balance), entry });
      if (groupDirections && (!report.rows[position + 1] || entryDirection(report.rows[position + 1].entry) !== type)) {
        total(`${type === 'credit' ? 'Credits' : 'Debits'} subtotal`, balance, type === 'credit' ? report.credit : '', type === 'debit' ? report.debit : '');
      }
    });
    const ending = report.rows[Math.min(start + pageSize, report.rows.length) - 1]?.balance ?? report.opening;
    total(index === pageCount - 1 ? 'Totals / closing balance' : 'Page carried forward', ending,
      index === pageCount - 1 ? report.credit : '', index === pageCount - 1 ? report.debit : '');
    return rows;
  }
  function exportReport(): ReportDocument {
    return { title, subtitle, printedAt: new Date().toLocaleString(), columns, pages: Array.from({ length: pageCount }, (_, index) => pageRows(index).map((row) => row.cells)) };
  }
  const selectedReport = () => selectedEntriesReport(
    report.rows.filter(({ entry }) => selectedIds.has(entry.id)).map(({ entry, balance }) => ({ entry, cells: entryCells(entry, balance) })),
    { title, subtitle, columns, pages: [] }, pageSize,
  );
  const summary = company ? { Credits: report.credit, Debits: report.debit, Balance: report.closing }
    : { [receivedLabel]: report.totalReceived, 'Total paid': report.totalBillPayment, 'Remaining balance': -report.remainingPayable };
  const invalidDates = invalidDateRange(filters);
  return <div className="ledger-view flex-col gap-md">
    {!attachmentReview && <h1>{title}</h1>}
    {(subtitle || !attachmentReview && filters.userScope !== 'all') && <div className="active-filters flex-row flex-wrap gap-sm"><span>{[subtitle, !company && filters.userScope !== 'all' ? userName(filters.userScope) : ''].filter(Boolean).join(' · ')}</span></div>}
    <div className="ledger-toolbar flex-row flex-wrap gap-sm">
      {!selectionActive && <button className="btn" disabled={!data || invalidDates || !report.rows.length} onClick={() => setSelection({ scope, active: true, ids: new Set(), anchor: null, range: false })}>Select entries</button>}
      <label className="field"><span>Entries</span><select value={draftFilters.direction} onChange={(event) => stageFilters({ ...draftFilters, direction: event.target.value as FiltersState['direction'] })}><option value="both">Credits & debits</option><option value="credit">Credits</option><option value="debit">Debits</option></select></label>
      <label className="field"><span>Arrangement</span><select value={order} onChange={(event) => { setOrder(event.target.value as LedgerOrder); setPage(0); }}>
        {attachmentReview ? <>
          <option value="by-head">Head-wise</option><option value="by-time">Time-wise</option>
        </> : <>
          <option value="by-time">Time-Wise</option><option value="credit-first">Credits, then debits</option><option value="debit-first">Debits, then credits</option>
        </>}
      </select></label>
      {!attachmentReview && <label className="field"><span>Rows per page</span><select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(0); }}>
        {[10, 20, 50, 100].map((size) => <option key={size}>{size}</option>)}
      </select></label>}
      {!selectionActive && (attachmentReview ? data && !invalidDates && attachmentReview.export(report.rows.map(({ entry, balance }) => ({ entry, cells: entryCells(entry, balance) })), exportReport()) : <ReportActions disabled={!data || invalidDates} getReport={exportReport} />)}
      <button className={`btn${pendingFilters ? ' btn--primary filter-apply--pending' : ''}`} disabled={!pendingFilters || invalidDraftDates} onClick={applyFilters}>Apply filters</button>
      <button className="btn" onClick={() => stageFilters({ dateFrom: '', dateTo: '', userScope: 'all', direction: 'both' })}>Clear filters</button>
      <button className="btn" disabled={!data || invalidDates || !report.rows.length} onClick={() => { setPage(pageCount - 1); setScrollLast((value) => value + 1); }}>Scroll to last ↓</button>
      {pendingFilters && <button className="btn" onClick={() => setDraft({ scope, filters })}>Discard changes</button>}
    </div>
    {pendingFilters && <p className={invalidDraftDates ? 'text-error' : 'text-muted'} role="status">{invalidDraftDates ? 'Choose an end date/time on or after the start.' : 'Filter changes ready to apply.'}</p>}
    {error && <p role="alert" className="text-error">{error} <button className="btn" onClick={() => setReload((value) => value + 1)}>Reload</button></p>}
    {invalidDates ? <p role="alert">Choose an end date/time on or after the start.</p> : !data ? <p>Loading ledger…</p> : <>
      <dl className="ledger-totals">
        {Object.entries(summary).map(([label, value]) => <div key={label}
          >
          <dt>{label}</dt><dd>{money(value)}</dd></div>)}
      </dl>
      {attachmentReview ? <>
        <div className="flex-row flex-wrap gap-md" aria-label="Attachment statement filters">{['Date/time', 'User', contractColumn ? 'Contract' : 'Head', 'Description'].map((column) =>
          <LedgerFilters key={column} column={column} filters={draftFilters} heads={reportHeads} contracts={contractOptions} users={data.users} includeTime creditUsers={data.creditUsers} onChange={stageFilters} />)}</div>
        <div className="ledger-total">{currentPage ? 'Page brought forward' : 'Balance brought forward'} · {money(currentPage ? report.rows[currentPage * pageSize - 1].balance : report.opening)}</div>
        {attachmentReview.render(report.rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(({ entry, balance }) => ({ entry, cells: entryCells(entry, balance) })), columns, { active: selectionActive, ids: selectedIds, toggle: toggleSelection })}
        <div ref={attachmentEnd} />
        <div className="ledger-total">{currentPage + 1 === pageCount ? 'Closing balance' : 'Page carried forward'} · {money(report.rows[Math.min((currentPage + 1) * pageSize, report.rows.length) - 1]?.balance ?? report.opening)}</div>
      </> : <>
      <div className="ledger-table-scroll"><table className="ledger-table"><thead><tr>{selectionActive && <th scope="col">Select</th>}{columns.map((label) => <th key={label}
        title={label === 'Balance' ? 'Opening balance plus credits minus debits in the displayed order.' : undefined}>{(company ? ['Date/time', ...(contract ? [] : ['User']), ...(!contract && contractColumn ? ['Contract'] : []), 'Description'] : ['Date/time', 'User', contractColumn ? 'Contract' : 'Head', 'Description']).includes(label) ? <LedgerFilters column={label} filters={draftFilters} heads={reportHeads} contracts={contractOptions} users={data.users} includeTime creditUsers={company || attachmentReview ? data.creditUsers : []} onChange={stageFilters} /> : label}</th>)}</tr></thead><tbody>
        {pageRows(currentPage).map(({ cells, entry: rowEntry }, index) => {
          return <tr ref={rowEntry && rowEntry.id === report.rows.at(-1)?.entry.id ? lastEntry : undefined} key={rowEntry ? `transaction:${rowEntry.id}` : `total:${index}`} className={rowEntry ? `ledger-entry${selectedIds.has(rowEntry.id) ? ' entry-selected' : ''}` : 'ledger-total'} onClick={(event) => { if (rowEntry) { if (selectionActive) toggleSelection(rowEntry.id, event.shiftKey); else openEntry(rowEntry); } }}>
            {selectionActive && <td>{rowEntry && <input type="checkbox" aria-label={`Select entry ${rowEntry.id}`} checked={selectedIds.has(rowEntry.id)} onClick={(event) => { event.stopPropagation(); toggleSelection(rowEntry.id, event.shiftKey); }} onChange={() => {}} />}</td>}
            {cells.map((value, column) => <td key={column} className={column >= 5 ? 'ledger-amount' : undefined}>{column === 0 && rowEntry && !selectionActive ? <button className="ledger-row-link" onClick={(event) => { event.stopPropagation(); openEntry(rowEntry); }}>{value}</button> : typeof value === 'number' ? money(value) : value}</td>)}
          </tr>;
        })}
      </tbody></table></div>
      </>}
      {!report.rows.length && <p className="text-muted">No entries in this selection.</p>}
      <div className="flex-row items-center justify-between gap-sm">
        <button className="btn" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span>Page {currentPage + 1} / {pageCount} · {report.rows.length} entries</span>
        <button className="btn" disabled={currentPage + 1 === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
      </div>
      {!attachmentReview && <details className="disclosure" open={showInactive} onToggle={(event) => setShowInactive(event.currentTarget.open)}><summary>Deactivated entries</summary>
        {transactions.filter((entry) => !entry.active && matchesContractScope(entry, filters.contractId) && matchesUserScope(entry, filters.userScope) && (!branch || (entry.headId !== null && branch.has(entry.headId)))).map((entry) =>
          <button className="btn" key={entry.id} onClick={() => setSelected(entry)}>{new Date(entry.createdAt).toLocaleString()} · {entryUserName(entry)} · {money(entry.amount)}</button>)}
      </details>}
    </>}
    {selectionActive && <div className="entry-selection-bar flex-row flex-wrap items-center gap-sm" role="region" aria-label="Selected entry actions">
      <strong role="status">{selectedIds.size} {selectedIds.size === 1 ? 'entry' : 'entries'} selected</strong>
      <button className="btn" aria-pressed={selection.range} onClick={() => setSelection((current) => ({ ...current, range: !current.range, anchor: null }))}>{selection.range ? 'Cancel range' : 'Select range'}</button>
      {selection.range && <span>{selection.anchor === null ? 'Tap the first entry' : 'Tap the last entry'}</span>}
      {attachmentReview ? attachmentReview.export(selectedReport().records, selectedReport().document, true) : <ReportActions selected disabled={!selectedIds.size} getReport={() => selectedReport().document} />}
      <button className="btn" disabled={!selectedIds.size} onClick={() => setSelection((current) => ({ ...current, ids: new Set(), anchor: null, range: false }))}>Clear selection</button>
      <button className="btn" onClick={() => setSelection({ scope, active: false, ids: new Set(), anchor: null, range: false })}>Cancel</button>
    </div>}
    {selected && data && <TransactionCard key={selected.id} entry={selected}
      admin company={company} heads={data.heads} users={data.users} creditUsers={data.creditUsers} contracts={data.contracts} transactions={data.transactions}
      onClose={() => { setSelected(null); setReload((value) => value + 1); }} onChanged={refresh} />}

  </div>;
}
