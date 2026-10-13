import { useMemo, useState, type ReactNode } from 'react';
import type { PatientState } from '@jiva/domain-models';
import {
  ASSIGNMENT_REASON_TEXT,
  AsyncButton,
  JivaBadge,
  JivaButton,
  JivaCard,
  JivaModal,
  JivaStatus,
  REASSIGNMENT_REASONS,
  cx,
  dataStatus,
  encounterArrivedAt,
  encounterHandedOverAt,
  encounterStatus,
  formatClock,
  timeAgo,
  type EncounterRecord,
  type RosterEntry,
} from '@jiva/ui/src';
import { CommandError, sendCommand } from './ui';

/**
 * Journey B at the receiving hospital: record the arrival (creates the encounter), record the handover
 * from the crew (the patient is now in hospital care, the crew is released) and assign the responsible
 * doctor. Every action is a command the API authorizes and validates; the screen only shows what the
 * server confirmed (it refreshes from authoritative state after each command).
 */

const ROLE_TEXT: Record<string, string> = { HOSPITAL: 'Hospital coordinator', CLINICIAN: 'Clinician', AMBULANCE: 'Ambulance crew' };

/** Send a command; the same clientRequestId is reused for retries of the same intent (idempotent). */
const send = async (path: string, body: Record<string, unknown>) => (await sendCommand(path, body)).error;

/* ------------------------------------------------------------------ arrival */

export function RecordArrivalButton({ hospitalId, caseId, ambulanceId, gpsArrived, onDone }: { hospitalId: string; caseId: string; ambulanceId?: string; gpsArrived?: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [requestId, setRequestId] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <JivaButton
        size="sm"
        variant={gpsArrived ? 'primary' : 'secondary'}
        icon="hospital"
        onClick={() => {
          setRequestId(crypto.randomUUID());
          setError(null);
          setOpen(true);
        }}
      >
        Record arrival
      </JivaButton>
      <JivaModal
        open={open}
        onClose={() => setOpen(false)}
        title={`Record the arrival of ${caseId}?`}
        icon="hospital"
        tone="ok"
        description={
          <>
            Confirm that the patient{ambulanceId ? ` brought by ${ambulanceId}` : ''} is physically at your emergency department. This opens the hospital encounter;{' '}
            <strong>the patient is in your care only once you also record the handover</strong> from the crew.
          </>
        }
        actions={
          <>
            <JivaButton onClick={() => setOpen(false)}>Cancel</JivaButton>
            <AsyncButton
              variant="primary"
              icon="hospital"
              pendingText="Recording…"
              onAction={async () => {
                const err = await send(`/api/hospitals/${encodeURIComponent(hospitalId)}/arrivals`, { clientRequestId: requestId, caseId });
                setError(err);
                if (!err) {
                  setOpen(false);
                  onDone();
                }
                return err;
              }}
            >
              Record arrival now
            </AsyncButton>
          </>
        }
      >
        {gpsArrived && <p className="text-xs text-ink-500">The ambulance's GPS already placed it at your hospital. GPS is evidence only; your record is the confirmation.</p>}
        {error && <CommandError message={error} />}
      </JivaModal>
    </>
  );
}

/** For a patient who reached the department without appearing in "Patients on the way" (e.g. a diversion). */
export function ArrivalByReference({ hospitalId, onDone }: { hospitalId: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [caseRef, setCaseRef] = useState('');
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const ref = caseRef.trim().toUpperCase();
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-xs font-semibold text-ink-600 hover:text-ink-900 hover:underline">
        Patient arrived but not listed here?
      </button>
    );
  }
  return (
    <div className="animate-fade rounded-xl bg-white p-3 ring-1 ring-ink-200">
      <label htmlFor="arrival-ref" className="text-xs font-semibold text-ink-700">
        Case reference
      </label>
      <div className="mt-1 flex flex-wrap gap-2">
        <input
          id="arrival-ref"
          value={caseRef}
          onChange={(e) => {
            setCaseRef(e.target.value);
            setRequestId(crypto.randomUUID()); // a different case is a different request
            setError(null);
          }}
          placeholder="CASE-…"
          autoComplete="off"
          className="h-9 min-w-0 flex-1 rounded-lg px-3 text-sm ring-1 ring-inset ring-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
        />
        <AsyncButton
          size="sm"
          variant="primary"
          icon="hospital"
          disabled={!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(ref)}
          pendingText="Recording…"
          onAction={async () => {
            const err = await send(`/api/hospitals/${encodeURIComponent(hospitalId)}/arrivals`, { clientRequestId: requestId, caseId: ref });
            setError(err);
            if (!err) {
              setOpen(false);
              setCaseRef('');
              setRequestId(crypto.randomUUID());
              onDone();
            }
            return err;
          }}
        >
          Record arrival
        </AsyncButton>
        <JivaButton size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </JivaButton>
      </div>
      <p className="mt-1.5 text-xs text-ink-500">Only cases routed to, or accepted by, your hospital can be recorded here.</p>
      {error && <CommandError message={error} />}
    </div>
  );
}

/* ------------------------------------------------------------------ department */

export function DepartmentSection({ encounters, patients, roster, now, onChanged }: { encounters: EncounterRecord[]; patients: Map<string, PatientState>; roster: RosterEntry[]; now: number; onChanged: () => void }) {
  const awaiting = encounters.filter((e) => e.status === 'ARRIVED');
  const inCare = encounters.filter((e) => e.status === 'IN_CARE');
  return (
    <section aria-labelledby="department-title" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="department-title" className="text-lg font-semibold tracking-[-0.01em] text-ink-900">
          In your department
        </h2>
        {awaiting.length > 0 && (
          <JivaBadge tone="warn" icon="clock">
            {awaiting.length} awaiting handover
          </JivaBadge>
        )}
      </div>
      {encounters.length === 0 ? (
        <p className="text-sm text-ink-500">Patients appear here once you record their arrival. They are in your care when you record the handover from the crew.</p>
      ) : (
        <ul className="grid gap-3 xl:grid-cols-2">
          {[...awaiting, ...inCare].map((e) => (
            <li key={e.encounterId}>
              <EncounterCard encounter={e} patient={patients.get(e.caseId)} roster={roster} now={now} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EncounterCard({ encounter: e, patient, roster, now, onChanged }: { encounter: EncounterRecord; patient?: PatientState; roster: RosterEntry[]; now: number; onChanged: () => void }) {
  const [handoverOpen, setHandoverOpen] = useState(false);
  const [handoverId, setHandoverId] = useState('');
  const [handoverError, setHandoverError] = useState<string | null>(null);
  const arrivedAt = encounterArrivedAt(e);
  const handedOverAt = encounterHandedOverAt(e);
  const meta = encounterStatus(e.status);
  return (
    <JivaCard as="article" accent={meta.tone} className="h-full animate-enter" aria-labelledby={`enc-${e.encounterId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 id={`enc-${e.encounterId}`} className="text-[15px] font-semibold text-ink-900">
            {e.caseId}
          </h3>
          <p className="text-xs text-ink-500">
            Encounter {e.encounterId} · arrived {formatClock(arrivedAt)} ({timeAgo(arrivedAt, now)})
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <JivaStatus meta={meta} />
          {e.dataStatus === 'SYNTHETIC_DEMO' && <JivaStatus meta={dataStatus('SYNTHETIC_DEMO')} />}
        </div>
      </div>

      <dl className="mt-3 grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-2">
        <Fact label="Reported">{patient?.reportedSymptoms?.join(', ') || patient?.activeConditions.join(', ') || 'Not shared'}</Fact>
        <Fact label="Brought by">{e.ambulanceId ?? 'No ambulance on record'}</Fact>
        <Fact label="Referral">{e.referral ? `${e.referral.requestId}${e.referral.responseStatus ? ` · ${e.referral.responseStatus.toLowerCase()}` : ''}` : 'None on record'}</Fact>
        <Fact label="Arrival recorded by">{e.arrival ? ROLE_TEXT[e.arrival.recordedBy.role] ?? e.arrival.recordedBy.role : '—'}</Fact>
        {e.arrival?.gpsArrivalAt && <Fact label="GPS geofence (evidence)">{formatClock(e.arrival.gpsArrivalAt)}</Fact>}
        {handedOverAt && <Fact label="Handed over">{`${formatClock(handedOverAt)}${e.handover ? ` · ${ROLE_TEXT[e.handover.recordedBy.role] ?? e.handover.recordedBy.role}` : ''}`}</Fact>}
      </dl>

      {e.status === 'ARRIVED' ? (
        <div className="mt-4 border-t border-ink-100 pt-3">
          <JivaButton
            variant="primary"
            icon="stethoscope"
            onClick={() => {
              setHandoverId(crypto.randomUUID());
              setHandoverError(null);
              setHandoverOpen(true);
            }}
          >
            Record handover
          </JivaButton>
          <p className="mt-1.5 text-xs text-ink-500">When the crew has handed the patient over to your team.</p>
        </div>
      ) : (
        <DoctorPanel encounter={e} roster={roster} onChanged={onChanged} />
      )}

      <JivaModal
        open={handoverOpen}
        onClose={() => setHandoverOpen(false)}
        title={`Record the handover of ${e.caseId}?`}
        icon="stethoscope"
        tone="ok"
        description={
          <>
            Confirm that {e.ambulanceId ? `the crew of ${e.ambulanceId}` : 'the crew'} has handed the patient over to your team. From now on the patient is <strong>in your hospital's care</strong>, and the crew is released for its next call.
          </>
        }
        actions={
          <>
            <JivaButton onClick={() => setHandoverOpen(false)}>Cancel</JivaButton>
            <AsyncButton
              variant="primary"
              icon="stethoscope"
              pendingText="Recording…"
              onAction={async () => {
                const err = await send(`/api/encounters/${encodeURIComponent(e.encounterId)}/handover`, { clientRequestId: handoverId });
                setHandoverError(err);
                if (!err) {
                  setHandoverOpen(false);
                  onChanged();
                }
                return err;
              }}
            >
              Record handover now
            </AsyncButton>
          </>
        }
      >
        {handoverError && <CommandError message={handoverError} />}
      </JivaModal>
    </JivaCard>
  );
}

function DoctorPanel({ encounter: e, roster, onChanged }: { encounter: EncounterRecord; roster: RosterEntry[]; onChanged: () => void }) {
  const current = e.assignedDoctor;
  const choices = useMemo(() => roster.filter((r) => r.active && r.practitionerId !== current?.practitionerId), [roster, current?.practitionerId]);
  const inactive = roster.filter((r) => !r.active).length;
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState('');
  const [reason, setReason] = useState<string>(REASSIGNMENT_REASONS[0]);
  const [requestId, setRequestId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const history = (e.assignmentHistory ?? []).slice().reverse();

  const start = () => {
    setPick(choices[0]?.practitionerId ?? '');
    setReason(REASSIGNMENT_REASONS[0]);
    setRequestId(crypto.randomUUID());
    setError(null);
    setEditing(true);
  };

  return (
    <div className="mt-4 space-y-2 border-t border-ink-100 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-500">Responsible doctor</p>
          {current ? (
            <p className="text-sm font-semibold text-ink-900">
              {current.displayName}
              <span className="font-normal text-ink-600">
                {current.specialty ? ` · ${current.specialty}` : ''} · since {formatClock(current.assignedAt)}
              </span>
            </p>
          ) : (
            <p className="text-sm font-semibold text-warn-700">No doctor assigned yet</p>
          )}
        </div>
        {!editing && (
          <JivaButton size="sm" variant={current ? 'secondary' : 'primary'} icon="user" onClick={start} disabled={choices.length === 0}>
            {current ? 'Change doctor' : 'Assign doctor'}
          </JivaButton>
        )}
      </div>
      {roster.length === 0 && <p className="text-xs text-ink-500">No clinician roster is connected for your hospital, so no doctor can be assigned in JIVA.</p>}

      {editing && (
        <div className="animate-fade space-y-2 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
          <label className="block text-xs font-semibold text-ink-700" htmlFor={`doc-${e.encounterId}`}>
            Clinician
          </label>
          <select
            id={`doc-${e.encounterId}`}
            value={pick}
            onChange={(ev) => {
              setPick(ev.target.value);
              setRequestId(crypto.randomUUID());
            }}
            className="h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-inset ring-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            {choices.map((r) => (
              <option key={r.practitionerId} value={r.practitionerId}>
                {r.displayName} · {r.specialty} · {r.activeEncounters} patient{r.activeEncounters === 1 ? '' : 's'}
              </option>
            ))}
          </select>
          {current && (
            <>
              <label className="block text-xs font-semibold text-ink-700" htmlFor={`reason-${e.encounterId}`}>
                Reason for the change
              </label>
              <select
                id={`reason-${e.encounterId}`}
                value={reason}
                onChange={(ev) => {
                  setReason(ev.target.value);
                  setRequestId(crypto.randomUUID());
                }}
                className="h-9 w-full rounded-lg bg-white px-2 text-sm ring-1 ring-inset ring-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {REASSIGNMENT_REASONS.map((r) => (
                  <option key={r} value={r}>
                    {ASSIGNMENT_REASON_TEXT[r]}
                  </option>
                ))}
              </select>
            </>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <AsyncButton
              size="sm"
              variant="primary"
              icon="check"
              disabled={!pick}
              pendingText="Assigning…"
              onAction={async () => {
                const err = await send(`/api/encounters/${encodeURIComponent(e.encounterId)}/doctor`, { clientRequestId: requestId, practitionerId: pick, ...(current ? { reason } : {}) });
                setError(err);
                if (!err) {
                  setEditing(false);
                  onChanged();
                }
                return err;
              }}
            >
              {current ? 'Change doctor' : 'Assign'}
            </AsyncButton>
            <JivaButton size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </JivaButton>
          </div>
          <p className="text-xs text-ink-500">
            Only active clinicians on your hospital's roster can be assigned{inactive ? ` (${inactive} inactive not shown)` : ''}. The assigned doctor gets access to this patient's records; a previous doctor loses it.
          </p>
          {error && <CommandError message={error} />}
        </div>
      )}

      {history.length > 0 && (
        <details className="text-xs text-ink-600">
          <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">Assignment history ({history.length})</summary>
          <ol className="mt-1.5 space-y-1">
            {history.map((h) => (
              <li key={`${h.practitionerId}-${h.assignedAt}`} className={cx('flex flex-wrap gap-x-2', h.endedAt && 'text-ink-500')}>
                <span className="font-semibold text-ink-800">{h.displayName}</span>
                <span>
                  {formatClock(h.assignedAt)}
                  {h.endedAt ? `–${formatClock(h.endedAt)}` : ' · current'}
                </span>
                <span>{ASSIGNMENT_REASON_TEXT[h.reason ?? ''] ?? h.reason}</span>
                {h.assignedBy && <span>by {ROLE_TEXT[h.assignedBy.role] ?? h.assignedBy.role}</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd className="truncate text-ink-900">{children}</dd>
    </div>
  );
}
