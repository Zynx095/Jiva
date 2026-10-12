import { useEffect, useState, type ReactNode } from 'react';
import {
  AsyncButton,
  CATEGORY_TEXT,
  DOCUMENT_TYPES,
  EmptyState,
  Icon,
  JivaCard,
  JivaSkeleton,
  JivaStatus,
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  cx,
  dataStatus,
  formatBytes,
  formatDateTime,
  formatMeasurementValue,
  measurementFreshness,
  measurementSource,
  medicationLine,
  prescriptionStatus,
  reportStatus,
  timeAgo,
  type DocumentRecord,
  type EncounterRecord,
  type IconName,
  type PatientPrescription,
  type PatientReport,
  type VitalsResponse,
} from '@jiva/ui/src';
import { apiBlob } from './api';

/**
 * State B — in hospital care. Shown only once the hospital has recorded the handover (encounter IN_CARE);
 * everything here is what the hospital released to this patient, read from the API with the patient's
 * own credentials. Nothing is invented to fill space: missing information is shown as missing.
 */

const docPath = (encounterId: string, documentId: string) => `/api/encounters/${encodeURIComponent(encounterId)}/documents/${encodeURIComponent(documentId)}/content`;

function Section({ id, icon, title, subtitle, children }: { id: string; icon: IconName; title: string; subtitle?: string; children: ReactNode }) {
  return (
    <JivaCard as="section" aria-labelledby={id}>
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name={icon} size={16} />
        </span>
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold text-ink-900">
            {title}
          </h2>
          {subtitle && <p className="text-[13px] text-ink-500">{subtitle}</p>}
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </JivaCard>
  );
}

/** Loading / unavailable / empty, consistently. */
function ListState<T>({ list, empty, children }: { list: T[] | null | undefined; empty: string; children: (items: T[]) => ReactNode }) {
  if (list === undefined) {
    return (
      <div className="space-y-2">
        <JivaSkeleton className="h-10" />
        <JivaSkeleton className="h-10" />
      </div>
    );
  }
  if (list === null) return <p className="text-sm text-danger-700">This information could not be loaded right now. It is retried automatically.</p>;
  if (list.length === 0) return <p className="text-sm text-ink-500">{empty}</p>;
  return <>{children(list)}</>;
}

export function CareTeamCard({ encounter, hospitalName, now }: { encounter: EncounterRecord; hospitalName: string; now: number }) {
  const doc = encounter.assignedDoctor;
  return (
    <Section id="care-team" icon="stethoscope" title="Your care team" subtitle={hospitalName}>
      {doc ? (
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-ink-100 text-ink-600">
            <Icon name="user" size={18} />
          </span>
          <div>
            <p className="text-sm font-semibold text-ink-900">{doc.displayName}</p>
            <p className="text-[13px] text-ink-600">{doc.specialty ? `${doc.specialty} · ` : ''}your responsible doctor</p>
            <p className="text-xs text-ink-500">Since {formatDateTime(doc.assignedAt)} ({timeAgo(doc.assignedAt, now)})</p>
          </div>
        </div>
      ) : (
        <p className="text-sm text-ink-600">The hospital has not assigned your doctor yet. Their name appears here as soon as it does.</p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 border-t border-ink-100 pt-3 text-[13px]">
        <dt className="text-ink-500">Arrival recorded</dt>
        <dd className="text-right text-ink-800">{encounter.arrivedAt ? formatDateTime(encounter.arrivedAt) : '—'}</dd>
        <dt className="text-ink-500">In hospital care since</dt>
        <dd className="text-right text-ink-800">{encounter.handedOverAt ? formatDateTime(encounter.handedOverAt) : '—'}</dd>
        <dt className="text-ink-500">Your hospital reference</dt>
        <dd className="text-right font-mono text-xs text-ink-700">{encounter.encounterId}</dd>
      </dl>
      {encounter.dataStatus === 'SYNTHETIC_DEMO' && <p className="mt-2 text-xs text-ink-500">Demo data: synthetic hospital, clinicians and records.</p>}
    </Section>
  );
}

export function MedicationsCard({ list }: { list: PatientPrescription[] | null | undefined }) {
  return (
    <Section id="medications" icon="pill" title="Your medications" subtitle="Prescribed by your care team during this stay">
      <ListState list={list} empty="No medications have been prescribed to you during this stay.">
        {(items) => (
          <ul className="divide-y divide-ink-100">
            {items.map((rx) => (
              <li key={rx.prescriptionId} className="py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className={rx.status === 'ACTIVE' ? 'text-sm font-semibold text-ink-900' : 'text-sm font-semibold text-ink-500 line-through decoration-ink-300'}>{medicationLine(rx)}</p>
                  <JivaStatus meta={prescriptionStatus(rx.status)} />
                </div>
                {rx.instructions && <p className="text-[13px] text-ink-700">{rx.instructions}</p>}
                <p className="mt-0.5 text-xs text-ink-500">
                  {rx.prescribedBy.displayName} · {formatDateTime(rx.prescribedAt)}
                  {rx.status === 'DISCONTINUED' && rx.discontinuedAt ? ` · stopped ${formatDateTime(rx.discontinuedAt)}` : rx.changed ? ` · changed ${formatDateTime(rx.updatedAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </ListState>
      <p className="mt-3 text-xs text-ink-500">Take medicines only as your care team tells you. Ask them if anything is unclear.</p>
    </Section>
  );
}

export function ReportsCard({ encounterId, list, documents }: { encounterId: string; list: PatientReport[] | null | undefined; documents: DocumentRecord[] | null | undefined }) {
  return (
    <Section id="reports" icon="file" title="Your reports and results" subtitle="Shared with you by your care team">
      <ListState list={list} empty="No reports have been shared with you yet. Results appear here when your care team shares them.">
        {(items) => (
          <ul className="space-y-3">
            {items.map((r) => (
              <li key={r.reportId} className="rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-ink-500">
                      {CATEGORY_TEXT[r.category] ?? r.category} · {formatDateTime(r.effectiveAt)}
                    </p>
                    <p className="text-sm font-semibold text-ink-900">{r.title}</p>
                  </div>
                  <JivaStatus meta={reportStatus(r.status)} />
                </div>
                {r.status === 'PRELIMINARY' && <p className="mt-1 text-xs font-semibold text-warn-800">Preliminary: these results may still change.</p>}
                {r.findings && <p className="mt-1.5 whitespace-pre-line text-[13px] text-ink-800">{r.findings}</p>}
                {r.conclusion && (
                  <p className="mt-1 text-[13px] text-ink-800">
                    <span className="font-semibold">Conclusion: </span>
                    {r.conclusion}
                  </p>
                )}
                {r.documentIds.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {r.documentIds.map((id) => {
                      const d = documents?.find((x) => x.documentId === id);
                      return d ? (
                        <li key={id}>
                          <DocumentRow encounterId={encounterId} d={d} compact />
                        </li>
                      ) : null;
                    })}
                  </ul>
                )}
                <p className="mt-1.5 text-xs text-ink-500">
                  {r.reportedBy.displayName} · {formatDateTime(r.reportedAt)}
                  {r.status === 'AMENDED' ? ` · corrected ${formatDateTime(r.updatedAt)}` : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </ListState>
      <p className="mt-3 text-xs text-ink-500">Your care team explains what your results mean for you. JIVA does not interpret them.</p>
    </Section>
  );
}

export function DocumentsCard({ encounterId, list }: { encounterId: string; list: DocumentRecord[] | null | undefined }) {
  return (
    <Section id="documents" icon="layers" title="Your scans and documents" subtitle="X-rays, ECGs and lab documents shared with you">
      <ListState list={list} empty="No scans or documents have been shared with you yet.">
        {(items) => (
          <ul className="divide-y divide-ink-100">
            {items.map((d) => (
              <li key={d.documentId} className="py-2.5">
                <DocumentRow encounterId={encounterId} d={d} />
              </li>
            ))}
          </ul>
        )}
      </ListState>
    </Section>
  );
}

function DocumentRow({ encounterId, d, compact }: { encounterId: string; d: DocumentRecord; compact?: boolean }) {
  const [preview, setPreview] = useState<string | null>(null);
  const image = d.contentType === 'image/png' || d.contentType === 'image/jpeg';
  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);
  const save = async () => {
    try {
      const url = URL.createObjectURL(await apiBlob(docPath(encounterId, d.documentId)));
      const a = document.createElement('a');
      a.href = url;
      a.download = d.fileName;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      return null;
    } catch {
      return 'Download failed';
    }
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink-900">{d.title}</p>
          {!compact && (
            <p className="text-xs text-ink-500">
              {CATEGORY_TEXT[d.category] ?? d.category} · {DOCUMENT_TYPES[d.contentType]?.label ?? d.contentType} · {formatBytes(d.sizeBytes)}
              {d.uploadedAt ? ` · ${formatDateTime(d.uploadedAt)}` : ''}
            </p>
          )}
        </div>
        <div className="flex gap-1.5">
          {image && !preview && (
            <AsyncButton
              size="sm"
              variant="ghost"
              icon="eye"
              pendingText="Opening…"
              onAction={async () => {
                try {
                  setPreview(URL.createObjectURL(await apiBlob(docPath(encounterId, d.documentId))));
                  return null;
                } catch {
                  return 'Could not open';
                }
              }}
            >
              View
            </AsyncButton>
          )}
          <AsyncButton size="sm" variant="ghost" icon="arrowDown" pendingText="Downloading…" onAction={save}>
            Download
          </AsyncButton>
        </div>
      </div>
      {preview && <img src={preview} alt={d.title} className="mt-2 max-h-72 rounded-lg ring-1 ring-ink-200" />}
      {!compact && d.dataStatus === 'SYNTHETIC_DEMO' && <p className="mt-1 text-xs text-ink-500">{dataStatus(d.dataStatus).label}: a synthetic file for the demo.</p>}
    </div>
  );
}

/**
 * Vital signs with their source and age on every value. Simulated (demo) readings are marked as such;
 * old readings are marked as old. Types that were never measured are not shown.
 */
export function VitalsCard({ vitals, now }: { vitals: VitalsResponse | null | undefined; now: number }) {
  const types = vitals ? MEASUREMENT_ORDER.filter((t) => vitals.latest[t]) : [];
  return (
    <Section id="vitals" icon="heart" title="Your vital signs" subtitle="As recorded by your care team">
      {vitals === undefined ? (
        <div className="space-y-2">
          <JivaSkeleton className="h-14" />
        </div>
      ) : vitals === null ? (
        <p className="text-sm text-danger-700">Your vital signs could not be loaded right now. They are retried automatically.</p>
      ) : types.length === 0 ? (
        <p className="text-sm text-ink-500">No vital signs have been recorded for you yet.</p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {types.map((t) => {
            const m = vitals.latest[t]!;
            const simulated = m.source === 'DEVICE_SIMULATED';
            return (
              <li key={t} className={cx('rounded-xl p-3 ring-1 ring-inset', simulated ? 'bg-warn-50/50 ring-warn-200' : 'bg-ink-25 ring-ink-200')}>
                <p className="text-xs font-semibold text-ink-500">{MEASUREMENT_TEXT[t].label}</p>
                <p className="text-xl font-semibold tabular-nums text-ink-900">
                  {formatMeasurementValue(m)} <span className="text-sm font-medium text-ink-500">{MEASUREMENT_TEXT[t].unit}</span>
                </p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <JivaStatus meta={measurementSource(m.source)} />
                  <JivaStatus meta={measurementFreshness(m.freshness)} />
                </div>
                <p className="mt-1 text-xs text-ink-500">
                  {formatDateTime(m.observedAt)} ({timeAgo(m.observedAt, now)})
                  {m.recordedByName && !simulated ? ` · ${m.recordedByName}` : ''}
                </p>
                {simulated && <p className="mt-1 text-xs font-semibold text-warn-800">Simulated for the demo — not a real measurement.</p>}
              </li>
            );
          })}
        </ul>
      )}
      {vitals && !vitals.sources.medicalDeviceIntegrated && (
        <p className="mt-3 text-xs text-ink-500">No monitoring device is connected to JIVA; values are those your care team recorded.</p>
      )}
    </Section>
  );
}

/** State A: what the records section means before the hospital takes over (no fake data). */
export function RecordsNotYet() {
  return (
    <JivaCard as="section" aria-labelledby="records-title">
      <h2 id="records-title" className="text-[15px] font-semibold text-ink-900">
        Your health records
      </h2>
      <EmptyState
        compact
        icon="file"
        title="Available after the hospital takes over your care"
        description="Once the hospital records the handover from the ambulance crew, your doctor, medications, results and scans that your care team shares with you appear here."
      />
    </JivaCard>
  );
}

