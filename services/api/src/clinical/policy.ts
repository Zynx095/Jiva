import type { AuthContext } from '@jiva/auth';
import type { ActorRef, EncounterStatus } from '@jiva/domain-models';
import { CLINICAL_RECORD_EVENT_TYPES, ENCOUNTER_EVENT_TYPES, PREHOSPITAL_EVENT_TYPES } from '@jiva/event-schema';

/**
 * PURE authorization policy for encounters and clinical records (no stores, no I/O), so it can be unit
 * tested exhaustively and reused by a future AWS handler. The API enforces every decision here on the
 * backend; frontends only mirror it to hide controls.
 *
 * Separation of duties:
 *   HOSPITAL (coordinator) — arrival, handover, doctor assignment and encounter metadata at its own hospital.
 *                            No access to clinical content.
 *   CLINICIAN              — clinical records (prescriptions, reports, documents, measurements) only for
 *                            encounters assigned to them at their own hospital. Other encounters at the same
 *                            hospital are invisible to them.
 *   PATIENT                — reads their own case's encounter and the records released to them. Never writes
 *                            clinician-authored records.
 *   AMBULANCE              — an encounter summary for its own case (to see that the handover happened).
 *   MANAGEMENT / ADMIN     — encounter summaries for coordination. No clinical content. ADMIN reads the audit log.
 *
 * Unrelated principals get 404 (existence is not revealed); related principals lacking the permission get 403.
 */

export type Decision =
  | { allowed: true }
  | { allowed: false; status: 403 | 404; code: string; reason: string };

/** The facts about an encounter that authorization depends on. */
export interface EncounterFacts {
  encounterId: string;
  caseId: string;
  hospitalId: string;
  status: EncounterStatus;
  assignedPractitionerId?: string;
}

export type EncounterAction =
  | 'encounter.read'
  | 'handover.record'
  | 'doctor.assign'
  | 'prescription.write'
  | 'prescription.read'
  | 'report.write'
  | 'report.read'
  | 'note.write'
  | 'note.read'
  | 'document.write'
  | 'document.read'
  | 'telemetry.write'
  | 'telemetry.read';

/** How much of an encounter a principal may see. */
export type EncounterView = 'FULL' | 'PATIENT' | 'SUMMARY';

const ALLOW: Decision = { allowed: true };
const notFound = (code = 'NOT_FOUND'): Decision => ({ allowed: false, status: 404, code, reason: 'Not found' });
const forbidden = (code: string, reason: string): Decision => ({ allowed: false, status: 403, code, reason });

const isPrivileged = (auth: AuthContext) => auth.role === 'ADMIN' || auth.role === 'MANAGEMENT';
const sameHospital = (auth: AuthContext, hospitalId: string) => !!auth.hospitalId && auth.hospitalId === hospitalId;

export const isAssignedClinician = (auth: AuthContext, enc: Pick<EncounterFacts, 'hospitalId' | 'assignedPractitionerId'>) =>
  auth.role === 'CLINICIAN' && sameHospital(auth, enc.hospitalId) && !!auth.practitionerId && enc.assignedPractitionerId === auth.practitionerId;

const isOwnPatient = (auth: AuthContext, caseId: string) => auth.role === 'PATIENT' && !!auth.caseId && auth.caseId === caseId;

/**
 * Is the principal related to this encounter at all? Unrelated principals must not learn it exists.
 * A clinician is related only through an assignment; the ambulance through its own case.
 */
function isRelated(auth: AuthContext, enc: EncounterFacts, ambulanceCaseId?: string): boolean {
  switch (auth.role) {
    case 'PATIENT': return isOwnPatient(auth, enc.caseId);
    case 'HOSPITAL': return sameHospital(auth, enc.hospitalId);
    case 'CLINICIAN': return isAssignedClinician(auth, enc);
    case 'AMBULANCE': return !!ambulanceCaseId && ambulanceCaseId === enc.caseId;
    case 'MANAGEMENT':
    case 'ADMIN': return true;
    default: return false;
  }
}

/** Which projection of the encounter the principal may read (undefined: none). */
export function encounterViewFor(auth: AuthContext, enc: EncounterFacts, ambulanceCaseId?: string): EncounterView | undefined {
  if (!isRelated(auth, enc, ambulanceCaseId)) return undefined;
  if (auth.role === 'HOSPITAL' || auth.role === 'CLINICIAN') return 'FULL';
  if (auth.role === 'PATIENT') return 'PATIENT';
  return 'SUMMARY';
}

/**
 * Decide whether `auth` may perform `action` on the encounter. State preconditions (e.g. "handed over")
 * are checked separately by the command handlers and answered with 409.
 *
 * `opts.patientVisible` applies to record reads: a patient never sees an unreleased record (404).
 * `opts.ambulanceCaseId` is the case the calling ambulance is assigned to, if any.
 */
export function authorizeEncounterAction(
  auth: AuthContext,
  enc: EncounterFacts,
  action: EncounterAction,
  opts: { patientVisible?: boolean; ambulanceCaseId?: string } = {},
): Decision {
  if (!isRelated(auth, enc, opts.ambulanceCaseId)) return notFound();

  switch (action) {
    case 'encounter.read':
      return ALLOW;

    case 'handover.record':
    case 'doctor.assign':
      return auth.role === 'HOSPITAL' ? ALLOW : forbidden('HOSPITAL_STAFF_ONLY', 'Only hospital coordination staff at this hospital may do this');

    case 'prescription.write':
    case 'report.write':
    case 'note.write':
    case 'document.write':
    case 'telemetry.write':
      if (isAssignedClinician(auth, enc)) return ALLOW;
      if (auth.role === 'PATIENT') return forbidden('READ_ONLY', 'Patients cannot create or change clinical records');
      return forbidden('ASSIGNED_CLINICIAN_ONLY', 'Only the clinician assigned to this encounter may record clinical information');

    case 'prescription.read':
    case 'telemetry.read':
      if (isAssignedClinician(auth, enc) || isOwnPatient(auth, enc.caseId)) return ALLOW;
      return forbidden('NO_CLINICAL_ACCESS', 'This role has no access to clinical records');

    case 'report.read':
    case 'document.read':
      if (isAssignedClinician(auth, enc)) return ALLOW;
      if (isOwnPatient(auth, enc.caseId)) return opts.patientVisible === false ? notFound('NOT_RELEASED') : ALLOW;
      return forbidden('NO_CLINICAL_ACCESS', 'This role has no access to clinical records');

    case 'note.read':
      // Clinical notes are internal to the care team: never released to the patient.
      if (isAssignedClinician(auth, enc)) return ALLOW;
      if (isOwnPatient(auth, enc.caseId)) return forbidden('INTERNAL_NOTES', 'Clinical notes are internal to the care team');
      return forbidden('NO_CLINICAL_ACCESS', 'This role has no access to clinical records');

    default:
      return forbidden('UNKNOWN_ACTION', 'Unknown action');
  }
}

/** The facts the pre-hospital record's authorization depends on. */
export interface PrehospitalFacts {
  caseId: string;
  /** The ambulance currently assigned to (attending) the case, if any. */
  attendingAmbulanceId?: string;
  /** The case's encounters (a clinician is related through an assignment to one of them). */
  encounters: EncounterFacts[];
}

export type PrehospitalAction = 'prehospital.write' | 'prehospital.read';

/**
 * Pre-hospital record of a case: written only by the crew attending the case (until the handover releases
 * it); read by that crew, the clinician assigned to the case's encounter and the patient. Coordinators,
 * network coordination and administrators are related but have no clinical access (403); everyone else
 * gets 404.
 */
export function authorizePrehospitalAction(auth: AuthContext, facts: PrehospitalFacts, action: PrehospitalAction): Decision {
  const crew = auth.role === 'AMBULANCE' && !!auth.ambulanceId && auth.ambulanceId === facts.attendingAmbulanceId;
  const clinician = facts.encounters.some(e => isAssignedClinician(auth, e));
  const patient = isOwnPatient(auth, facts.caseId);
  const coordinator = auth.role === 'HOSPITAL' && facts.encounters.some(e => sameHospital(auth, e.hospitalId));
  if (!crew && !clinician && !patient && !coordinator && !isPrivileged(auth)) return notFound();
  if (action === 'prehospital.write') {
    return crew ? ALLOW : forbidden('ATTENDING_CREW_ONLY', 'Only the ambulance crew attending this patient records pre-hospital observations');
  }
  return crew || clinician || patient ? ALLOW : forbidden('NO_CLINICAL_ACCESS', 'This role has no access to clinical records');
}

/** Recording an arrival happens before an encounter exists: hospital coordination staff of that hospital only. */
export function authorizeArrivalRecording(auth: AuthContext, hospitalId: string): Decision {
  if (auth.role === 'HOSPITAL' && sameHospital(auth, hospitalId)) return ALLOW;
  if (auth.role === 'HOSPITAL') return forbidden('OTHER_HOSPITAL', 'A hospital may only record arrivals at its own facility');
  return forbidden('HOSPITAL_STAFF_ONLY', 'Only hospital coordination staff may record an arrival');
}

/** The staff roster of a hospital (doctor assignment). */
export function authorizeRosterRead(auth: AuthContext, hospitalId: string): Decision {
  if ((auth.role === 'HOSPITAL' || auth.role === 'CLINICIAN') && sameHospital(auth, hospitalId)) return ALLOW;
  return forbidden('HOSPITAL_STAFF_ONLY', 'Only staff of this hospital may read its roster');
}

/** Audit log: who did what. Platform administrators only. */
export function authorizeAuditRead(auth: AuthContext): Decision {
  return auth.role === 'ADMIN' ? ALLOW : forbidden('ADMIN_ONLY', 'Only administrators may read the audit log');
}

// ------------------------------------------------------------------ realtime / ledger delivery

// Derived from the event contracts, so a new clinical event type cannot be missed by the delivery rules.
export const ENCOUNTER_ASSIGNMENT_EVENTS = new Set<string>(['encounter.doctor.assigned']);
export const ENCOUNTER_LIFECYCLE_EVENTS = new Set<string>(ENCOUNTER_EVENT_TYPES.filter(t => !ENCOUNTER_ASSIGNMENT_EVENTS.has(t)));
export const CLINICAL_RECORD_EVENTS = new Set<string>(CLINICAL_RECORD_EVENT_TYPES);
export const PREHOSPITAL_EVENTS = new Set<string>(PREHOSPITAL_EVENT_TYPES);

/** Event types whose delivery is decided by `canReceiveClinicalDomainEvent`. */
export const isClinicalDomainEvent = (eventType: string) =>
  ENCOUNTER_LIFECYCLE_EVENTS.has(eventType) || ENCOUNTER_ASSIGNMENT_EVENTS.has(eventType) || CLINICAL_RECORD_EVENTS.has(eventType) || PREHOSPITAL_EVENTS.has(eventType);

interface DomainEventLike {
  eventType: string;
  payload: {
    encounterId?: unknown;
    caseId?: unknown;
    hospitalId?: unknown;
    ambulanceId?: unknown;
    practitionerId?: unknown;
    previousPractitionerId?: unknown;
    patientVisible?: unknown;
  };
}

/** The case's encounters, for events that are linked to a case only (pre-hospital record). */
export type CaseEncounterLookup = (caseId: string) => EncounterFacts[];

/**
 * Realtime and ledger delivery for encounter and clinical events. Default deny.
 *  - clinical.*: the patient (released records only) and the assigned clinician. Nobody else — not
 *    management, not admin, not the hospital coordinator — even though the events carry no content.
 *  - encounter.doctor.assigned: the patient, the hospital, and the clinicians it concerns.
 *  - arrival / handover: the patient, the ambulance that brought them, the hospital, the assigned
 *    clinician and network coordination (management/admin).
 */
export function canReceiveClinicalDomainEvent(
  auth: AuthContext,
  event: DomainEventLike,
  lookup: (encounterId: string) => EncounterFacts | undefined,
  caseEncounters: CaseEncounterLookup = () => [],
): boolean {
  const p = event.payload || {};
  const caseId = typeof p.caseId === 'string' ? p.caseId : undefined;
  // Pre-hospital record: the crew that recorded it, the patient, and the clinician assigned to the case's
  // encounter. Nobody else — not management, not the coordinator — even though the event has no content.
  if (PREHOSPITAL_EVENTS.has(event.eventType)) {
    if (!caseId) return false;
    if (auth.role === 'AMBULANCE') return !!auth.ambulanceId && p.ambulanceId === auth.ambulanceId;
    if (isOwnPatient(auth, caseId)) return true;
    return auth.role === 'CLINICIAN' && caseEncounters(caseId).some(e => isAssignedClinician(auth, e));
  }
  const hospitalId = typeof p.hospitalId === 'string' ? p.hospitalId : undefined;
  const encounterId = typeof p.encounterId === 'string' ? p.encounterId : undefined;
  if (!caseId || !hospitalId || !encounterId) return false;
  const enc = lookup(encounterId);
  const assigned = !!enc && enc.hospitalId === hospitalId && isAssignedClinician(auth, enc);

  if (CLINICAL_RECORD_EVENTS.has(event.eventType)) {
    if (isOwnPatient(auth, caseId)) return p.patientVisible === true;
    return assigned;
  }
  if (ENCOUNTER_ASSIGNMENT_EVENTS.has(event.eventType)) {
    if (isOwnPatient(auth, caseId)) return true;
    if (auth.role === 'HOSPITAL') return sameHospital(auth, hospitalId);
    if (auth.role === 'CLINICIAN') {
      return sameHospital(auth, hospitalId) && !!auth.practitionerId &&
        (p.practitionerId === auth.practitionerId || p.previousPractitionerId === auth.practitionerId);
    }
    return false;
  }
  if (ENCOUNTER_LIFECYCLE_EVENTS.has(event.eventType)) {
    if (isPrivileged(auth)) return true;
    if (isOwnPatient(auth, caseId)) return true;
    if (auth.role === 'HOSPITAL') return sameHospital(auth, hospitalId);
    if (auth.role === 'AMBULANCE') return !!auth.ambulanceId && p.ambulanceId === auth.ambulanceId;
    if (auth.role === 'CLINICIAN') return assigned;
    return false;
  }
  return false;
}

/** The actor recorded on events and records: identity comes only from the authenticated principal. */
export function actorFromAuth(auth: AuthContext): ActorRef {
  const actor: ActorRef = { userId: auth.userId, role: auth.role };
  if (auth.hospitalId) actor.hospitalId = auth.hospitalId;
  if (auth.practitionerId) actor.practitionerId = auth.practitionerId;
  if (auth.ambulanceId) actor.ambulanceId = auth.ambulanceId;
  return actor;
}
