import { createHash } from 'crypto';
import type {
  ActorRef,
  DataStatus,
  DiagnosticReport,
  Prescription,
  PrescriptionContent,
  PrescriptionStatus,
  PrescriptionVersion,
  ReportContent,
  ReportStatus,
  ReportVersion,
} from '@jiva/domain-models';
import { canonicalJson } from '@jiva/feasibility';

/**
 * Clinical records (Phase 7): prescriptions and diagnostic reports as PURE, versioned, append-only
 * records. Every change is a new version that keeps who, when and why; nothing is edited in place.
 *
 * Version rules
 *  - Prescriptions: CREATED (ACTIVE) → AMENDED (content changed, still ACTIVE) → DISCONTINUED (final).
 *    A discontinued prescription is never changed again; a new one is written instead.
 *  - Reports: PRELIMINARY → PRELIMINARY | FINAL. A FINAL report whose clinical content changes becomes
 *    AMENDED; it can never return to PRELIMINARY. Changing only the release to the patient keeps the
 *    clinical status (a released final report is not "amended" for the patient).
 *  - Every change names the version it was based on (`expectedVersion`): a stale edit is refused (409),
 *    so two clinicians cannot silently overwrite each other.
 *  - `contentHash` = sha256 of the canonical JSON of the version's content and status; the canonical
 *    event carries the hash, never the content.
 */

export type RecordResult<T> = { ok: true; record: T } | { ok: false; status: 409 | 422; code: string; message: string };

const sha256 = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const fail = <T>(status: 409 | 422, code: string, message: string): RecordResult<T> => ({ ok: false, status, code, message });

/** Who/when/where of one recorded change (from the authenticated principal and the server clock). */
export interface RecordMeta {
  encounterId: string;
  caseId: string;
  hospitalId: string;
  actor: ActorRef;
  at: string;
  eventId: string;
  dataStatus: DataStatus;
}

// ------------------------------------------------------------------ prescriptions

/** The content fields only, without empty optionals, in a stable shape (hashing and comparison). */
export function prescriptionContent(c: PrescriptionContent): PrescriptionContent {
  return {
    medication: c.medication,
    ...(c.strength ? { strength: c.strength } : {}),
    dose: c.dose,
    route: c.route,
    frequency: c.frequency,
    ...(c.duration ? { duration: c.duration } : {}),
    ...(c.instructions ? { instructions: c.instructions } : {}),
  };
}

export const prescriptionHash = (c: PrescriptionContent, status: PrescriptionStatus) => sha256({ ...prescriptionContent(c), status });

function prescriptionVersion(
  content: PrescriptionContent, status: PrescriptionStatus, version: number, action: PrescriptionVersion['action'], meta: RecordMeta, changeReason?: string,
): PrescriptionVersion {
  return {
    ...prescriptionContent(content),
    version,
    status,
    recordedAt: meta.at,
    recordedBy: meta.actor,
    action,
    ...(changeReason ? { changeReason } : {}),
    contentHash: prescriptionHash(content, status),
    eventId: meta.eventId,
  };
}

export function createPrescription(prescriptionId: string, content: PrescriptionContent, meta: RecordMeta): Prescription {
  const v1 = prescriptionVersion(content, 'ACTIVE', 1, 'CREATED', meta);
  return { prescriptionId, encounterId: meta.encounterId, caseId: meta.caseId, hospitalId: meta.hospitalId, current: v1, history: [v1], dataStatus: meta.dataStatus };
}

function checkVersion<T>(current: number, expected: number): RecordResult<T> | undefined {
  return current === expected ? undefined : fail(409, 'version_conflict', `This record changed meanwhile (now version ${current}, you edited version ${expected}). Reload it and apply your change again.`);
}

export function amendPrescription(rx: Prescription, expectedVersion: number, content: PrescriptionContent, changeReason: string, meta: RecordMeta): RecordResult<Prescription> {
  const stale = checkVersion<Prescription>(rx.current.version, expectedVersion);
  if (stale) return stale;
  if (rx.current.status !== 'ACTIVE') return fail(409, 'discontinued', 'A discontinued prescription cannot be changed. Write a new prescription instead.');
  if (prescriptionHash(content, 'ACTIVE') === rx.current.contentHash) return fail(422, 'no_change', 'Nothing was changed.');
  const next = prescriptionVersion(content, 'ACTIVE', rx.current.version + 1, 'AMENDED', meta, changeReason);
  return { ok: true, record: { ...rx, current: next, history: [...rx.history, next] } };
}

export function discontinuePrescription(rx: Prescription, expectedVersion: number, changeReason: string, meta: RecordMeta): RecordResult<Prescription> {
  const stale = checkVersion<Prescription>(rx.current.version, expectedVersion);
  if (stale) return stale;
  if (rx.current.status !== 'ACTIVE') return fail(409, 'already_discontinued', 'This prescription is already discontinued.');
  const next = prescriptionVersion(rx.current, 'DISCONTINUED', rx.current.version + 1, 'DISCONTINUED', meta, changeReason);
  return { ok: true, record: { ...rx, current: next, history: [...rx.history, next] } };
}

// ------------------------------------------------------------------ diagnostic reports

export function reportContent(c: ReportContent): ReportContent {
  return {
    category: c.category,
    title: c.title,
    ...(c.findings ? { findings: c.findings } : {}),
    ...(c.conclusion ? { conclusion: c.conclusion } : {}),
    effectiveAt: c.effectiveAt,
    documentIds: [...c.documentIds],
    patientVisible: c.patientVisible,
  };
}

/** The clinical content alone (without the release flag): what makes a final report "amended". */
const clinicalHash = (c: ReportContent) => {
  const { patientVisible: _released, ...clinical } = reportContent(c);
  return sha256(clinical);
};

export const reportHash = (c: ReportContent, status: ReportStatus) => sha256({ ...reportContent(c), status });

function reportVersion(content: ReportContent, status: ReportStatus, version: number, action: ReportVersion['action'], meta: RecordMeta, changeReason?: string): ReportVersion {
  return {
    ...reportContent(content),
    version,
    status,
    recordedAt: meta.at,
    recordedBy: meta.actor,
    action,
    ...(changeReason ? { changeReason } : {}),
    contentHash: reportHash(content, status),
    eventId: meta.eventId,
  };
}

export function createReport(reportId: string, content: ReportContent, status: 'PRELIMINARY' | 'FINAL', meta: RecordMeta): DiagnosticReport {
  const v1 = reportVersion(content, status, 1, 'CREATED', meta);
  return { reportId, encounterId: meta.encounterId, caseId: meta.caseId, hospitalId: meta.hospitalId, current: v1, history: [v1], dataStatus: meta.dataStatus };
}

export function amendReport(
  report: DiagnosticReport, expectedVersion: number, content: ReportContent, requested: 'PRELIMINARY' | 'FINAL', changeReason: string, meta: RecordMeta,
): RecordResult<DiagnosticReport> {
  const stale = checkVersion<DiagnosticReport>(report.current.version, expectedVersion);
  if (stale) return stale;
  const wasFinal = report.current.status === 'FINAL' || report.current.status === 'AMENDED';
  if (wasFinal && requested === 'PRELIMINARY') return fail(409, 'final_report', 'A final report cannot go back to preliminary. Amend it instead.');
  const clinicalChanged = clinicalHash(content) !== clinicalHash(report.current);
  const releaseChanged = content.patientVisible !== report.current.patientVisible;
  const status: ReportStatus = wasFinal ? (clinicalChanged ? 'AMENDED' : report.current.status) : requested;
  if (!clinicalChanged && !releaseChanged && status === report.current.status) return fail(422, 'no_change', 'Nothing was changed.');
  const next = reportVersion(content, status, report.current.version + 1, 'AMENDED', meta, changeReason);
  return { ok: true, record: { ...report, current: next, history: [...report.history, next] } };
}
