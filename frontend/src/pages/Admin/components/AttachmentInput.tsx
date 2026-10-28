import { AttachmentExport } from '../../Ledger/AttachmentExport';
import { Icon } from '../../../Icon';
import { useEffect, useRef, useState } from 'react';
import type { Attachment } from '../types';
import { cashbookApi } from '../../../data/cashbookApi';
import { Dialog } from './Dialog';

// Shared picker and review for image evidence and voice notes.
export function AttachmentInput({ kind, items, onChange, onBusyChange, multiple = true, exportable = false }: {
  kind: Attachment['kind']; items: Attachment[];
  multiple?: boolean; exportable?: boolean;
  onChange?: (items: Attachment[]) => void; onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Attachment | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const uploading = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      const current = recorder.current;
      if (current?.state === 'recording') current.stop();
      current?.stream.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);

  async function add(files: File[]) {
    if (!files.length || uploading.current) return;
    uploading.current = true;
    setBusy(true); setError('');
    try {
      const selected = multiple ? files : files.slice(0, 1);
      const results = await Promise.allSettled(selected.map((file) => cashbookApi.uploadAttachment(file, kind)));
      const uploaded: Attachment[] = [];
      const errors: string[] = [];
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') uploaded.push(result.value);
        else errors.push(`${selected[index].name}: ${result.reason instanceof Error ? result.reason.message : 'Could not attach file.'}`);
      });
      if (mounted.current) {
        if (uploaded.length) onChange?.(multiple ? [...items, ...uploaded] : uploaded);
        setError(errors.join(' '));
      }
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : 'Could not attach files.');
    } finally { uploading.current = false; if (mounted.current) setBusy(false); }
  }
  async function record() {
    if (busy || uploading.current) return;
    setError(''); setBusy(true);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
        throw new Error('Recording is unavailable here. You can upload a voice file instead.');
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!mounted.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      let current: MediaRecorder;
      try { current = new MediaRecorder(stream); }
      catch (error) { stream.getTracks().forEach((track) => track.stop()); throw error; }
      recorder.current = current;
      const chunks: Blob[] = [];
      current.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      current.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (!mounted.current) return;
        setRecording(false);
        const mime = current.mimeType || chunks[0]?.type || 'audio/webm';
        const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        void add([new File(chunks, `Voice note ${items.length + 1}.${extension}`, { type: mime })]);
      };
      current.start(); setRecording(true);
    } catch (error) {
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
      if (!mounted.current) return;
      setError(error instanceof Error ? error.message : 'Microphone access failed. Try uploading a voice file.');
      setBusy(false);
    }
  }
  return <div className="flex-col gap-sm">
    {onChange && <>
      <input ref={fileInput} type="file" hidden multiple={multiple}
        accept={kind === 'image' ? 'image/*' : 'audio/*'} disabled={busy}
        onChange={async (event) => { const input = event.currentTarget; await add(Array.from(input.files ?? [])); input.value = ''; }} />
      {kind === 'image' && <input ref={cameraInput} type="file" hidden accept="image/*" capture="environment" disabled={busy}
        onChange={async (event) => { const input = event.currentTarget; await add(Array.from(input.files ?? [])); input.value = ''; }} />}
      <div className={`attachment-dropzone flex-col items-center gap-md${dragOver ? ' attachment-dropzone--active' : ''}`}
        role="region" aria-label={kind === 'image' ? 'Add images' : 'Add voice notes'} aria-busy={busy}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
          if (!busy) setDragOver(true);
        }}
        onDragLeave={(event) => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault(); event.stopPropagation(); setDragOver(false);
          if (!busy) void add(Array.from(event.dataTransfer.files));
        }}>
        <button type="button" className={`btn attachment-trigger${recording ? ' attachment-trigger--recording' : ''}`}
          disabled={busy && !recording}
          aria-label={recording ? 'Stop recording' : kind === 'image' ? 'Add or replace image' : 'Record a voice note'}
          title={recording ? 'Stop recording' : kind === 'image' ? 'Choose image · up to 5 MB' : 'Tap to record a voice note'}
          onClick={() => {
            if (recording) {
              if (recorder.current?.state === 'recording') recorder.current.stop();
              setRecording(false);
            }
            else if (kind === 'image') fileInput.current?.click();
            else void record();
          }}>
            <Icon size={26} strokeWidth="1.7">
              {recording ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" /> : kind === 'image' ? <>
                <rect x="3" y="3" width="18" height="18" rx="3" />
                <circle cx="8" cy="8" r="1.5" />
                <path d="m3 17 5-5 4 4 4-6 5 7" />
              </> : <>
                <rect x="9" y="2" width="6" height="13" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
              </>}
            </Icon>
        </button>
        <p className="attachment-prompt">{kind === 'image'
          ? `Drag ${multiple ? 'images' : 'an image'} here or choose below`
          : recording ? 'Tap to stop recording' : 'Tap the microphone to record'}</p>
        <div className="attachment-actions flex-row flex-wrap gap-sm">
          <button type="button" className="btn" disabled={busy} onClick={() => fileInput.current?.click()}>
            {kind === 'image' ? 'Gallery / files' : 'Upload audio file'}
          </button>
          {kind === 'image' && <button type="button" className="btn" disabled={busy}
            onClick={() => cameraInput.current?.click()}>Camera</button>}
        </div>
        <p className="hint text-muted">{kind === 'image' && multiple ? 'Add multiple photos, together or one at a time. ' : ''}Up to 5 MB per file.</p>
      </div>
      {busy && <p role="status">{recording ? 'Recording… stop when you are done.' : 'Preparing attachment…'}</p>}
    </>}
    {error && <p role="alert" className="text-error">{error}</p>}
    {!onChange && items.length === 0 && <p className="text-muted">No {kind === 'image' ? 'images' : 'voice notes'} attached.</p>}
    <div className={`attachment-list${kind === 'image' ? ' attachment-list--images' : ''}`}>
      {items.map((item) => <figure key={item.id} className="flex-col gap-sm">
        {kind === 'image' ? <button type="button" className="transaction-thumbnail" onClick={() => setExpanded(item)} aria-label={`Open ${item.name} full size`}>
          <img className="attachment-image" src={item.url} alt={item.name} /></button>
          : <audio controls preload="metadata" src={item.url} aria-label={item.name} />}
        <figcaption className="hint">{item.name}</figcaption>
        {onChange && <button type="button" className="btn attachment-remove" disabled={busy}
          aria-label={`Remove ${item.name}`} title={`Remove ${item.name}`}
          onClick={() => onChange(items.filter((other) => other.id !== item.id))}>×</button>}
      </figure>)}
    </div>
    {expanded && <Dialog title={expanded.name} className="image-lightbox" onClose={() => setExpanded(null)}>
      <img src={expanded.url} alt={expanded.name} />
      <div className="flex-row flex-wrap gap-sm">
        {exportable && <AttachmentExport items={[expanded]} perPage={1} />}
        <button type="button" className="btn" onClick={() => setExpanded(null)}>Close image</button>
      </div>
    </Dialog>}
  </div>;
}
