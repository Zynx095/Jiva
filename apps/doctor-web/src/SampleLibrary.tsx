import { useEffect, useState } from 'react';
import {
  AsyncButton,
  DOCUMENT_KIND_TEXT,
  Icon,
  JivaBadge,
  JivaButton,
  cx,
  formatBytes,
  type DocumentRecord,
  type SampleCatalogueEntry,
} from '@jiva/ui/src';
import { apiBlob } from './api';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from './ui';
import { useUnsaved } from './unsaved';
import { useSampleLibrary } from './useCatalogue';

const FILTERS = ['ALL', 'XRAY', 'CT', 'MRI', 'ULTRASOUND', 'ECG', 'LAB_REPORT'] as const;

/**
 * The synthetic sample library (demo mode only): browse the catalogue's sample documents, preview the
 * images, and attach one to this encounter. An attached sample is stored and shown as a sample — never as
 * the patient's own result — and attaching one records no finding.
 */
export function SampleLibrary({ encounterId, replaceable, onAttached, onClose }: { encounterId: string; replaceable: DocumentRecord[]; onAttached: () => void; onClose: () => void }) {
  const library = useSampleLibrary();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('ALL');
  const [chosen, setChosen] = useState<SampleCatalogueEntry | null>(null);

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-warn-50/40 p-3 ring-1 ring-inset ring-warn-200">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="layers" size={16} className="text-warn-800" />
        <p className="text-sm font-semibold text-ink-900">Synthetic sample library</p>
        <JivaBadge tone="warn" icon="alertTriangle">
          Demo only · not patient data
        </JivaBadge>
        <JivaButton size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          Close
        </JivaButton>
      </div>
      {library.state === 'loading' ? (
        <p className="text-sm text-ink-500">Loading the sample library…</p>
      ) : library.state === 'unavailable' ? (
        <p className="text-sm text-ink-700">The sample library exists in demo mode only. In operational mode synthetic samples can never be attached to an encounter.</p>
      ) : library.state === 'error' ? (
        <p className="text-sm text-danger-700">The sample library could not be loaded.</p>
      ) : chosen ? (
        <AttachForm encounterId={encounterId} entry={chosen} replaceable={replaceable.filter((d) => d.category === chosen.category)} onBack={() => setChosen(null)} onAttached={onAttached} />
      ) : (
        <>
          <p className="text-xs text-ink-600">{library.data.notice}</p>
          <div role="group" aria-label="Filter by document type" className="flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f}
                type="button"
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
                className={cx('rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset', filter === f ? 'bg-ink-900 text-white ring-ink-900' : 'bg-white text-ink-700 ring-ink-200 hover:bg-ink-50')}
              >
                {f === 'ALL' ? 'All' : DOCUMENT_KIND_TEXT[f] ?? f}
              </button>
            ))}
          </div>
          <ul className="grid gap-2 sm:grid-cols-2">
            {library.data.entries
              .filter((e) => filter === 'ALL' || e.documentType === filter)
              .map((e) => (
                <li key={e.assetId}>
                  <SampleCard entry={e} onChoose={() => setChosen(e)} />
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SampleCard({ entry, onChoose }: { entry: SampleCatalogueEntry; onChoose: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const image = entry.contentType.startsWith('image/');
  return (
    <div className="h-full rounded-lg bg-white p-2.5 ring-1 ring-inset ring-ink-200">
      <p className="text-xs font-semibold text-ink-500">
        {DOCUMENT_KIND_TEXT[entry.documentType] ?? entry.documentType} · {entry.contentType === 'application/pdf' ? 'PDF' : 'Image'} · {formatBytes(entry.sizeBytes)}
      </p>
      <p className="text-sm font-semibold text-ink-900">{entry.title}</p>
      {entry.description && <p className="text-xs text-ink-600">{entry.description}</p>}
      <p className="mt-1 text-[11px] text-ink-500">
        {entry.designation === 'SYNTHETIC' ? 'Synthetic' : 'Educational'} · {entry.provenance.source} · {entry.assetId}
      </p>
      {preview && <img src={preview} alt={`${entry.title} (synthetic sample)`} className="mt-2 max-h-48 w-full rounded-md object-contain ring-1 ring-ink-200" />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {image && !preview && (
          <AsyncButton
            size="sm"
            variant="ghost"
            icon="eye"
            pendingText="Loading…"
            onAction={async () => {
              try {
                setPreview(URL.createObjectURL(await apiBlob(`/api/catalogue/scan-assets/${encodeURIComponent(entry.assetId)}/content`)));
                return null;
              } catch {
                return 'Preview unavailable';
              }
            }}
          >
            Preview
          </AsyncButton>
        )}
        <JivaButton size="sm" variant="secondary" icon="plus" onClick={onChoose}>
          Attach to this encounter
        </JivaButton>
      </div>
    </div>
  );
}

function AttachForm({ encounterId, entry, replaceable, onBack, onAttached }: { encounterId: string; entry: SampleCatalogueEntry; replaceable: DocumentRecord[]; onBack: () => void; onAttached: () => void }) {
  const [title, setTitle] = useState(entry.title);
  const [share, setShare] = useState(false);
  const [supersedes, setSupersedes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  useUnsaved(title !== entry.title || share || supersedes !== '', 'a sample attachment');
  const id = (k: string) => `sample-${entry.assetId}-${k}`;
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-800">
        Attach <span className="font-semibold">{entry.title}</span> ({entry.assetId}). It will be stored and shown as a <span className="font-semibold">synthetic sample</span>, not as a result of this patient.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Title" htmlFor={id('title')} required>
          <input id={id('title')} className={cx(inputClass, 'h-9')} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Replaces" htmlFor={id('sup')} hint="Optional: a document of the same category this sample replaces.">
          <select id={id('sup')} className={cx(inputClass, 'h-9')} value={supersedes} onChange={(e) => setSupersedes(e.target.value)}>
            <option value="">Nothing</option>
            {replaceable.map((d) => (
              <option key={d.documentId} value={d.documentId}>
                {d.title} (version {d.version ?? 1})
              </option>
            ))}
          </select>
        </Field>
        <label className="inline-flex items-center gap-2 text-sm text-ink-800 sm:col-span-2">
          <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={share} onChange={(e) => setShare(e.target.checked)} />
          Share with the patient (they see it labelled as a synthetic sample)
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="primary"
          icon="check"
          disabled={!title.trim()}
          pendingText="Attaching…"
          onAction={async () => {
            const body = { assetId: entry.assetId, title: title.trim(), patientVisible: share, ...(supersedes ? { supersedesDocumentId: supersedes } : {}) };
            const r = await sendCommand(`/api/encounters/${encodeURIComponent(encounterId)}/documents/samples`, { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onAttached();
            return r.error;
          }}
        >
          Attach sample
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onBack}>
          Back to the library
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}
