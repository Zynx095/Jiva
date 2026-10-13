import { useEffect, useMemo, useState } from 'react';
import {
  AsyncButton,
  CATEGORY_TEXT,
  CardHeader,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_TEXT,
  DOCUMENT_TYPES,
  Icon,
  JivaButton,
  JivaCard,
  JivaStatus,
  MAX_DOCUMENT_BYTES,
  SkeletonRows,
  cx,
  documentStatus,
  documentTypeOf,
  formatBytes,
  formatDateTime,
  sampleLabel,
  type DocumentRecord,
} from '@jiva/ui/src';
import { apiBlob, apiPutFile } from './api';
import { SampleLibrary } from './SampleLibrary';
import { CommandError, Field, inputClass, sendCommand } from './ui';

const encPath = (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}/documents`;

async function sha256Hex(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Save a protected document through the API (credentials in the request, never in a URL). */
async function saveDocument(encounterId: string, d: DocumentRecord): Promise<string | null> {
  try {
    const blob = await apiBlob(`${encPath(encounterId)}/${encodeURIComponent(d.documentId)}/content`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = d.fileName;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return null;
  } catch {
    return 'The document could not be downloaded.';
  }
}

/** The first document type that fits a category (documents recorded before types existed have none). */
const firstKindFor = (category: string) => DOCUMENT_KINDS.find((k) => k.category === category)?.value ?? 'OTHER';

/** Documents that may be replaced by a new version: verified and not yet replaced. */
const replaceable = (list: DocumentRecord[]) => list.filter((d) => d.status === 'AVAILABLE' && !d.supersededBy);

/**
 * Diagnostic documents of one encounter (X-ray, CT, MRI, ultrasound, ECG, laboratory reports …) for the
 * assigned clinician: upload with a server-verified checksum and file type, attach a labelled synthetic
 * sample from the catalogue (demo only), replace a document with a new version (the old one is kept),
 * preview images and download. JIVA stores and shows files; it never interprets them.
 */
export function DocumentsPanel({ encounterId, list, onChanged }: { encounterId: string; list: DocumentRecord[] | null | undefined; onChanged: () => void }) {
  const [mode, setMode] = useState<'none' | 'upload' | 'samples'>('none');
  const [replacing, setReplacing] = useState<string | undefined>(undefined);
  const done = () => {
    setMode('none');
    setReplacing(undefined);
    onChanged();
  };
  return (
    <JivaCard>
      <CardHeader
        title="Documents and scans"
        icon="file"
        subtitle="Verified on upload · private to the care team unless shared · JIVA does not interpret images or results"
        actions={
          mode === 'none' && (
            <div className="flex flex-wrap gap-1.5">
              <JivaButton size="sm" icon="plus" onClick={() => setMode('upload')}>
                Upload
              </JivaButton>
              <JivaButton size="sm" variant="warn-soft" icon="layers" onClick={() => setMode('samples')}>
                Sample library (demo)
              </JivaButton>
            </div>
          )
        }
      />
      {mode === 'upload' && (
        <UploadForm
          encounterId={encounterId}
          replaceable={replaceable(list ?? [])}
          replacing={replacing}
          onSaved={done}
          onRefresh={onChanged}
          onCancel={() => {
            setMode('none');
            setReplacing(undefined);
          }}
        />
      )}
      {mode === 'samples' && <SampleLibrary encounterId={encounterId} replaceable={replaceable(list ?? [])} onAttached={done} onClose={() => setMode('none')} />}
      {list === undefined ? (
        <SkeletonRows rows={2} className="mt-3" />
      ) : list === null ? (
        <p className="mt-3 text-sm text-danger-700">Documents could not be loaded. They will be retried automatically.</p>
      ) : list.length === 0 ? (
        mode === 'none' && <p className="mt-3 text-sm text-ink-500">No documents for this encounter yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {list.map((d) => (
            <li key={d.documentId} className="py-3">
              <DocumentItem
                encounterId={encounterId}
                d={d}
                all={list}
                onReplace={() => {
                  setReplacing(d.documentId);
                  setMode('upload');
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </JivaCard>
  );
}

function DocumentItem({ encounterId, d, all, onReplace }: { encounterId: string; d: DocumentRecord; all: DocumentRecord[]; onReplace: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = d.contentType === 'image/png' || d.contentType === 'image/jpeg';
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const status = documentStatus(d);
  const sample = sampleLabel(d);
  const newer = d.supersededBy ? all.find((x) => x.documentId === d.supersededBy) : undefined;
  const older = d.supersedes ? all.find((x) => x.documentId === d.supersedes) : undefined;
  return (
    <div className={cx(d.supersededBy && 'opacity-75')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-500">
            {d.documentType ? DOCUMENT_KIND_TEXT[d.documentType] ?? d.documentType : CATEGORY_TEXT[d.category] ?? d.category} · {DOCUMENT_TYPES[d.contentType]?.label ?? d.contentType} · {formatBytes(d.sizeBytes)}
            {d.version ? ` · version ${d.version}` : ''}
          </p>
          <p className="truncate text-sm font-semibold text-ink-900" title={d.fileName}>
            {d.title}
          </p>
          <p className="text-xs text-ink-500">
            {d.fileName} · {d.uploadedAt ? `${sample ? 'attached' : 'uploaded'} ${formatDateTime(d.uploadedAt)}` : d.createdAt ? `declared ${formatDateTime(d.createdAt)}` : ''}
            {d.uploader ? ` by ${d.uploader.displayName}` : ''}
          </p>
          {(newer || older) && (
            <p className="text-xs text-ink-600">
              {newer ? `Replaced by version ${newer.version ?? '?'} (${newer.title})` : ''}
              {newer && older ? ' · ' : ''}
              {older ? `Replaces version ${older.version ?? 1} (${older.title})` : ''}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {sample && <JivaStatus meta={{ label: sample, tone: 'warn', icon: 'alertTriangle', hint: 'A synthetic sample from the catalogue for the demonstration. It is not a result of this patient.' }} />}
          <JivaStatus meta={status} />
          {d.patientVisible && <JivaStatus meta={{ label: 'Shared with patient', tone: 'ok', icon: 'eye' }} />}
          {d.supersededBy && <JivaStatus meta={{ label: 'Older version', tone: 'neutral', icon: 'clock' }} />}
        </div>
      </div>
      {d.status === 'REJECTED' && <p className="mt-1 text-xs text-danger-700">{status.hint} Upload the file again.</p>}
      {d.status === 'AVAILABLE' && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {image && !preview && (
            <AsyncButton
              size="sm"
              variant="ghost"
              icon="eye"
              pendingText="Loading…"
              onAction={async () => {
                try {
                  setPreview(URL.createObjectURL(await apiBlob(`${encPath(encounterId)}/${encodeURIComponent(d.documentId)}/content`)));
                  return null;
                } catch {
                  return 'Preview unavailable';
                }
              }}
            >
              Preview
            </AsyncButton>
          )}
          <AsyncButton
            size="sm"
            variant="ghost"
            icon="arrowDown"
            pendingText="Downloading…"
            onAction={async () => {
              const err = await saveDocument(encounterId, d);
              setError(err);
              return err;
            }}
          >
            Download
          </AsyncButton>
          {!d.supersededBy && (
            <JivaButton size="sm" variant="ghost" icon="refresh" onClick={onReplace}>
              Upload a new version
            </JivaButton>
          )}
        </div>
      )}
      {preview && (
        <figure className="mt-2">
          <img src={preview} alt={d.title} className="max-h-80 rounded-lg ring-1 ring-ink-200" />
          <figcaption className="mt-1 text-xs text-ink-500">
            {d.title}
            {sample ? (/sample/i.test(d.title) ? ' — not this patient' : ` — ${sample.toLowerCase()}`) : d.dataStatus === 'SYNTHETIC_DEMO' ? ' — synthetic demo file' : ''}
          </figcaption>
        </figure>
      )}
      {error && <CommandError message={error} />}
    </div>
  );
}

type Step = 'idle' | 'checking' | 'declaring' | 'uploading';

function UploadForm({ encounterId, replaceable, replacing, onSaved, onRefresh, onCancel }: {
  encounterId: string;
  replaceable: DocumentRecord[];
  replacing?: string;
  onSaved: () => void;
  onRefresh: () => void;
  onCancel: () => void;
}) {
  const target = replaceable.find((d) => d.documentId === replacing);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState(() => target?.documentType ?? (target ? firstKindFor(target.category) : 'XRAY'));
  const [category, setCategory] = useState(() => target?.category ?? 'IMAGING');
  const [title, setTitle] = useState(target ? `${target.title} — new version` : '');
  const [share, setShare] = useState(false);
  const [supersedes, setSupersedes] = useState(replacing ?? '');
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const type = file ? documentTypeOf(file) : undefined;
  const problem = !file ? null : !type ? 'Accepted files: PDF, PNG, JPEG or DICOM.' : file.size === 0 ? 'The file is empty.' : file.size > MAX_DOCUMENT_BYTES ? `Files up to ${formatBytes(MAX_DOCUMENT_BYTES)}.` : null;
  const id = (k: string) => `doc-${encounterId}-${k}`;
  const kinds = useMemo(() => DOCUMENT_KINDS.filter((k) => !supersedes || k.category === category || (k.value === 'OTHER' && ['OTHER', 'PROCEDURE'].includes(category))), [supersedes, category]);

  const chooseKind = (value: string) => {
    setKind(value);
    const k = DOCUMENT_KINDS.find((x) => x.value === value);
    if (k && !supersedes) setCategory(k.category);
  };
  const chooseTarget = (docId: string) => {
    setSupersedes(docId);
    const t = replaceable.find((d) => d.documentId === docId);
    if (t) {
      setCategory(t.category);
      setKind(t.documentType ?? firstKindFor(t.category));
    }
  };

  const submit = async () => {
    if (!file || !type || problem) return 'Choose a valid file';
    setError(null);
    setStep('checking');
    const sha256 = await sha256Hex(file);
    setStep('declaring');
    const declared = await sendCommand<{ document: DocumentRecord; upload: { url: string } }>(encPath(encounterId), {
      clientRequestId: crypto.randomUUID(),
      category,
      documentType: kind,
      title: title.trim() || file.name,
      fileName: file.name,
      contentType: type,
      sizeBytes: file.size,
      sha256,
      patientVisible: share,
      ...(supersedes ? { supersedesDocumentId: supersedes } : {}),
    });
    if (declared.error || !declared.body?.upload) {
      setStep('idle');
      setError(declared.error ?? 'The upload could not be prepared.');
      return declared.error ?? 'failed';
    }
    setStep('uploading');
    let put;
    try {
      put = await apiPutFile(declared.body.upload.url, file, type);
    } catch {
      setStep('idle');
      setError('The connection dropped during the upload. Try again.');
      onRefresh(); // the declared (pending) document is listed, so its state stays visible
      return 'failed';
    }
    setStep('idle');
    if (put.status !== 200) {
      const msg = put.body.message ?? put.body.error ?? `Upload failed (${put.status}).`;
      setError(msg);
      onRefresh();
      return msg;
    }
    onSaved();
    return null;
  };

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-sm font-semibold text-ink-900">{supersedes ? 'Upload a new version' : 'Upload a document'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="File" htmlFor={id('file')} required hint="PDF, PNG, JPEG or DICOM, up to 20 MB. Use synthetic files in the demo." className="sm:col-span-2">
          <input
            id={id('file')}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.dcm,application/pdf,image/png,image/jpeg,application/dicom"
            className="block w-full text-sm text-ink-700 file:mr-3 file:rounded-lg file:border-0 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-ink-800 file:ring-1 file:ring-inset file:ring-ink-300"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              setFile(f);
              if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
            }}
          />
        </Field>
        <Field label="Document type" htmlFor={id('kind')} required hint={`Filed under ${CATEGORY_TEXT[category] ?? category}`}>
          <select id={id('kind')} className={cx(inputClass, 'h-9')} value={kind} onChange={(e) => chooseKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" htmlFor={id('title')} required>
          <input id={id('title')} className={cx(inputClass, 'h-9')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Replaces" htmlFor={id('sup')} className="sm:col-span-2" hint="A new version keeps the earlier one in the record; it is marked as replaced.">
          <select id={id('sup')} className={cx(inputClass, 'h-9')} value={supersedes} onChange={(e) => chooseTarget(e.target.value)}>
            <option value="">Nothing — this is a new document</option>
            {replaceable.map((d) => (
              <option key={d.documentId} value={d.documentId}>
                {d.title} (version {d.version ?? 1}){d.origin === 'CATALOGUE_SAMPLE' ? ' — sample' : ''}
              </option>
            ))}
          </select>
        </Field>
        <label className="inline-flex items-center gap-2 text-sm text-ink-800 sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={share} onChange={(e) => setShare(e.target.checked)} />
          Share with the patient now (otherwise share it through a report)
        </label>
      </div>
      {problem && <p className="text-xs font-semibold text-danger-700">{problem}</p>}
      <p className="flex items-start gap-1.5 text-xs text-ink-500">
        <Icon name="shield" size={13} className="mt-px shrink-0" />
        The file's checksum is computed in your browser and checked by JIVA together with its size and file type before anything is stored.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <AsyncButton variant="primary" icon="send" disabled={!file || !!problem || step !== 'idle'} pendingText={step === 'checking' ? 'Computing checksum…' : step === 'declaring' ? 'Preparing…' : 'Uploading…'} onAction={submit}>
          Upload and verify
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel} disabled={step !== 'idle'}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}
