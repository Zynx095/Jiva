import { Router, type Request } from 'express';
import { randomUUID } from 'crypto';
import type { AuthContext } from '@jiva/auth';
import { AnyEventSchema, EmergencyIntakeCommandSchema, type AnyEvent } from '@jiva/event-schema';
import { authorizeEventSubmission } from '../authorizationPolicy';
import { ambulancesStore, patientsStore } from '../stateStore';
import { recordAndPublish } from '../ingest';
import { composeCondition, ambulanceCanAttend } from '../intake';
import { isWithinServiceArea, serviceArea } from '../serviceArea';
import { audit, conflict, idempotent, replayOr, validationError, withKeyLock } from '../commands/support';

type AuthedRequest = Request & { auth?: AuthContext };

/** Server-generated case reference for an emergency reported without one. */
function newCaseId(): string {
  for (;;) {
    const id = `CASE-${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`;
    if (!patientsStore.has(id)) return id;
  }
}

/**
 * Ambulance emergency intake (Journey A, step 1).
 *
 * POST /api/emergencies — the crew reports the emergency it is attending. The command validates the
 * structured intake, checks the unit can take the case and the location is inside the service area,
 * then submits a canonical `patient.emergency.created` (source = the crew's own unit) through the same
 * authorization and ingestion pipeline as POST /api/events. The state engines then derive the case,
 * the care requirement and the hospital referrals, and assign the reporting crew (ON_SCENE).
 *
 * 202 means the canonical event was recorded and published. Clients confirm the resulting case from
 * authoritative state (GET /api/patients), not from this response.
 */
export function emergencyRouter(): Router {
  const router = Router();

  router.post('/emergencies', async (req: AuthedRequest, res) => {
    const auth = req.auth!;
    if (auth.role !== 'AMBULANCE' || !auth.ambulanceId) {
      return res.status(403).json({ error: 'forbidden', message: 'Only an ambulance crew reports emergencies here. Dispatch uses POST /api/events.' });
    }
    const parsed = EmergencyIntakeCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const cmd = parsed.data;
    const ambulanceId = auth.ambulanceId;

    const idem = idempotent('emergency.report', auth, cmd.clientRequestId, cmd);
    if (replayOr(res, idem)) return;

    return withKeyLock(`ambulance:${ambulanceId}`, async () => {
      if (replayOr(res, idem)) return; // a concurrent retry finished first

      const area = serviceArea();
      if (!isWithinServiceArea(cmd.location.latitude, cmd.location.longitude, area)) {
        return res.status(422).json({ error: 'outside_service_area', message: `The location is outside the ${area.name} service area. Check the pin or the coordinates.`, area });
      }

      const amb = ambulancesStore.get(ambulanceId);
      if (!amb) return res.status(404).json({ error: 'unknown_ambulance', message: `Ambulance ${ambulanceId} is not registered with JIVA.` });
      if (!ambulanceCanAttend(amb)) {
        audit(auth, 'emergency.report', 'DENIED', { entityType: 'EMERGENCY', caseId: amb.assignedPatient, reasonCode: amb.status === 'UNAVAILABLE' ? 'AMBULANCE_OUT_OF_SERVICE' : 'AMBULANCE_BUSY' });
        return amb.status === 'UNAVAILABLE'
          ? conflict(res, 'ambulance_unavailable', `${ambulanceId} is out of service.`)
          : conflict(res, 'ambulance_busy', `${ambulanceId} is still assigned to ${amb.assignedPatient}. Complete the handover first, or ask dispatch to reassign.`, { caseId: amb.assignedPatient });
      }

      if (cmd.caseRef) {
        const existing = patientsStore.get(cmd.caseRef);
        if (existing && existing.currentStatus !== 'DISCHARGED') {
          audit(auth, 'emergency.report', 'DENIED', { entityType: 'EMERGENCY', caseId: cmd.caseRef, reasonCode: 'CASE_ALREADY_OPEN' });
          return conflict(res, 'case_exists', `${cmd.caseRef} is already an open case. Leave the reference empty to create a new one.`);
        }
      }
      const caseId = cmd.caseRef ?? newCaseId();
      const symptoms = [...new Map(cmd.reportedSymptoms.map(s => [s.toLowerCase(), s])).values()];

      const event = {
        eventId: randomUUID(),
        eventType: 'patient.emergency.created',
        timestamp: new Date().toISOString(),
        version: '1.0',
        source: { type: 'ambulance', id: ambulanceId },
        patientId: caseId,
        payload: {
          condition: composeCondition(symptoms, cmd.suspectedCause),
          location: { latitude: cmd.location.latitude, longitude: cmd.location.longitude, ...(cmd.location.address ? { address: cmd.location.address } : {}) },
          severity: cmd.severity,
          reportedSymptoms: symptoms,
          ...(cmd.suspectedCause ? { suspectedCause: cmd.suspectedCause } : {}),
          ...(cmd.requiredCapabilities.length ? { requestedCapabilities: [...new Set(cmd.requiredCapabilities)] } : {}),
          ...(cmd.notes ? { notes: cmd.notes } : {}),
          intake: {
            channel: 'AMBULANCE_CREW',
            locationMethod: cmd.location.method,
            ...(cmd.location.accuracyMeters !== undefined ? { locationAccuracyMeters: cmd.location.accuracyMeters } : {}),
          },
        },
      };

      // Defense in depth: the built event must satisfy the canonical contract and the shared policy.
      const valid = AnyEventSchema.safeParse(event);
      if (!valid.success) {
        console.error('[Intake] Built an invalid canonical event (contract drift):', valid.error.issues.slice(0, 3).map(i => i.path.join('.')).join(', '));
        return res.status(500).json({ error: 'internal_error' });
      }
      const denial = authorizeEventSubmission(auth, valid.data as AnyEvent);
      if (denial) return res.status(403).json({ error: 'forbidden', message: denial });

      await recordAndPublish(auth, valid.data as AnyEvent);
      audit(auth, 'emergency.report', 'ALLOWED', { entityType: 'EMERGENCY', caseId });

      const body = {
        status: 'accepted',
        caseId,
        eventId: event.eventId,
        // Local mode projects synchronously; these let the crew see the outcome without waiting.
        projected: patientsStore.has(caseId),
        assignedToThisAmbulance: ambulancesStore.get(ambulanceId)?.assignedPatient === caseId,
      };
      idem.remember(202, body);
      return res.status(202).json(body);
    });
  });

  return router;
}
