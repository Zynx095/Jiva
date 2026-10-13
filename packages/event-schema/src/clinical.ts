import { z } from 'zod';
import { BaseEventSchema } from './base';
import {
  ActorSchema,
  DiagnosticCategorySchema,
  DocumentContentTypeSchema,
  DocumentTypeSchema,
  DoctorAssignmentReasonSchema,
  MeasurementTypeSchema,
  RecordIdSchema,
  Sha256HexSchema,
  TelemetrySourceSchema,
} from './primitives';

/**
 * Encounter and clinical-record events (Journey B).
 *
 * These events are produced ONLY by the API's command handlers after authorization and state checks.
 * They are not externally submittable through POST /api/events (see EXTERNAL_EVENT_TYPES).
 *
 * Payloads are `.strict()` and deliberately carry identifiers, versions, hashes and actors only:
 * medication names, report findings, measurement values and file contents are never part of an event.
 * They are stored in the access-controlled clinical store and served by authorized read endpoints.
 */

export const ENCOUNTER_EVENT_TYPES = ['encounter.arrival.recorded', 'encounter.handover.recorded', 'encounter.doctor.assigned'] as const;
export const CLINICAL_RECORD_EVENT_TYPES = [
  'clinical.prescription.recorded',
  'clinical.report.recorded',
  'clinical.document.stored',
  'clinical.telemetry.recorded',
] as const;

const timestamp = z.string().datetime();

/**
 * Provenance of the recorded fact, derived by the API from the authenticated principal (never from a
 * client): a demo persona produces SYNTHETIC_DEMO; real hospital staff produce HOSPITAL_CONFIRMED; an
 * authorised device or feed produces AUTHORIZED_FEED.
 */
export const RecordProvenanceSchema = z.enum(['SYNTHETIC_DEMO', 'HOSPITAL_CONFIRMED', 'AUTHORIZED_FEED', 'UNVERIFIED']);

/** A hospital user confirmed the patient is physically at the hospital. Creates the encounter. */
export const EncounterArrivalRecordedSchema = BaseEventSchema.extend({
  eventType: z.literal('encounter.arrival.recorded'),
  payload: z.object({
    encounterId: RecordIdSchema,
    caseId: RecordIdSchema,
    hospitalId: RecordIdSchema,
    ambulanceId: RecordIdSchema.optional(),
    /** Acceptance request (referral) the patient arrived under, when one exists. */
    referralRequestId: RecordIdSchema.optional(),
    arrivedAt: timestamp,
    recordedBy: ActorSchema,
    dataStatus: RecordProvenanceSchema.optional(),
    /** Recorded by hospital personnel. A GPS geofence alone never produces this event. */
    basis: z.literal('HOSPITAL_CONFIRMED'),
  }).strict(),
});

/** A hospital user recorded the handover from the ambulance crew: in-hospital care begins. */
export const EncounterHandoverRecordedSchema = BaseEventSchema.extend({
  eventType: z.literal('encounter.handover.recorded'),
  payload: z.object({
    encounterId: RecordIdSchema,
    caseId: RecordIdSchema,
    hospitalId: RecordIdSchema,
    ambulanceId: RecordIdSchema.optional(),
    handedOverAt: timestamp,
    recordedBy: ActorSchema,
    dataStatus: RecordProvenanceSchema.optional(),
  }).strict(),
});

export const EncounterDoctorAssignedSchema = BaseEventSchema.extend({
  eventType: z.literal('encounter.doctor.assigned'),
  payload: z.object({
    encounterId: RecordIdSchema,
    caseId: RecordIdSchema,
    hospitalId: RecordIdSchema,
    practitionerId: RecordIdSchema,
    previousPractitionerId: RecordIdSchema.optional(),
    reason: DoctorAssignmentReasonSchema,
    assignedAt: timestamp,
    recordedBy: ActorSchema,
    dataStatus: RecordProvenanceSchema.optional(),
  }).strict(),
});

const recordRef = {
  encounterId: RecordIdSchema,
  caseId: RecordIdSchema,
  hospitalId: RecordIdSchema,
  recordedAt: timestamp,
  recordedBy: ActorSchema,
  dataStatus: RecordProvenanceSchema.optional(),
};

export const ClinicalPrescriptionRecordedSchema = BaseEventSchema.extend({
  eventType: z.literal('clinical.prescription.recorded'),
  payload: z.object({
    prescriptionId: RecordIdSchema,
    ...recordRef,
    version: z.number().int().min(1),
    action: z.enum(['CREATED', 'AMENDED', 'AUTHORISED', 'DISCONTINUED', 'CANCELLED']),
    status: z.enum(['DRAFT', 'ACTIVE', 'DISCONTINUED', 'CANCELLED']),
    contentHash: Sha256HexSchema,
    /** False while the prescription has never been authorised (drafts and discarded drafts). */
    patientVisible: z.boolean(),
  }).strict(),
});

export const ClinicalReportRecordedSchema = BaseEventSchema.extend({
  eventType: z.literal('clinical.report.recorded'),
  payload: z.object({
    reportId: RecordIdSchema,
    ...recordRef,
    version: z.number().int().min(1),
    action: z.enum(['CREATED', 'AMENDED']),
    category: DiagnosticCategorySchema,
    status: z.enum(['PRELIMINARY', 'FINAL', 'AMENDED']),
    documentCount: z.number().int().min(0).max(20),
    contentHash: Sha256HexSchema,
    patientVisible: z.boolean(),
  }).strict(),
});

export const ClinicalDocumentStoredSchema = BaseEventSchema.extend({
  eventType: z.literal('clinical.document.stored'),
  payload: z.object({
    documentId: RecordIdSchema,
    ...recordRef,
    category: DiagnosticCategorySchema,
    documentType: DocumentTypeSchema.optional(),
    /** CATALOGUE_SAMPLE: a synthetic sample copied from the catalogue (demo only), never the patient's result. */
    origin: z.enum(['UPLOAD', 'CATALOGUE_SAMPLE']).optional(),
    /** The earlier version this document replaces. */
    supersedes: RecordIdSchema.optional(),
    contentType: DocumentContentTypeSchema,
    sizeBytes: z.number().int().positive(),
    sha256: Sha256HexSchema,
    patientVisible: z.boolean(),
  }).strict(),
});

export const ClinicalTelemetryRecordedSchema = BaseEventSchema.extend({
  eventType: z.literal('clinical.telemetry.recorded'),
  payload: z.object({
    batchId: RecordIdSchema,
    ...recordRef,
    source: TelemetrySourceSchema,
    measurementCount: z.number().int().min(1).max(100),
    measurementTypes: z.array(MeasurementTypeSchema).min(1).max(5),
    observedFrom: timestamp,
    observedTo: timestamp,
    deviceId: RecordIdSchema.optional(),
    patientVisible: z.boolean(),
  }).strict(),
});

export type EncounterArrivalRecorded = z.infer<typeof EncounterArrivalRecordedSchema>;
export type EncounterHandoverRecorded = z.infer<typeof EncounterHandoverRecordedSchema>;
export type EncounterDoctorAssigned = z.infer<typeof EncounterDoctorAssignedSchema>;
export type ClinicalPrescriptionRecorded = z.infer<typeof ClinicalPrescriptionRecordedSchema>;
export type ClinicalReportRecorded = z.infer<typeof ClinicalReportRecordedSchema>;
export type ClinicalDocumentStored = z.infer<typeof ClinicalDocumentStoredSchema>;
export type ClinicalTelemetryRecorded = z.infer<typeof ClinicalTelemetryRecordedSchema>;
