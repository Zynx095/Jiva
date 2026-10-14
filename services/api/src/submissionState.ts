import type { AnyEvent } from '@jiva/event-schema';
import type { AmbulanceState, PatientState } from '@jiva/domain-models';

/**
 * State preconditions for externally submitted operational events (POST /api/events and the AWS
 * ingestion lambda), shared so both answer the same way. Without them the state engines silently ignore
 * a second emergency for an open case, and a dispatch of a unit that is attending another patient
 * reassigns it, leaving that patient with no ambulance while still shown as in transit.
 *
 * A retry of an event that was already applied is not a conflict: it passes and is answered as a
 * duplicate by the ledger.
 */
export interface SubmissionFacts {
  patient: (caseId: string) => PatientState | undefined | Promise<PatientState | undefined>;
  ambulance: (ambulanceId: string) => AmbulanceState | undefined | Promise<AmbulanceState | undefined>;
}

export type SubmissionVerdict = { ok: true } | { ok: false; status: 409; error: string; message: string };

const OK: SubmissionVerdict = { ok: true };

export async function checkSubmissionState(event: AnyEvent, facts: SubmissionFacts): Promise<SubmissionVerdict> {
  if (event.eventType === 'patient.emergency.created' && event.patientId) {
    const existing = await facts.patient(event.patientId);
    const retry = existing?.provenance.some(p => p.eventId === event.eventId);
    if (existing && existing.currentStatus !== 'DISCHARGED' && !retry) {
      return { ok: false, status: 409, error: 'case_exists', message: `${event.patientId} is already an open case.` };
    }
  }
  if (event.eventType === 'ambulance.dispatched') {
    const { ambulanceId, caseId } = event.payload;
    const amb = await facts.ambulance(ambulanceId);
    if (amb?.status === 'UNAVAILABLE') {
      return { ok: false, status: 409, error: 'ambulance_unavailable', message: `${ambulanceId} is out of service.` };
    }
    if (caseId && amb?.assignedPatient && amb.assignedPatient !== caseId && amb.status !== 'AVAILABLE') {
      return { ok: false, status: 409, error: 'ambulance_busy', message: `${ambulanceId} is attending ${amb.assignedPatient}. Complete that handover before dispatching it to another case.` };
    }
  }
  return OK;
}
