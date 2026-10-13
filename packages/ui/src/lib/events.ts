import type { IconName } from '../components/Icon';
import type { Tone } from './status';
import { capabilityStatus } from './status';
import { capabilityLabel, joinList, plainCapabilities, SEVERITY_TEXT } from './labels';
import { formatClock, formatKm, minutesFromSeconds } from './time';

/** Structural view of a canonical event (see packages/event-schema). Payload fields are read defensively. */
export interface JivaEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  source: { type: string; id: string };
  patientId?: string;
  correlationId?: string;
  causationId?: string;
  version?: string;
  metadata?: Record<string, unknown>;
  payload: Record<string, unknown>;
}

export type EventCategory = 'case' | 'decision' | 'hospital' | 'ambulance' | 'routing' | 'ai' | 'system';

/** Who reads the sentence: operations staff, the patient, the ambulance crew or a hospital. */
export type Audience = 'ops' | 'patient' | 'crew' | 'hospital';

export interface EventDescription {
  title: string;
  detail?: string;
  tone: Tone;
  icon: IconName;
  category: EventCategory;
  /** High-frequency telemetry (GPS, shadow traces): collapsed by default. */
  quiet?: boolean;
  /** Worth a short live notification when it arrives. */
  notable?: boolean;
  caseId?: string;
  hospitalId?: string;
  ambulanceId?: string;
}

/** Resolves an id (hospital, ambulance…) to a readable name, or undefined to keep the id. */
export type NameResolver = (id: string) => string | undefined;

export const UNASSIGNED_DESTINATION = 'UNASSIGNED';

const str = (p: Record<string, unknown>, k: string): string | undefined => (typeof p[k] === 'string' ? (p[k] as string) : undefined);
const num = (p: Record<string, unknown>, k: string): number | undefined => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
const strings = (p: Record<string, unknown>, k: string): string[] =>
  Array.isArray(p[k]) ? (p[k] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
const dotJoin = (parts: Array<string | undefined | false>) => parts.filter(Boolean).join(' · ') || undefined;

export function eventCaseId(e: JivaEvent): string | undefined {
  return e.patientId || str(e.payload, 'caseId') || str(e.payload, 'patientId');
}

/** Hospitals an event refers to (current, previous and new destination). */
export function eventHospitalIds(e: JivaEvent): string[] {
  return ['hospitalId', 'oldHospitalId', 'newHospitalId']
    .map((k) => str(e.payload, k))
    .filter((x): x is string => !!x && x !== UNASSIGNED_DESTINATION);
}

export function eventAmbulanceId(e: JivaEvent): string | undefined {
  return str(e.payload, 'ambulanceId') || (e.source.type === 'ambulance' ? e.source.id : undefined);
}

/**
 * Rewrites engine reason strings ("Destination HOSP-BLR-001 capacity became UNAVAILABLE") as sentences
 * people can read at a glance. Unknown phrasing falls back to id → name substitution only.
 */
export function humanizeReason(reason: string | undefined, name: NameResolver): string | undefined {
  if (!reason) return undefined;
  const n = (id: string) => name(id) ?? id;
  const rules: Array<[RegExp, (...m: string[]) => string]> = [
    [/Hospital (HOSP-[\w-]+) ACCEPTED the acceptance request/g, (_, id) => `${n(id)} accepted the request`],
    [/Hospital (HOSP-[\w-]+) LIMITED the acceptance request/g, (_, id) => `${n(id)} accepted with limits`],
    [/Destination (HOSP-[\w-]+) REJECTED the case/g, (_, id) => `${n(id)} declined the case`],
    [/Destination (HOSP-[\w-]+) reported UNAVAILABLE/g, (_, id) => `${n(id)} reported it is unavailable`],
    [/Destination (HOSP-[\w-]+) capacity became UNAVAILABLE/g, (_, id) => `${n(id)} reported its emergency capacity unavailable`],
    [/Acceptance from (HOSP-[\w-]+) expired/g, (_, id) => `${n(id)}'s acceptance expired`],
    [/Destination assigned from existing acceptance/g, () => 'Assigned from an existing acceptance'],
    [/no eligible accepting hospital — awaiting responses/g, () => 'no other hospital has accepted yet — waiting for responses'],
    [/\b(HOSP-[\w-]+)\b/g, (_, id) => n(id)],
  ];
  let out = reason;
  for (const [re, fn] of rules) out = out.replace(re, (...m: unknown[]) => fn(...(m as string[])));
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const CANCEL_REASON: Record<string, string> = {
  CASE_CLOSED: 'Case closed',
  DESTINATION_FINALIZED_ELSEWHERE: 'Patient going elsewhere',
  REQUIREMENT_CHANGED: 'Care needs changed',
  OPERATOR_WITHDRAWN: 'Withdrawn by an operator',
};

/** Turns any event into a short human sentence for the given audience. */
export function describeEvent(e: JivaEvent, name: NameResolver, audience: Audience = 'ops'): EventDescription {
  const p = e.payload || {};
  const caseId = eventCaseId(e);
  const hospitalId = str(p, 'hospitalId') || str(p, 'newHospitalId');
  const ambulanceId = eventAmbulanceId(e);
  const base = { caseId, hospitalId: hospitalId === UNASSIGNED_DESTINATION ? undefined : hospitalId, ambulanceId };
  const H = (id?: string) => (id ? name(id) ?? id : 'a hospital');
  const A = ambulanceId ?? 'Ambulance';
  const patient = audience === 'patient';

  switch (e.eventType) {
    case 'patient.emergency.created': {
      const sev = str(p, 'severity');
      return patient
        ? { ...base, title: 'Emergency reported', detail: 'Help was requested for you.', tone: 'danger', icon: 'siren', category: 'case', notable: true }
        : { ...base, title: `Emergency reported${caseId ? ` · ${caseId}` : ''}`, detail: dotJoin([sev && SEVERITY_TEXT[sev], str(p, 'condition')]), tone: 'danger', icon: 'siren', category: 'case', notable: true };
    }
    case 'care.requirement.created': {
      const caps = strings(p, 'requiredCapabilities').map((c) => capabilityLabel(c, patient ? 'plain' : 'short'));
      return { ...base, title: patient ? 'Your care needs were assessed' : 'Care needs assessed', detail: caps.length ? `Needs ${joinList(caps)}` : undefined, tone: 'neutral', icon: 'stethoscope', category: 'decision' };
    }
    case 'hospital.candidate.generated': {
      const cands = Array.isArray(p.candidates) ? (p.candidates as Array<Record<string, unknown>>) : [];
      const count = (v: string) => cands.filter((c) => c.operationalEligibility === v).length;
      return {
        ...base,
        title: `${cands.length} hospital${cands.length === 1 ? '' : 's'} evaluated`,
        detail: dotJoin([count('ELIGIBLE') ? `${count('ELIGIBLE')} eligible` : false, count('PENDING_ACCEPTANCE') ? `${count('PENDING_ACCEPTANCE')} need to accept` : false, count('INELIGIBLE') ? `${count('INELIGIBLE')} not suitable` : false]),
        tone: 'neutral', icon: 'list', category: 'decision',
      };
    }
    case 'hospital.acceptance.requested':
      return {
        ...base,
        title: audience === 'hospital' ? 'New emergency request' : `Asked ${H(hospitalId)} to accept`,
        detail: dotJoin([str(p, 'expiresAt') && `Answer by ${formatClock(str(p, 'expiresAt'))}`, num(p, 'ambulanceEtaMinutes') !== undefined && `Ambulance ETA ${num(p, 'ambulanceEtaMinutes')} min`]),
        tone: 'warn', icon: 'send', category: 'hospital', notable: audience === 'hospital',
      };
    case 'hospital.acceptance.received': {
      const status = str(p, 'status');
      const lim = strings(p, 'limitations');
      const valid = str(p, 'validUntil');
      const who = H(hospitalId);
      const meta: Record<string, Pick<EventDescription, 'title' | 'tone' | 'icon'>> = {
        ACCEPTED: { title: `${who} accepted`, tone: 'ok', icon: 'checkCircle' },
        LIMITED: { title: `${who} accepted with limits`, tone: 'warn', icon: 'half' },
        REJECTED: { title: `${who} declined`, tone: 'danger', icon: 'xCircle' },
        UNAVAILABLE: { title: `${who} is unavailable`, tone: 'danger', icon: 'ban' },
      };
      const m = meta[status ?? ''] ?? { title: `${who} responded`, tone: 'neutral' as Tone, icon: 'info' as IconName };
      return {
        ...base, ...m,
        detail: dotJoin([lim.length ? lim.join('; ') : false, (status === 'ACCEPTED' || status === 'LIMITED') && valid && `Valid until ${formatClock(valid)}`]),
        category: 'hospital', notable: true,
      };
    }
    case 'hospital.acceptance.expired':
      if (str(p, 'kind') === 'REQUEST_UNANSWERED') {
        return { ...base, title: audience === 'hospital' ? 'A request closed without your answer' : `${H(hospitalId)} did not answer in time`, detail: 'Treated as unknown for this case', tone: 'neutral', icon: 'hourglass', category: 'hospital', notable: audience !== 'hospital' };
      }
      return { ...base, title: `${H(hospitalId)}'s acceptance expired`, detail: 'Treated as unknown until the hospital answers again', tone: 'neutral', icon: 'hourglass', category: 'hospital', notable: true };
    case 'hospital.acceptance.cancelled':
      return { ...base, title: `Request to ${H(hospitalId)} withdrawn`, detail: CANCEL_REASON[str(p, 'reason') ?? ''] ?? str(p, 'reason'), tone: 'neutral', icon: 'x', category: 'hospital' };
    case 'hospital.capacity.updated': {
      const ed = str(p, 'emergencyStatus');
      const statuses = [ed, str(p, 'traumaStatus'), str(p, 'icuStatus')];
      const tone: Tone = statuses.includes('UNAVAILABLE') ? 'danger' : statuses.includes('LIMITED') ? 'warn' : statuses.includes('AVAILABLE') ? 'ok' : 'neutral';
      return {
        ...base,
        title: ed === 'UNAVAILABLE' ? `${H(hospitalId)} reported ED unavailable` : `${H(hospitalId)} updated its status`,
        detail: `Emergency ${capabilityStatus(ed).label.toLowerCase()} · Trauma ${capabilityStatus(str(p, 'traumaStatus')).label.toLowerCase()} · ICU ${capabilityStatus(str(p, 'icuStatus')).label.toLowerCase()}`,
        tone, icon: tone === 'danger' ? 'ban' : 'hospital', category: 'hospital', notable: tone === 'danger',
      };
    }
    case 'ambulance.dispatched': {
      const eta = num(p, 'estimatedEtaMinutes');
      if (str(p, 'assignmentBasis') === 'REPORTED_BY_CREW') {
        return patient
          ? { ...base, title: 'An ambulance crew is with you', detail: `Ambulance ${A} reported your emergency`, tone: 'ok', icon: 'ambulance', category: 'ambulance', notable: true }
          : { ...base, title: `${A} is attending${caseId ? ` ${caseId}` : ''}`, detail: 'The crew reported this emergency from the scene', tone: 'ok', icon: 'ambulance', category: 'ambulance', notable: true };
      }
      return patient
        ? { ...base, title: 'An ambulance is on the way', detail: dotJoin([`Ambulance ${A}`, eta !== undefined && `About ${eta} min to reach you`]), tone: 'ok', icon: 'ambulance', category: 'ambulance', notable: true }
        : { ...base, title: `${A} dispatched`, detail: dotJoin([caseId && `To ${caseId}`, eta !== undefined && `${eta} min to scene`]), tone: 'ok', icon: 'ambulance', category: 'ambulance', notable: true };
    }
    case 'ambulance.location.updated': {
      const speed = num(p, 'speedKmh');
      return { ...base, title: patient ? 'Ambulance position updated' : `${A} position updated`, detail: speed !== undefined ? `${Math.round(speed)} km/h` : undefined, tone: 'neutral', icon: 'pin', category: 'ambulance', quiet: true };
    }
    case 'ambulance.arrived': {
      // GPS geofence = derived signal; only the hospital's own record (encounter.arrival.recorded) confirms arrival.
      const confirmed = str(p, 'basis') === 'HOSPITAL_CONFIRMED';
      if (confirmed) {
        return { ...base, title: patient ? `${H(hospitalId)} confirmed your arrival` : `${A} at ${H(hospitalId)} · arrival confirmed`, detail: 'Recorded by the hospital', tone: 'ok', icon: 'pin', category: 'ambulance', quiet: true };
      }
      return patient
        ? { ...base, title: `Your ambulance reached ${H(hospitalId)}`, detail: 'The hospital confirms your arrival and takes over your care.', tone: 'ok', icon: 'pin', category: 'ambulance', notable: true }
        : { ...base, title: `${A} reached ${H(hospitalId)}`, detail: "GPS geofence · awaiting the hospital's arrival record", tone: 'ok', icon: 'pin', category: 'ambulance', notable: true };
    }
    case 'encounter.arrival.recorded':
      return audience === 'patient'
        ? { ...base, title: `${H(hospitalId)} confirmed your arrival`, detail: 'The emergency team is taking over from the ambulance crew.', tone: 'ok', icon: 'hospital', category: 'case', notable: true }
        : audience === 'crew'
          ? { ...base, title: `${H(hospitalId)} confirmed your arrival`, detail: 'Hand the patient over to the emergency team.', tone: 'ok', icon: 'hospital', category: 'case', notable: true }
          : audience === 'hospital'
            ? { ...base, title: `Arrival recorded${caseId ? ` · ${caseId}` : ''}`, detail: 'Awaiting handover from the crew', tone: 'ok', icon: 'hospital', category: 'case', notable: true }
            : { ...base, title: `${caseId ?? 'Patient'} arrived at ${H(hospitalId)}`, detail: 'Recorded by the hospital · awaiting handover', tone: 'ok', icon: 'hospital', category: 'case', notable: true };
    case 'encounter.handover.recorded':
      return audience === 'patient'
        ? { ...base, title: `You are in the care of ${H(hospitalId)}`, detail: 'The ambulance crew handed you over to the hospital team.', tone: 'ok', icon: 'stethoscope', category: 'case', notable: true }
        : audience === 'crew'
          ? { ...base, title: `Handover to ${H(hospitalId)} recorded`, detail: 'Your unit is released for the next call.', tone: 'ok', icon: 'checkCircle', category: 'case', notable: true }
          : audience === 'hospital'
            ? { ...base, title: `Handover recorded${caseId ? ` · ${caseId}` : ''}`, detail: 'The patient is in your care; the crew is released', tone: 'ok', icon: 'stethoscope', category: 'case', notable: true }
            : { ...base, title: `${caseId ?? 'Patient'} handed over to ${H(hospitalId)}`, detail: dotJoin([ambulanceId && `${ambulanceId} released`]), tone: 'ok', icon: 'stethoscope', category: 'case', notable: true };
    case 'encounter.doctor.assigned': {
      const reason = str(p, 'reason');
      const reasonText: Record<string, string> = { INITIAL_ASSIGNMENT: 'First assignment', REASSIGNMENT: 'Reassigned', SHIFT_HANDOVER: 'Shift handover', SPECIALTY_REFERRAL: 'Specialty referral' };
      return patient
        ? { ...base, title: str(p, 'previousPractitionerId') ? 'Your doctor changed' : 'A doctor was assigned to your care', detail: reason ? reasonText[reason] : undefined, tone: 'ok', icon: 'user', category: 'case', notable: true }
        : { ...base, title: `Doctor ${str(p, 'previousPractitionerId') ? 'reassigned' : 'assigned'}${caseId ? ` · ${caseId}` : ''}`, detail: reason ? reasonText[reason] : undefined, tone: 'ok', icon: 'user', category: 'case', notable: true };
    }
    case 'destination.changed': {
      const dest = str(p, 'hospitalId');
      const reason = humanizeReason(str(p, 'reason'), name);
      if (dest === UNASSIGNED_DESTINATION) {
        return patient
          ? { ...base, title: 'Finding another hospital', detail: 'Your hospital can no longer take you. JIVA is asking others.', tone: 'warn', icon: 'clock', category: 'routing', notable: true }
          : { ...base, title: `${A} has no destination`, detail: reason, tone: 'danger', icon: 'alertTriangle', category: 'routing', notable: true };
      }
      return patient
        ? { ...base, title: `Going to ${H(dest)}`, detail: 'This hospital confirmed it can receive you.', tone: 'ok', icon: 'navigation', category: 'routing' }
        : { ...base, title: `${A} heading to ${H(dest)}`, detail: reason, tone: 'ok', icon: 'navigation', category: 'routing' };
    }
    case 'route.recalculated':
    case 'route.calculated': {
      const oldId = str(p, 'oldHospitalId');
      const newId = str(p, 'newHospitalId') || str(p, 'hospitalId');
      const min = minutesFromSeconds(num(p, 'durationSeconds'));
      const synthetic = p.synthetic === true;
      const routeFacts = dotJoin([formatKm(num(p, 'distanceMeters')), min !== undefined && `${min} min`, synthetic && 'synthetic route', p.trafficAware === false && 'no live traffic']);
      if (oldId) {
        return patient
          ? { ...base, title: 'Your destination changed', detail: `Now going to ${H(newId)} so you reach a hospital that can treat you now${min !== undefined ? ` · about ${min} min away` : ''}.`, tone: 'warn', icon: 'route', category: 'routing', notable: true }
          : { ...base, title: `Rerouted to ${H(newId)}`, detail: dotJoin([`From ${H(oldId)}`, routeFacts]), tone: 'warn', icon: 'route', category: 'routing', notable: true };
      }
      return patient
        ? { ...base, title: `Going to ${H(newId)}`, detail: `This hospital confirmed it can receive you${min !== undefined ? ` · about ${min} min away` : ''}`, tone: 'ok', icon: 'navigation', category: 'routing', notable: true }
        : { ...base, title: `Route to ${H(newId)}`, detail: routeFacts, tone: 'ok', icon: 'route', category: 'routing' };
    }
    case 'clinical.prescription.recorded': {
      // Content-free event: the medication itself is read from the records API by those allowed to see it.
      const action = str(p, 'action');
      const status = str(p, 'status');
      if (patient) {
        const title = action === 'DISCONTINUED' ? 'A medication was stopped' : action === 'AMENDED' ? 'A prescription was changed' : 'A new prescription was added';
        return { ...base, title, detail: 'See your prescriptions for details.', tone: action === 'DISCONTINUED' ? 'neutral' : 'ok', icon: 'pill', category: 'case', notable: true };
      }
      const verb = action === 'AUTHORISED' ? 'authorised' : action === 'CANCELLED' ? 'draft discarded' : action === 'DISCONTINUED' ? 'stopped'
        : status === 'DRAFT' ? (action === 'AMENDED' ? 'draft edited' : 'draft saved') : action === 'AMENDED' ? 'changed' : 'written and authorised';
      return {
        ...base, title: `Prescription ${verb}${caseId ? ` · ${caseId}` : ''}`,
        detail: dotJoin([`Version ${num(p, 'version') ?? '?'}`, status === 'DRAFT' && 'not in force, not visible to the patient']),
        tone: action === 'DISCONTINUED' || action === 'CANCELLED' ? 'neutral' : status === 'DRAFT' ? 'warn' : 'ok', icon: 'pill', category: 'case', notable: true,
      };
    }
    case 'clinical.note.recorded':
      return { ...base, title: `Clinical note ${num(p, 'version') === 1 ? 'written' : 'amended'}${caseId ? ` · ${caseId}` : ''}`, detail: dotJoin([str(p, 'noteType')?.toLowerCase(), 'internal to the care team']), tone: 'neutral', icon: 'file', category: 'case' };
    case 'clinical.prehospital.recorded': {
      const n = num(p, 'measurementCount') ?? 0;
      const missing = num(p, 'unavailableCount') ?? 0;
      const simulated = str(p, 'source') === 'DEVICE_SIMULATED';
      const facts = dotJoin([n > 0 && `${n} vital sign${n === 1 ? '' : 's'}`, missing > 0 && `${missing} not available`, p.narrative === true && 'symptom notes', simulated && 'simulated monitor (demo)']);
      return patient
        ? { ...base, title: 'The ambulance crew recorded your observations', detail: facts, tone: simulated ? 'warn' : 'ok', icon: 'ambulance', category: 'case', notable: !simulated }
        : { ...base, title: `Pre-hospital observations recorded${caseId ? ` · ${caseId}` : ''}`, detail: dotJoin([facts, `by ${A}`]), tone: simulated ? 'warn' : 'ok', icon: 'heart', category: 'case', notable: !simulated };
    }
    case 'clinical.report.recorded': {
      const first = num(p, 'version') === 1;
      return patient
        ? { ...base, title: first ? 'A new report is available' : 'A report was updated', detail: 'See your reports for details.', tone: 'ok', icon: 'file', category: 'case', notable: true }
        : { ...base, title: `Report ${first ? 'recorded' : 'updated'}${caseId ? ` · ${caseId}` : ''}`, detail: dotJoin([str(p, 'status')?.toLowerCase(), p.patientVisible === true ? 'shared with the patient' : 'not shared']), tone: 'ok', icon: 'file', category: 'case', notable: true };
    }
    case 'clinical.telemetry.recorded': {
      const simulated = str(p, 'source') === 'DEVICE_SIMULATED';
      const n = num(p, 'measurementCount') ?? 0;
      return patient
        ? { ...base, title: simulated ? 'Simulated vital signs added (demo)' : 'New vital signs recorded', detail: 'See your vital signs.', tone: simulated ? 'warn' : 'ok', icon: 'heart', category: 'case', notable: !simulated }
        : { ...base, title: `${n} vital sign${n === 1 ? '' : 's'} recorded${caseId ? ` · ${caseId}` : ''}`, detail: simulated ? 'Simulated monitor — demo data' : 'Entered by a clinician', tone: simulated ? 'warn' : 'ok', icon: 'heart', category: 'case' };
    }
    case 'clinical.document.stored': {
      const sample = str(p, 'origin') === 'CATALOGUE_SAMPLE';
      return patient
        ? { ...base, title: sample ? 'A sample document was added (demo)' : 'A document was added to your records', detail: sample ? 'A synthetic sample, not your own result.' : 'See your documents and scans.', tone: sample ? 'warn' : 'ok', icon: 'file', category: 'case', notable: true }
        : { ...base, title: `${sample ? 'Synthetic sample attached' : 'Document stored'}${caseId ? ` · ${caseId}` : ''}`, detail: dotJoin([str(p, 'documentType')?.toLowerCase().replace(/_/g, ' ') ?? str(p, 'category')?.toLowerCase(), str(p, 'supersedes') && 'new version', sample ? 'catalogue sample — not the patient’s result' : 'checksum and file type verified']), tone: sample ? 'warn' : 'ok', icon: 'file', category: 'case', notable: true };
    }
    case 'ai.handoff.generated':
      return { ...base, title: `Handoff brief${hospitalId ? ` for ${H(hospitalId)}` : ''}`, detail: str(p, 'summary'), tone: 'neutral', icon: 'brief', category: 'ai' };
    case 'ai.anomaly.explained':
      return { ...base, title: 'Disruption explained', detail: str(p, 'explanation'), tone: 'neutral', icon: 'brief', category: 'ai' };
    case 'ai.summary.generated':
      return { ...base, title: patient ? 'A summary of your journey is ready' : 'Case summary ready', detail: patient ? plainCapabilities(str(p, 'briefSummary') ?? '') || undefined : str(p, 'briefSummary'), tone: 'neutral', icon: 'brief', category: 'ai' };
    case 'feasibility.trace.recorded': {
      const outcome = str(p, 'outcome');
      return { ...base, title: 'Shadow engine evaluated hospitals', detail: dotJoin([outcome && outcome.toLowerCase().replace(/_/g, ' '), 'observation only, no decision authority']), tone: 'neutral', icon: 'shield', category: 'decision', quiet: true };
    }
    case 'demo.reset':
      return { ...base, title: 'Demo reset', detail: 'All demo state was cleared and re-seeded', tone: 'neutral', icon: 'refresh', category: 'system', notable: true };
    default:
      return { ...base, title: e.eventType, tone: 'neutral', icon: 'activity', category: 'system' };
  }
}
