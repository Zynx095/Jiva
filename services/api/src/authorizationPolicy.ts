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
