import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import type { PatientState } from '@jiva/domain-models';
import {
  AppHeader,
  CardHeader,
  ConnectionPill,
  DemoBadge,
  EmptyState,
  Icon,
  JivaButton,
  JivaCard,
  JivaStatus,
  PersonaSelect,
  SkeletonRows,
  capabilityLabel,
  cx,
  encounterArrivedAt,
  encounterHandedOverAt,
  encounterStatus,
  formatClock,
  formatDateTime,
  hospitalShortName,
  timeAgo,
  useNow,
  useToast,
  type EncounterRecord,
  type JivaEvent,
} from '@jiva/ui/src';
import { PERSONA } from '../api';
import { PERSONAS } from '../personas';
import { DocumentsPanel } from './DocumentsPanel';
import { PrescriptionsPanel } from './PrescriptionsPanel';
import { ReportsPanel } from './ReportsPanel';
import { useClinician } from './useClinician';

/**
 * Clinician workspace: only the patients assigned to this clinician, and their clinical records. The API
 * enforces the assignment on every read and write; this screen never shows another doctor's patients.
 */
export function ClinicianWorkspace() {
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
  const selected = c.encounters.find((e) => e.encounterId === c.selectedId);
  const patientOf = (caseId: string) => c.patients.find((p) => p.patientId === caseId);
  const short = c.hospital ? hospitalShortName(c.hospital.displayName, c.hospital.address?.locality) : '';
  useEffect(() => {
    document.title = 'JIVA · Clinician';
  }, []);

  return (
    <div className="min-h-dvh">
      <AppHeader
        app="Clinician workspace"
        context={c.self ? `${c.self.displayName}${c.self.specialty ? ` · ${c.self.specialty}` : ''}${short ? ` · ${short}` : ''}` : c.loaded ? 'Clinician' : 'Loading…'}
        actions={
          <>
            <PersonaSelect value={PERSONA} options={PERSONAS} />
            <ConnectionPill state={c.connection} lastSync={c.lastSync} />
            <DemoBadge detail="Synthetic patients, clinicians and records for the demo — not real medical data." />
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

      <main id="main" className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 lg:grid-cols-[320px_minmax(0,1fr)] lg:px-6">
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
        </aside>

        <div className="min-w-0 space-y-5">
          {selected ? (
            <>
              <EncounterSummary e={selected} patient={patientOf(selected.caseId)} now={now} />
              <PrescriptionsPanel
                encounterId={selected.encounterId}
                list={c.records?.encounterId === selected.encounterId ? c.records.prescriptions : undefined}
                onChanged={c.reloadRecords}
              />
              <ReportsPanel
                encounterId={selected.encounterId}
                list={c.records?.encounterId === selected.encounterId ? c.records.reports : undefined}
                documents={c.records?.encounterId === selected.encounterId ? (c.records.documents ?? []) : []}
                onChanged={c.reloadRecords}
              />
              <DocumentsPanel encounterId={selected.encounterId} list={c.records?.encounterId === selected.encounterId ? c.records.documents : undefined} onChanged={c.reloadRecords} />
            </>
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

function EncounterSummary({ e, patient, now }: { e: EncounterRecord; patient?: PatientState; now: number }) {
  const handedOverAt = encounterHandedOverAt(e);
  return (
    <JivaCard>
      <CardHeader title={e.caseId} icon="user" subtitle={`Encounter ${e.encounterId}`} actions={<JivaStatus meta={encounterStatus(e.status)} />} />
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Arrived">{`${formatDateTime(encounterArrivedAt(e))} (${timeAgo(encounterArrivedAt(e), now)})`}</Fact>
        <Fact label="Handed over">{handedOverAt ? formatDateTime(handedOverAt) : '—'}</Fact>
        <Fact label="Brought by">{e.ambulanceId ?? 'Not by a JIVA ambulance'}</Fact>
        <Fact label="Reported symptoms">{patient?.reportedSymptoms?.join(', ') || '—'}</Fact>
        <Fact label="Suspected cause (unconfirmed)">{patient?.suspectedCause || '—'}</Fact>
        <Fact label="Care needed (assessed)" wide>
          {patient?.careRequirements.length ? patient.careRequirements.map((x) => capabilityLabel(x)).join(', ') : '—'}
        </Fact>
        {patient?.intake?.notes && (
          <Fact label="Crew notes" wide>
            {patient.intake.notes}
          </Fact>
        )}
      </dl>
      <p className="mt-3 text-xs text-ink-500">Intake details come from the ambulance crew and are not a diagnosis.</p>
    </JivaCard>
  );
}

function Fact({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cx('min-w-0', wide && 'sm:col-span-2 lg:col-span-3')}>
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd className="text-ink-900">{children}</dd>
    </div>
  );
}
