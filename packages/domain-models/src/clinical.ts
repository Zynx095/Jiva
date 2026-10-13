import type { DataStatus } from './hospital';

/**
 * In-hospital clinical domain (Journey B): encounters, doctor assignment, prescriptions,
 * diagnostic reports and documents, and medical telemetry.
 *
 * Privacy model: clinical CONTENT (medications, findings, measurement values, files) lives only in the
 * access-controlled clinical store. Canonical events about it carry identifiers, versions, hashes and
 * actors — never the content — so the operational event bus, ledger and realtime stream cannot leak it.
 */

/** Roles that can appear as the actor of a recorded action. */
export type ActorRole = 'PATIENT' | 'AMBULANCE' | 'HOSPITAL' | 'CLINICIAN' | 'MANAGEMENT' | 'ADMIN' | 'SYSTEM';

/** Who performed an action. Always derived from the authenticated principal, never from a payload. */
export interface ActorRef {
  userId: string;
  role: ActorRole;
  hospitalId?: string;
  practitionerId?: string;
  ambulanceId?: string;
}

/**
 * A clinician known to JIVA for one hospital. Staff-directory data only: it says who may be assigned,
 * not who is on duty or available.
 */
export interface Practitioner {
  practitionerId: string;
  hospitalId: string;
  displayName: string;
  /** Free-text specialty label, e.g. "Emergency medicine". */
  specialty: string;
  active: boolean;
  /** SYNTHETIC_DEMO for the demo roster. A real roster would come from a hospital staff feed. */
  dataStatus: DataStatus;
  /** Where the record comes from, e.g. 'synthetic-demo-roster'. */
  source: string;
}

/**
 * ARRIVED  — a hospital user confirmed the patient is physically at the hospital.
 * IN_CARE  — a hospital user recorded the handover from the ambulance crew; in-hospital care has begun.
 */
export type EncounterStatus = 'ARRIVED' | 'IN_CARE';

export interface DoctorAssignment {
  practitionerId: string;
  displayName: string;
  specialty?: string;
  assignedAt: string;
  assignedBy: ActorRef;
  reason: DoctorAssignmentReason;
  eventId: string;
  /** Set when a later assignment replaced this one. */
  endedAt?: string;
}

export type DoctorAssignmentReason = 'INITIAL_ASSIGNMENT' | 'REASSIGNMENT' | 'SHIFT_HANDOVER' | 'SPECIALTY_REFERRAL';

/** One patient's stay at one hospital, created by an explicit, authorized arrival record. */
export interface HospitalEncounter {
  encounterId: string;
  caseId: string;
  hospitalId: string;
  status: EncounterStatus;
  ambulanceId?: string;
  /** The acceptance request (referral) and response that brought the patient here, when one exists. */
  referral?: {
    requestId: string;
    responseId?: string;
    responseStatus?: 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE';
    respondedAt?: string;
  };
  arrival: {
    arrivedAt: string;
    recordedBy: ActorRef;
    eventId: string;
    /** Time of the GPS geofence signal for the same ambulance and hospital, if one was seen. Evidence only. */
    gpsArrivalAt?: string;
  };
  handover?: {
    handedOverAt: string;
    recordedBy: ActorRef;
    eventId: string;
    fromAmbulanceId?: string;
  };
  assignedDoctor?: DoctorAssignment;
  /** Every assignment, oldest first (current one included). */
  assignmentHistory: DoctorAssignment[];
  dataStatus: DataStatus;
  createdAt: string;
  updatedAt: string;
  /** Increments on every applied lifecycle event. */
  version: number;
}

// ------------------------------------------------------------------ prescriptions

export type MedicationRoute = 'ORAL' | 'IV' | 'IM' | 'SC' | 'INHALED' | 'TOPICAL' | 'SUBLINGUAL' | 'RECTAL' | 'OTHER';
export type MedicationFormulation =
  | 'TABLET' | 'CAPSULE' | 'ORAL_SOLUTION' | 'ORAL_SUSPENSION' | 'INJECTION' | 'INFUSION' | 'INHALER' | 'NEBULISER_SOLUTION'
  | 'SPRAY' | 'CREAM' | 'OINTMENT' | 'PATCH' | 'SUPPOSITORY' | 'DROPS' | 'OTHER';

/**
 * DRAFT        — written but not authorised: not in force, never shown to the patient.
 * ACTIVE       — authorised by the assigned clinician (at creation, or by authorising a draft).
 * DISCONTINUED — an authorised prescription that was stopped (final).
 * CANCELLED    — a draft that was discarded without ever being authorised (final).
 */
export type PrescriptionStatus = 'DRAFT' | 'ACTIVE' | 'DISCONTINUED' | 'CANCELLED';

/** The catalogue entry a prescription was written from (the revision in force at the time). */
export interface CatalogueReference {
  medicationId: string;
  revision: number;
  catalogueVersion: number;
}

/** What the clinician wrote. Free text is bounded and validated at the API boundary. */
export interface PrescriptionContent {
  medication: string;
  strength?: string;
  /** Dosage form, e.g. TABLET. Required when the medication was chosen from the catalogue. */
  formulation?: MedicationFormulation;
  dose: string;
  route: MedicationRoute;
  frequency: string;
  duration?: string;
  instructions?: string;
  /** Set by the server when the medication was chosen from the catalogue (never sent by a client). */
  catalogueRef?: CatalogueReference;
}

export interface PrescriptionVersion extends PrescriptionContent {
  version: number;
  status: PrescriptionStatus;
  recordedAt: string;
  recordedBy: ActorRef;
  action: 'CREATED' | 'AMENDED' | 'AUTHORISED' | 'DISCONTINUED' | 'CANCELLED';
  /** Required for amendments, discontinuation and discarding a draft. */
  changeReason?: string;
  /** sha256 of the canonical content of this version. */
  contentHash: string;
  eventId: string;
}

export interface Prescription {
  prescriptionId: string;
  encounterId: string;
  caseId: string;
  hospitalId: string;
  current: PrescriptionVersion;
  /** Append-only, oldest first; includes the current version. */
  history: PrescriptionVersion[];
  /** The latest authorisation: who put the current content in force, when, at which version. */
  authorisation?: { authorisedAt: string; authorisedBy: ActorRef; version: number };
  dataStatus: DataStatus;
}

// ------------------------------------------------------------------ clinical notes

/** Internal notes of the care team. Never released to the patient. */
export type ClinicalNoteType = 'PROGRESS' | 'ASSESSMENT' | 'PROCEDURE' | 'HANDOVER' | 'OTHER';

export interface ClinicalNoteContent {
  noteType: ClinicalNoteType;
  title: string;
  text: string;
}

export interface ClinicalNoteVersion extends ClinicalNoteContent {
  version: number;
  recordedAt: string;
  recordedBy: ActorRef;
  action: 'CREATED' | 'AMENDED';
  changeReason?: string;
  contentHash: string;
  eventId: string;
}

export interface ClinicalNote {
  noteId: string;
  encounterId: string;
  caseId: string;
  hospitalId: string;
  current: ClinicalNoteVersion;
  /** Append-only, oldest first; includes the current version. */
  history: ClinicalNoteVersion[];
  dataStatus: DataStatus;
}

// ------------------------------------------------------------------ diagnostic reports and documents

export type DiagnosticCategory = 'LABORATORY' | 'IMAGING' | 'ECG' | 'PROCEDURE' | 'OTHER';
export type ReportStatus = 'PRELIMINARY' | 'FINAL' | 'AMENDED';

export interface ReportContent {
  category: DiagnosticCategory;
  title: string;
  findings?: string;
  conclusion?: string;
  /** When the test or observation was performed. */
  effectiveAt: string;
  /** Diagnostic documents (files) attached to this report. */
  documentIds: string[];
  /** Released to the patient. Unreleased reports are visible only to the treating clinician. */
  patientVisible: boolean;
}

export interface ReportVersion extends ReportContent {
  version: number;
  status: ReportStatus;
  recordedAt: string;
  recordedBy: ActorRef;
  action: 'CREATED' | 'AMENDED';
  changeReason?: string;
  contentHash: string;
  eventId: string;
}

export interface DiagnosticReport {
  reportId: string;
  encounterId: string;
  caseId: string;
  hospitalId: string;
  current: ReportVersion;
  history: ReportVersion[];
  dataStatus: DataStatus;
}

export type DocumentContentType = 'application/pdf' | 'image/png' | 'image/jpeg' | 'application/dicom';
export type DocumentStatus = 'PENDING_UPLOAD' | 'AVAILABLE' | 'REJECTED';
/** What kind of document it is, finer than its category (an X-ray is always IMAGING). */
export type DiagnosticDocumentType = 'XRAY' | 'CT' | 'MRI' | 'ULTRASOUND' | 'ECG' | 'LAB_REPORT' | 'PATHOLOGY_REPORT' | 'OTHER';
/**
 * UPLOAD           — a file a clinician uploaded (verified on upload).
 * CATALOGUE_SAMPLE — a synthetic or educational sample copied from the clinical catalogue (DEMO mode only).
 *                    Never this patient's result, and always labelled as a sample.
 */
export type DocumentOrigin = 'UPLOAD' | 'CATALOGUE_SAMPLE';

/** Metadata of an uploaded diagnostic file (X-ray, ECG trace, lab PDF…). The bytes live in document storage. */
export interface DiagnosticDocument {
  documentId: string;
  encounterId: string;
  caseId: string;
  hospitalId: string;
  category: DiagnosticCategory;
  title: string;
  /** Sanitised display name; never used as a storage path. */
  fileName: string;
  contentType: DocumentContentType;
  sizeBytes: number;
  /** Declared by the uploader and verified against the received bytes. */
  sha256: string;
  status: DocumentStatus;
  patientVisible: boolean;
  uploadedBy: ActorRef;
  createdAt: string;
  uploadedAt?: string;
  rejectionReason?: string;
  dataStatus: DataStatus;
  /** Absent on documents recorded before document types existed. */
  documentType?: DiagnosticDocumentType;
  /** Absent means UPLOAD (documents recorded before origins existed). */
  origin?: DocumentOrigin;
  /** The catalogue sample this document was copied from (CATALOGUE_SAMPLE only). */
  sample?: { assetId: string; revision: number; catalogueVersion: number; designation: 'SYNTHETIC' | 'EDUCATIONAL' };
  /**
   * Versions of a document: a new document may replace an earlier verified one of the same encounter
   * (`supersedes`); the earlier one is kept and marked `supersededBy`. `seriesId` is the first version's id.
   */
  version?: number;
  seriesId?: string;
  supersedes?: string;
  supersededBy?: string;
}

// ------------------------------------------------------------------ medical telemetry

/**
 * MANUAL_CLINICIAN — entered by an authenticated clinician.
 * MANUAL_CREW      — entered by the attending ambulance crew (pre-hospital).
 * DEVICE_SIMULATED — generated for demonstrations; never a real measurement.
 * MEDICAL_DEVICE   — from a registered device integration (none is integrated yet).
 */
export type TelemetrySource = 'MANUAL_CLINICIAN' | 'MANUAL_CREW' | 'DEVICE_SIMULATED' | 'MEDICAL_DEVICE';
/** The person measuring may flag a value as questionable (e.g. motion artefact, poor perfusion). */
export type ObservationQuality = 'RELIABLE' | 'QUESTIONABLE';
/** Why a vital sign was not recorded: stated, never left to look like a normal value. */
export type ObservationUnavailableReason = 'NOT_MEASURED' | 'EQUIPMENT_UNAVAILABLE' | 'UNABLE_TO_OBTAIN';
export type MeasurementType = 'HEART_RATE' | 'SPO2' | 'BLOOD_PRESSURE' | 'TEMPERATURE' | 'RESPIRATORY_RATE';
export type MeasurementUnit = 'bpm' | '%' | 'mmHg' | 'degC' | 'breaths/min';

export interface TelemetryMeasurement {
  measurementId: string;
  batchId: string;
  encounterId: string;
  caseId: string;
  hospitalId: string;
  type: MeasurementType;
  /** Primary value (systolic for blood pressure). */
  value: number;
  /** Diastolic for blood pressure. */
  secondaryValue?: number;
  unit: MeasurementUnit;
  observedAt: string;
  recordedAt: string;
  source: TelemetrySource;
  recordedBy?: ActorRef;
  deviceId?: string;
  /** As flagged by whoever measured it; absent = not flagged. */
  quality?: ObservationQuality;
  dataStatus: DataStatus;
}

// ------------------------------------------------------------------ pre-hospital record (ambulance)

/** One vital sign the crew measured, or recorded as not available (with the reason). */
export interface PrehospitalObservation {
  type: MeasurementType;
  status: 'MEASURED' | 'NOT_AVAILABLE';
  value?: number;
  secondaryValue?: number;
  unit?: MeasurementUnit;
  /** When it was measured (for NOT_AVAILABLE: when that was recorded). */
  observedAt: string;
  quality?: ObservationQuality;
  unavailableReason?: ObservationUnavailableReason;
}

/**
 * What the attending crew recorded before the hospital took over: vital signs with their times, source and
 * quality, and the symptom narrative. Linked to the case; the clinician assigned to that case's encounter
 * reads it. Never a diagnosis.
 */
export interface PrehospitalEntry {
  entryId: string;
  caseId: string;
  ambulanceId: string;
  recordedAt: string;
  recordedBy: ActorRef;
  /** MANUAL_CREW (typed in by the crew) or DEVICE_SIMULATED (demo only). No device is integrated. */
  source: 'MANUAL_CREW' | 'DEVICE_SIMULATED';
  deviceId?: string;
  observations: PrehospitalObservation[];
  /** Free-text description of the symptoms, as reported or observed. */
  symptomDescription?: string;
  /** When the symptoms started, as reported. */
  symptomOnsetAt?: string;
  dataStatus: DataStatus;
  eventId: string;
}

// ------------------------------------------------------------------ audit

/** Append-only audit entry. Identifies who did what to which record — never the record's content. */
export interface AuditRecord {
  auditId: string;
  at: string;
  actor: ActorRef;
  action: string;
  outcome: 'ALLOWED' | 'DENIED';
  entityType: 'ENCOUNTER' | 'PRESCRIPTION' | 'REPORT' | 'NOTE' | 'DOCUMENT' | 'TELEMETRY' | 'PREHOSPITAL' | 'ROSTER' | 'EMERGENCY' | 'AUDIT' | 'CATALOGUE' | 'DEMO';
  entityId?: string;
  encounterId?: string;
  caseId?: string;
  hospitalId?: string;
  /** Machine-readable reason for a denial (e.g. NOT_ASSIGNED). Never free text from a client. */
  reasonCode?: string;
}
