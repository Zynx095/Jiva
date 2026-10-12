import type { AuthContext } from '@jiva/auth';
import type { HospitalEncounter } from '@jiva/domain-models';
import type { EncounterView } from './policy';
import { evidenceEnvironment } from '../evidenceTrust';

/**
 * Provenance of a record created by `auth`, derived from the principal (never from the request body):
 * demo personas → SYNTHETIC_DEMO (UNVERIFIED outside demo mode); real hospital staff → HOSPITAL_CONFIRMED.
 */
export function recordProvenance(auth: AuthContext): 'SYNTHETIC_DEMO' | 'HOSPITAL_CONFIRMED' | 'UNVERIFIED' {
  if (auth.isDemo) return evidenceEnvironment() === 'DEMO' ? 'SYNTHETIC_DEMO' : 'UNVERIFIED';
  return auth.role === 'HOSPITAL' || auth.role === 'CLINICIAN' ? 'HOSPITAL_CONFIRMED' : 'UNVERIFIED';
}

/** An encounter as one principal may see it. Staff user ids are internal and never shown to patients. */
export function projectEncounter(enc: HospitalEncounter, view: EncounterView, hospitalName?: string) {
  const summary = {
    encounterId: enc.encounterId,
    caseId: enc.caseId,
    hospitalId: enc.hospitalId,
    ...(hospitalName ? { hospitalName } : {}),
    status: enc.status,
    arrivedAt: enc.arrival.arrivedAt,
    ...(enc.handover ? { handedOverAt: enc.handover.handedOverAt } : {}),
    ...(enc.ambulanceId ? { ambulanceId: enc.ambulanceId } : {}),
    dataStatus: enc.dataStatus,
  };
  if (view === 'SUMMARY') return summary;
  if (view === 'PATIENT') {
    return {
      ...summary,
      ...(enc.assignedDoctor ? { assignedDoctor: { displayName: enc.assignedDoctor.displayName, specialty: enc.assignedDoctor.specialty, assignedAt: enc.assignedDoctor.assignedAt } } : {}),
    };
  }
  return { ...enc, ...(hospitalName ? { hospitalName } : {}) };
}
