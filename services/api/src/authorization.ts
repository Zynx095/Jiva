import { AuthContext } from '@jiva/auth';
import { AnyEvent } from '@jiva/event-schema';
import { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import { ambulancesStore } from './stateStore';
import { relatedCasesForHospital } from './stateEngines';

/**
 * Server-side authorization policy. Single source of truth for REST reads,
 * event submission and realtime (Socket.IO) delivery.
 */

const isPrivileged = (auth: AuthContext) => auth.role === 'ADMIN' || auth.role === 'MANAGEMENT';

/** Event types an external client may submit. Everything else is system-generated only. */
export const EXTERNAL_EVENT_TYPES = new Set([
  'patient.emergency.created',
  'ambulance.dispatched',
  'ambulance.location.updated',
  'hospital.acceptance.received',
  'hospital.capacity.updated',
]);

/** Returns null if allowed, otherwise a reason string. */
export function authorizeEventSubmission(auth: AuthContext, event: AnyEvent): string | null {
  if (!EXTERNAL_EVENT_TYPES.has(event.eventType)) {
    return `Event type ${event.eventType} is system-generated and cannot be submitted`;
  }
  const src = event.source;
  switch (event.eventType) {
    case 'patient.emergency.created':
      if (isPrivileged(auth)) return null;
      if (auth.role === 'PATIENT' && event.patientId && event.patientId === auth.caseId && src.type === 'patient') return null;
      return 'Only management or the patient themself may report this emergency';
    case 'ambulance.dispatched':
      return isPrivileged(auth) ? null : 'Only dispatch (MANAGEMENT/ADMIN) may dispatch ambulances';
    case 'ambulance.location.updated': {
      const id = event.payload.ambulanceId;
      if (src.type !== 'ambulance' || src.id !== id) return 'Event source must be the reporting ambulance';
      if (auth.role === 'ADMIN' || (auth.role === 'AMBULANCE' && auth.ambulanceId === id)) return null;
      return 'Only the ambulance itself may report its location';
    }
    case 'hospital.acceptance.received':
    case 'hospital.capacity.updated': {
      const id = event.payload.hospitalId;
      if (src.type !== 'hospital' || src.id !== id) return 'Event source must be the responding hospital';
      if (auth.role === 'ADMIN' || (auth.role === 'HOSPITAL' && auth.hospitalId === id)) return null;
      return 'A hospital may only report on its own facility';
    }
    default:
      return 'Forbidden';
  }
}

function ambulanceCase(ambulanceId?: string): string | undefined {
  return ambulanceId ? ambulancesStore.get(ambulanceId)?.assignedPatient : undefined;
}

/** Cases this principal is operationally related to (for non-privileged roles). */
export function relatedCases(auth: AuthContext): Set<string> {
  if (auth.role === 'PATIENT') return new Set(auth.caseId ? [auth.caseId] : []);
  if (auth.role === 'AMBULANCE') {
    const c = ambulanceCase(auth.ambulanceId);
    return new Set(c ? [c] : []);
  }
  if (auth.role === 'HOSPITAL' && auth.hospitalId) return relatedCasesForHospital(auth.hospitalId);
  return new Set();
}

export function canReadCase(auth: AuthContext, caseId: string): boolean {
  return isPrivileged(auth) || relatedCases(auth).has(caseId);
}

export function filterPatients(auth: AuthContext, patients: PatientState[]): PatientState[] {
  if (isPrivileged(auth)) return patients;
  const cases = relatedCases(auth);
  return patients.filter(p => cases.has(p.patientId));
}

export function filterAmbulances(auth: AuthContext, ambulances: AmbulanceState[]): AmbulanceState[] {
  if (isPrivileged(auth)) return ambulances;
  if (auth.role === 'AMBULANCE') return ambulances.filter(a => a.ambulanceId === auth.ambulanceId);
  if (auth.role === 'PATIENT') return ambulances.filter(a => !!a.assignedPatient && a.assignedPatient === auth.caseId);
  if (auth.role === 'HOSPITAL') return ambulances.filter(a => a.destinationHospital === auth.hospitalId);
  return [];
}

/** Hospital directory/operational status is shared; the case an acceptance refers to is not. */
export function sanitizeHospitals(auth: AuthContext, hospitals: HospitalState[]): HospitalState[] {
  if (isPrivileged(auth)) return hospitals;
  const cases = relatedCases(auth);
  return hospitals.map(h => {
    const caseId = h.operationalState.acceptanceCaseId;
    if (!caseId || cases.has(caseId)) return h;
    return { ...h, operationalState: { ...h.operationalState, acceptanceCaseId: undefined } };
  });
}

const PATIENT_VISIBLE = new Set([
  'patient.emergency.created',
  'ambulance.dispatched',
  'ambulance.location.updated',
  'ambulance.arrived',
  'destination.changed',
  'route.recalculated',
  'ai.summary.generated',
]);

function eventCase(event: any): string | undefined {
  return event.patientId || event.payload?.caseId || event.payload?.patientId || ambulanceCase(event.payload?.ambulanceId);
}

/** Realtime delivery filter: may this principal receive this event? */
export function canReceiveEvent(auth: AuthContext, event: AnyEvent): boolean {
  if (event.eventType === 'demo.reset') return true;
  if (isPrivileged(auth)) return true;
  const p: any = (event as any).payload || {};
  const caseId = eventCase(event);

  if (auth.role === 'PATIENT') {
    return PATIENT_VISIBLE.has(event.eventType) && !!caseId && caseId === auth.caseId;
  }
  if (auth.role === 'AMBULANCE') {
    if (p.ambulanceId && p.ambulanceId === auth.ambulanceId) return true;
    if (event.eventType === 'hospital.capacity.updated' || event.eventType === 'hospital.acceptance.expired') return true;
    const own = ambulanceCase(auth.ambulanceId);
    return !!own && caseId === own && !event.eventType.startsWith('ai.summary');
  }
  if (auth.role === 'HOSPITAL') {
    const h = auth.hospitalId;
    if (event.eventType === 'hospital.candidate.generated') return false; // contains other hospitals' evaluation
    if (event.eventType === 'ai.handoff.generated') return p.hospitalId === h;
    if (event.eventType.startsWith('ai.')) return false;
    return p.hospitalId === h || p.newHospitalId === h || p.oldHospitalId === h;
  }
  return false;
}
