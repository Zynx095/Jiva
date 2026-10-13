import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash, randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import type { DiagnosticDocument, HospitalEncounter } from '@jiva/domain-models';
import { AttachCatalogueSampleCommandSchema, DocumentUploadIntentCommandSchema, type ScanAssetEntry } from '@jiva/event-schema';
import { clinicalStore } from '../clinical';
import { catalogue, catalogueAssets } from '../catalogue';
import { actorFromAuth, authorizeEncounterAction } from '../clinical/policy';
import {
  contentDisposition, defaultDocumentDir, LocalDocumentStorage, newDocumentId, sanitizeFileName, signatureMatches, SIGNATURE_BYTES,
  UploadTickets, type DocumentStorage,
} from '../clinical/documents';
import { recordProvenance } from '../clinical/views';
import { asyncRoute, audit, auditAccess, denied, idempotent, replayOr, validationError, withKeyLock } from '../commands/support';
import { encounterFor, publishCommandEvent } from './encounters';
import { target, writableEncounter } from './clinicalRecords';

type AuthedRequest = Request & { auth?: AuthContext };

export const documentStorage: DocumentStorage = new LocalDocumentStorage(defaultDocumentDir());
export const uploadTickets = new UploadTickets();

/** Demo reset / start of a local run: local documents are as ephemeral as the rest of local state. */
export async function resetDocuments(): Promise<void> {
  uploadTickets.clear();
  await documentStorage.clear();
}

/**
 * May the patient see this document? Only verified documents, and only when the clinician released it at
 * upload or attached it to a report that is shared with the patient.
 */
export function patientMaySee(doc: DiagnosticDocument): boolean {
  if (doc.status !== 'AVAILABLE') return false;
  if (doc.patientVisible) return true;
  return clinicalStore.listReports(doc.encounterId).some(r => r.current.patientVisible && r.current.documentIds.includes(doc.documentId));
}

/** A declared upload that was never completed is closed when its ticket lapses (shown, never silently kept). */
function expireIfStale(doc: DiagnosticDocument): DiagnosticDocument {
  if (doc.status !== 'PENDING_UPLOAD') return doc;
  const ticket = uploadTickets.forDocument(doc.documentId);
  if (ticket && Date.now() <= ticket.expiresAt) return doc;
  uploadTickets.revokeDocument(doc.documentId);
  const closed: DiagnosticDocument = { ...doc, status: 'REJECTED', rejectionReason: 'UPLOAD_EXPIRED' };
  clinicalStore.putDocument(closed);
  return closed;
}

const uploaderName = (doc: DiagnosticDocument) => {
  const p = doc.uploadedBy.practitionerId ? clinicalStore.getPractitioner(doc.uploadedBy.practitionerId) : undefined;
  return { displayName: p && p.hospitalId === doc.hospitalId ? p.displayName : 'Clinician' };
};

/**
 * Clinician: full metadata. Patient: what the file is, when and by whom (roster name), and whether it is a
 * catalogue sample — no staff ids.
 */
function projectDocument(doc: DiagnosticDocument, view: 'CLINICIAN' | 'PATIENT') {
  if (view === 'CLINICIAN') return { ...doc, origin: doc.origin ?? 'UPLOAD', uploader: uploaderName(doc) };
  return {
    documentId: doc.documentId,
    encounterId: doc.encounterId,
    category: doc.category,
    ...(doc.documentType ? { documentType: doc.documentType } : {}),
    title: doc.title,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    uploadedAt: doc.uploadedAt,
    uploadedBy: uploaderName(doc),
    origin: doc.origin ?? 'UPLOAD',
    ...(doc.sample ? { sample: { designation: doc.sample.designation } } : {}),
    ...(doc.version ? { version: doc.version } : {}),
    ...(doc.supersededBy ? { superseded: true } : {}),
    dataStatus: doc.dataStatus,
  };
}

type Series = { ok: true; prev?: DiagnosticDocument; fields: Pick<DiagnosticDocument, 'version' | 'seriesId' | 'supersedes'> } | { ok: false; message: string };

/**
 * Document versions: a new document may replace a verified, not yet replaced document of the same
 * encounter and category. The earlier version is kept (and stays downloadable); it is only marked.
 */
function seriesFor(enc: HospitalEncounter, supersedesId: string | undefined, category: DiagnosticDocument['category']): Series {
  if (!supersedesId) return { ok: true, fields: { version: 1 } };
  const prev = clinicalStore.getDocument(supersedesId);
  if (!prev || prev.encounterId !== enc.encounterId) return { ok: false, message: 'The document to replace is not a document of this encounter.' };
  if (prev.status !== 'AVAILABLE') return { ok: false, message: 'Only a verified document can be replaced.' };
  if (prev.supersededBy) return { ok: false, message: 'That document was already replaced by a newer version.' };
  if (prev.category !== category) return { ok: false, message: 'A new version must have the same category as the document it replaces.' };
  return { ok: true, prev, fields: { version: (prev.version ?? 1) + 1, seriesId: prev.seriesId ?? prev.documentId, supersedes: prev.documentId } };
}

/**
 * Copy a verified catalogue sample into document storage, re-hashing while copying: if the file changed
 * after it was verified, nothing is stored.
 */
async function copySample(entry: ScanAssetEntry, documentId: string): Promise<boolean> {
  const check = catalogueAssets.verify(entry);
  if (!check.ok) return false;
  const tmp = documentStorage.tempPath(documentId);
  const hash = createHash('sha256');
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(fs.createReadStream(check.path), counter, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
  } catch {
    await documentStorage.discard(tmp);
    return false;
  }
  if (size !== entry.sizeBytes || hash.digest('hex') !== entry.sha256) {
    await documentStorage.discard(tmp);
    return false;
  }
  await documentStorage.commit(tmp, documentId);
  return true;
}

function documentEvent(auth: AuthContext, doc: DiagnosticDocument) {
  const at = doc.uploadedAt ?? new Date().toISOString();
  return {
    eventId: randomUUID(), eventType: 'clinical.document.stored', timestamp: at, version: '1.0',
    source: { type: 'clinician', id: auth.practitionerId ?? auth.userId }, patientId: doc.caseId,
    payload: {
      documentId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId,
      recordedAt: at, recordedBy: actorFromAuth(auth), dataStatus: doc.dataStatus,
      category: doc.category,
      ...(doc.documentType ? { documentType: doc.documentType } : {}),
      origin: doc.origin ?? 'UPLOAD',
      ...(doc.supersedes ? { supersedes: doc.supersedes } : {}),
      contentType: doc.contentType, sizeBytes: doc.sizeBytes, sha256: doc.sha256, patientVisible: doc.patientVisible,
    },
  };
}

class UploadRejected extends Error {
  constructor(readonly reason: 'SIZE_MISMATCH' | 'HASH_MISMATCH' | 'CONTENT_TYPE_MISMATCH') {
    super(reason);
  }
}

/** Reject a request before reading its body: answer and close the connection (the body is not consumed). */
const refuse = (res: Response, status: number, body: Record<string, unknown>) => res.set('Connection', 'close').status(status).json(body);

/**
 * Diagnostic documents (Phase 8): upload intent (JSON), ticket-bound binary upload with integrity checks,
 * listing and authorized download. Large files never pass through the JSON API or the event bus, and the
 * 100 kB JSON limit is unchanged.
 */
export function documentRouter(): Router {
  const router = Router();

  // ---------------------------------------------------------------- 1. upload intent
  router.post('/encounters/:id/documents', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'document.write', 'document.upload.intent');
    if (!found) return;
    const parsed = DocumentUploadIntentCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { clientRequestId, ...decl } = parsed.data;
    const idem = idempotent('document.intent', auth, clientRequestId, { encounterId: found.encounterId, ...parsed.data });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'document.write', 'document.upload.intent');
      if (!enc) return;
      const series = seriesFor(enc, decl.supersedesDocumentId, decl.category);
      if (!series.ok) return res.status(422).json({ error: 'invalid_supersedes', message: series.message });
      const documentId = newDocumentId();
      const doc: DiagnosticDocument = {
        documentId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
        category: decl.category, ...(decl.documentType ? { documentType: decl.documentType } : {}), title: decl.title,
        fileName: sanitizeFileName(decl.fileName), contentType: decl.contentType,
        sizeBytes: decl.sizeBytes, sha256: decl.sha256, status: 'PENDING_UPLOAD', patientVisible: decl.patientVisible,
        uploadedBy: actorFromAuth(auth), createdAt: new Date().toISOString(), dataStatus: recordProvenance(auth),
        origin: 'UPLOAD', seriesId: documentId, ...series.fields,
      };
      clinicalStore.putDocument(doc);
      const ticket = uploadTickets.issue(doc, auth.userId);
      audit(auth, 'document.upload.intent', 'ALLOWED', target(enc, 'DOCUMENT', doc.documentId));
      const body = {
        status: 'awaiting_upload',
        document: projectDocument(doc, 'CLINICIAN'),
        upload: { url: `/api/uploads/${ticket.token}`, method: 'PUT', headers: { 'content-type': doc.contentType }, maxBytes: doc.sizeBytes, expiresAt: new Date(ticket.expiresAt).toISOString() },
      };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  // ---------------------------------------------------------------- 2. binary upload
  router.put('/uploads/:token', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const token = String(req.params.token);
    const ticket = uploadTickets.find(token);
    // An unknown token and someone else's token get the same answer.
    if (!ticket || ticket.userId !== auth.userId) {
      audit(auth, 'document.upload', 'DENIED', { entityType: 'DOCUMENT', reasonCode: 'UNKNOWN_TICKET' });
      return refuse(res, 404, { error: 'not_found' });
    }
    const doc = clinicalStore.getDocument(ticket.documentId);
    if (!doc || doc.status !== 'PENDING_UPLOAD') {
      uploadTickets.revoke(token);
      return refuse(res, 409, { error: 'not_pending', message: 'This upload is closed. Start a new upload.' });
    }
    if (Date.now() > ticket.expiresAt) {
      expireIfStale(doc);
      return refuse(res, 410, { error: 'upload_expired', message: 'The upload window closed. Start a new upload.' });
    }
    // Still the assigned clinician of an encounter in care?
    const facts = clinicalStore.encounterFacts(doc.encounterId);
    const decision = facts ? authorizeEncounterAction(auth, facts, 'document.write') : undefined;
    if (!decision?.allowed || facts?.status !== 'IN_CARE') {
      audit(auth, 'document.upload', 'DENIED', { entityType: 'DOCUMENT', entityId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId, reasonCode: decision && !decision.allowed ? decision.code : 'NOT_IN_CARE' });
      if (decision && !decision.allowed) {
        res.set('Connection', 'close');
        return denied(res, decision);
      }
      return refuse(res, 409, { error: 'not_in_care' });
    }
    if (ticket.inProgress) return refuse(res, 409, { error: 'upload_in_progress' });
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== ticket.contentType) return refuse(res, 415, { error: 'content_type_mismatch', message: `Send the file as ${ticket.contentType}, as declared.` });
    const length = req.headers['content-length'];
    if (length !== undefined && Number(length) !== ticket.sizeBytes) return refuse(res, 400, { error: 'size_mismatch', message: 'The file size differs from the declared size.' });

    ticket.inProgress = true;
    const tmp = documentStorage.tempPath(doc.documentId);
    const hash = createHash('sha256');
    let size = 0;
    let head = Buffer.alloc(0);
    const guard = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > ticket.sizeBytes) return cb(new UploadRejected('SIZE_MISMATCH'));
        hash.update(chunk);
        if (head.length < SIGNATURE_BYTES) head = Buffer.concat([head, chunk.subarray(0, SIGNATURE_BYTES - head.length)]);
        cb(null, chunk);
      },
    });

    const reject = async (reason: UploadRejected['reason']) => {
      await documentStorage.discard(tmp);
      uploadTickets.revoke(token);
      clinicalStore.putDocument({ ...doc, status: 'REJECTED', rejectionReason: reason });
      audit(auth, 'document.upload', 'DENIED', { entityType: 'DOCUMENT', entityId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId, reasonCode: reason });
      return refuse(res, 422, { error: 'integrity_check_failed', reason, message: 'The file did not match its declaration and was not stored. Start a new upload.' });
    };

    try {
      await pipeline(req, guard, fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    } catch (err) {
      if (err instanceof UploadRejected) return reject(err.reason);
      // Interrupted by the client or the network: nothing is stored; the ticket stays valid for a retry.
      await documentStorage.discard(tmp);
      ticket.inProgress = false;
      if (!res.headersSent) return refuse(res, 400, { error: 'upload_interrupted', message: 'The upload was interrupted. Try again.' });
      return;
    }

    const digest = hash.digest('hex');
    if (size !== ticket.sizeBytes) return reject('SIZE_MISMATCH');
    if (digest !== ticket.sha256) return reject('HASH_MISMATCH');
    if (!signatureMatches(ticket.contentType, head)) return reject('CONTENT_TYPE_MISMATCH');

    return withKeyLock(`case:${doc.caseId}`, async () => {
      const current = clinicalStore.getDocument(doc.documentId);
      if (!current || current.status !== 'PENDING_UPLOAD') {
        await documentStorage.discard(tmp);
        return refuse(res, 409, { error: 'not_pending' });
      }
      // The version this upload replaces must still be the latest one (another upload may have replaced it).
      const prev = current.supersedes ? clinicalStore.getDocument(current.supersedes) : undefined;
      if (current.supersedes && (!prev || prev.status !== 'AVAILABLE' || prev.supersededBy)) {
        await documentStorage.discard(tmp);
        uploadTickets.revoke(token);
        clinicalStore.putDocument({ ...current, status: 'REJECTED', rejectionReason: 'ALREADY_SUPERSEDED' });
        audit(auth, 'document.upload', 'DENIED', { entityType: 'DOCUMENT', entityId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId, reasonCode: 'ALREADY_SUPERSEDED' });
        return refuse(res, 409, { error: 'already_superseded', message: 'The document this upload replaces was replaced meanwhile. Nothing was stored.' });
      }
      await documentStorage.commit(tmp, doc.documentId);
      uploadTickets.revoke(token);
      const stored: DiagnosticDocument = { ...current, status: 'AVAILABLE', uploadedAt: new Date().toISOString() };
      clinicalStore.putDocument(stored);
      if (prev) clinicalStore.putDocument({ ...prev, supersededBy: stored.documentId });
      try {
        await publishCommandEvent(auth, documentEvent(auth, stored));
      } catch (err) {
        clinicalStore.putDocument(current);
        if (prev) clinicalStore.putDocument(prev);
        await documentStorage.remove(doc.documentId);
        throw err;
      }
      audit(auth, 'document.upload', 'ALLOWED', { entityType: 'DOCUMENT', entityId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId });
      return res.status(200).json({ status: 'stored', document: projectDocument(stored, 'CLINICIAN') });
    });
  }));

  // ---------------------------------------------------------------- 2b. catalogue sample (DEMO only)
  router.post('/encounters/:id/documents/samples', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    // Synthetic samples exist in DEMO mode only: in operational mode this route does not exist, so a sample
    // can never be attached to a real patient's encounter.
    if (!catalogue.isAvailable('scan-assets')) return res.status(404).json({ error: 'not_found' });
    const found = encounterFor(req, res, 'document.write', 'document.sample.attach');
    if (!found) return;
    const parsed = AttachCatalogueSampleCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const body = parsed.data;
    const idem = idempotent('document.sample', auth, body.clientRequestId, { encounterId: found.encounterId, ...body });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'document.write', 'document.sample.attach');
      if (!enc) return;
      const stored = catalogue.get('scan-assets', body.assetId);
      const entry = stored?.entry as ScanAssetEntry | undefined;
      if (!stored || !entry || entry.status !== 'ACTIVE') {
        return res.status(422).json({ error: 'unknown_sample', message: 'This sample is not in the catalogue or was withdrawn.' });
      }
      const series = seriesFor(enc, body.supersedesDocumentId, entry.category);
      if (!series.ok) return res.status(422).json({ error: 'invalid_supersedes', message: series.message });
      const documentId = newDocumentId();
      if (!(await copySample(entry, documentId))) {
        console.error(`[Documents] Catalogue sample ${entry.assetId} is missing or no longer matches its entry; nothing attached.`);
        return res.status(503).json({ error: 'asset_unavailable', message: 'The sample file is missing or changed on the server. Nothing was attached.' });
      }
      const now = new Date().toISOString();
      const doc: DiagnosticDocument = {
        documentId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
        category: entry.category, documentType: entry.documentType, title: body.title ?? entry.title,
        fileName: entry.assetRef, contentType: entry.contentType, sizeBytes: entry.sizeBytes, sha256: entry.sha256,
        status: 'AVAILABLE', patientVisible: body.patientVisible, uploadedBy: actorFromAuth(auth), createdAt: now, uploadedAt: now,
        // A sample is synthetic whoever attaches it.
        dataStatus: 'SYNTHETIC_DEMO', origin: 'CATALOGUE_SAMPLE',
        sample: { assetId: entry.assetId, revision: stored.revision, catalogueVersion: catalogue.version('scan-assets'), designation: entry.designation },
        seriesId: documentId, ...series.fields,
      };
      const prev = series.prev;
      clinicalStore.putDocument(doc);
      if (prev) clinicalStore.putDocument({ ...prev, supersededBy: documentId });
      try {
        await publishCommandEvent(auth, documentEvent(auth, doc));
      } catch (err) {
        clinicalStore.removeDocument(documentId);
        if (prev) clinicalStore.putDocument(prev);
        await documentStorage.remove(documentId);
        throw err;
      }
      audit(auth, 'document.sample.attach', 'ALLOWED', target(enc, 'DOCUMENT', documentId));
      const response = { status: 'stored', document: projectDocument(doc, 'CLINICIAN') };
      idem.remember(201, response);
      return res.status(201).json(response);
    });
  }));

  // ---------------------------------------------------------------- 3. list and download
  router.get('/encounters/:id/documents', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'document.read', 'document.read');
    if (!enc) return;
    auditAccess(auth, 'document.read', target(enc, 'DOCUMENT'));
    const docs = clinicalStore.listDocuments(enc.encounterId).map(expireIfStale);
    const visible = auth.role === 'PATIENT' ? docs.filter(patientMaySee) : docs;
    const view = auth.role === 'PATIENT' ? 'PATIENT' : 'CLINICIAN';
    res.json(visible.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).map(d => projectDocument(d, view)));
  });

  router.get('/encounters/:id/documents/:documentId/content', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'document.read', 'document.download');
    if (!enc) return;
    const doc = clinicalStore.getDocument(String(req.params.documentId));
    if (!doc || doc.encounterId !== enc.encounterId) {
      audit(auth, 'document.download', 'DENIED', { ...target(enc, 'DOCUMENT'), reasonCode: 'NOT_IN_ENCOUNTER' });
      return res.status(404).json({ error: 'not_found' });
    }
    const decision = authorizeEncounterAction(auth, clinicalStore.encounterFacts(enc.encounterId)!, 'document.read', { patientVisible: patientMaySee(doc) });
    if (!decision.allowed) {
      audit(auth, 'document.download', 'DENIED', { ...target(enc, 'DOCUMENT', doc.documentId), reasonCode: decision.code });
      return denied(res, decision);
    }
    if (doc.status !== 'AVAILABLE') return res.status(409).json({ error: 'not_available', message: 'This document has not been uploaded and verified.' });
    const stream = documentStorage.open(doc.documentId);
    if (!stream) {
      console.error(`[Documents] Stored bytes missing for ${doc.documentId}.`);
      return res.status(503).json({ error: 'document_unavailable' });
    }
    audit(auth, 'document.download', 'ALLOWED', target(enc, 'DOCUMENT', doc.documentId));
    res.set({
      'Content-Type': doc.contentType,
      'Content-Length': String(doc.sizeBytes),
      'Content-Disposition': contentDisposition(doc.fileName),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  return router;
}
