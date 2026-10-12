import { Router, type Request, type Response } from 'express';
import fs from 'fs';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { createHash, randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import type { DiagnosticDocument } from '@jiva/domain-models';
import { DocumentUploadIntentCommandSchema } from '@jiva/event-schema';
import { clinicalStore } from '../clinical';
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

/** Clinician: full metadata. Patient: what the file is, when and by whom (roster name) — no staff ids. */
function projectDocument(doc: DiagnosticDocument, view: 'CLINICIAN' | 'PATIENT') {
  if (view === 'CLINICIAN') return { ...doc, uploader: uploaderName(doc) };
  return {
    documentId: doc.documentId,
    encounterId: doc.encounterId,
    category: doc.category,
    title: doc.title,
    fileName: doc.fileName,
    contentType: doc.contentType,
    sizeBytes: doc.sizeBytes,
    uploadedAt: doc.uploadedAt,
    uploadedBy: uploaderName(doc),
    dataStatus: doc.dataStatus,
  };
}

function documentEvent(auth: AuthContext, doc: DiagnosticDocument) {
  const at = doc.uploadedAt ?? new Date().toISOString();
  return {
    eventId: randomUUID(), eventType: 'clinical.document.stored', timestamp: at, version: '1.0',
    source: { type: 'clinician', id: auth.practitionerId ?? auth.userId }, patientId: doc.caseId,
    payload: {
      documentId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId,
      recordedAt: at, recordedBy: actorFromAuth(auth), dataStatus: doc.dataStatus,
      category: doc.category, contentType: doc.contentType, sizeBytes: doc.sizeBytes, sha256: doc.sha256, patientVisible: doc.patientVisible,
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
      const doc: DiagnosticDocument = {
        documentId: newDocumentId(), encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
        category: decl.category, title: decl.title, fileName: sanitizeFileName(decl.fileName), contentType: decl.contentType,
        sizeBytes: decl.sizeBytes, sha256: decl.sha256, status: 'PENDING_UPLOAD', patientVisible: decl.patientVisible,
        uploadedBy: actorFromAuth(auth), createdAt: new Date().toISOString(), dataStatus: recordProvenance(auth),
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
      await documentStorage.commit(tmp, doc.documentId);
      uploadTickets.revoke(token);
      const stored: DiagnosticDocument = { ...current, status: 'AVAILABLE', uploadedAt: new Date().toISOString() };
      clinicalStore.putDocument(stored);
      try {
        await publishCommandEvent(auth, documentEvent(auth, stored));
      } catch (err) {
        clinicalStore.putDocument(current);
        await documentStorage.remove(doc.documentId);
        throw err;
      }
      audit(auth, 'document.upload', 'ALLOWED', { entityType: 'DOCUMENT', entityId: doc.documentId, encounterId: doc.encounterId, caseId: doc.caseId, hospitalId: doc.hospitalId });
      return res.status(200).json({ status: 'stored', document: projectDocument(stored, 'CLINICIAN') });
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
