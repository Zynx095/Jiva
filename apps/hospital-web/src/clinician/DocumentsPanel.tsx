import { useEffect, useState } from 'react';
import {
  AsyncButton,
  CATEGORY_TEXT,
  CardHeader,
  DIAGNOSTIC_CATEGORIES,
  DOCUMENT_TYPES,
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
  type DocumentRecord,
} from '@jiva/ui/src';
import { apiBlob, apiPutFile } from '../api';
import { CommandError, Field, inputClass, sendCommand } from '../ui';

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

/**
 * Diagnostic documents of one encounter (X-rays, ECG traces, lab PDFs) for the assigned clinician:
 * upload with a server-verified checksum and file type, list with the verification status, preview images
 * and download. Files are shared with the patient at upload or through a shared report.
 */
export function DocumentsPanel({ encounterId, list, onChanged }: { encounterId: string; list: DocumentRecord[] | null | undefined; onChanged: () => void }) {
  const [uploading, setUploading] = useState(false);
  return (
    <JivaCard>
      <CardHeader
        title="Documents and scans"
        icon="file"
        subtitle="X-rays, ECGs, lab reports · verified on upload · private to the care team unless shared"
        actions={
          !uploading && (
            <JivaButton size="sm" icon="plus" onClick={() => setUploading(true)}>
              Upload
            </JivaButton>
          )
        }
      />
      {uploading && (
        <UploadForm
          encounterId={encounterId}
          onSaved={() => {
            setUploading(false);
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setUploading(false)}
        />
      )}
      {list === undefined ? (
        <SkeletonRows rows={2} className="mt-3" />
      ) : list === null ? (
        <p className="mt-3 text-sm text-danger-700">Documents could not be loaded. They will be retried automatically.</p>
      ) : list.length === 0 ? (
        !uploading && <p className="mt-3 text-sm text-ink-500">No documents for this encounter yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {list.map((d) => (
            <li key={d.documentId} className="py-3">
              <DocumentItem encounterId={encounterId} d={d} />
            </li>
          ))}
        </ul>
      )}
    </JivaCard>
  );
}

function DocumentItem({ encounterId, d }: { encounterId: string; d: DocumentRecord }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const image = d.contentType === 'image/png' || d.contentType === 'image/jpeg';
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const status = documentStatus(d);
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-500">
            {CATEGORY_TEXT[d.category] ?? d.category} · {DOCUMENT_TYPES[d.contentType]?.label ?? d.contentType} · {formatBytes(d.sizeBytes)}
          </p>
          <p className="truncate text-sm font-semibold text-ink-900" title={d.fileName}>
            {d.title}
          </p>
          <p className="text-xs text-ink-500">
            {d.fileName} · {d.uploadedAt ? `uploaded ${formatDateTime(d.uploadedAt)}` : d.createdAt ? `declared ${formatDateTime(d.createdAt)}` : ''}
            {d.uploader ? ` by ${d.uploader.displayName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <JivaStatus meta={status} />
          {d.patientVisible && <JivaStatus meta={{ label: 'Shared with patient', tone: 'ok', icon: 'eye' }} />}
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
        </div>
      )}
      {preview && (
        <figure className="mt-2">
          <img src={preview} alt={d.title} className="max-h-80 rounded-lg ring-1 ring-ink-200" />
          <figcaption className="mt-1 text-xs text-ink-500">
            {d.title}
            {d.dataStatus === 'SYNTHETIC_DEMO' ? ' — synthetic demo file' : ''}
          </figcaption>
        </figure>
      )}
      {error && <CommandError message={error} />}
    </div>
  );
}

type Step = 'idle' | 'checking' | 'declaring' | 'uploading';

function UploadForm({ encounterId, onSaved, onRefresh, onCancel }: { encounterId: string; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('IMAGING');
  const [title, setTitle] = useState('');
  const [share, setShare] = useState(false);
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const type = file ? documentTypeOf(file) : undefined;
  const problem = !file ? null : !type ? 'Accepted files: PDF, PNG, JPEG or DICOM.' : file.size === 0 ? 'The file is empty.' : file.size > MAX_DOCUMENT_BYTES ? `Files up to ${formatBytes(MAX_DOCUMENT_BYTES)}.` : null;
  const id = (k: string) => `doc-${encounterId}-${k}`;

  const submit = async () => {
    if (!file || !type || problem) return 'Choose a valid file';
    setError(null);
    setStep('checking');
    const sha256 = await sha256Hex(file);
    setStep('declaring');
    const declared = await sendCommand<{ document: DocumentRecord; upload: { url: string } }>(encPath(encounterId), {
      clientRequestId: crypto.randomUUID(),
      category,
      title: title.trim() || file.name,
      fileName: file.name,
      contentType: type,
      sizeBytes: file.size,
      sha256,
      patientVisible: share,
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
      <p className="text-sm font-semibold text-ink-900">Upload a document</p>
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
        <Field label="Type" htmlFor={id('cat')} required>
          <select id={id('cat')} className={cx(inputClass, 'h-9')} value={category} onChange={(e) => setCategory(e.target.value)}>
            {DIAGNOSTIC_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_TEXT[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Title" htmlFor={id('title')} required>
          <input id={id('title')} className={cx(inputClass, 'h-9')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <label className="inline-flex items-center gap-2 text-sm text-ink-800 sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={share} onChange={(e) => setShare(e.target.checked)} />
          Share with the patient now (otherwise share it through a report)
        </label>
      </div>
      {problem && <p className="text-xs font-semibold text-danger-700">{problem}</p>}
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
