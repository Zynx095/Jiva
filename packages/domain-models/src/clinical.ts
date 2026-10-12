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
export type PrescriptionStatus = 'ACTIVE' | 'DISCONTINUED';

/** What the clinician wrote. Free text is bounded and validated at the API boundary. */
export interface PrescriptionContent {
  medication: string;
  strength?: string;
  dose: string;
  route: MedicationRoute;
  frequency: string;
  duration?: string;
  instructions?: string;
}

export interface PrescriptionVersion extends PrescriptionContent {
  version: number;
  status: PrescriptionStatus;
  recordedAt: string;
  recordedBy: ActorRef;
  action: 'CREATED' | 'AMENDED' | 'DISCONTINUED';
  /** Required for amendments and discontinuation. */
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
}

// ------------------------------------------------------------------ medical telemetry

/**
 * MANUAL_CLINICIAN — entered by an authenticated clinician.
 * DEVICE_SIMULATED — generated for demonstrations; never a real measurement.
 * MEDICAL_DEVICE   — from a registered device integration (none is integrated yet).
 */
export type TelemetrySource = 'MANUAL_CLINICIAN' | 'DEVICE_SIMULATED' | 'MEDICAL_DEVICE';
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
  dataStatus: DataStatus;
}

// ------------------------------------------------------------------ audit

/** Append-only audit entry. Identifies who did what to which record — never the record's content. */
export interface AuditRecord {
  auditId: string;
  at: string;
  actor: ActorRef;
  action: string;
  outcome: 'ALLOWED' | 'DENIED';
  entityType: 'ENCOUNTER' | 'PRESCRIPTION' | 'REPORT' | 'DOCUMENT' | 'TELEMETRY' | 'ROSTER' | 'EMERGENCY';
  entityId?: string;
  encounterId?: string;
  caseId?: string;
  hospitalId?: string;
  /** Machine-readable reason for a denial (e.g. NOT_ASSIGNED). Never free text from a client. */
  reasonCode?: string;
}
