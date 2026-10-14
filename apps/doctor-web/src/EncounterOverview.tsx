import { useState, type ReactNode } from 'react';
import type { HospitalState, PatientState } from '@jiva/domain-models';
import {
  ASSIGNMENT_REASON_TEXT,
  CardHeader,
  JivaButton,
  JivaCard,
  JivaTimeline,
  SkeletonRows,
  capabilityLabel,
  cx,
  describeEvent,
  encounterArrivedAt,
  encounterHandedOverAt,
  formatDateTime,
  timeAgo,
  type EncounterRecord,
  type JivaEvent,
  type TimelineItem,
} from '@jiva/ui/src';

/** What the crew reported at the scene (symptoms, suspected cause, care needed): reported, never a diagnosis. */
export function SceneReport({ patient }: { patient?: PatientState }) {
  return (
    <JivaCard>
      <CardHeader title="Reported at the scene" icon="siren" subtitle="From the ambulance crew's emergency report · not a diagnosis" />
      {!patient ? (
        <p className="mt-3 text-sm text-ink-500">The case summary is not available.</p>
      ) : (
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2">
          <Fact label="Reported symptoms" wide>
            {patient.reportedSymptoms?.length ? (
              <span className="flex flex-wrap gap-1">
                {patient.reportedSymptoms.map((s) => (
                  <span key={s} className="rounded-full bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-800">
                    {s}
                  </span>
                ))}
              </span>
            ) : (
              '—'
            )}
          </Fact>
          <Fact label="Suspected cause (unconfirmed)">{patient.suspectedCause || '—'}</Fact>
          <Fact label="Care needed (assessed)">{patient.careRequirements.length ? patient.careRequirements.map((x) => capabilityLabel(x)).join(', ') : '—'}</Fact>
          {patient.intake?.notes && (
            <Fact label="Crew notes" wide>
              {patient.intake.notes}
            </Fact>
          )}
        </dl>
      )}
    </JivaCard>
  );
}

/** The hospital's own records: arrival, handover, and who is responsible (with the assignment history). */
export function HandoverCard({ e, now }: { e: EncounterRecord; now: number }) {
  const handedOverAt = encounterHandedOverAt(e);
  const history = [...(e.assignmentHistory ?? [])].reverse();
  return (
    <JivaCard>
      <CardHeader title="Arrival, handover and responsibility" icon="hospital" subtitle="Recorded by hospital staff — an ambulance position alone never records an arrival" />
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Arrival recorded">{`${formatDateTime(encounterArrivedAt(e))} (${timeAgo(encounterArrivedAt(e), now)})`}</Fact>
        <Fact label="Handover recorded">{handedOverAt ? formatDateTime(handedOverAt) : 'Not yet'}</Fact>
        <Fact label="Brought by">{e.ambulanceId ?? 'Not by a JIVA ambulance'}</Fact>
        {e.arrival?.gpsArrivalAt && <Fact label="Position at hospital (evidence only)">{formatDateTime(e.arrival.gpsArrivalAt)}</Fact>}
        {e.referral && <Fact label="Referral answer">{e.referral.responseStatus ? `${e.referral.responseStatus.toLowerCase()}${e.referral.respondedAt ? ` at ${formatDateTime(e.referral.respondedAt)}` : ''}` : 'Arrived under referral'}</Fact>}
        <Fact label="Encounter">{e.encounterId}</Fact>
      </dl>
      {e.handover?.notes && (
        <div className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-[13px] ring-1 ring-inset ring-ink-200">
          <p className="text-xs font-semibold text-ink-500">Handover notes (recorded by the hospital team)</p>
          <p className="mt-0.5 whitespace-pre-line text-ink-800">{e.handover.notes}</p>
        </div>
      )}
      {history.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-ink-500">Responsible doctor</p>
          <ol className="mt-1 space-y-1 text-[13px]">
            {history.map((d, i) => (
              <li key={`${d.practitionerId}-${d.assignedAt}`} className={cx(i > 0 && 'text-ink-500')}>
                <span className="font-semibold">{d.displayName}</span>
                {d.specialty ? ` · ${d.specialty}` : ''} · {ASSIGNMENT_REASON_TEXT[d.reason ?? ''] ?? d.reason} {formatDateTime(d.assignedAt)}
                {d.endedAt ? ` → until ${formatDateTime(d.endedAt)}` : ' (current)'}
              </li>
            ))}
          </ol>
        </div>
      )}
    </JivaCard>
  );
}

const HISTORY_PREVIEW = 6;

/** The encounter's recorded history as this clinician may see it: real events, content-free (latest first, older on request). */
export function EncounterHistory({ events, hospital }: { events: JivaEvent[] | null | undefined; hospital: HospitalState | null }) {
  const [all, setAll] = useState(false);
  const name = (id: string) => (hospital && id === hospital.hospitalId ? hospital.displayName : undefined);
  const items: TimelineItem[] = (events ?? [])
    .filter((e) => e.eventType !== 'ambulance.location.updated')
    .map((e) => {
      const d = describeEvent(e, name, 'hospital');
      const synthetic = (e.payload?.dataStatus ?? (e.metadata?.trustedEvidence as { status?: string } | undefined)?.status) === 'SYNTHETIC_DEMO';
      return { id: e.eventId, time: e.timestamp, title: d.title, description: d.detail, tone: d.tone, icon: d.icon, meta: synthetic ? 'synthetic' : undefined };
    })
    .sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  return (
    <JivaCard>
      <CardHeader title="Encounter history" icon="clock" subtitle="Recorded events, newest first · record contents are read from the records themselves" />
      {events === undefined ? (
        <SkeletonRows rows={3} className="mt-3" />
      ) : events === null ? (
        <p className="mt-3 text-sm text-danger-700">The history could not be loaded. It will be retried automatically.</p>
      ) : (
        <>
          <JivaTimeline items={all ? items : items.slice(0, HISTORY_PREVIEW)} dense className="mt-3" empty={<p className="mt-3 text-sm text-ink-500">No recorded events yet.</p>} />
          {items.length > HISTORY_PREVIEW && (
            <JivaButton size="sm" variant="tertiary" icon={all ? 'chevronUp' : 'chevronDown'} onClick={() => setAll((v) => !v)}>
              {all ? 'Show the latest only' : `Show all ${items.length} events`}
            </JivaButton>
          )}
        </>
      )}
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
