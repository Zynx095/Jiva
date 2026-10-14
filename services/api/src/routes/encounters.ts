import { Router, type Request, type Response } from 'express';
import { randomBytes, randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import type { HospitalEncounter } from '@jiva/domain-models';
import { AnyEventSchema, AssignDoctorCommandSchema, RecordArrivalCommandSchema, RecordHandoverCommandSchema, type AnyEvent } from '@jiva/event-schema';
import { ambulancesStore, hospitalsStore, patientsStore } from '../stateStore';
import { acceptanceLedger, isCurrentlyAccepted } from '../feasibility/acceptanceLedger';
import { recordAndPublish } from '../ingest';
import { ambulanceCase } from '../authorization';
import { clinicalStore } from '../clinical';
import {
  actorFromAuth, authorizeArrivalRecording, authorizeEncounterAction, authorizeRosterRead, encounterViewFor,
  type EncounterAction, type EncounterFacts,
} from '../clinical/policy';
import { projectEncounter, recordProvenance } from '../clinical/views';
import { asyncRoute, audit, CLOCK_SKEW_MS, conflict, denied, idempotent, replayOr, validationError, withKeyLock } from '../commands/support';

type AuthedRequest = Request & { auth?: AuthContext };

const MAX_BACKDATE_MS = 12 * 3600_000;
const hospitalName = (id: string) => hospitalsStore.get(id)?.displayName;
const facts = (e: HospitalEncounter): EncounterFacts => ({ encounterId: e.encounterId, caseId: e.caseId, hospitalId: e.hospitalId, status: e.status, assignedPractitionerId: e.assignedDoctor?.practitionerId });

/** Validate a canonical event built by a command, then record and publish it. Throws on contract drift. */
export async function publishCommandEvent(auth: AuthContext, event: Record<string, unknown>): Promise<void> {
  const parsed = AnyEventSchema.safeParse(event);
  if (!parsed.success) {
    // A command built an event its own contract rejects: a server bug, never a client error.
    throw new Error(`contract drift: ${parsed.error.issues.slice(0, 3).map(i => i.path.join('.')).join(', ')}`);
  }
  await recordAndPublish(auth, parsed.data as AnyEvent);
}

/** Resolve an encounter and authorize the action; answers 404/403 itself (with an audit entry) when not allowed. */
export function encounterFor(req: AuthedRequest, res: Response, action: EncounterAction, auditAction: string, opts: { patientVisible?: boolean } = {}): HospitalEncounter | undefined {
  const auth = req.auth!;
  const enc = clinicalStore.getEncounter(String(req.params.id));
  if (!enc) {
    res.status(404).json({ error: 'not_found' });
    return undefined;
  }
  const decision = authorizeEncounterAction(auth, facts(enc), action, { ...opts, ambulanceCaseId: ambulanceCase(auth.ambulanceId) });
  if (!decision.allowed) {
    audit(auth, auditAction, 'DENIED', { entityType: 'ENCOUNTER', entityId: enc.encounterId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId, reasonCode: decision.code });
    denied(res, decision);
    return undefined;
  }
  return enc;
}

const badTime = (res: Response, message: string) => res.status(400).json({ error: 'validation_failed', issues: [{ path: 'time', message }] });

/**
 * Hospital arrival, handover and doctor assignment (Phases 5–6), plus encounter and roster reads.
 * Every write: backend authorization → strict body → idempotency → per-case lock → state preconditions →
 * canonical event (validated) → ledger + bus → projection. The response reflects the projected state.
 */
export function encounterRouter(): Router {
  const router = Router();

  // ---------------------------------------------------------------- arrival
  router.post('/hospitals/:hospitalId/arrivals', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const hospitalId = String(req.params.hospitalId);
    const decision = authorizeArrivalRecording(auth, hospitalId);
    if (!decision.allowed) {
      audit(auth, 'encounter.arrival.record', 'DENIED', { entityType: 'ENCOUNTER', hospitalId, reasonCode: decision.code });
      return denied(res, decision);
    }
    if (!hospitalsStore.has(hospitalId)) return res.status(404).json({ error: 'not_found' });
    const parsed = RecordArrivalCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const cmd = parsed.data;
    const idem = idempotent('encounter.arrival', auth, cmd.clientRequestId, { hospitalId, ...cmd });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${cmd.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const now = Date.now();
      const patient = patientsStore.get(cmd.caseId);
      const amb = patient?.assignedAmbulance ? ambulancesStore.get(patient.assignedAmbulance) : undefined;
      const crew = amb && amb.assignedPatient === cmd.caseId ? amb : undefined;
      const routedHere = !!crew && crew.destinationHospital === hospitalId;
      // A legitimate relationship with the case: the crew is routed here, or this hospital's own answer for
      // this case stands (accepted, not expired, referral not withdrawn). Anything else could let a hospital
      // open an encounter — and gain access — for a case it has nothing to do with.
      const view = acceptanceLedger.view(cmd.caseId, hospitalId, now);
      const acceptedHere = isCurrentlyAccepted(view, now) && view.requestState !== 'REQUEST_CANCELLED';
      // Same answer for an unknown case and one not routed here: no case-existence oracle.
      if (!patient || (!routedHere && !acceptedHere && !clinicalStore.findEncounter(cmd.caseId, hospitalId))) {
        audit(auth, 'encounter.arrival.record', 'DENIED', { entityType: 'ENCOUNTER', caseId: cmd.caseId, hospitalId, reasonCode: 'NOT_ROUTED_HERE' });
        return res.status(404).json({ error: 'not_routed_here', message: 'No case with this reference is heading to, or accepted by, your hospital.' });
      }
      const existing = clinicalStore.findEncounter(cmd.caseId, hospitalId);
      if (existing) return conflict(res, 'already_recorded', `Arrival of ${cmd.caseId} was already recorded at ${existing.arrival.arrivedAt}.`, { encounterId: existing.encounterId });
      const elsewhere = clinicalStore.listEncountersByCase(cmd.caseId).find(e => e.hospitalId !== hospitalId);
      if (elsewhere) return conflict(res, 'encounter_elsewhere', `${cmd.caseId} has already arrived at another hospital.`);

      const arrivedAt = cmd.arrivedAt ?? new Date(now).toISOString();
      const reportedAt = Date.parse(patient.provenance[0]?.timestamp ?? patient.lastUpdated);
      if (Date.parse(arrivedAt) > now + CLOCK_SKEW_MS) return badTime(res, 'arrivedAt is in the future');
      if (Date.parse(arrivedAt) < reportedAt - CLOCK_SKEW_MS || Date.parse(arrivedAt) < now - MAX_BACKDATE_MS) return badTime(res, 'arrivedAt is before the emergency was reported, or more than 12 hours ago');

      const encounterId = `ENC-${hospitalId.replace(/^HOSP-/, '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
      const referral = view.request;
      await publishCommandEvent(auth, {
        eventId: randomUUID(),
        eventType: 'encounter.arrival.recorded',
        timestamp: new Date(now).toISOString(),
        version: '1.0',
        source: { type: 'hospital', id: hospitalId },
        patientId: cmd.caseId,
        payload: {
          encounterId, caseId: cmd.caseId, hospitalId,
          ...(crew ? { ambulanceId: crew.ambulanceId } : {}),
          ...(referral ? { referralRequestId: referral.requestId } : {}),
          arrivedAt, recordedBy: actorFromAuth(auth), dataStatus: recordProvenance(auth), basis: 'HOSPITAL_CONFIRMED',
        },
      });
      audit(auth, 'encounter.arrival.record', 'ALLOWED', { entityType: 'ENCOUNTER', entityId: encounterId, encounterId, caseId: cmd.caseId, hospitalId });
      const enc = clinicalStore.getEncounter(encounterId);
      const body = { status: 'recorded', encounter: enc ? projectEncounter(enc, 'FULL', hospitalName(hospitalId)) : { encounterId } };
      idem.remember(201, body);
      return res.status(201).json(body);
    });
  }));

  // ---------------------------------------------------------------- handover
  router.post('/encounters/:id/handover', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'handover.record', 'encounter.handover.record');
    if (!found) return;
    const parsed = RecordHandoverCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const cmd = parsed.data;
    const idem = idempotent('encounter.handover', auth, cmd.clientRequestId, { encounterId: found.encounterId, ...cmd });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = clinicalStore.getEncounter(found.encounterId)!;
      if (enc.status !== 'ARRIVED') return conflict(res, 'already_handed_over', `The handover of ${enc.caseId} was already recorded at ${enc.handover?.handedOverAt}.`);
      const now = Date.now();
      const handedOverAt = cmd.handedOverAt ?? new Date(now).toISOString();
      if (Date.parse(handedOverAt) > now + CLOCK_SKEW_MS) return badTime(res, 'handedOverAt is in the future');
      if (Date.parse(handedOverAt) < Date.parse(enc.arrival.arrivedAt)) return badTime(res, 'handedOverAt is before the recorded arrival');
      await publishCommandEvent(auth, {
        eventId: randomUUID(),
        eventType: 'encounter.handover.recorded',
        timestamp: new Date(now).toISOString(),
        version: '1.0',
        source: { type: 'hospital', id: enc.hospitalId },
        patientId: enc.caseId,
        payload: {
          encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
          ...(enc.ambulanceId ? { ambulanceId: enc.ambulanceId } : {}),
          handedOverAt, recordedBy: actorFromAuth(auth), dataStatus: recordProvenance(auth),
        },
      });
      // The notes stay in the clinical store (the event above is content-free and reaches the patient too).
      const recorded = clinicalStore.getEncounter(enc.encounterId);
      if (cmd.notes && recorded?.handover) clinicalStore.putEncounter({ ...recorded, handover: { ...recorded.handover, notes: cmd.notes } });
      audit(auth, 'encounter.handover.record', 'ALLOWED', { entityType: 'ENCOUNTER', entityId: enc.encounterId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId });
      const body = { status: 'recorded', encounter: projectEncounter(clinicalStore.getEncounter(enc.encounterId)!, 'FULL', hospitalName(enc.hospitalId)) };
      idem.remember(200, body);
      return res.status(200).json(body);
    });
  }));

  // ---------------------------------------------------------------- doctor assignment
  router.post('/encounters/:id/doctor', asyncRoute(async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const found = encounterFor(req, res, 'doctor.assign', 'encounter.doctor.assign');
    if (!found) return;
    const parsed = AssignDoctorCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const cmd = parsed.data;
    const idem = idempotent('encounter.doctor', auth, cmd.clientRequestId, { encounterId: found.encounterId, ...cmd });
    if (replayOr(res, idem)) return;

    return withKeyLock(`case:${found.caseId}`, async () => {
      if (replayOr(res, idem)) return;
      const enc = clinicalStore.getEncounter(found.encounterId)!;
      if (enc.status !== 'IN_CARE') return conflict(res, 'not_handed_over', 'Record the handover before assigning a doctor.');
      const pr = clinicalStore.getPractitioner(cmd.practitionerId);
      if (!pr || pr.hospitalId !== enc.hospitalId || !pr.active) {
        audit(auth, 'encounter.doctor.assign', 'DENIED', { entityType: 'ENCOUNTER', entityId: enc.encounterId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId, reasonCode: 'PRACTITIONER_NOT_ELIGIBLE' });
        return res.status(422).json({ error: 'practitioner_not_eligible', message: 'Only an active clinician on this hospital\'s roster can be assigned.' });
      }
      if (enc.assignedDoctor?.practitionerId === pr.practitionerId) return conflict(res, 'already_assigned', `${pr.displayName} is already the assigned doctor.`);
      if (!enc.assignedDoctor && cmd.reason && cmd.reason !== 'INITIAL_ASSIGNMENT') return res.status(400).json({ error: 'validation_failed', issues: [{ path: 'reason', message: 'The first assignment is INITIAL_ASSIGNMENT' }] });
      if (enc.assignedDoctor && cmd.reason === 'INITIAL_ASSIGNMENT') return res.status(400).json({ error: 'validation_failed', issues: [{ path: 'reason', message: 'A doctor is already assigned; use REASSIGNMENT, SHIFT_HANDOVER or SPECIALTY_REFERRAL' }] });
      const now = new Date().toISOString();
      await publishCommandEvent(auth, {
        eventId: randomUUID(),
        eventType: 'encounter.doctor.assigned',
        timestamp: now,
        version: '1.0',
        source: { type: 'hospital', id: enc.hospitalId },
        patientId: enc.caseId,
        payload: {
          encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId,
          practitionerId: pr.practitionerId,
          ...(enc.assignedDoctor ? { previousPractitionerId: enc.assignedDoctor.practitionerId } : {}),
          reason: enc.assignedDoctor ? cmd.reason ?? 'REASSIGNMENT' : 'INITIAL_ASSIGNMENT',
          assignedAt: now, recordedBy: actorFromAuth(auth), dataStatus: recordProvenance(auth),
        },
      });
      audit(auth, 'encounter.doctor.assign', 'ALLOWED', { entityType: 'ENCOUNTER', entityId: enc.encounterId, encounterId: enc.encounterId, caseId: enc.caseId, hospitalId: enc.hospitalId });
      const body = { status: 'assigned', encounter: projectEncounter(clinicalStore.getEncounter(enc.encounterId)!, 'FULL', hospitalName(enc.hospitalId)) };
      idem.remember(200, body);
      return res.status(200).json(body);
    });
  }));

  // ---------------------------------------------------------------- reads
  router.get('/encounters', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const amb = ambulanceCase(auth.ambulanceId);
    const caseFilter = req.query.caseId ? String(req.query.caseId) : undefined;
    const candidates =
      auth.role === 'PATIENT' ? clinicalStore.listEncountersByCase(auth.caseId ?? '')
      : auth.role === 'HOSPITAL' || auth.role === 'CLINICIAN' ? clinicalStore.listEncountersByHospital(auth.hospitalId ?? '')
      : auth.role === 'AMBULANCE' ? (amb ? clinicalStore.listEncountersByCase(amb) : [])
      : clinicalStore.listEncounters();
    const list = candidates
      .filter(e => !caseFilter || e.caseId === caseFilter)
      .map(e => ({ e, view: encounterViewFor(auth, facts(e), amb) }))
      .filter((x): x is { e: HospitalEncounter; view: NonNullable<typeof x.view> } => !!x.view)
      .sort((a, b) => Date.parse(b.e.arrival.arrivedAt) - Date.parse(a.e.arrival.arrivedAt))
      .map(({ e, view }) => projectEncounter(e, view, hospitalName(e.hospitalId)));
    res.json(list);
  });

  router.get('/encounters/:id', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const enc = clinicalStore.getEncounter(String(req.params.id));
    const view = enc && encounterViewFor(auth, facts(enc), ambulanceCase(auth.ambulanceId));
    if (!enc || !view) return res.status(404).json({ error: 'not_found' });
    res.json(projectEncounter(enc, view, hospitalName(enc.hospitalId)));
  });

  router.get('/hospitals/:hospitalId/clinicians', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    const hospitalId = String(req.params.hospitalId);
    const decision = authorizeRosterRead(auth, hospitalId);
    if (!decision.allowed) return denied(res, decision);
    const encounters = clinicalStore.listEncountersByHospital(hospitalId).filter(e => e.status === 'IN_CARE');
    res.json(clinicalStore.listPractitioners(hospitalId).map(p => ({
      ...p,
      activeEncounters: encounters.filter(e => e.assignedDoctor?.practitionerId === p.practitionerId).length,
    })));
  });

  return router;
}
