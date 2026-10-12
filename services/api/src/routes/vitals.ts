import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import type { HospitalEncounter, TelemetryMeasurement } from '@jiva/domain-models';
import { RecordTelemetryCommandSchema, SimulateTelemetryCommandSchema, type MeasurementInput } from '@jiva/event-schema';
import { clinicalStore } from '../clinical';
import { actorFromAuth, isAssignedClinician } from '../clinical/policy';
import {
  latestByType, measurementsFromInputs, newBatchId, observationTimeProblem, simulatedReading, simulationAllowed, SIMULATED_DEVICE_ID, type BatchContext,
} from '../clinical/telemetry';
import { recordProvenance } from '../clinical/views';
import { asyncRoute, audit, auditAccess, idempotent, replayOr, validationError, withKeyLock } from '../commands/support';
import { encounterFor, publishCommandEvent } from './encounters';
import { target, writableEncounter } from './clinicalRecords';

type AuthedRequest = Request & { auth?: AuthContext };

const MAX_LISTED = 200;

const recorderName = (m: TelemetryMeasurement) => {
  const p = m.recordedBy?.practitionerId ? clinicalStore.getPractitioner(m.recordedBy.practitionerId) : undefined;
  return p && p.hospitalId === m.hospitalId ? p.displayName : m.recordedBy ? 'Clinician' : undefined;
};

/** Clinician: full measurement. Patient: value, unit, time, source and who — never a staff user id. */
function projectMeasurement(m: TelemetryMeasurement, view: 'CLINICIAN' | 'PATIENT') {
  const name = recorderName(m);
  if (view === 'CLINICIAN') return { ...m, ...(name ? { recordedByName: name } : {}) };
  const { recordedBy: _actor, caseId: _case, hospitalId: _hospital, ...rest } = m;
  return { ...rest, ...(name ? { recordedByName: name } : {}) };
}

function telemetryEvent(auth: AuthContext, enc: HospitalEncounter, batch: TelemetryMeasurement[], ctx: BatchContext) {
  const times = batch.map(m => Date.parse(m.observedAt));
  return {
    eventId: randomUUID(), eventType: 'clinical.telemetry.recorded', timestamp: ctx.recordedAt, version: '1.0',
    source: { type: 'clinician', id: auth.practitionerId ?? auth.userId }, patientId: enc.caseId,
    payload: {
      batchId: ctx.batchId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
      recordedAt: ctx.recordedAt, recordedBy: actorFromAuth(auth), dataStatus: ctx.dataStatus,
      source: ctx.source, measurementCount: batch.length, measurementTypes: [...new Set(batch.map(m => m.type))],
      observedFrom: new Date(Math.min(...times)).toISOString(), observedTo: new Date(Math.max(...times)).toISOString(),
      ...(ctx.deviceId ? { deviceId: ctx.deviceId } : {}),
      // Values stay in the clinical store; the patient may see their own vital signs.
      patientVisible: true,
    },
  };
}

/** Store a batch and record its content-free event together (the batch is removed if the event fails). */
async function commitBatch(auth: AuthContext, enc: HospitalEncounter, inputs: MeasurementInput[], ctx: BatchContext): Promise<TelemetryMeasurement[]> {
  const batch = measurementsFromInputs(inputs, ctx);
  clinicalStore.addMeasurements(batch);
  try {
    await publishCommandEvent(auth, telemetryEvent(auth, enc, batch, ctx));
  } catch (err) {
    clinicalStore.removeMeasurementBatch(enc.encounterId, ctx.batchId);
    throw err;
  }
  return batch;
}

const batchContext = (auth: AuthContext, enc: HospitalEncounter, source: BatchContext['source']): BatchContext => ({
  batchId: newBatchId(), encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId, source,
  recordedAt: new Date().toISOString(), recordedBy: actorFromAuth(auth),
  ...(source === 'DEVICE_SIMULATED' ? { deviceId: SIMULATED_DEVICE_ID } : {}),
  // Simulated readings are synthetic by definition, whoever triggers them.
  dataStatus: source === 'DEVICE_SIMULATED' ? 'SYNTHETIC_DEMO' : recordProvenance(auth),
});

const badTime = (res: Response, message: string) => res.status(400).json({ error: 'validation_failed', issues: [{ path: 'measurements.observedAt', message }] });

/**
 * Vital signs (Phase 10): read by the assigned clinician and the patient; entered by the assigned
 * clinician (MANUAL_CLINICIAN); a labelled simulated monitor in DEMO mode only (DEVICE_SIMULATED). There is
 * no route for MEDICAL_DEVICE data: no device is integrated (see clinical/telemetry.ts for the contract).
 */
export function vitalsRouter(): Router {
  const router = Router();

  router.get('/encounters/:id/vitals', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'telemetry.read', 'telemetry.read');
    if (!enc) return;
    auditAccess(auth, 'telemetry.read', target(enc, 'TELEMETRY'));
    const all = clinicalStore.listMeasurements(enc.encounterId);
    const view = auth.role === 'PATIENT' ? 'PATIENT' : 'CLINICIAN';
    const latest = latestByType(all, Date.now());
    res.json({
      encounterId: enc.encounterId,
      latest: Object.fromEntries(Object.entries(latest).map(([k, m]) => [k, { ...projectMeasurement(m!, view), ageSeconds: m!.ageSeconds, freshness: m!.freshness }])),
      measurements: [...all].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt)).slice(0, MAX_LISTED).map(m => projectMeasurement(m, view)),
      sources: { medicalDeviceIntegrated: false, simulationAvailable: simulationAllowed() && isAssignedClinician(auth, clinicalStore.encounterFacts(enc.encounterId)!) },
    });
  });

  router.post('/encounters/:id/vitals', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'telemetry.write', 'telemetry.record');
    if (!found) return;
    const parsed = RecordTelemetryCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const timeProblem = observationTimeProblem(parsed.data.measurements, Date.now());
    if (timeProblem) return badTime(res, timeProblem);
    const idem = idempotent('telemetry.record', auth, parsed.data.clientRequestId, { encounterId: found.encounterId, ...parsed.data });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'telemetry.write', 'telemetry.record');
      if (!enc) return;
      const ctx = batchContext(auth, enc, 'MANUAL_CLINICIAN');
      const batch = await commitBatch(auth, enc, parsed.data.measurements, ctx);
      audit(auth, 'telemetry.record', 'ALLOWED', target(enc, 'TELEMETRY', ctx.batchId));
      const body = { status: 'recorded', batchId: ctx.batchId, measurements: batch.map(m => projectMeasurement(m, 'CLINICIAN')) };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  router.post('/encounters/:id/vitals/simulate', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    // Operational mode cannot generate measurements at all: the route does not exist there.
    if (!simulationAllowed()) return res.status(404).json({ error: 'not_found' });
    const found = encounterFor(req, res, 'telemetry.write', 'telemetry.simulate');
    if (!found) return;
    const parsed = SimulateTelemetryCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const idem = idempotent('telemetry.simulate', auth, parsed.data.clientRequestId, { encounterId: found.encounterId });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = writableEncounter(req, res, found.encounterId, 'telemetry.write', 'telemetry.simulate');
      if (!enc) return;
      const ctx = batchContext(auth, enc, 'DEVICE_SIMULATED');
      const batch = await commitBatch(auth, enc, simulatedReading(`${enc.encounterId}|${ctx.batchId}`, new Date()), ctx);
      audit(auth, 'telemetry.simulate', 'ALLOWED', target(enc, 'TELEMETRY', ctx.batchId));
      const body = { status: 'recorded', batchId: ctx.batchId, simulated: true, measurements: batch.map(m => projectMeasurement(m, 'CLINICIAN')) };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  return router;
}
