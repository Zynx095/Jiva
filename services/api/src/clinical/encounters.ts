import type { DataStatus, DoctorAssignment, HospitalEncounter, Practitioner } from '@jiva/domain-models';
import type { EncounterArrivalRecorded, EncounterDoctorAssigned, EncounterHandoverRecorded } from '@jiva/event-schema';
import { eventBus } from '../eventBus';
import { ambulancesStore, patientsStore } from '../stateStore';
import { closeCaseReferrals, markAmbulanceArrived, PRE_ARRIVAL } from '../stateEngines';
import { acceptanceLedger } from '../feasibility/acceptanceLedger';
import { clinicalStore } from './index';

/**
 * Encounter lifecycle (Journey A → B): pure transitions + the projector that applies the canonical
 * encounter events to the clinical store and to the operational case/ambulance state.
 *
 *   encounter.arrival.recorded  → encounter ARRIVED; case ARRIVED; the crew's unit ARRIVED (authoritative,
 *                                 basis HOSPITAL_CONFIRMED); the case's other referrals withdrawn
 *   encounter.handover.recorded → encounter IN_CARE; case HANDED_OVER; the crew is released (AVAILABLE)
 *   encounter.doctor.assigned   → assignment recorded with history (who, when, why)
 *
 * The commands (routes/encounters.ts) check every precondition before publishing; the transitions here
 * re-check them so a replayed or out-of-order event can never corrupt an encounter.
 */

export type Transition = { ok: true; next: HospitalEncounter } | { ok: false; reason: string };

const asDataStatus = (s: string | undefined): DataStatus => (s === 'SYNTHETIC_DEMO' || s === 'HOSPITAL_CONFIRMED' || s === 'AUTHORIZED_FEED' ? s : 'UNVERIFIED');

export function encounterFromArrival(
  e: EncounterArrivalRecorded,
  extras: { gpsArrivalAt?: string; referral?: HospitalEncounter['referral'] } = {},
): HospitalEncounter {
  const p = e.payload;
  return {
    encounterId: p.encounterId,
    caseId: p.caseId,
    hospitalId: p.hospitalId,
    status: 'ARRIVED',
    ...(p.ambulanceId ? { ambulanceId: p.ambulanceId } : {}),
    ...(extras.referral ? { referral: extras.referral } : {}),
    arrival: { arrivedAt: p.arrivedAt, recordedBy: p.recordedBy, eventId: e.eventId, ...(extras.gpsArrivalAt ? { gpsArrivalAt: extras.gpsArrivalAt } : {}) },
    assignmentHistory: [],
    dataStatus: asDataStatus(p.dataStatus),
    createdAt: e.timestamp,
    updatedAt: e.timestamp,
    version: 1,
  };
}

export function applyHandover(enc: HospitalEncounter, e: EncounterHandoverRecorded): Transition {
  const p = e.payload;
  if (p.encounterId !== enc.encounterId || p.caseId !== enc.caseId || p.hospitalId !== enc.hospitalId) return { ok: false, reason: 'ENCOUNTER_MISMATCH' };
  if (enc.status !== 'ARRIVED') return { ok: false, reason: 'NOT_AWAITING_HANDOVER' };
  if (Date.parse(p.handedOverAt) < Date.parse(enc.arrival.arrivedAt)) return { ok: false, reason: 'HANDOVER_BEFORE_ARRIVAL' };
  return {
    ok: true,
    next: {
      ...enc,
      status: 'IN_CARE',
      handover: { handedOverAt: p.handedOverAt, recordedBy: p.recordedBy, eventId: e.eventId, ...(p.ambulanceId ? { fromAmbulanceId: p.ambulanceId } : {}) },
      updatedAt: e.timestamp,
      version: enc.version + 1,
    },
  };
}

export function applyDoctorAssignment(enc: HospitalEncounter, e: EncounterDoctorAssigned, practitioner: Practitioner | undefined): Transition {
  const p = e.payload;
  if (p.encounterId !== enc.encounterId || p.caseId !== enc.caseId || p.hospitalId !== enc.hospitalId) return { ok: false, reason: 'ENCOUNTER_MISMATCH' };
  if (enc.status !== 'IN_CARE') return { ok: false, reason: 'NOT_HANDED_OVER' };
  if (!practitioner || practitioner.hospitalId !== enc.hospitalId || !practitioner.active) return { ok: false, reason: 'PRACTITIONER_NOT_ELIGIBLE' };
  if (enc.assignedDoctor?.practitionerId === p.practitionerId) return { ok: false, reason: 'ALREADY_ASSIGNED' };
  if ((enc.assignedDoctor?.practitionerId ?? undefined) !== p.previousPractitionerId) return { ok: false, reason: 'STALE_ASSIGNMENT' };
  const assignment: DoctorAssignment = {
    practitionerId: practitioner.practitionerId,
    displayName: practitioner.displayName,
    specialty: practitioner.specialty,
    assignedAt: p.assignedAt,
    assignedBy: p.recordedBy,
    reason: p.reason,
    eventId: e.eventId,
  };
  const history = enc.assignmentHistory.map(a => (a.endedAt || a.eventId !== enc.assignedDoctor?.eventId ? a : { ...a, endedAt: p.assignedAt }));
  return {
    ok: true,
    next: { ...enc, assignedDoctor: assignment, assignmentHistory: [...history, assignment], updatedAt: e.timestamp, version: enc.version + 1 },
  };
}

// ------------------------------------------------------------------ projector

/** GPS geofence arrivals seen per (case, hospital): kept as evidence on the encounter, never as the arrival itself. */
const gpsArrivals = new Map<string, string>();

export function resetEncounterEngine(): void {
  gpsArrivals.clear();
}


export function initializeEncounterEngine(): void {
  eventBus.on('ambulance.arrived', (e: { timestamp: string; payload: { caseId?: string; hospitalId: string; basis?: string } }) => {
    if (e.payload.caseId && e.payload.basis !== 'HOSPITAL_CONFIRMED') gpsArrivals.set(`${e.payload.caseId}|${e.payload.hospitalId}`, e.timestamp);
  });

  eventBus.on('encounter.arrival.recorded', async (e: EncounterArrivalRecorded) => {
    const p = e.payload;
    if (clinicalStore.getEncounter(p.encounterId) || clinicalStore.findEncounter(p.caseId, p.hospitalId)) {
      console.warn(`[Encounter] Arrival for ${p.caseId} at ${p.hospitalId} already recorded; ignored.`);
      return;
    }
    const view = acceptanceLedger.view(p.caseId, p.hospitalId, Date.now());
    const r = view.response;
    const referral = p.referralRequestId
      ? { requestId: p.referralRequestId, ...(r && r.requestId === p.referralRequestId ? { responseId: r.responseId, responseStatus: r.status, respondedAt: r.respondedAt } : {}) }
      : undefined;
    clinicalStore.putEncounter(encounterFromArrival(e, { gpsArrivalAt: gpsArrivals.get(`${p.caseId}|${p.hospitalId}`), referral }));

    const patient = patientsStore.get(p.caseId);
    if (patient) {
      patientsStore.set(p.caseId, {
        ...patient,
        encounterId: p.encounterId,
        assignedHospital: p.hospitalId,
        currentStatus: PRE_ARRIVAL.has(patient.currentStatus) ? 'ARRIVED' : patient.currentStatus,
        lastUpdated: e.timestamp,
      });
    }
    // The crew's unit is at this hospital and stops being routed (authoritative arrival; this also withdraws
    // the case's referrals). Without a crew still carrying the case, withdraw the referrals directly.
    const marked = p.ambulanceId ? await markAmbulanceArrived(p.ambulanceId, p.hospitalId, p.arrivedAt, 'HOSPITAL_CONFIRMED', p.caseId) : false;
    if (!marked) await closeCaseReferrals(p.caseId, p.arrivedAt);
  });

  eventBus.on('encounter.handover.recorded', (e: EncounterHandoverRecorded) => {
    const enc = clinicalStore.getEncounter(e.payload.encounterId);
    if (!enc) return console.warn(`[Encounter] Handover for unknown encounter ${e.payload.encounterId} ignored.`);
    const t = applyHandover(enc, e);
    if (!t.ok) return console.warn(`[Encounter] Handover for ${enc.encounterId} rejected: ${t.reason}.`);
    clinicalStore.putEncounter(t.next);

    const patient = patientsStore.get(enc.caseId);
    if (patient && patient.currentStatus !== 'DISCHARGED') patientsStore.set(enc.caseId, { ...patient, currentStatus: 'HANDED_OVER', lastUpdated: e.timestamp });
    // Care is transferred: the crew is released for the next job.
    const amb = enc.ambulanceId ? ambulancesStore.get(enc.ambulanceId) : undefined;
    if (amb && amb.assignedPatient === enc.caseId) {
      ambulancesStore.set(amb.ambulanceId, {
        ...amb,
        status: 'AVAILABLE',
        assignedPatient: undefined,
        destinationHospital: undefined,
        activeRoute: undefined,
        lastUpdated: e.timestamp,
        provenance: [...amb.provenance, { sourceType: e.source.type, sourceId: e.source.id, eventId: e.eventId, timestamp: e.timestamp, confidence: 1 }].slice(-50),
      });
    }
  });

  eventBus.on('encounter.doctor.assigned', (e: EncounterDoctorAssigned) => {
    const enc = clinicalStore.getEncounter(e.payload.encounterId);
    if (!enc) return console.warn(`[Encounter] Assignment for unknown encounter ${e.payload.encounterId} ignored.`);
    const t = applyDoctorAssignment(enc, e, clinicalStore.getPractitioner(e.payload.practitionerId));
    if (!t.ok) return console.warn(`[Encounter] Assignment for ${enc.encounterId} rejected: ${t.reason}.`);
    clinicalStore.putEncounter(t.next);
  });
}
