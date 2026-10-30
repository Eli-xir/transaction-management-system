import { PdfPreview } from './PdfPreview';
import { AttachmentExport } from './AttachmentExport';
import { Icon } from '../../Icon';
import { cashbookApi } from '../../data/cashbookApi';
import { useState } from 'react';
import type { AdminUser, CreditUser, FiltersState, Head, Attachment } from '../Admin/types';
import { HomeCard } from '../Admin/components/HomeCard';
import { Dialog } from '../Admin/components/Dialog';
import { AttachmentInput } from '../Admin/components/AttachmentInput';
import { matchesUser } from '../Admin/utils/userProfile';
import { Ledger } from './Ledger';
import { money } from './ledgerModel';
import { attachmentPdf, type EvidenceRecord } from './attachmentReport';
import { download, printLedger, type ReportDocument } from './ledgerExport';
import './AttachmentsPage.css';

const ignoreDirty = () => {};
const unchanged = async () => {};
const empty: FiltersState = { dateFrom: '', dateTo: '', userScope: 'all', direction: 'both' };
export function AttachmentsPage({ users, creditUsers, heads, initialScope = '' }: {
  initialScope?: string; users: AdminUser[]; creditUsers: CreditUser[]; heads: Head[];
}) {
  const [scope, setScope] = useState(initialScope);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FiltersState>({ ...empty, userScope: initialScope || 'all' });
  const [images, setImages] = useState<Attachment[]>([]);
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [perPage, setPerPage] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pdf, setPdf] = useState<File | null>(null);
  const people = [
    ...users.filter((user) => user.role !== 'admin').map((user) => ({ ...user, id: user.user_id, type: 'user' as const })),
    ...creditUsers.map((user) => ({ ...user, id: `credit:${user.credit_user_id}`, type: 'external' as const })),
  ];
  const selected = people.find((user) => user.id === filters.userScope);
  const photo = imageIndex === null ? null : images[imageIndex];
  
  async function prepare(records: EvidenceRecord[], document: ReportDocument) {
    setBusy(true); setError('');
    try { setPdf(await attachmentPdf(records, document, perPage, cashbookApi.attachmentImages)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not prepare images.'); }
    finally { setBusy(false); }
  }
  async function share() {
    if (!pdf) return;
    if (!navigator.canShare?.({ files: [pdf] })) { setError('Download the PDF and attach it in WhatsApp or email. Direct file sharing is unavailable in this browser.'); return; }
    try { await navigator.share({ files: [pdf], title: 'Transaction attachments' }); }
    catch (cause) { if (!(cause instanceof DOMException && cause.name === 'AbortError')) setError('Could not share the file. Download it instead.'); }
  }
  const exportControls = (records: EvidenceRecord[], document: ReportDocument, selected = false) => <div className="flex-row flex-wrap items-center gap-sm">
    {!selected && <label className="field"><span>Images per A4 page (maximum)</span><select value={perPage} disabled={busy} onChange={(event) => setPerPage(Number(event.target.value))}>
      {[1, 2, 4, 6].map((count) => <option key={count}>{count}</option>)}</select></label>}
    {(selected ? ['Preview selected', 'Print selected', 'Download PDF'] : ['Preview / export']).map((label) => <button key={label} className="btn" disabled={busy || !records.length} onClick={() => void prepare(records, document)}>{busy ? 'Preparing…' : label}</button>)}
    <AttachmentExport items={records.flatMap(({ entry }) => entry.attachments)} perPage={perPage} />
  </div>;
  return <section className="evidence-page flex-col gap-md">
    <header className="flex-row items-center gap-sm">
      {scope && <button className="btn" disabled={busy} onClick={() => { setScope(''); setImageIndex(null); setError(''); }}>← Users</button>}
      <h1>{selected ? `Attachments · ${selected.user_name}` : 'Attachments'}</h1>
    </header>
    {!scope ? <>
      <input type="search" aria-label="Search attachment users" placeholder="Search name, contact or description" value={search} onChange={(event) => setSearch(event.target.value)} />
      <div className="home-cards">{people.filter((user) => matchesUser(user, search)).map((user, index) => <HomeCard key={user.id}
        title={user.user_name} description={user.description} detail={user.is_active ? undefined : 'Inactive'} accountType={user.type}
        tone={(['blue', 'gold', 'green', 'purple'] as const)[index % 4]} actions={<span className="hint">{user.type === 'external' ? 'External user' : 'User'}</span>}
        icon={<Icon size={42}><path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h4" /></Icon>}
        onClick={() => { setScope(user.id); setFilters({ ...empty, userScope: user.id }); setImageIndex(null); }} />)}</div>
      {!people.some((user) => matchesUser(user, search)) && <p>No matching users.</p>}
    </> : <>
      <Ledger filters={filters} onFilterChange={(next) => { setFilters(next); setImageIndex(null); }}
        revision={0} heads={heads} users={users} onDirtyChange={ignoreDirty} onChanged={unchanged}
        attachmentReview={{ export: exportControls, render: (records, columns, selection) => <div className="evidence-records">{records.map(({ entry, cells }) =>
          <article key={entry.id} className={`evidence-record${selection.ids.has(entry.id) ? ' entry-selected' : ''}`} onClick={(event) => { if (selection.active) selection.toggle(entry.id, event.shiftKey); }}>
            {selection.active && <label className="entry-selection-check" onClick={(event) => event.stopPropagation()}><input type="checkbox" aria-label={`Select entry ${entry.id}`} checked={selection.ids.has(entry.id)} onClick={(event) => { event.stopPropagation(); selection.toggle(entry.id, event.shiftKey); }} onChange={() => {}} /> Select entry</label>}
            <div className="flex-col gap-md" inert={selection.active}>
            {!selection.active && <AttachmentExport items={entry.attachments} perPage={perPage} />}
            <dl className="evidence-entry">{cells.map((value, index) => index < 5 && <div key={columns[index]}><dt>{columns[index]}</dt><dd>{typeof value === 'number' ? money(value) : value || '—'}</dd></div>)}</dl>
            <div className="flex-col gap-md">
              <div className="evidence-images">{entry.attachments.filter((a) => a.kind === 'image').map((attachment, index, items) =>
                <button key={attachment.id} aria-label={`Open ${attachment.name}`} onClick={() => { setImages(items); setImageIndex(index); setZoom(1); }}>
                  <img loading="lazy" src={attachment.url} alt={attachment.name} />
                </button>)}</div>
              {entry.attachments.some((a) => a.kind === 'voice') && <AttachmentInput kind="voice" items={entry.attachments.filter((a) => a.kind === 'voice')} />}
              {!entry.attachments.length && <p className="text-muted">No attachments</p>}
              <dl className="evidence-entry">{cells.map((value, index) => index >= 5 && <div key={columns[index]}><dt>{columns[index]}</dt><dd>{typeof value === 'number' ? money(value) : '—'}</dd></div>)}</dl>
            </div>
            </div>
          </article>)}</div> }} />
    </>}
    {error && !pdf && <p className="text-error" role="alert">{error}</p>}
    {photo && <Dialog className="evidence-lightbox" title={photo.name} onClose={() => setImageIndex(null)}>
      <div className="flex-row flex-wrap items-center gap-sm">
        <button className="btn" disabled={imageIndex === 0} onClick={() => { setImageIndex(imageIndex! - 1); setZoom(1); }}>← Previous</button>
        <span>{imageIndex! + 1} / {images.length}</span>
        <button className="btn" disabled={imageIndex === images.length - 1} onClick={() => { setImageIndex(imageIndex! + 1); setZoom(1); }}>Next →</button>
        <select aria-label="Image zoom" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}><option value="1">Fit</option><option value="2">200%</option><option value="3">300%</option></select>
        <AttachmentExport items={[photo]} perPage={1} />
        <button className="btn" onClick={() => setImageIndex(null)}>Close image</button>
      </div>
      <div className="evidence-full-image"><img src={photo.url} alt={photo.name} style={{ width: `${zoom * 100}%`, maxHeight: zoom === 1 ? '75dvh' : undefined }} /></div>
    </Dialog>}
    {pdf && <Dialog className="report-preview" title="Attachment pages" onClose={() => setPdf(null)}>
      <div className="flex-row flex-wrap gap-sm">
        <button className="btn" onClick={() => { setError(''); void download(pdf, pdf.name).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not download the file.')); }}>Download PDF</button>
        <button className="btn" onClick={() => void share()}>Share…</button>
        <button className="btn" onClick={() => { try { printLedger(pdf); } catch (cause) { setError((cause as Error).message); } }}>Print</button>
        <button className="btn" onClick={() => setPdf(null)}>Close</button>
      </div>
      {error && <p className="text-error" role="alert">{error}</p>}
      <PdfPreview file={pdf} />
    </Dialog>}
  </section>;
}
