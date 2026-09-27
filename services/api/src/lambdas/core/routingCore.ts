import type { AmbulanceState } from '@jiva/domain-models';
import { evaluateHospitals } from '../../eligibilityEngine';
import { pickLegacyDestination, selectionRequirement, UNASSIGNED } from '../../stateTransitions';
import { observeValue } from '../../feasibility/containment';
import { LambdaDeps, nowIso, publishSystem } from './deps';
import { caseAcceptanceStatus } from '../../feasibility/acceptanceLedger';
import { loadAcceptanceView } from './deps';

export { UNASSIGNED };

/**
 * AWS destination orchestration. The DECISIONS are the shared ones (evaluateHospitals +
 * pickLegacyDestination, identical to the local engine); only store/bus I/O differs. The Care
 * Feasibility Engine runs in shadow alongside the pick and never influences it.
 */
export async function selectDestination(
  d: LambdaDeps,
  amb: AmbulanceState,
  exclude: Set<string>,
  reason: string
): Promise<string | undefined> {
  const patient = await d.store.getPatient(amb.assignedPatient || '');
  if (!patient || !amb.currentLocation) return undefined;
  const hospitals = await d.store.listHospitals();
  const byId = new Map(hospitals.map(h => [h.hospitalId, h]));
  const requirement = selectionRequirement(amb.ambulanceId, patient.patientId, patient.careRequirements, nowIso(d));
  const nowForAcceptance = Date.now();
  const acceptanceView = await loadAcceptanceView(d.store, patient.patientId, hospitals.map(h => h.hospitalId), nowForAcceptance);
  const candidates = await evaluateHospitals(requirement, amb.currentLocation, {
    hospitals, mapping: d.mapping,
    acceptanceOverride: hospitalId => caseAcceptanceStatus(acceptanceView.view(patient.patientId, hospitalId, nowForAcceptance), nowForAcceptance),
  });
  const pick = pickLegacyDestination(candidates, exclude, patient.patientId, id => byId.get(id));

  if (d.shadow) {
    // Shadow only: sees the SAME hospital snapshot the legacy pick used; compares, never alters.
    // EVERYTHING here is auxiliary: the requirement-history read, the evaluation and the trace
    // publication are contained and time-bounded, so the legacy pick above is always returned.
    const shadow = d.shadow;
    await observeValue('shadow.destination-selection', async () => {
      const shadowRequirement = await shadow.bounded(() => shadow.resolveRequirement(patient.patientId));
      await shadow.evaluate({
        context: 'destination-selection',
        requirement: shadowRequirement || requirement,
        requirementProvenance: 'RULE_DERIVED',
        trigger: { eventId: 'n/a', eventType: 'destination.selection', sourceId: `routing-engine:${reason}`, sourceType: 'system' },
        origin: amb.currentLocation,
        originAsOf: amb.locationAsOf,
        ambulanceId: amb.ambulanceId,
        excludedHospitalIds: [...exclude],
        hospitals,
        legacyCandidates: candidates,
        legacySelection: { hospitalId: pick },
      });
    }, undefined);
  }
  return pick;
}

/** Compute a route to `hospitalId`, commit destination state, then publish the change. */
export async function commitDestination(d: LambdaDeps, ambulanceId: string, hospitalId: string, reason: string): Promise<void> {
  const amb = await d.store.getAmbulance(ambulanceId);
  const hosp = await d.store.getHospital(hospitalId);
  if (!amb || !hosp?.location || !amb.currentLocation) return;
  const oldHospitalId = amb.destinationHospital || '';

  const route = await d.mapping.calculateRoute({
    origin: amb.currentLocation,
    destination: { latitude: hosp.location.latitude, longitude: hosp.location.longitude },
    travelMode: 'DRIVING',
  });

  const calculatedAt = nowIso(d);
  await d.store.setAmbulance({
    ...amb,
    destinationHospital: hospitalId,
    status: 'EN_ROUTE_TO_HOSPITAL',
    activeRoute: {
      hospitalId,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      coordinates: route.coordinates,
      provider: route.provider,
      sourceType: route.sourceType,
      synthetic: route.synthetic,
      trafficAware: route.trafficAware ?? false,
      calculatedAt,
    },
    lastUpdated: calculatedAt,
  });
  const patient = await d.store.getPatient(amb.assignedPatient || '');
  if (patient) {
    await d.store.setPatient({ ...patient, assignedHospital: hospitalId, currentStatus: 'IN_TRANSIT', lastUpdated: calculatedAt });
  }

  await publishSystem(d, {
    eventType: 'destination.changed',
    source: { type: 'system', id: 'routing-engine' },
    payload: { ambulanceId, hospitalId, reason },
  });
  await publishSystem(d, {
    eventType: 'route.recalculated',
    source: { type: 'system', id: 'routing-engine' },
    payload: {
      ambulanceId,
      oldHospitalId,
      newHospitalId: hospitalId,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      polyline: route.polyline,
      coordinates: route.coordinates,
      provider: route.provider,
      sourceType: route.sourceType,
      synthetic: route.synthetic,
      trafficAware: route.trafficAware ?? false,
      reason,
    },
  });
}

/**
 * Per-ambulance task containment, as in the local engine (withAmbulanceLock's catch): a failed route
 * calculation is logged and never fails the lambda. Failing it would be pointless anyway — the
 * EventBridge retry would hit the idempotency guard (eventId already recorded) and be skipped.
 */
async function contained(ambulanceId: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[Routing] Ambulance ${ambulanceId} task failed: ${err instanceof Error ? err.message : err}`);
  }
}

/** Assign an initial destination if the ambulance has none. */
export function ensureDestination(d: LambdaDeps, ambulanceId: string, reason: string): Promise<void> {
  return contained(ambulanceId, () => ensureDestinationUnsafe(d, ambulanceId, reason));
}

async function ensureDestinationUnsafe(d: LambdaDeps, ambulanceId: string, reason: string): Promise<void> {
  const amb = await d.store.getAmbulance(ambulanceId);
  if (!amb || amb.destinationHospital || !amb.assignedPatient || amb.status === 'ARRIVED') return;
  const target = await selectDestination(d, amb, new Set(), reason);
  if (target) await commitDestination(d, ambulanceId, target, reason);
}

/** Destination became invalid: choose the next eligible hospital, or mark unassigned. */
export function rerouteAmbulance(d: LambdaDeps, ambulanceId: string, invalidHospitalId: string, reason: string): Promise<void> {
  return contained(ambulanceId, () => rerouteAmbulanceUnsafe(d, ambulanceId, invalidHospitalId, reason));
}

async function rerouteAmbulanceUnsafe(d: LambdaDeps, ambulanceId: string, invalidHospitalId: string, reason: string): Promise<void> {
  const amb = await d.store.getAmbulance(ambulanceId);
  if (!amb || amb.destinationHospital !== invalidHospitalId || amb.status === 'ARRIVED') return;
  console.log(`[Rerouting] ${ambulanceId}: destination ${invalidHospitalId} invalid (${reason}).`);
  const target = await selectDestination(d, amb, new Set([invalidHospitalId]), reason);
  if (target) {
    await commitDestination(d, ambulanceId, target, reason);
    return;
  }
  const current = await d.store.getAmbulance(ambulanceId);
  if (!current) return;
  await d.store.setAmbulance({ ...current, destinationHospital: undefined, activeRoute: undefined, lastUpdated: nowIso(d) });
  await publishSystem(d, {
    eventType: 'destination.changed',
    source: { type: 'system', id: 'routing-engine' },
    payload: { ambulanceId, hospitalId: UNASSIGNED, reason: `${reason}; no eligible accepting hospital — awaiting responses` },
  });
}

/** Reroute every ambulance whose destination is `hospitalId` and matches the predicate. */
export async function reroutePredicate(
  d: LambdaDeps,
  match: (a: AmbulanceState) => boolean | Promise<boolean>,
  hospitalId: string,
  reason: string
): Promise<void> {
  for (const amb of await d.store.listAmbulances()) {
    if (amb.destinationHospital === hospitalId && (await match(amb))) await rerouteAmbulance(d, amb.ambulanceId, hospitalId, reason);
  }
}
