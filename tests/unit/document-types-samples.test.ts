/**
 * Diagnostic documents, second iteration: document types that must fit their category, catalogue samples
 * (a separate, strict command; samples are labelled in events) and document versions (supersedes).
 * Route behaviour (who may attach, demo-only samples, version conflicts) is covered by the doctor
 * workspace integration suite.
 */
import { randomUUID } from 'crypto';
import {
  AnyEventSchema, AttachCatalogueSampleCommandSchema, DOCUMENT_TYPE_CATEGORIES, DocumentUploadIntentCommandSchema, documentTypeFits,
} from '../../packages/event-schema/src';
import { check, eq, ok, run } from './helpers/assert';

const sha = 'a'.repeat(64);
const intent = (o: Record<string, unknown> = {}) => ({
  clientRequestId: randomUUID(), category: 'IMAGING', title: 'Chest X-ray', fileName: 'cxr.png', contentType: 'image/png', sizeBytes: 100, sha256: sha, patientVisible: false, ...o,
});
const actor = { userId: 'demo-doc-3', role: 'CLINICIAN', hospitalId: 'HOSP-BLR-001', practitionerId: 'PRAC-BLR-001-01' };
const stored = (o: Record<string, unknown> = {}) => ({
  eventId: randomUUID(), eventType: 'clinical.document.stored', timestamp: new Date().toISOString(), version: '1.0',
  source: { type: 'clinician', id: 'PRAC-BLR-001-01' }, patientId: 'CASE-BLR-876',
  payload: {
    documentId: 'DOC-0123456789ABCDEF', encounterId: 'ENC-BLR-001-AAAA0000', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-001', recordedAt: new Date().toISOString(),
    recordedBy: actor, dataStatus: 'SYNTHETIC_DEMO', category: 'IMAGING', contentType: 'image/png', sizeBytes: 100, sha256: sha, patientVisible: false, ...o,
  },
});

run('Document types, catalogue samples and versions', async () => {
  await check('every document type maps to categories, and a type must fit the category it is filed under', () => {
    eq(Object.keys(DOCUMENT_TYPE_CATEGORIES).sort(), ['CT', 'ECG', 'LAB_REPORT', 'MRI', 'OTHER', 'PATHOLOGY_REPORT', 'ULTRASOUND', 'XRAY'], 'types');
    ok(documentTypeFits('IMAGING', 'CT') && documentTypeFits('ECG', 'ECG') && documentTypeFits('LABORATORY', 'LAB_REPORT') && documentTypeFits('PROCEDURE', 'OTHER'), 'fitting pairs');
    ok(!documentTypeFits('LABORATORY', 'XRAY') && !documentTypeFits('IMAGING', 'ECG') && !documentTypeFits('ECG', 'MRI'), 'contradictions');
  });

  await check('upload declarations: optional type that must fit, optional version link, nothing else', () => {
    ok(DocumentUploadIntentCommandSchema.safeParse(intent()).success, 'without a type (backwards compatible)');
    ok(DocumentUploadIntentCommandSchema.safeParse(intent({ documentType: 'XRAY', supersedesDocumentId: 'DOC-0123456789ABCDEF' })).success, 'X-ray replacing an earlier version');
    const bad = DocumentUploadIntentCommandSchema.safeParse(intent({ category: 'LABORATORY', documentType: 'XRAY' }));
    eq(bad.success ? 'ok' : bad.error.issues.map(i => i.path.join('.')), ['documentType'], 'an X-ray filed as laboratory');
    ok(!DocumentUploadIntentCommandSchema.safeParse(intent({ origin: 'CATALOGUE_SAMPLE' })).success, 'a client cannot claim an origin');
    ok(!DocumentUploadIntentCommandSchema.safeParse(intent({ supersedesDocumentId: '../DOC' })).success, 'version link is an identifier');
    ok(!DocumentUploadIntentCommandSchema.safeParse(intent({ sizeBytes: 20 * 1024 * 1024 + 1 })).success, 'oversized declaration');
    ok(!DocumentUploadIntentCommandSchema.safeParse(intent({ contentType: 'text/html' })).success, 'unsupported type');
  });

  await check('attaching a catalogue sample: an asset id and the release flag; never a path, bytes or a provenance claim', () => {
    const base = { clientRequestId: randomUUID(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: false };
    ok(AttachCatalogueSampleCommandSchema.safeParse(base).success, 'minimal');
    ok(AttachCatalogueSampleCommandSchema.safeParse({ ...base, title: 'Chest X-ray (sample)', supersedesDocumentId: 'DOC-0123456789ABCDEF' }).success, 'title and version link');
    for (const [field, value] of [['assetId', '../../etc/passwd'], ['assetId', 'synthetic-chest-xray-pa.png'], ['assetRef', 'synthetic-chest-xray-pa.png'], ['bytes', 'iVBOR'], ['dataStatus', 'HOSPITAL_CONFIRMED'], ['designation', 'SYNTHETIC']] as const) {
      ok(!AttachCatalogueSampleCommandSchema.safeParse({ ...base, [field]: value }).success, `${field} refused`);
    }
    ok(!AttachCatalogueSampleCommandSchema.safeParse({ clientRequestId: base.clientRequestId, assetId: base.assetId }).success, 'release decision required');
  });

  await check('document events carry type, origin and version link — still content-free', () => {
    ok(AnyEventSchema.safeParse(stored()).success, 'legacy shape still valid');
    ok(AnyEventSchema.safeParse(stored({ documentType: 'XRAY', origin: 'CATALOGUE_SAMPLE', supersedes: 'DOC-FEDCBA9876543210' })).success, 'sample with version link');
    ok(!AnyEventSchema.safeParse(stored({ origin: 'GENERATED' })).success, 'unknown origin');
    ok(!AnyEventSchema.safeParse(stored({ title: 'Chest X-ray' })).success, 'no title (content) in the event');
    ok(!AnyEventSchema.safeParse(stored({ assetRef: 'synthetic-chest-xray-pa.png' })).success, 'no file reference in the event');
  });
});
