import { createHash } from 'crypto';
import type {
  ActorRef,
  ClinicalNote,
  ClinicalNoteContent,
  ClinicalNoteVersion,
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
 *    Drafts: CREATED (DRAFT) → AMENDED (still DRAFT) → AUTHORISED (ACTIVE, by the clinician's explicit
 *    authorisation of exactly the version they reviewed) or CANCELLED (discarded, final). A draft is never
 *    in force and never shown to the patient; nothing authorises a draft automatically.
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
    ...(c.formulation ? { formulation: c.formulation } : {}),
    dose: c.dose,
    route: c.route,
    frequency: c.frequency,
    ...(c.duration ? { duration: c.duration } : {}),
    ...(c.instructions ? { instructions: c.instructions } : {}),
    ...(c.catalogueRef ? { catalogueRef: { medicationId: c.catalogueRef.medicationId, revision: c.catalogueRef.revision, catalogueVersion: c.catalogueRef.catalogueVersion } } : {}),
  };
}

/** Has this prescription ever been in force? Drafts and discarded drafts have not (the patient never sees them). */
export const everAuthorised = (rx: Prescription) => rx.history.some(v => v.status === 'ACTIVE');

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

const authorisationOf = (v: PrescriptionVersion) => ({ authorisedAt: v.recordedAt, authorisedBy: v.recordedBy, version: v.version });

/** Written and authorised in one explicit action (ACTIVE), or saved as a draft that is not in force. */
export function createPrescription(prescriptionId: string, content: PrescriptionContent, meta: RecordMeta, opts: { draft?: boolean } = {}): Prescription {
  const v1 = prescriptionVersion(content, opts.draft ? 'DRAFT' : 'ACTIVE', 1, 'CREATED', meta);
  return {
    prescriptionId, encounterId: meta.encounterId, caseId: meta.caseId, hospitalId: meta.hospitalId, current: v1, history: [v1],
    ...(opts.draft ? {} : { authorisation: authorisationOf(v1) }),
    dataStatus: meta.dataStatus,
  };
}

function checkVersion<T>(current: number, expected: number): RecordResult<T> | undefined {
  return current === expected ? undefined : fail(409, 'version_conflict', `This record changed meanwhile (now version ${current}, you edited version ${expected}). Reload it and apply your change again.`);
}

/** Change the content. A draft stays a draft; an amended ACTIVE prescription is authorised by the amending clinician. */
export function amendPrescription(rx: Prescription, expectedVersion: number, content: PrescriptionContent, changeReason: string, meta: RecordMeta): RecordResult<Prescription> {
  const stale = checkVersion<Prescription>(rx.current.version, expectedVersion);
  if (stale) return stale;
  const status = rx.current.status;
  if (status === 'DISCONTINUED') return fail(409, 'discontinued', 'A discontinued prescription cannot be changed. Write a new prescription instead.');
  if (status === 'CANCELLED') return fail(409, 'cancelled', 'A discarded draft cannot be changed. Write a new prescription instead.');
  if (prescriptionHash(content, status) === rx.current.contentHash) return fail(422, 'no_change', 'Nothing was changed.');
  const next = prescriptionVersion(content, status, rx.current.version + 1, 'AMENDED', meta, changeReason);
  return { ok: true, record: { ...rx, current: next, history: [...rx.history, next], ...(status === 'ACTIVE' ? { authorisation: authorisationOf(next) } : {}) } };
}

/**
 * The clinician's explicit authorisation of a draft: the version they reviewed becomes ACTIVE, unchanged.
 * Only a draft can be authorised; a stale version is refused like any other edit.
 */
export function authorisePrescription(rx: Prescription, expectedVersion: number, meta: RecordMeta): RecordResult<Prescription> {
  const stale = checkVersion<Prescription>(rx.current.version, expectedVersion);
  if (stale) return stale;
  if (rx.current.status !== 'DRAFT') return fail(409, 'not_a_draft', rx.current.status === 'ACTIVE' ? 'This prescription is already authorised.' : 'Only a draft can be authorised.');
  const next = prescriptionVersion(rx.current, 'ACTIVE', rx.current.version + 1, 'AUTHORISED', meta);
  return { ok: true, record: { ...rx, current: next, history: [...rx.history, next], authorisation: authorisationOf(next) } };
}

/** Discard a draft that was never authorised (final). */
export function discardPrescriptionDraft(rx: Prescription, expectedVersion: number, changeReason: string, meta: RecordMeta): RecordResult<Prescription> {
  const stale = checkVersion<Prescription>(rx.current.version, expectedVersion);
  if (stale) return stale;
  if (rx.current.status !== 'DRAFT') return fail(409, 'not_a_draft', 'Only a draft can be discarded. Stop an authorised prescription instead.');
  const next = prescriptionVersion(rx.current, 'CANCELLED', rx.current.version + 1, 'CANCELLED', meta, changeReason);
  return { ok: true, record: { ...rx, current: next, history: [...rx.history, next] } };
}

export function discontinuePrescription(rx: Prescription, expectedVersion: number, changeReason: string, meta: RecordMeta): RecordResult<Prescription> {
  const stale = checkVersion<Prescription>(rx.current.version, expectedVersion);
  if (stale) return stale;
  if (rx.current.status === 'DRAFT') return fail(409, 'draft', 'A draft is not in force: discard it instead of stopping it.');
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

// ------------------------------------------------------------------ clinical notes

/**
 * Internal notes of the care team (progress, assessment, procedure, handover …): versioned and append-only
 * like the other records, never released to the patient. A note records what a clinician wrote; JIVA
 * neither generates nor interprets it.
 */
export const noteContent = (c: ClinicalNoteContent): ClinicalNoteContent => ({ noteType: c.noteType, title: c.title, text: c.text });
export const noteHash = (c: ClinicalNoteContent) => sha256(noteContent(c));

function noteVersion(content: ClinicalNoteContent, version: number, action: ClinicalNoteVersion['action'], meta: RecordMeta, changeReason?: string): ClinicalNoteVersion {
  return {
    ...noteContent(content), version, recordedAt: meta.at, recordedBy: meta.actor, action,
    ...(changeReason ? { changeReason } : {}),
    contentHash: noteHash(content), eventId: meta.eventId,
  };
}

export function createNote(noteId: string, content: ClinicalNoteContent, meta: RecordMeta): ClinicalNote {
  const v1 = noteVersion(content, 1, 'CREATED', meta);
  return { noteId, encounterId: meta.encounterId, caseId: meta.caseId, hospitalId: meta.hospitalId, current: v1, history: [v1], dataStatus: meta.dataStatus };
}

export function amendNote(note: ClinicalNote, expectedVersion: number, content: ClinicalNoteContent, changeReason: string, meta: RecordMeta): RecordResult<ClinicalNote> {
  const stale = checkVersion<ClinicalNote>(note.current.version, expectedVersion);
  if (stale) return stale;
  if (noteHash(content) === note.current.contentHash) return fail(422, 'no_change', 'Nothing was changed.');
  const next = noteVersion(content, note.current.version + 1, 'AMENDED', meta, changeReason);
  return { ok: true, record: { ...note, current: next, history: [...note.history, next] } };
}
