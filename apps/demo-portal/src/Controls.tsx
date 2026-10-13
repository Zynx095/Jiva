import { useEffect, useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  JivaButton,
  JivaCard,
  JivaModal,
  cx,
  formatClockSeconds,
  type RosterEntry,
} from '@jiva/ui/src';
import { call, socket } from './api';
import { CaseStrip } from './CaseStrip';
import { DEMO, PRACTITIONER_PERSONA, steps, type Ctx, type Deps, type Step } from './workflows';
import type { LiveState } from './useLiveState';

interface LogLine {
  at: number;
  persona: string;
  title: string;
  ok: boolean;
  detail: string;
}

const deps: Deps = {
  call: (persona, method, path, body) => call(persona, method, path, body),
  realtimeConnected: () => socket.connected,
};

const HOSPITALS = ['HOSP-BLR-001', 'HOSP-BLR-002', 'HOSP-BLR-004'];

/**
 * Manual controls for the demo case. Each button performs one real workflow as the persona named on it
 * (the same step definitions the scenarios use) and logs the server's answer.
 */
export function Controls({ live }: { live: LiveState }) {
  const [log, setLog] = useState<LogLine[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [doctor, setDoctor] = useState('');
  const encounter = live.encounter;
  const assigned = encounter?.assignedDoctor?.practitionerId;
  const doctorPersona = assigned ? PRACTITIONER_PERSONA[assigned] : undefined;
  const destination = live.ambulance?.destinationHospital;

  useEffect(() => {
    const hid = encounter?.hospitalId;
    const persona = hid ? DEMO.hospitals[hid]?.persona ?? (hid === 'HOSP-BLR-003' ? 'demo-hosp-3' : undefined) : undefined;
    if (!hid || !persona) return;
    let alive = true;
    void call<RosterEntry[]>(persona, 'GET', `/api/hospitals/${hid}/clinicians`).then((r) => {
      if (alive) setRoster(r.ok && Array.isArray(r.body) ? r.body.filter((p) => p.active && p.hospitalId === hid) : []);
    });
    return () => {
      alive = false;
    };
  }, [encounter?.hospitalId, live.version]);
  // Without an encounter there is nobody to assign: the roster of a previous encounter is never offered.
  const shownRoster = encounter ? roster.filter((p) => p.hospitalId === encounter.hospitalId) : [];

  /** Build the step context from the server's current state, then run the step. */
  const run = async (step: Step): Promise<string | null> => {
    const ctx: Ctx = { caseId: DEMO.caseId, requestIds: {}, encounterId: encounter?.encounterId };
    for (const id of HOSPITALS) {
      const r = await call<Array<{ caseId: string; requestId: string }>>(DEMO.hospitals[id].persona, 'GET', `/api/hospitals/${id}/requests`).catch(() => null);
      const req = r?.ok && Array.isArray(r.body) ? r.body.find((q) => q.caseId === DEMO.caseId) : undefined;
      if (req) ctx.requestIds[id] = req.requestId;
    }
    if (doctorPersona && encounter) {
      const rx = await call<Array<{ prescriptionId: string; current: { status: string; version: number } }>>(doctorPersona, 'GET', `/api/encounters/${encounter.encounterId}/prescriptions`).catch(() => null);
      const draft = rx?.ok && Array.isArray(rx.body) ? rx.body.find((p) => p.current.status === 'DRAFT') : undefined;
      if (draft) {
        ctx.prescriptionId = draft.prescriptionId;
        ctx.prescriptionVersion = draft.current.version;
      }
    }
    try {
      const detail = await step.run(ctx, deps);
      setLog((l) => [{ at: Date.now(), persona: step.persona, title: step.title, ok: true, detail }, ...l].slice(0, 50));
      live.refresh();
      return null;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setLog((l) => [{ at: Date.now(), persona: step.persona, title: step.title, ok: false, detail }, ...l].slice(0, 50));
      live.refresh();
      return detail;
    }
  };

  /** The doctor-side steps act as whichever demo clinician is assigned now. */
  const asAssigned = (step: Step): Step => ({ ...step, persona: doctorPersona ?? step.persona, run: (ctx, d) => step.run(ctx, { ...d, call: (_p, m, path, body) => d.call(doctorPersona ?? step.persona, m, path, body) }) });

  return (
    <div className="space-y-4">
      <CaseStrip live={live} />
      <div className="grid gap-4 xl:grid-cols-2">
        <JivaCard>
          <CardHeader title="Emergency" icon="siren" subtitle={`Crew ${DEMO.crew.ambulanceId} (persona ${DEMO.crew.persona}) · case ${DEMO.caseId}`} />
          <div className="mt-3 flex flex-wrap gap-2">
            <AsyncButton variant="primary" icon="siren" pendingText="Reporting…" onAction={() => run(steps.report())}>
              Crew reports the emergency
            </AsyncButton>
            <JivaButton variant="danger-soft" icon="refresh" onClick={() => setConfirmReset(true)}>
              Reset the demo
            </JivaButton>
          </div>
        </JivaCard>

        <JivaCard>
          <CardHeader title="Hospital answers" icon="hospital" subtitle="Each answer names the hospital's open referral for this case (refused otherwise)" />
          <div className="mt-3 space-y-2">
            {HOSPITALS.map((id) => (
              <div key={id} className="flex flex-wrap items-center gap-1.5">
                <span className="w-24 text-[13px] font-semibold text-ink-800">{DEMO.hospitals[id].name}</span>
                <AsyncButton size="sm" variant="ok-soft" icon="checkCircle" onAction={() => run(steps.answer(id, 'ACCEPTED'))}>
                  Accept
                </AsyncButton>
                <AsyncButton size="sm" variant="ok-soft" icon="clock" title="Accept for 20 seconds, to demonstrate expiry" onAction={() => run(steps.answer(id, 'ACCEPTED', 20_000))}>
                  Accept 20 s
                </AsyncButton>
                <AsyncButton size="sm" variant="danger-soft" icon="xCircle" onAction={() => run(steps.answer(id, 'REJECTED'))}>
                  Decline
                </AsyncButton>
                <AsyncButton size="sm" variant="warn-soft" icon="ban" onAction={() => run(steps.answer(id, 'UNAVAILABLE'))}>
                  Busy
                </AsyncButton>
              </div>
            ))}
          </div>
        </JivaCard>

        <JivaCard>
          <CardHeader title="Journey" icon="navigation" subtitle={destination ? `Destination: ${DEMO.hospitals[destination]?.name ?? destination}` : 'No destination yet'} />
          <div className="mt-3 flex flex-wrap gap-2">
            <AsyncButton icon="pin" disabled={!destination} onAction={() => run(steps.gpsArrival(destination!))}>
              Ambulance reaches the destination (simulated position)
            </AsyncButton>
            <AsyncButton icon="hospital" disabled={!destination || !!encounter} onAction={() => run(steps.recordArrival(destination!))}>
              Hospital records the arrival
            </AsyncButton>
            <AsyncButton icon="checkCircle" disabled={!encounter || encounter.status !== 'ARRIVED'} onAction={() => run(steps.recordHandover(encounter!.hospitalId))}>
              Hospital records the handover
            </AsyncButton>
          </div>
        </JivaCard>

        <JivaCard>
          <CardHeader title="Doctor" icon="stethoscope" subtitle={encounter ? `Roster of ${DEMO.hospitals[encounter.hospitalId]?.name ?? encounter.hospitalId} (synthetic)` : 'After the handover'} />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              aria-label="Clinician to assign"
              className="h-9 rounded-lg bg-white px-2.5 text-sm ring-1 ring-inset ring-ink-200"
              value={doctor}
              onChange={(e) => setDoctor(e.target.value)}
              disabled={!encounter || encounter.status !== 'IN_CARE'}
            >
              <option value="">Choose a clinician</option>
              {shownRoster.map((p) => (
                <option key={p.practitionerId} value={p.practitionerId}>
                  {p.displayName} · {p.specialty}
                  {PRACTITIONER_PERSONA[p.practitionerId] ? '' : ' (no demo persona)'}
                </option>
              ))}
            </select>
            <AsyncButton
              icon="user"
              disabled={!doctor || !encounter || encounter.status !== 'IN_CARE' || encounter.assignedDoctor?.practitionerId === doctor}
              onAction={async () => {
                const persona = DEMO.hospitals[encounter!.hospitalId]?.persona ?? 'demo-hosp-3';
                const step: Step = {
                  id: 'assign-manual', title: 'Assign the responsible doctor', persona, actor: 'Hospital coordinator', description: '',
                  run: async (ctx, d) => {
                    const r = await d.call(persona, 'POST', `/api/encounters/${ctx.encounterId}/doctor`, { clientRequestId: crypto.randomUUID(), practitionerId: doctor, ...(encounter?.assignedDoctor ? { reason: 'REASSIGNMENT' } : {}) });
                    if (r.status !== 200) throw new Error(`${r.status} ${r.body?.message ?? r.body?.error ?? ''}`);
                    return `${r.body.encounter.assignedDoctor.displayName} is responsible.`;
                  },
                };
                return run(step);
              }}
            >
              Assign
            </AsyncButton>
          </div>
        </JivaCard>

        <JivaCard>
          <CardHeader
            title="Clinical (as the assigned doctor)"
            icon="pill"
            subtitle={doctorPersona ? `Acts as ${encounter?.assignedDoctor?.displayName} (persona ${doctorPersona})` : 'Assign a doctor with a demo persona first'}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <AsyncButton icon="layers" disabled={!doctorPersona} onAction={() => run(asAssigned(steps.attachSample()))}>
              Attach synthetic chest X-ray
            </AsyncButton>
            <AsyncButton icon="file" disabled={!doctorPersona} onAction={() => run(asAssigned(steps.draftPrescription()))}>
              Draft demo prescription
            </AsyncButton>
            <AsyncButton variant="primary" icon="check" disabled={!doctorPersona} onAction={() => run(asAssigned(steps.authorisePrescription()))}>
              Authorise the draft
            </AsyncButton>
          </div>
        </JivaCard>

        <JivaCard>
          <CardHeader title="Faults" icon="wifiOff" subtitle="Demo-only fault injection, as the demo administrator" />
          <div className="mt-3 flex flex-wrap gap-2">
            <AsyncButton variant="warn-soft" icon="wifiOff" onAction={() => run(steps.interruptRealtime(15))}>
              Interrupt realtime for 15 s
            </AsyncButton>
          </div>
          <p className="mt-2 text-xs text-ink-500">A full API outage is demonstrated by stopping the API process and starting it again (in-memory demo state is lost on restart).</p>
        </JivaCard>
      </div>

      <JivaCard>
        <CardHeader title="Control log" icon="list" subtitle="The server's answer to each control, newest first" />
        {log.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">Nothing run yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-ink-100 text-[13px]">
            {log.map((l, i) => (
              <li key={`${l.at}-${i}`} className="py-1.5">
                <span className={cx('font-semibold', l.ok ? 'text-brand-800' : 'text-danger-700')}>{l.ok ? '✓' : '✗'} {l.title}</span>
                <span className="text-ink-500"> · {formatClockSeconds(l.at)} · as {l.persona}</span>
                <span className="block text-ink-700">{l.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </JivaCard>

      <JivaModal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Reset the demo?"
        icon="refresh"
        tone="warn"
        description="Clears every demo case, encounter and record and re-seeds the synthetic network. Everyone watching the demo sees it. Operational mode has no reset."
        actions={
          <>
            <JivaButton variant="ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </JivaButton>
            <JivaButton
              variant="primary"
              icon="refresh"
              onClick={() => {
                setConfirmReset(false);
                void run(steps.reset());
              }}
            >
              Reset
            </JivaButton>
          </>
        }
      />
    </div>
  );
}
