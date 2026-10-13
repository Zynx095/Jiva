import { z } from 'zod';
import {
  boundedText,
  ClientRequestIdSchema,
  DiagnosticCategorySchema,
  DocumentTypeSchema,
  documentTypeFits,
  MedicationFormulationSchema,
  MedicationRouteSchema,
  RecordIdSchema,
  Sha256HexSchema,
} from './primitives';

/**
 * Clinical catalogue: a validated, versioned list of (1) synthetic or educational sample documents
 * (X-rays, CT, MRI, ultrasound, ECG, laboratory reports …) and (2) medication metadata used to fill a
 * prescription. JSON is the canonical format (data/catalogue/*.json); CSV is supported for import/export.
 *
 * What the catalogue is NOT: complete (it lists a small illustrative selection), a formulary, a source of
 * dosing advice or a diagnostic aid. Entries may be offered to clinicians as choices; they never diagnose a
 * patient and never create or authorise a prescription by themselves.
 *
 * Binary files are never embedded in JSON or CSV: an entry names its file (`assetRef`, a bare file name in
 * the catalogue's asset store) together with its type, size and sha256, and the server verifies the file.
 */

/** Version of the catalogue file and entry format. Bump on incompatible changes. */
export const CATALOGUE_SCHEMA_VERSION = 1 as const;

export const CATALOGUE_KINDS = ['scan-assets', 'medications'] as const;
export const CatalogueKindSchema = z.enum(CATALOGUE_KINDS);

/** Largest sample file a catalogue entry may reference. */
export const MAX_CATALOGUE_ASSET_BYTES = 5 * 1024 * 1024;
/** Most entries per catalogue (and per import). */
export const MAX_CATALOGUE_ENTRIES = 500;
/** Largest import payload (CSV or JSON text); stays inside the API's 100 kB JSON request limit. */
export const MAX_CATALOGUE_IMPORT_CHARS = 90_000;

export const CatalogueEntryStatusSchema = z.enum(['ACTIVE', 'WITHDRAWN']);

/** Where an entry comes from and under which terms it may be used. */
export const CatalogueProvenanceSchema = z.object({
  source: boundedText(200),
  licence: boundedText(120),
}).strict();

// ------------------------------------------------------------------ sample documents

export const ScanAssetIdSchema = z.string().regex(/^SCAN-[A-Z0-9][A-Z0-9-]{1,46}$/, 'Asset ids look like SCAN-XRAY-CHEST-PA');
export const CatalogueAssetContentTypeSchema = z.enum(['image/png', 'image/jpeg', 'application/pdf']);

/**
 * A bare file name inside the catalogue's asset store: lower-case letters, digits, '-' and '_', one
 * extension. No directories, no '..', no absolute paths — a reference can never point outside the store.
 */
export const AssetRefSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,80}\.(png|jpg|jpeg|pdf)$/, 'assetRef must be a plain file name such as chest-xray-pa.png');

const EXTENSION_TYPE: Record<string, z.infer<typeof CatalogueAssetContentTypeSchema>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf',
};

/**
 * SYNTHETIC — generated for JIVA, depicts no person.
 * EDUCATIONAL — a de-identified teaching image used under its licence; still not this patient.
 * Either way, a sample attached to an encounter is labelled as a sample, never as the patient's result.
 */
export const SampleDesignationSchema = z.enum(['SYNTHETIC', 'EDUCATIONAL']);

export const ScanAssetEntrySchema = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  assetId: ScanAssetIdSchema,
  status: CatalogueEntryStatusSchema,
  category: DiagnosticCategorySchema,
  documentType: DocumentTypeSchema,
  title: boundedText(120),
  description: boundedText(500).optional(),
  bodySite: boundedText(60).optional(),
  assetRef: AssetRefSchema,
  contentType: CatalogueAssetContentTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_CATALOGUE_ASSET_BYTES),
  sha256: Sha256HexSchema,
  designation: SampleDesignationSchema,
  provenance: CatalogueProvenanceSchema,
}).strict().superRefine((e, ctx) => {
  if (!documentTypeFits(e.category, e.documentType)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['documentType'], message: `A ${e.documentType} document cannot be filed under ${e.category}` });
  }
  const ext = e.assetRef.slice(e.assetRef.lastIndexOf('.') + 1);
  if (EXTENSION_TYPE[ext] !== e.contentType) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['assetRef'], message: `The file extension .${ext} does not match ${e.contentType}` });
  }
});

// ------------------------------------------------------------------ medications

export const MedicationIdSchema = z.string().regex(/^MED-[A-Z0-9][A-Z0-9.-]{1,46}$/, 'Medication ids look like MED-PARACETAMOL-500-TAB');

/** WHO ATC code (7 characters, e.g. N02BE01). */
export const AtcCodeSchema = z.string().regex(/^[A-Z][0-9]{2}[A-Z]{2}[0-9]{2}$/, 'ATC codes look like N02BE01');

/**
 * One medication product as a prescriber selects it: generic name, one strength, one dosage form and the
 * routes it can be given by. Deliberately no doses, frequencies or indications: the catalogue identifies a
 * product, it does not recommend treatment.
 */
export const MedicationEntrySchema = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  medicationId: MedicationIdSchema,
  status: CatalogueEntryStatusSchema,
  name: boundedText(120),
  strength: boundedText(40),
  formulation: MedicationFormulationSchema,
  routes: z.array(MedicationRouteSchema).min(1).max(6).refine(r => new Set(r).size === r.length, 'A route is listed twice'),
  atcCode: AtcCodeSchema.optional(),
  provenance: CatalogueProvenanceSchema,
}).strict();

// ------------------------------------------------------------------ files and import commands

/** Envelope of a canonical catalogue file. Entries are validated one by one (see the API catalogue module). */
export const CatalogueFileEnvelopeSchema = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  kind: CatalogueKindSchema,
  /** Version of the content: starts at 1, +1 for every applied import (exports carry the current one). */
  catalogueVersion: z.number().int().min(1).optional(),
  notice: boundedText(600),
  entries: z.array(z.unknown()).max(MAX_CATALOGUE_ENTRIES),
}).strict();

/** Step 1 of an import (administrators): parse and validate, compare with the current catalogue, change nothing. */
export const CatalogueImportPreviewCommandSchema = z.object({
  format: z.enum(['csv', 'json']),
  content: z.string().min(1).max(MAX_CATALOGUE_IMPORT_CHARS),
}).strict();

/**
 * Step 2: apply exactly what the preview showed. Refused when the catalogue changed since the preview, when
 * any record was invalid or duplicated, and — unless `confirmChanges` is true — when existing entries would
 * be changed (existing records are never overwritten silently).
 */
export const CatalogueImportApplyCommandSchema = z.object({
  clientRequestId: ClientRequestIdSchema,
  previewId: RecordIdSchema,
  confirmChanges: z.boolean().default(false),
}).strict();

export type CatalogueKind = z.infer<typeof CatalogueKindSchema>;
export type ScanAssetEntry = z.infer<typeof ScanAssetEntrySchema>;
export type MedicationEntry = z.infer<typeof MedicationEntrySchema>;
export type CatalogueImportPreviewCommand = z.infer<typeof CatalogueImportPreviewCommandSchema>;
export type CatalogueImportApplyCommand = z.infer<typeof CatalogueImportApplyCommandSchema>;
