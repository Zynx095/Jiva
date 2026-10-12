import { z } from 'zod';
import {
  boundedText,
  CapabilityCodeSchema,
  ClientRequestIdSchema,
  DiagnosticCategorySchema,
  DocumentContentTypeSchema,
  DoctorAssignmentReasonSchema,
  LatitudeSchema,
  LongitudeSchema,
  MedicationRouteSchema,
  RecordIdSchema,
  Sha256HexSchema,
} from './primitives';

/**
 * Request bodies of the command endpoints that produce encounter and clinical events.
 * Identity, timestamps of record, provenance and telemetry source are NEVER taken from a body:
 * the server derives them from the authenticated principal and its own clock.
 * Every object is `.strict()`: unknown fields are rejected rather than silently ignored.
 */

const timestamp = z.string().datetime();

// ------------------------------------------------------------------ ambulance emergency intake

export const LOCATION_METHODS = ['DEVICE_GPS', 'MAP_PIN', 'MANUAL_ENTRY'] as const;

export const EmergencyIntakeCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  /**
   * Case reference the patient shared (e.g. shown in their JIVA app). Omit it and JIVA creates a new
   * reference. JIVA does not collect names or other identity details at intake.
   */
  caseRef: z.string().regex(/^CASE-[A-Z0-9][A-Z0-9-]{2,40}$/, 'Case reference looks like CASE-XXXX').optional(),
  location: z.object({
    latitude: LatitudeSchema,
    longitude: LongitudeSchema,
    address: boundedText(200).optional(),
    method: z.enum(LOCATION_METHODS),
    accuracyMeters: z.number().finite().nonnegative().max(100_000).optional(),
  }).strict(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  /** What the patient or bystanders report, or the crew observes. Not a diagnosis. */
  reportedSymptoms: z.array(boundedText(80)).min(1).max(20),
  /** The crew's suspicion of the cause, recorded separately and labelled as unconfirmed. */
  suspectedCause: boundedText(160).optional(),
  /** Care the crew believes is needed, added to JIVA's rule-based assessment (never removed from it). */
  requiredCapabilities: z.array(CapabilityCodeSchema).max(12).default([]),
  notes: boundedText(1000).optional(),
}).strict();

// ------------------------------------------------------------------ encounter lifecycle

export const RecordArrivalCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  caseId: RecordIdSchema,
  /** Defaults to the server time. May be back-dated a little when recorded after the fact. */
  arrivedAt: timestamp.optional(),
}).strict();

export const RecordHandoverCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  handedOverAt: timestamp.optional(),
}).strict();

export const AssignDoctorCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  practitionerId: RecordIdSchema,
  /** Ignored for the first assignment (always INITIAL_ASSIGNMENT); defaults to REASSIGNMENT afterwards. */
  reason: DoctorAssignmentReasonSchema.optional(),
}).strict();

// ------------------------------------------------------------------ prescriptions

const prescriptionContent = {
  medication: boundedText(120),
  strength: boundedText(40).optional(),
  dose: boundedText(60),
  route: MedicationRouteSchema,
  frequency: boundedText(60),
  duration: boundedText(60).optional(),
  instructions: boundedText(500).optional(),
};

export const CreatePrescriptionCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  ...prescriptionContent,
}).strict();

/** Full replacement of the content. `expectedVersion` prevents silently overwriting a concurrent change. */
export const AmendPrescriptionCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  expectedVersion: z.number().int().min(1),
  changeReason: boundedText(300),
  ...prescriptionContent,
}).strict();

export const DiscontinuePrescriptionCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  expectedVersion: z.number().int().min(1),
  changeReason: boundedText(300),
}).strict();

// ------------------------------------------------------------------ diagnostic reports

const reportContent = {
  category: DiagnosticCategorySchema,
  title: boundedText(120),
  findings: boundedText(4000).optional(),
  conclusion: boundedText(1000).optional(),
  effectiveAt: timestamp,
  documentIds: z.array(RecordIdSchema).max(10).default([]),
  patientVisible: z.boolean(),
};

export const CreateReportCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  status: z.enum(['PRELIMINARY', 'FINAL']),
  ...reportContent,
}).strict();

export const AmendReportCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  expectedVersion: z.number().int().min(1),
  changeReason: boundedText(300),
  /** FINAL becomes AMENDED automatically once a final report is changed. */
  status: z.enum(['PRELIMINARY', 'FINAL']),
  ...reportContent,
}).strict();

// ------------------------------------------------------------------ diagnostic documents

/** Largest diagnostic file accepted by the upload workflow (bytes). */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export const DocumentUploadIntentCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  category: DiagnosticCategorySchema,
  title: boundedText(120),
  fileName: boundedText(160),
  contentType: DocumentContentTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256: Sha256HexSchema,
  patientVisible: z.boolean(),
}).strict();

// ------------------------------------------------------------------ medical telemetry

/**
 * Accepted unit and plausible range per measurement type. Values outside these ranges are rejected as
 * entry errors rather than stored. Ranges are input-plausibility bounds, not clinical thresholds.
 */
export const MEASUREMENT_RULES = {
  HEART_RATE: { unit: 'bpm', min: 20, max: 300 },
  SPO2: { unit: '%', min: 50, max: 100 },
  BLOOD_PRESSURE: { unit: 'mmHg', min: 40, max: 300, secondaryMin: 20, secondaryMax: 200 },
  TEMPERATURE: { unit: 'degC', min: 25, max: 45 },
  RESPIRATORY_RATE: { unit: 'breaths/min', min: 2, max: 80 },
} as const;

const measurement = <T extends keyof typeof MEASUREMENT_RULES>(type: T) =>
  z.object({
    type: z.literal(type),
    value: z.number().finite().min(MEASUREMENT_RULES[type].min).max(MEASUREMENT_RULES[type].max),
    unit: z.literal(MEASUREMENT_RULES[type].unit),
    observedAt: timestamp,
  }).strict();

const bloodPressure = z.object({
  type: z.literal('BLOOD_PRESSURE'),
  value: z.number().finite().min(MEASUREMENT_RULES.BLOOD_PRESSURE.min).max(MEASUREMENT_RULES.BLOOD_PRESSURE.max),
  secondaryValue: z.number().finite().min(MEASUREMENT_RULES.BLOOD_PRESSURE.secondaryMin).max(MEASUREMENT_RULES.BLOOD_PRESSURE.secondaryMax),
  unit: z.literal('mmHg'),
  observedAt: timestamp,
}).strict().refine(m => m.value > m.secondaryValue, { message: 'Systolic must be higher than diastolic', path: ['secondaryValue'] });

export const MeasurementInputSchema = z.union([
  measurement('HEART_RATE'),
  measurement('SPO2'),
  bloodPressure,
  measurement('TEMPERATURE'),
  measurement('RESPIRATORY_RATE'),
]);

export const RecordTelemetryCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  measurements: z.array(MeasurementInputSchema).min(1).max(20),
}).strict();

/** Demo only: ask the simulated bedside monitor for one labelled, synthetic reading. */
export const SimulateTelemetryCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
}).strict();

/**
 * Ingestion contract for a FUTURE medical-device integration. No device is integrated: there is no
 * endpoint that accepts this yet. A batch would have to come from a registered device that authenticates
 * as a device (never a browser user), bound to the encounter by a clinician, with a per-device sequence
 * number so replays and reordering are detected. Defined now so the contract is reviewed before any
 * integration exists; see services/api/src/clinical/telemetry.ts (checkDeviceBatch).
 */
export const DeviceObservationBatchSchema = z.object({
  deviceId: RecordIdSchema,
  sequence: z.number().int().min(0),
  encounterId: RecordIdSchema,
  measurements: z.array(MeasurementInputSchema).min(1).max(100),
  /** Device clock at transmission. */
  sentAt: timestamp,
}).strict();

export type EmergencyIntakeCommand = z.infer<typeof EmergencyIntakeCommandSchema>;
export type RecordArrivalCommand = z.infer<typeof RecordArrivalCommandSchema>;
export type RecordHandoverCommand = z.infer<typeof RecordHandoverCommandSchema>;
export type AssignDoctorCommand = z.infer<typeof AssignDoctorCommandSchema>;
export type CreatePrescriptionCommand = z.infer<typeof CreatePrescriptionCommandSchema>;
export type AmendPrescriptionCommand = z.infer<typeof AmendPrescriptionCommandSchema>;
export type DiscontinuePrescriptionCommand = z.infer<typeof DiscontinuePrescriptionCommandSchema>;
export type CreateReportCommand = z.infer<typeof CreateReportCommandSchema>;
export type AmendReportCommand = z.infer<typeof AmendReportCommandSchema>;
export type DocumentUploadIntentCommand = z.infer<typeof DocumentUploadIntentCommandSchema>;
export type MeasurementInput = z.infer<typeof MeasurementInputSchema>;
export type RecordTelemetryCommand = z.infer<typeof RecordTelemetryCommandSchema>;
export type DeviceObservationBatch = z.infer<typeof DeviceObservationBatchSchema>;
