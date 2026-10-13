import { useEffect, useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  DOCUMENT_KIND_TEXT,
  Icon,
  JivaCard,
  cx,
  formatBytes,
  type CatalogueList,
  type SampleCatalogueEntry,
} from '@jiva/ui/src';
import { blob, call, failure } from './api';
import { DEMO, PRACTITIONER_PERSONA } from './workflows';
import type { LiveState } from './useLiveState';

/**
 * The clinical catalogue's synthetic sample documents (read as the demo administrator, who manages the
 * catalogue). Images preview through the API; a sample can be attached to the demo encounter as the doctor
 * assigned to it — through the same command, authorization and labelling as in the doctor workspace.
 */
export function AssetLibrary({ live }: { live: LiveState }) {
  const [library, setLibrary] = useState<CatalogueList<SampleCatalogueEntry> | null | undefined>(undefined);
  const [share, setShare] = useState(false);
  const encounter = live.encounter;
  const doctorPersona = encounter?.assignedDoctor?.practitionerId ? PRACTITIONER_PERSONA[encounter.assignedDoctor.practitionerId] : undefined;
  useEffect(() => {
    void call<CatalogueList<SampleCatalogueEntry>>(DEMO.admin, 'GET', '/api/catalogue/scan-assets').then((r) => setLibrary(r.ok ? r.body : null)).catch(() => setLibrary(null));
  }, []);

  return (
    <div className="space-y-4">
      <JivaCard>
        <CardHeader title="Clinical asset library" icon="layers" subtitle="Synthetic sample documents from the clinical catalogue · not patient data · no finding implied" />
        {library === undefined ? (
          <p className="mt-3 text-sm text-ink-500">Loading…</p>
        ) : library === null ? (
          <p className="mt-3 text-sm text-danger-700">The sample catalogue could not be read.</p>
        ) : (
          <>
            <p className="mt-2 text-xs text-ink-600">
              {library.notice} Catalogue version {library.catalogueVersion}.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg bg-amber-50 px-3 py-2 text-[13px] text-amber-950 ring-1 ring-inset ring-amber-200">
              <Icon name="stethoscope" size={15} />
              {doctorPersona ? (
                <span>
                  Attaching acts as {encounter?.assignedDoctor?.displayName} (persona {doctorPersona}) on encounter {encounter?.encounterId}.
                </span>
              ) : (
                <span>To attach a sample, run a scenario up to the doctor assignment (or assign a demo clinician in Controls).</span>
              )}
              <label className="ml-auto inline-flex items-center gap-1.5">
                <input type="checkbox" className="h-4 w-4 accent-amber-700" checked={share} onChange={(e) => setShare(e.target.checked)} />
                Share with the patient (labelled as a sample)
              </label>
            </div>
            <ul className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {library.entries.map((e) => (
                <li key={e.assetId}>
                  <SampleCard entry={e} attachAs={doctorPersona} encounterId={encounter?.encounterId} share={share} onAttached={live.refresh} />
                </li>
              ))}
            </ul>
          </>
        )}
      </JivaCard>
    </div>
  );
}

function SampleCard({ entry, attachAs, encounterId, share, onAttached }: { entry: SampleCatalogueEntry; attachAs?: string; encounterId?: string; share: boolean; onAttached: () => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const image = entry.contentType.startsWith('image/');
  return (
    <div className="h-full rounded-xl bg-white p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-xs font-semibold text-ink-500">
        {DOCUMENT_KIND_TEXT[entry.documentType] ?? entry.documentType} · {entry.contentType === 'application/pdf' ? 'PDF' : 'PNG'} · {formatBytes(entry.sizeBytes)} · rev {entry.revision}
      </p>
      <p className="text-sm font-semibold text-ink-900">{entry.title}</p>
      {entry.description && <p className="text-xs text-ink-600">{entry.description}</p>}
      <dl className="mt-1 space-y-0.5 text-[11px] text-ink-500">
        <div>
          <dt className="inline font-semibold">Id </dt>
          <dd className="inline font-mono">{entry.assetId}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Designation </dt>
          <dd className="inline">{entry.designation === 'SYNTHETIC' ? 'Synthetic — depicts no person' : 'Educational — de-identified, not this patient'}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">Source </dt>
          <dd className="inline">{entry.provenance.source}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">sha256 </dt>
          <dd className="inline font-mono">{entry.sha256.slice(0, 16)}…</dd>
        </div>
      </dl>
      {preview && <img src={preview} alt={`${entry.title} (synthetic sample)`} className="mt-2 max-h-56 w-full rounded-lg bg-black object-contain ring-1 ring-ink-200" />}
      <div className="mt-2 flex flex-wrap gap-1.5">
        {image && !preview && (
          <AsyncButton
            size="sm"
            variant="ghost"
            icon="eye"
            pendingText="Loading…"
            onAction={async () => {
              try {
                setPreview(URL.createObjectURL(await blob(DEMO.admin, `/api/catalogue/scan-assets/${encodeURIComponent(entry.assetId)}/content`)));
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
          icon="plus"
          disabled={!attachAs || !encounterId}
          pendingText="Attaching…"
          onAction={async () => {
            const r = await call<{ document: { documentId: string; origin: string; status: string } }>(attachAs!, 'POST', `/api/encounters/${encounterId}/documents/samples`, {
              clientRequestId: crypto.randomUUID(), assetId: entry.assetId, patientVisible: share,
            }).catch(() => null);
            const msg = !r ? 'Cannot reach JIVA.' : r.status === 201 ? null : failure(r);
            setResult(msg ?? `Attached as ${r!.body.document.documentId} (${r!.body.document.origin}, ${r!.body.document.status}).`);
            if (!msg) onAttached();
            return msg;
          }}
        >
          Attach to the demo encounter
        </AsyncButton>
      </div>
      {result && <p className={cx('mt-1 text-xs', result.startsWith('Attached') ? 'text-brand-800' : 'text-danger-700')}>{result}</p>}
    </div>
  );
}
