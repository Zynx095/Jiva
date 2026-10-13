import { AuthContext } from '@jiva/auth';
import { AnyEvent } from '@jiva/event-schema';

/**
 * PURE submission policy (no stores, no engines): shared by the local API and the AWS ingestion
 * lambda so both enforce the same RBAC for event submission.
 */

export const isPrivileged = (auth: AuthContext) => auth.role === 'ADMIN' || auth.role === 'MANAGEMENT';

/** Event types an external client may submit. Everything else is system-generated only. */
export const EXTERNAL_EVENT_TYPES = new Set([
  'patient.emergency.created',
  'ambulance.dispatched',
  'ambulance.location.updated',
  'hospital.acceptance.received',
  'hospital.capacity.updated',
]);

/**
 * Audit/observability telemetry that only privileged principals may read (realtime and history).
 * Never externally submittable (not in EXTERNAL_EVENT_TYPES).
 */
export const PRIVILEGED_ONLY_EVENT_TYPES = new Set(['feasibility.trace.recorded']);

/**
 * Intake channel each principal may claim when it reports an emergency (provenance must match the
 * reporter: a crew cannot label its report as coming from dispatch, and vice versa).
 */
function intakeChannelFor(auth: AuthContext): 'AMBULANCE_CREW' | 'DISPATCH' | 'PATIENT_APP' | undefined {
  if (auth.role === 'AMBULANCE') return 'AMBULANCE_CREW';
  if (auth.role === 'PATIENT') return 'PATIENT_APP';
  if (isPrivileged(auth)) return 'DISPATCH';
  return undefined;
}

/** Returns null if allowed, otherwise a reason string. */
export function authorizeEventSubmission(auth: AuthContext, event: AnyEvent): string | null {
  if (!EXTERNAL_EVENT_TYPES.has(event.eventType)) {
    return `Event type ${event.eventType} is system-generated and cannot be submitted`;
  }
  const src = event.source;
  switch (event.eventType) {
    case 'patient.emergency.created': {
      const channel = event.payload.intake?.channel;
      if (channel && channel !== intakeChannelFor(auth)) return `Intake channel ${channel} does not match the reporting principal`;
      if (isPrivileged(auth)) return null;
      if (auth.role === 'PATIENT' && event.patientId && event.patientId === auth.caseId && src.type === 'patient') return null;
      // The crew attending a patient may report the emergency — only as its own unit (source bound to it).
      // It gains no other permission: it still cannot dispatch, answer for hospitals or touch clinical records.
      if (auth.role === 'AMBULANCE' && auth.ambulanceId && src.type === 'ambulance' && src.id === auth.ambulanceId) return null;
      if (auth.role === 'AMBULANCE') return 'An ambulance crew may only report an emergency as its own unit';
      return 'Only dispatch (MANAGEMENT/ADMIN), the attending ambulance crew or the patient themself may report this emergency';
    }
    case 'ambulance.dispatched':
      // A crew-reported assignment is derived by the intake engine from the crew's own emergency report.
      if (event.payload.assignmentBasis === 'REPORTED_BY_CREW') return 'Crew-reported assignments are system-generated';
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
