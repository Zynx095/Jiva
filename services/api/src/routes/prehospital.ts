import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import type { PrehospitalEntry } from '@jiva/domain-models';
import { RecordIdSchema, RecordPrehospitalCommandSchema, SimulateTelemetryCommandSchema, type PrehospitalClinical } from '@jiva/event-schema';
import { clinicalStore } from '../clinical';
import { actorFromAuth, authorizePrehospitalAction, type PrehospitalAction, type PrehospitalFacts } from '../clinical/policy';
import {
  latestPrehospital, newPrehospitalId, prehospitalEntry, prehospitalEventPayload, prehospitalTimeProblem, projectPrehospitalEntry, SIMULATED_AMBULANCE_MONITOR_ID,
} from '../clinical/prehospital';
import { simulatedReading, simulationAllowed } from '../clinical/telemetry';
import { recordProvenance } from '../clinical/views';
import { caseEncounterFacts } from '../authorization';
import { ambulancesStore, patientsStore } from '../stateStore';
import { asyncRoute, audit, auditAccess, denied, idempotent, replayOr, validationError, withKeyLock } from '../commands/support';
import { encounterFor, publishCommandEvent } from './encounters';

type AuthedRequest = Request & { auth?: AuthContext };

/** The ambulance attending the case right now: assigned to it, and the case assigned to that ambulance. */
function attendingAmbulance(caseId: string): string | undefined {
  const id = patientsStore.get(caseId)?.assignedAmbulance;
  return id && ambulancesStore.get(id)?.assignedPatient === caseId ? id : undefined;
}

const factsFor = (caseId: string): PrehospitalFacts => ({ caseId, attendingAmbulanceId: attendingAmbulance(caseId), encounters: caseEncounterFacts(caseId) });

const known = (caseId: string) => patientsStore.has(caseId) || caseEncounterFacts(caseId).length > 0;

/** Authorize, or answer 404/403 (audited) and return false. Unknown cases answer like unrelated ones. */
function authorized(req: AuthedRequest, res: Response, caseId: string, action: PrehospitalAction, auditAction: string): boolean {
  const auth = req.auth!;
  if (!RecordIdSchema.safeParse(caseId).success || !known(caseId)) {
    res.status(404).json({ error: 'not_found' });
    return false;
  }
  const decision = authorizePrehospitalAction(auth, factsFor(caseId), action);
  if (decision.allowed) return true;
  audit(auth, auditAction, 'DENIED', { entityType: 'PREHOSPITAL', caseId, reasonCode: decision.code });
  denied(res, decision);
  return false;
}

function view(caseId: string, simulationAvailable: boolean) {
  const entries = clinicalStore.listPrehospitalEntries(caseId).sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt));
  return {
    caseId,
    latest: latestPrehospital(entries, Date.now()),
    entries: entries.map(projectPrehospitalEntry),
    sources: { medicalDeviceIntegrated: false, simulationAvailable },
  };
}

/**
 * Store a pre-hospital entry and record its content-free event together (the entry is removed again if
 * the event cannot be recorded). Shared by the intake command and the en-route command.
 */
export async function recordPrehospital(
  auth: AuthContext, caseId: string, ambulanceId: string, input: PrehospitalClinical, source: PrehospitalEntry['source'],
): Promise<PrehospitalEntry> {
  const entry = prehospitalEntry(input, {
    entryId: newPrehospitalId(), caseId, ambulanceId, recordedAt: new Date().toISOString(), recordedBy: actorFromAuth(auth), source,
    ...(source === 'DEVICE_SIMULATED' ? { deviceId: SIMULATED_AMBULANCE_MONITOR_ID } : {}),
    // Simulated readings are synthetic by definition, whoever triggers them.
    dataStatus: source === 'DEVICE_SIMULATED' ? 'SYNTHETIC_DEMO' : recordProvenance(auth),
    eventId: randomUUID(),
  });
  clinicalStore.addPrehospitalEntry(entry);
  try {
    await publishCommandEvent(auth, {
      eventId: entry.eventId, eventType: 'clinical.prehospital.recorded', timestamp: entry.recordedAt, version: '1.0',
      source: { type: 'ambulance', id: ambulanceId }, patientId: caseId,
      payload: prehospitalEventPayload(entry),
    });
  } catch (err) {
    clinicalStore.removePrehospitalEntry(caseId, entry.entryId);
    throw err;
  }
  return entry;
}

const badRequest = (res: Response, path: string, message: string) => res.status(400).json({ error: 'validation_failed', issues: [{ path, message }] });

/**
 * Pre-hospital record (ambulance): vital signs with time, source and quality (or why one could not be
 * taken), and the symptom narrative. Written by the crew attending the case until the handover releases it;
 * read by that crew, the patient, and the clinician assigned to the case's encounter. No device is
 * integrated; a labelled simulated ambulance monitor exists in DEMO mode only.
 */
export function prehospitalRouter(): Router {
  const router = Router();

  router.get('/cases/:caseId/prehospital', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const caseId = String(req.params.caseId);
    if (!authorized(req, res, caseId, 'prehospital.read', 'prehospital.read')) return;
    auditAccess(auth, 'prehospital.read', { entityType: 'PREHOSPITAL', caseId });
    const crew = auth.role === 'AMBULANCE' && auth.ambulanceId === attendingAmbulance(caseId);
    res.json(view(caseId, simulationAllowed() && crew));
  });

  router.get('/encounters/:id/prehospital', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = encounterFor(req, res, 'telemetry.read', 'prehospital.read');
    if (!enc) return;
    auditAccess(auth, 'prehospital.read', { entityType: 'PREHOSPITAL', caseId: enc.caseId, encounterId: enc.encounterId, hospitalId: enc.hospitalId });
    res.json(view(enc.caseId, false));
  });

  router.post('/cases/:caseId/prehospital', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const caseId = String(req.params.caseId);
    if (!authorized(req, res, caseId, 'prehospital.write', 'prehospital.record')) return;
    const parsed = RecordPrehospitalCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { clientRequestId, ...input } = parsed.data;
    const problem = prehospitalTimeProblem(input, Date.now());
    if (problem) return badRequest(res, 'time', problem);
    const idem = idempotent('prehospital.record', auth, clientRequestId, { caseId, ...parsed.data });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${caseId}`, async () => {
      if (replayOr(res, idem)) return;
      // Re-checked under the case lock: a handover recorded meanwhile releases the crew.
      if (!authorized(req, res, caseId, 'prehospital.write', 'prehospital.record')) return;
      const entry = await recordPrehospital(auth, caseId, auth.ambulanceId!, input, 'MANUAL_CREW');
      audit(auth, 'prehospital.record', 'ALLOWED', { entityType: 'PREHOSPITAL', entityId: entry.entryId, caseId });
      const body = { status: 'recorded', entry: projectPrehospitalEntry(entry) };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  router.post('/cases/:caseId/prehospital/simulate', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    // Operational mode cannot generate measurements at all: the route does not exist there.
    if (!simulationAllowed()) return res.status(404).json({ error: 'not_found' });
    const caseId = String(req.params.caseId);
    if (!authorized(req, res, caseId, 'prehospital.write', 'prehospital.simulate')) return;
    const parsed = SimulateTelemetryCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const idem = idempotent('prehospital.simulate', auth, parsed.data.clientRequestId, { caseId });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${caseId}`, async () => {
      if (replayOr(res, idem)) return;
      if (!authorized(req, res, caseId, 'prehospital.write', 'prehospital.simulate')) return;
      const measurements = simulatedReading(`${caseId}|${randomUUID()}`, new Date());
      const entry = await recordPrehospital(auth, caseId, auth.ambulanceId!, { measurements, unavailable: [] }, 'DEVICE_SIMULATED');
      audit(auth, 'prehospital.simulate', 'ALLOWED', { entityType: 'PREHOSPITAL', entityId: entry.entryId, caseId });
      const body = { status: 'recorded', simulated: true, entry: projectPrehospitalEntry(entry) };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  return router;
}
