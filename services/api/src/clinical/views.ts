import type { AuthContext } from '@jiva/auth';
import type { ActorRef, DiagnosticReport, HospitalEncounter, Prescription } from '@jiva/domain-models';
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

// ------------------------------------------------------------------ clinical records

/** Who is shown as the author of a record: the clinician's roster name, never a user id. */
export interface AuthorName {
  displayName: string;
  specialty?: string;
}

export type AuthorLookup = (actor: ActorRef) => AuthorName | undefined;

const authorOf = (lookup: AuthorLookup, actor: ActorRef): AuthorName => lookup(actor) ?? { displayName: actor.role === 'CLINICIAN' ? 'Clinician' : 'Hospital staff' };

/**
 * A prescription as a principal may see it.
 * CLINICIAN (assigned): the full record with every version, author names added.
 * PATIENT: the current medication and its status, who prescribed it and when — no staff ids, no internal
 * change reasons.
 */
export function projectPrescription(rx: Prescription, view: 'CLINICIAN' | 'PATIENT', lookup: AuthorLookup) {
  if (view === 'CLINICIAN') {
    return { ...rx, current: { ...rx.current, author: authorOf(lookup, rx.current.recordedBy) }, history: rx.history.map(v => ({ ...v, author: authorOf(lookup, v.recordedBy) })) };
  }
  const first = rx.history[0] ?? rx.current;
  const c = rx.current;
  return {
    prescriptionId: rx.prescriptionId,
    encounterId: rx.encounterId,
    medication: c.medication,
    ...(c.strength ? { strength: c.strength } : {}),
    dose: c.dose,
    route: c.route,
    frequency: c.frequency,
    ...(c.duration ? { duration: c.duration } : {}),
    ...(c.instructions ? { instructions: c.instructions } : {}),
    status: c.status,
    prescribedAt: first.recordedAt,
    prescribedBy: authorOf(lookup, first.recordedBy),
    updatedAt: c.recordedAt,
    changed: rx.history.some(v => v.action === 'AMENDED'),
    ...(c.status === 'DISCONTINUED' ? { discontinuedAt: c.recordedAt } : {}),
    version: c.version,
    dataStatus: rx.dataStatus,
  };
}

/**
 * A diagnostic report as a principal may see it. PATIENT: only a released report (the caller checks), its
 * current version, and only attachments released to the patient.
 */
export function projectReport(report: DiagnosticReport, view: 'CLINICIAN' | 'PATIENT', lookup: AuthorLookup, patientDocumentIds: (ids: string[]) => string[] = () => []) {
  if (view === 'CLINICIAN') {
    return { ...report, current: { ...report.current, author: authorOf(lookup, report.current.recordedBy) }, history: report.history.map(v => ({ ...v, author: authorOf(lookup, v.recordedBy) })) };
  }
  const first = report.history[0] ?? report.current;
  const c = report.current;
  return {
    reportId: report.reportId,
    encounterId: report.encounterId,
    category: c.category,
    title: c.title,
    ...(c.findings ? { findings: c.findings } : {}),
    ...(c.conclusion ? { conclusion: c.conclusion } : {}),
    effectiveAt: c.effectiveAt,
    status: c.status,
    reportedAt: first.recordedAt,
    reportedBy: authorOf(lookup, first.recordedBy),
    updatedAt: c.recordedAt,
    documentIds: patientDocumentIds(c.documentIds),
    version: c.version,
    dataStatus: report.dataStatus,
  };
}
