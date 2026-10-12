import { Router, type Request, type Response } from 'express';
import type { ZodType, ZodTypeDef } from 'zod';
import { randomBytes, randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import type { DiagnosticReport, HospitalEncounter, Prescription, ReportContent } from '@jiva/domain-models';
import {
  AmendPrescriptionCommandSchema,
  AmendReportCommandSchema,
  CreatePrescriptionCommandSchema,
  CreateReportCommandSchema,
  DiscontinuePrescriptionCommandSchema,
} from '@jiva/event-schema';
import { clinicalStore } from '../clinical';
import { actorFromAuth, authorizeEncounterAction, type EncounterAction } from '../clinical/policy';
import {
  amendPrescription, amendReport, createPrescription, createReport, discontinuePrescription, type RecordMeta, type RecordResult,
} from '../clinical/records';
import { projectPrescription, projectReport, recordProvenance, type AuthorLookup } from '../clinical/views';
import { asyncRoute, audit, auditAccess, CLOCK_SKEW_MS, conflict, denied, idempotent, replayOr, validationError, withKeyLock } from '../commands/support';
import { encounterFor, publishCommandEvent } from './encounters';

type AuthedRequest = Request & { auth?: AuthContext };

const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex').toUpperCase()}`;

/** Authors are shown by their roster name (never their user id). */
const authorLookup: AuthorLookup = actor => {
  const p = actor.practitionerId ? clinicalStore.getPractitioner(actor.practitionerId) : undefined;
  return p && p.hospitalId === actor.hospitalId ? { displayName: p.displayName, specialty: p.specialty } : undefined;
};

const viewFor = (auth: AuthContext): 'CLINICIAN' | 'PATIENT' => (auth.role === 'PATIENT' ? 'PATIENT' : 'CLINICIAN');

/** Attachments of a report shared with the patient: its verified documents of the same encounter. */
const releasedDocuments = (encounterId: string) => (ids: string[]) =>
  ids.filter(id => {
    const d = clinicalStore.getDocument(id);
    return !!d && d.encounterId === encounterId && d.status === 'AVAILABLE';
  });

type RecordEntity = 'PRESCRIPTION' | 'REPORT' | 'DOCUMENT' | 'TELEMETRY';
const ENTITY_OF: Record<string, RecordEntity> = { prescription: 'PRESCRIPTION', report: 'REPORT', document: 'DOCUMENT', telemetry: 'TELEMETRY' };

export const target = (enc: HospitalEncounter, entityType: RecordEntity, entityId?: string) =>
  ({ entityType, ...(entityId ? { entityId } : {}), encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId });

function metaFor(auth: AuthContext, enc: HospitalEncounter): RecordMeta {
  return {
    encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
    actor: actorFromAuth(auth), at: new Date().toISOString(), eventId: randomUUID(), dataStatus: recordProvenance(auth),
  };
}

/**
 * Re-check, under the encounter's lock, that the caller may still write (the doctor may have been
 * reassigned between the first check and the lock) and that the patient is in hospital care.
 */
export function writableEncounter(req: AuthedRequest, res: Response, encounterId: string, action: EncounterAction, auditAction: string): HospitalEncounter | undefined {
  const auth = req.auth!;
  const enc = clinicalStore.getEncounter(encounterId);
  const facts = clinicalStore.encounterFacts(encounterId);
  if (!enc || !facts) {
    res.status(404).json({ error: 'not_found' });
    return undefined;
  }
  const decision = authorizeEncounterAction(auth, facts, action);
  if (!decision.allowed) {
    audit(auth, auditAction, 'DENIED', { ...target(enc, ENTITY_OF[action.split('.')[0]] ?? 'PRESCRIPTION'), reasonCode: decision.code });
    denied(res, decision);
    return undefined;
  }
  if (enc.status !== 'IN_CARE') {
    conflict(res, 'not_in_care', 'Clinical records can be written once the hospital has recorded the handover.');
    return undefined;
  }
  return enc;
}

/**
 * Store a record and record its canonical event together. The record is stored first, so a client that
 * refreshes on the realtime event finds it, and restored if the event cannot be recorded: a record
 * version exists if and only if its event is in the ledger.
 */
async function commit<T>(put: (r: T) => void, restore: () => void, record: T, auth: AuthContext, event: Record<string, unknown>): Promise<void> {
  put(record);
  try {
    await publishCommandEvent(auth, event);
  } catch (err) {
    restore();
    throw err;
  }
}

/** Content-free canonical events: identifiers, version, status, hash and actor — never the medication or findings. */
function prescriptionEvent(auth: AuthContext, rx: Prescription) {
  const v = rx.current;
  return {
    eventId: v.eventId, eventType: 'clinical.prescription.recorded', timestamp: v.recordedAt, version: '1.0',
    source: { type: 'clinician', id: auth.practitionerId ?? auth.userId }, patientId: rx.caseId,
    payload: {
      prescriptionId: rx.prescriptionId, encounterId: rx.encounterId, caseId: rx.caseId, hospitalId: rx.hospitalId,
      recordedAt: v.recordedAt, recordedBy: v.recordedBy, dataStatus: rx.dataStatus,
      version: v.version, action: v.action, status: v.status, contentHash: v.contentHash,
      // A patient's own medication list is always theirs to see.
      patientVisible: true,
    },
  };
}

function reportEvent(auth: AuthContext, report: DiagnosticReport) {
  const v = report.current;
  return {
    eventId: v.eventId, eventType: 'clinical.report.recorded', timestamp: v.recordedAt, version: '1.0',
    source: { type: 'clinician', id: auth.practitionerId ?? auth.userId }, patientId: report.caseId,
    payload: {
      reportId: report.reportId, encounterId: report.encounterId, caseId: report.caseId, hospitalId: report.hospitalId,
      recordedAt: v.recordedAt, recordedBy: v.recordedBy, dataStatus: report.dataStatus,
      version: v.version, action: v.action, category: v.category, status: v.status, documentCount: v.documentIds.length,
      contentHash: v.contentHash, patientVisible: v.patientVisible,
    },
  };
}

const rejected = <T>(res: Response, r: Extract<RecordResult<T>, { ok: false }>, currentVersion: number) =>
  res.status(r.status).json({ error: r.code, message: r.message, currentVersion });

/** Report attachments must be available documents of the same encounter; times may not lie in the future. */
function reportInputProblem(enc: HospitalEncounter, content: ReportContent): { status: 400 | 422; error: string; message: string } | undefined {
  if (Date.parse(content.effectiveAt) > Date.now() + CLOCK_SKEW_MS) return { status: 400, error: 'validation_failed', message: 'effectiveAt is in the future' };
  if (new Set(content.documentIds).size !== content.documentIds.length) return { status: 400, error: 'validation_failed', message: 'A document is attached twice' };
  for (const id of content.documentIds) {
    const d = clinicalStore.getDocument(id);
    if (!d || d.encounterId !== enc.encounterId || d.status !== 'AVAILABLE') {
      return { status: 422, error: 'invalid_document', message: 'Attachments must be uploaded, verified documents of this encounter.' };
    }
  }
  return undefined;
}

const sendProblem = (res: Response, p: { status: 400 | 422; error: string; message: string }) =>
  res.status(p.status).json(p.status === 400 ? { error: p.error, issues: [{ path: 'report', message: p.message }] } : { error: p.error, message: p.message });

/**
 * Encounter-linked clinical records (Phase 7). Writes: the clinician assigned to the encounter only, once
 * the patient is in hospital care. Reads: that clinician (full records with history) and the patient
 * (their own prescriptions and released reports). Hospital coordinators, crews and network coordination
 * have no access to clinical content. Every write and every denied attempt is audited; reads are
 * access-audited (see auditAccess).
 */
export function clinicalRecordsRouter(): Router {
  const router = Router();

  // ---------------------------------------------------------------- prescriptions
  router.get('/encounters/:id/prescriptions', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'prescription.read', 'prescription.read');
    if (!enc) return;
    auditAccess(auth, 'prescription.read', target(enc, 'PRESCRIPTION'));
    const list = clinicalStore.listPrescriptions(enc.encounterId).sort((a, b) =>
      Number(a.current.status !== 'ACTIVE') - Number(b.current.status !== 'ACTIVE') || Date.parse(b.history[0].recordedAt) - Date.parse(a.history[0].recordedAt));
    res.json(list.map(rx => projectPrescription(rx, viewFor(auth), authorLookup)));
  });

  router.post('/encounters/:id/prescriptions', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'prescription.write', 'prescription.create');
    if (!found) return;
    const parsed = CreatePrescriptionCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { clientRequestId, ...content } = parsed.data;
    const idem = idempotent('prescription.create', auth, clientRequestId, { encounterId: found.encounterId, ...parsed.data });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'prescription.write', 'prescription.create');
      if (!enc) return;
      const rx = createPrescription(newId('RX'), content, metaFor(auth, enc));
      await commit(r => clinicalStore.putPrescription(r), () => clinicalStore.removePrescription(rx.prescriptionId), rx, auth, prescriptionEvent(auth, rx));
      audit(auth, 'prescription.create', 'ALLOWED', target(enc, 'PRESCRIPTION', rx.prescriptionId));
      const body = { status: 'recorded', prescription: projectPrescription(rx, 'CLINICIAN', authorLookup) };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  /** Amend or discontinue: a new version based on `expectedVersion`, with the reason for the change. */
  function changePrescription<B extends { clientRequestId: string; expectedVersion: number; changeReason: string }>(
    action: 'prescription.amend' | 'prescription.discontinue',
    schema: ZodType<B, ZodTypeDef, unknown>,
    apply: (rx: Prescription, body: B, meta: RecordMeta) => RecordResult<Prescription>,
  ) {
    return asyncRoute(async (req: AuthedRequest, res) => {
      const auth = req.auth!;
      const found = encounterFor(req, res, 'prescription.write', action);
      if (!found) return;
      const rxId = String(req.params.rxId);
      const existing = clinicalStore.getPrescription(rxId);
      if (!existing || existing.encounterId !== found.encounterId) return res.status(404).json({ error: 'not_found' });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error);
      const body = parsed.data;
      const idem = idempotent(action, auth, body.clientRequestId, { prescriptionId: rxId, ...body });
      if (replayOr(res, idem)) return;

      return withKeyLock(`case:${found.caseId}`, async () => {
        if (replayOr(res, idem)) return;
        const enc = writableEncounter(req, res, found.encounterId, 'prescription.write', action);
        if (!enc) return;
        const rx = clinicalStore.getPrescription(rxId)!;
        const result = apply(rx, body, metaFor(auth, enc));
        if (!result.ok) return rejected(res, result, rx.current.version);
        const next = result.record;
        await commit(r => clinicalStore.putPrescription(r), () => clinicalStore.putPrescription(rx), next, auth, prescriptionEvent(auth, next));
        audit(auth, action, 'ALLOWED', target(enc, 'PRESCRIPTION', rxId));
        const response = { status: 'recorded', prescription: projectPrescription(next, 'CLINICIAN', authorLookup) };
        idem.remember(200, response);
        return res.status(200).json(response);
      });
    });
  }
  router.post('/encounters/:id/prescriptions/:rxId/amend', changePrescription('prescription.amend', AmendPrescriptionCommandSchema,
    (rx, { clientRequestId: _key, expectedVersion, changeReason, ...content }, meta) => amendPrescription(rx, expectedVersion, content, changeReason, meta)));
  router.post('/encounters/:id/prescriptions/:rxId/discontinue', changePrescription('prescription.discontinue', DiscontinuePrescriptionCommandSchema,
    (rx, body, meta) => discontinuePrescription(rx, body.expectedVersion, body.changeReason, meta)));

  // ---------------------------------------------------------------- diagnostic reports
  router.get('/encounters/:id/reports', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'report.read', 'report.read');
    if (!enc) return;
    auditAccess(auth, 'report.read', target(enc, 'REPORT'));
    const list = clinicalStore.listReports(enc.encounterId)
      .filter(r => auth.role !== 'PATIENT' || r.current.patientVisible)
      .sort((a, b) => Date.parse(b.current.effectiveAt) - Date.parse(a.current.effectiveAt));
    res.json(list.map(r => projectReport(r, viewFor(auth), authorLookup, releasedDocuments(enc.encounterId))));
  });

  router.get('/encounters/:id/reports/:reportId', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'report.read', 'report.read');
    if (!enc) return;
    const report = clinicalStore.getReport(String(req.params.reportId));
    if (!report || report.encounterId !== enc.encounterId) return res.status(404).json({ error: 'not_found' });
    const decision = authorizeEncounterAction(auth, clinicalStore.encounterFacts(enc.encounterId)!, 'report.read', { patientVisible: report.current.patientVisible });
    if (!decision.allowed) {
      audit(auth, 'report.read', 'DENIED', { ...target(enc, 'REPORT', report.reportId), reasonCode: decision.code });
      return denied(res, decision);
    }
    auditAccess(auth, 'report.read', target(enc, 'REPORT', report.reportId));
    res.json(projectReport(report, viewFor(auth), authorLookup, releasedDocuments(enc.encounterId)));
  });

  router.post('/encounters/:id/reports', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'report.write', 'report.create');
    if (!found) return;
    const parsed = CreateReportCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { clientRequestId, status, ...content } = parsed.data;
    const idem = idempotent('report.create', auth, clientRequestId, { encounterId: found.encounterId, ...parsed.data });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'report.write', 'report.create');
      if (!enc) return;
      const problem = reportInputProblem(enc, content);
      if (problem) return sendProblem(res, problem);
      const report = createReport(newId('RPT'), content, status, metaFor(auth, enc));
      await commit(r => clinicalStore.putReport(r), () => clinicalStore.removeReport(report.reportId), report, auth, reportEvent(auth, report));
      audit(auth, 'report.create', 'ALLOWED', target(enc, 'REPORT', report.reportId));
      const body = { status: 'recorded', report: projectReport(report, 'CLINICIAN', authorLookup) };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  router.post('/encounters/:id/reports/:reportId/amend', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'report.write', 'report.amend');
    if (!found) return;
    const reportId = String(req.params.reportId);
    const existing = clinicalStore.getReport(reportId);
    if (!existing || existing.encounterId !== found.encounterId) return res.status(404).json({ error: 'not_found' });
    const parsed = AmendReportCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { clientRequestId, expectedVersion, changeReason, status, ...content } = parsed.data;
    const idem = idempotent('report.amend', auth, clientRequestId, { reportId, ...parsed.data });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'report.write', 'report.amend');
      if (!enc) return;
      const problem = reportInputProblem(enc, content);
      if (problem) return sendProblem(res, problem);
      const report = clinicalStore.getReport(reportId)!;
      const result = amendReport(report, expectedVersion, content, status, changeReason, metaFor(auth, enc));
      if (!result.ok) return rejected(res, result, report.current.version);
      const next = result.record;
      await commit(r => clinicalStore.putReport(r), () => clinicalStore.putReport(report), next, auth, reportEvent(auth, next));
      audit(auth, 'report.amend', 'ALLOWED', target(enc, 'REPORT', reportId));
      const body = { status: 'recorded', report: projectReport(next, 'CLINICIAN', authorLookup) };
      idem.remember(200, body);
      return res.status(200).json(body);
    });
  }));

  return router;
}
