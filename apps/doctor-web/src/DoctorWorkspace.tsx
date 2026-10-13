import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { PatientState } from '@jiva/domain-models';
import {
  AppHeader,
  ConnectionPill,
  EmptyState,
  Icon,
  JivaButton,
  JivaCard,
  JivaModal,
  JivaStatus,
  JivaTabs,
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  ModeBadge,
  PersonaSelect,
  SkeletonRows,
  TabPanel,
  cx,
  encounterArrivedAt,
  encounterStatus,
  formatClock,
  formatMeasurementValue,
  hospitalShortName,
  jivaAppUrl,
  timeAgo,
  useNow,
  useToast,
  type EncounterRecord,
  type JivaEvent,
} from '@jiva/ui/src';
import { API_URL, PERSONA } from './api';
import { PERSONAS } from './personas';
import { DocumentsPanel } from './DocumentsPanel';
import { EncounterHistory, HandoverCard, SceneReport } from './EncounterOverview';
import { NotesPanel } from './NotesPanel';
import { PrehospitalPanel } from './PrehospitalPanel';
import { PrescriptionsPanel } from './PrescriptionsPanel';
import { ReportsPanel } from './ReportsPanel';
import { VitalsPanel } from './VitalsPanel';
import { listLabels, useUnsavedRegistry } from './unsaved';
import { useClinician, type EncounterRecords } from './useClinician';

type Tab = 'overview' | 'vitals' | 'prescriptions' | 'reports' | 'documents';

/**
 * The doctor's clinical workspace: only the patients assigned to this clinician, and everything about
 * them — what the ambulance crew reported and measured, the hospital's arrival and handover records, the
 * encounter's history, vital signs, prescriptions (drafts and authorisation), reports, internal notes and
 * diagnostic documents. The API enforces the assignment on every read and write; this screen never shows
 * another doctor's patients, and nothing here diagnoses or prescribes by itself.
 *
 * The selected patient stays pinned above the records while scrolling, so it is always clear whose record
 * is being read or written. Switching patients with unsaved edits asks first; edits are never carried over
 * (every panel remounts per encounter).
 */
export function DoctorWorkspace() {
  const toast = useToast();
  const practitionerRef = useRef<string | undefined>(undefined);
  const onLive = useCallback(
    (e: JivaEvent) => {
      const p = e.payload;
      if (e.eventType === 'demo.reset') {
        toast.show({ title: 'Demo reset', description: 'All demo state was cleared.', icon: 'refresh', groupKey: 'reset' });
      } else if (e.eventType === 'encounter.doctor.assigned' && p.practitionerId === practitionerRef.current) {
        toast.show({ title: `New patient: ${String(p.caseId)}`, description: 'You were assigned as the responsible doctor.', tone: 'ok', icon: 'user', groupKey: `assign:${String(p.caseId)}` });
      } else if (e.eventType === 'encounter.doctor.assigned' && p.previousPractitionerId === practitionerRef.current) {
        toast.show({ title: `${String(p.caseId)} was reassigned`, description: 'Another doctor is now responsible; the records are no longer shown here.', tone: 'warn', icon: 'user', groupKey: `assign:${String(p.caseId)}` });
      }
    },
    [toast],
  );
  const c = useClinician(onLive);
  useEffect(() => {
    practitionerRef.current = c.me?.practitionerId;
  }, [c.me?.practitionerId]);
  const now = useNow(15_000);
  const [tab, setTab] = useState<Tab>('overview');
  const unsaved = useUnsavedRegistry();
  const [switchTo, setSwitchTo] = useState<{ encounterId: string; pending: string[] } | null>(null);
  const selected = c.encounters.find((e) => e.encounterId === c.selectedId);
  const patientOf = (caseId: string) => c.patients.find((p) => p.patientId === caseId);
  const short = c.hospital ? hospitalShortName(c.hospital.displayName, c.hospital.address?.locality) : '';
  const r = c.records?.encounterId === selected?.encounterId ? c.records : null;
  useEffect(() => {
    document.title = selected ? `${selected.caseId} · JIVA Doctor` : 'JIVA · Doctor';
  }, [selected]);

  /** Select a patient; with unsaved edits open, ask first (nothing is saved or carried over either way). */
  const requestSelect = (encounterId: string) => {
    if (encounterId === c.selectedId) return;
    const pending = unsaved?.pending() ?? [];
    if (pending.length) setSwitchTo({ encounterId, pending });
    else c.select(encounterId);
  };
  const switchTarget = switchTo ? c.encounters.find((e) => e.encounterId === switchTo.encounterId) : undefined;

  const drafts = r?.prescriptions?.filter((rx) => rx.current.status === 'DRAFT').length ?? 0;
  const tabs = [
    { id: 'overview' as const, label: 'Overview', icon: 'user' as const },
    { id: 'vitals' as const, label: 'Vital signs', icon: 'heart' as const },
    { id: 'prescriptions' as const, label: 'Prescriptions', icon: 'pill' as const, count: r?.prescriptions?.length, attention: drafts > 0 },
    { id: 'reports' as const, label: 'Reports and notes', icon: 'file' as const, count: r ? (r.reports?.length ?? 0) + (r.notes?.length ?? 0) : undefined },
    { id: 'documents' as const, label: 'Documents and scans', icon: 'layers' as const, count: r?.documents?.length },
  ];

  return (
    <div className="min-h-dvh">
      <AppHeader
        app="Doctor workspace"
        context={c.self ? `${c.self.displayName}${c.self.specialty ? ` · ${c.self.specialty}` : ''}${short ? ` · ${short}` : ''}` : c.loaded ? 'Clinician' : 'Loading…'}
        actions={
          <>
            <PersonaSelect value={PERSONA} options={PERSONAS} />
            <ConnectionPill state={c.connection} lastSync={c.lastSync} />
            <ModeBadge apiUrl={API_URL} detail="Synthetic patients, clinicians and records for the demo — not real medical data." />
          </>
        }
      />

      {c.error && (
        <div role="alert" className="flex items-center gap-2 border-b border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger-700 lg:px-6">
          <Icon name="alertCircle" size={16} />
          <span className="flex-1">{c.error}</span>
          <JivaButton size="sm" variant="danger-soft" icon="refresh" onClick={() => void c.refresh()}>
            Try again
          </JivaButton>
        </div>
      )}

      <main id="main" className="mx-auto grid max-w-[1440px] gap-6 px-4 py-6 lg:grid-cols-[296px_minmax(0,1fr)] lg:px-8">
        <aside aria-labelledby="my-patients" className="min-w-0 space-y-3 lg:sticky lg:top-[calc(var(--jiva-header-h)+24px)] lg:self-start">
          <div className="flex items-baseline justify-between gap-2 px-1">
            <h2 id="my-patients" className="text-lg font-semibold tracking-[-0.01em] text-ink-900">
              My patients
            </h2>
            {c.loaded && c.encounters.length > 0 && <span className="text-[13px] text-ink-500">{c.encounters.length} assigned</span>}
          </div>
          {!c.loaded ? (
            <JivaCard>
              <SkeletonRows rows={2} />
            </JivaCard>
          ) : c.encounters.length === 0 ? (
            <JivaCard className="border-dashed">
              <EmptyState icon="user" title="No patients assigned to you" description="A hospital coordinator assigns you after the handover from the ambulance crew. The patient's records appear here then." compact />
            </JivaCard>
          ) : (
            <ul className="space-y-2" role="listbox" aria-label="Assigned patients">
              {c.encounters.map((e) => (
                <li key={e.encounterId}>
                  <PatientRow e={e} patient={patientOf(e.caseId)} selected={e.encounterId === c.selectedId} now={now} onSelect={() => requestSelect(e.encounterId)} />
                </li>
              ))}
            </ul>
          )}
          <p className="px-1 text-xs leading-5 text-ink-500">
            Arrivals, handovers and doctor assignments are recorded in the{' '}
            <a className="font-semibold text-brand-700 underline-offset-2 hover:underline" href={jivaAppUrl('hospital', 'demo-hosp-1')}>
              hospital console
            </a>
            .
          </p>
        </aside>

        <div className="min-w-0">
          {selected ? (
            // Keyed by the encounter: switching patients remounts every panel, so a half-filled form
            // (vital signs, prescription, note, report, upload) can never be submitted to the next patient.
            <Fragment key={selected.encounterId}>
              <div className="sticky top-[var(--jiva-header-h)] z-20 -mx-1 -mt-6 bg-canvas px-1 pb-4 pt-6">
                <PatientContext e={selected} patient={patientOf(selected.caseId)} now={now}>
                  <JivaTabs items={tabs} value={tab} onChange={setTab} label="Encounter sections" idPrefix="enc" className="border-b-0 px-2 sm:px-3" />
                </PatientContext>
              </div>
              <TabPanel idPrefix="enc" id="overview" className={cx('space-y-4', tab !== 'overview' && 'hidden')}>
                <AtAGlance r={r} onOpen={setTab} />
                <SceneReport patient={patientOf(selected.caseId)} />
                <PrehospitalPanel data={r ? r.prehospital : undefined} now={now} compact />
                <HandoverCard e={selected} now={now} />
                <EncounterHistory events={r ? r.timeline : undefined} hospital={c.hospital} />
              </TabPanel>
              <TabPanel idPrefix="enc" id="vitals" className={cx('space-y-4', tab !== 'vitals' && 'hidden')}>
                <VitalsPanel encounterId={selected.encounterId} vitals={r ? r.vitals : undefined} onChanged={c.reloadRecords} now={now} />
                <PrehospitalPanel data={r ? r.prehospital : undefined} now={now} />
              </TabPanel>
              <TabPanel idPrefix="enc" id="prescriptions" className={cx(tab !== 'prescriptions' && 'hidden')}>
                <PrescriptionsPanel encounterId={selected.encounterId} list={r ? r.prescriptions : undefined} onChanged={c.reloadRecords} />
              </TabPanel>
              <TabPanel idPrefix="enc" id="reports" className={cx('space-y-4', tab !== 'reports' && 'hidden')}>
                <ReportsPanel encounterId={selected.encounterId} list={r ? r.reports : undefined} documents={r?.documents ?? []} onChanged={c.reloadRecords} />
                <NotesPanel encounterId={selected.encounterId} list={r ? r.notes : undefined} onChanged={c.reloadRecords} />
              </TabPanel>
              <TabPanel idPrefix="enc" id="documents" className={cx(tab !== 'documents' && 'hidden')}>
                <DocumentsPanel encounterId={selected.encounterId} list={r ? r.documents : undefined} onChanged={c.reloadRecords} />
              </TabPanel>
            </Fragment>
          ) : (
            c.loaded &&
            c.encounters.length > 0 && (
              <JivaCard className="border-dashed">
                <EmptyState icon="stethoscope" title="Select a patient" description="Choose an assigned patient to read and write their records." />
              </JivaCard>
            )
          )}
        </div>
      </main>

      <JivaModal
        open={!!switchTo}
        onClose={() => setSwitchTo(null)}
        title="Discard unsaved changes?"
        icon="alertTriangle"
        tone="warn"
        description={
          switchTo && selected ? (
            <>
              You have unsaved {listLabels(switchTo.pending)} for <strong className="text-ink-900">{selected.caseId}</strong>. Opening {switchTarget?.caseId ?? 'another patient'} discards these edits —
              nothing is saved to either patient.
            </>
          ) : null
        }
        actions={
          <>
            <JivaButton
              variant="danger-soft"
              onClick={() => {
                const target = switchTo?.encounterId;
                setSwitchTo(null);
                if (target) c.select(target);
              }}
            >
              Discard and open {switchTarget?.caseId ?? 'patient'}
            </JivaButton>
            <JivaButton variant="primary" autoFocus onClick={() => setSwitchTo(null)}>
              Keep editing {selected?.caseId}
            </JivaButton>
          </>
        }
      />
    </div>
  );
}

function PatientRow({ e, patient, selected, now, onSelect }: { e: EncounterRecord; patient?: PatientState; selected: boolean; now: number; onSelect: () => void }) {
  const since = e.assignedDoctor?.assignedAt;
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={cx(
        'relative w-full overflow-hidden rounded-xl p-3 pl-4 text-left ring-1 transition-[background-color,box-shadow] duration-150',
        selected ? 'bg-white shadow-sm ring-2 ring-brand-600' : 'bg-white/70 ring-ink-200 hover:bg-white hover:shadow-xs hover:ring-ink-300',
      )}
    >
      {selected && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-1 bg-brand-600" />}
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold tracking-[-0.005em] text-ink-900">{e.caseId}</span>
        <JivaStatus meta={encounterStatus(e.status)} />
      </div>
      <p className="mt-1 truncate text-[13px] text-ink-700">{patient?.reportedSymptoms?.join(', ') || patient?.activeConditions.join(', ') || 'No reported symptoms shared'}</p>
      <p className="mt-0.5 text-xs text-ink-500">{since ? `Yours since ${formatClock(since)} (${timeAgo(since, now)})` : `Arrived ${formatClock(encounterArrivedAt(e))}`}</p>
    </button>
  );
}

/** The selected patient, pinned above the records: whose record this is, what was reported, who is responsible. */
function PatientContext({ e, patient, now, children }: { e: EncounterRecord; patient?: PatientState; now: number; children: ReactNode }) {
  const symptoms = patient?.reportedSymptoms?.join(', ') || patient?.activeConditions.join(', ');
  return (
    <section aria-label={`Selected patient ${e.caseId}`} className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-ink-200">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden="true" className="mt-0.5 hidden h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700 ring-1 ring-inset ring-brand-200 sm:flex">
            <Icon name="user" size={19} />
          </span>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-ink-500">Patient record · encounter {e.encounterId}</p>
            <h2 className="text-xl font-semibold leading-7 tracking-[-0.015em] text-ink-900">{e.caseId}</h2>
            <p className="mt-0.5 text-[13px] leading-5 text-ink-700">
              {symptoms ? <span className="font-medium text-ink-900">{symptoms}</span> : 'No reported symptoms shared'}
              {patient?.suspectedCause ? ` · suspected ${patient.suspectedCause} (unconfirmed)` : ''}
              {` · arrived ${timeAgo(encounterArrivedAt(e), now)}`}
              {e.assignedDoctor ? ` · responsible: ${e.assignedDoctor.displayName}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <JivaStatus meta={encounterStatus(e.status)} />
          {e.dataStatus === 'SYNTHETIC_DEMO' && <JivaStatus meta={{ label: 'Synthetic demo patient', tone: 'info', icon: 'info', hint: 'Created in demo mode. Not a real person.' }} />}
        </div>
      </div>
      <div className="mt-3 border-t border-ink-200">{children}</div>
    </section>
  );
}

/** What needs the doctor now, and the latest measured values, before the detailed records. */
function AtAGlance({ r, onOpen }: { r: EncounterRecords | null; onOpen: (t: Tab) => void }) {
  if (!r) return null;
  const drafts = r.prescriptions?.filter((rx) => rx.current.status === 'DRAFT') ?? [];
  // The crew's values are shown in full right below; this summarises what the care team measured.
  const latest = r.vitals?.latest ?? {};
  const shown = MEASUREMENT_ORDER.filter((t) => latest[t]?.value !== undefined);
  if (drafts.length === 0 && shown.length === 0) return null;
  return (
    <div className={cx('grid gap-3', drafts.length > 0 && shown.length > 0 && 'xl:grid-cols-[minmax(0,1fr)_auto]')}>
      {shown.length > 0 && (
        <JivaCard padded={false} className="px-4 py-3 sm:px-5">
          <p className="text-xs font-semibold text-ink-500">Latest vital signs from the care team</p>
          <dl className="mt-1.5 flex flex-wrap gap-x-7 gap-y-2">
            {shown.map((t) => {
              const m = latest[t];
              if (!m || m.value === undefined) return null;
              return (
                <div key={t} className="min-w-0">
                  <dt className="text-xs text-ink-500">{MEASUREMENT_TEXT[t].label}</dt>
                  <dd className="text-[15px] font-semibold tabular-nums text-ink-900">
                    {formatMeasurementValue({ type: t, value: m.value, secondaryValue: m.secondaryValue })} <span className="text-xs font-medium text-ink-500">{MEASUREMENT_TEXT[t].unit}</span>
                    <span className="ml-1.5 text-xs font-medium text-ink-500">{formatClock(m.observedAt)}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        </JivaCard>
      )}
      {drafts.length > 0 && (
        <div role="status" className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-50 px-4 py-3 ring-1 ring-inset ring-warn-200">
          <Icon name="pill" size={18} className="shrink-0 text-warn-700" />
          <p className="text-sm text-warn-900">
            <span className="font-semibold">
              {drafts.length} prescription draft{drafts.length === 1 ? '' : 's'}
            </span>{' '}
            {drafts.length === 1 ? 'awaits' : 'await'} your authorisation.
          </p>
          <JivaButton size="sm" variant="warn-soft" iconRight="arrowRight" onClick={() => onOpen('prescriptions')}>
            Review drafts
          </JivaButton>
        </div>
      )}
    </div>
  );
}
