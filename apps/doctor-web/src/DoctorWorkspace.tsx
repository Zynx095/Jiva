import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { PatientState } from '@jiva/domain-models';
import {
  AppHeader,
  ConnectionPill,
  EmptyState,
  Icon,
  JivaButton,
  JivaCard,
  JivaStatus,
  JivaTabs,
  ModeBadge,
  PersonaSelect,
  SkeletonRows,
  TabPanel,
  cx,
  encounterArrivedAt,
  encounterStatus,
  formatClock,
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
import { useClinician } from './useClinician';

type Tab = 'overview' | 'vitals' | 'prescriptions' | 'reports' | 'documents';

/**
 * The doctor's clinical workspace: only the patients assigned to this clinician, and everything about
 * them — what the ambulance crew reported and measured, the hospital's arrival and handover records, the
 * encounter's history, vital signs, prescriptions (drafts and authorisation), reports, internal notes and
 * diagnostic documents. The API enforces the assignment on every read and write; this screen never shows
 * another doctor's patients, and nothing here diagnoses or prescribes by itself.
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
  const selected = c.encounters.find((e) => e.encounterId === c.selectedId);
  const patientOf = (caseId: string) => c.patients.find((p) => p.patientId === caseId);
  const short = c.hospital ? hospitalShortName(c.hospital.displayName, c.hospital.address?.locality) : '';
  const r = c.records?.encounterId === selected?.encounterId ? c.records : null;
  useEffect(() => {
    document.title = 'JIVA · Doctor';
  }, []);

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

      <main id="main" className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 lg:grid-cols-[300px_minmax(0,1fr)] lg:px-6">
        <aside aria-labelledby="my-patients" className="min-w-0 space-y-3">
          <h2 id="my-patients" className="text-lg font-semibold tracking-[-0.01em] text-ink-900">
            My patients
          </h2>
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
                  <PatientRow e={e} patient={patientOf(e.caseId)} selected={e.encounterId === c.selectedId} now={now} onSelect={() => c.select(e.encounterId)} />
                </li>
              ))}
            </ul>
          )}
          <p className="px-1 text-xs text-ink-500">
            Coordination (arrivals, handovers, assigning doctors) happens in the{' '}
            <a className="font-semibold text-brand-800 underline-offset-2 hover:underline" href={jivaAppUrl('hospital', 'demo-hosp-1')}>
              hospital console
            </a>
            .
          </p>
        </aside>

        <div className="min-w-0 space-y-4">
          {selected ? (
            // Keyed by the encounter: switching patients remounts every panel, so a half-filled form
            // (vital signs, prescription, note, report, upload) can never be submitted to the next patient.
            <Fragment key={selected.encounterId}>
              <EncounterHeader e={selected} patient={patientOf(selected.caseId)} now={now} />
              <JivaTabs items={tabs} value={tab} onChange={setTab} label="Encounter sections" idPrefix="enc" className="overflow-y-hidden" />
              <TabPanel idPrefix="enc" id="overview" className={cx('space-y-4', tab !== 'overview' && 'hidden')}>
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
            c.loaded && (
              <JivaCard className="border-dashed">
                <EmptyState icon="stethoscope" title="Select a patient" description="Choose an assigned patient to see and write their records." />
              </JivaCard>
            )
          )}
        </div>
      </main>
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
      className={cx('w-full rounded-xl bg-white p-3 text-left ring-1 transition-shadow hover:shadow-sm', selected ? 'ring-2 ring-brand-500' : 'ring-ink-200')}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-ink-900">{e.caseId}</span>
        <JivaStatus meta={encounterStatus(e.status)} />
      </div>
      <p className="mt-1 truncate text-[13px] text-ink-700">{patient?.reportedSymptoms?.join(', ') || patient?.activeConditions.join(', ') || 'No reported symptoms shared'}</p>
      <p className="mt-0.5 text-xs text-ink-500">{since ? `Yours since ${formatClock(since)} (${timeAgo(since, now)})` : `Arrived ${formatClock(encounterArrivedAt(e))}`}</p>
    </button>
  );
}

function EncounterHeader({ e, patient, now }: { e: EncounterRecord; patient?: PatientState; now: number }) {
  return (
    <JivaCard>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-500">Encounter {e.encounterId}</p>
          <h2 className="text-xl font-semibold tracking-[-0.01em] text-ink-900">{e.caseId}</h2>
          <p className="text-[13px] text-ink-700">
            {patient?.suspectedCause ? `Suspected: ${patient.suspectedCause} (unconfirmed) · ` : ''}arrived {timeAgo(encounterArrivedAt(e), now)}
            {e.assignedDoctor ? ` · responsible: ${e.assignedDoctor.displayName}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <JivaStatus meta={encounterStatus(e.status)} />
          {e.dataStatus === 'SYNTHETIC_DEMO' && <JivaStatus meta={{ label: 'Synthetic demo patient', tone: 'warn', icon: 'info', hint: 'Created in demo mode. Not a real person.' }} />}
        </div>
      </div>
    </JivaCard>
  );
}
