import { z } from 'zod';

/**
 * Shared building blocks for the clinical event contracts and command bodies.
 */

/** Care capability codes. Must stay identical to `CapabilityType` in @jiva/domain-models (unit-tested). */
export const CAPABILITY_CODES = [
  'EMERGENCY', 'TRAUMA', 'ICU', 'HDU', 'NICU', 'PICU', 'VENTILATOR', 'CARDIOLOGY', 'CARDIAC_SURGERY',
  'NEUROLOGY', 'NEUROSURGERY', 'ORTHOPAEDICS', 'ONCOLOGY', 'PAEDIATRICS', 'NEONATOLOGY', 'OBSTETRICS',
  'GENERAL_SURGERY', 'VASCULAR', 'BURNS', 'DIALYSIS', 'TRANSPLANT', 'BLOOD_BANK', 'CT', 'MRI',
] as const;
export const CapabilityCodeSchema = z.enum(CAPABILITY_CODES);

// No C0 control characters except tab/newline/carriage return, and no DEL.
const NO_CONTROL_CHARS = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]*$/;

/** Human-entered text: trimmed, non-empty, bounded, no control characters. */
export const boundedText = (max: number) =>
  z.string().trim().min(1).max(max).regex(NO_CONTROL_CHARS, 'Contains control characters');

/** Identifier of a JIVA record (case, hospital, encounter…): a safe, bounded charset. */
export const RecordIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/, 'Invalid identifier');

/** Client-generated idempotency key for a command (one per user action, reused on retry). */
export const ClientRequestIdSchema = z.string().uuid();

export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase hex sha256');

export const LatitudeSchema = z.number().finite().min(-90).max(90);
export const LongitudeSchema = z.number().finite().min(-180).max(180);

export const ActorRoleSchema = z.enum(['PATIENT', 'AMBULANCE', 'HOSPITAL', 'CLINICIAN', 'MANAGEMENT', 'ADMIN', 'SYSTEM']);

/** Who performed an action — derived server-side from the authenticated principal. */
export const ActorSchema = z.object({
  userId: z.string().min(1).max(128),
  role: ActorRoleSchema,
  hospitalId: RecordIdSchema.optional(),
  practitionerId: RecordIdSchema.optional(),
  ambulanceId: RecordIdSchema.optional(),
}).strict();

export const DiagnosticCategorySchema = z.enum(['LABORATORY', 'IMAGING', 'ECG', 'PROCEDURE', 'OTHER']);
export const MedicationRouteSchema = z.enum(['ORAL', 'IV', 'IM', 'SC', 'INHALED', 'TOPICAL', 'SUBLINGUAL', 'RECTAL', 'OTHER']);
export const DocumentContentTypeSchema = z.enum(['application/pdf', 'image/png', 'image/jpeg', 'application/dicom']);
export const TelemetrySourceSchema = z.enum(['MANUAL_CLINICIAN', 'DEVICE_SIMULATED', 'MEDICAL_DEVICE']);
export const MeasurementTypeSchema = z.enum(['HEART_RATE', 'SPO2', 'BLOOD_PRESSURE', 'TEMPERATURE', 'RESPIRATORY_RATE']);
export const DoctorAssignmentReasonSchema = z.enum(['INITIAL_ASSIGNMENT', 'REASSIGNMENT', 'SHIFT_HANDOVER', 'SPECIALTY_REFERRAL']);

export type CapabilityCode = z.infer<typeof CapabilityCodeSchema>;
export type Actor = z.infer<typeof ActorSchema>;
