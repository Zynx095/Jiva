import { eventBus } from './eventBus';
import { patientsStore, hospitalsStore, ambulancesStore } from './stateStore';
import {
  AnyEvent,
  PatientEmergencyCreated,
  HospitalCapacityUpdated,
  AmbulanceDispatched,
  AmbulanceLocationUpdated,
  CareRequirementCreated,
  HospitalAcceptanceReceived,
  HospitalAcceptanceRequested,
} from '@jiva/event-schema';
import { AmbulanceState, CapabilityType, CareRequirement } from '@jiva/domain-models';
import { evaluateHospitals } from './eligibilityEngine';
import { mappingProvider } from './mapping';
import { v4 as uuidv4 } from 'uuid';

export { mappingProvider };

/** Sentinel used in destination.changed when no eligible accepting hospital exists. */
export const UNASSIGNED = 'UNASSIGNED';

const ARRIVAL_RADIUS_METERS = 150;
const REQUEST_TTL_MS = 15 * 60000;

/**
 * Engine-local runtime state. Everything here is cleared by resetEngines().
 * `epoch` increments on reset so that async work started before a reset
 * (e.g. a route calculation in flight) can detect it is stale and abort.
 */
const engine = {
  epoch: 0,
  processedResponseIds: new Set<string>(),
  /** Outstanding acceptance requests, keyed `${caseId}|${hospitalId}`. */
  requests: new Map<string, HospitalAcceptanceRequested['payload']>(),
  /** Requests that already received a response (request stays open so the hospital can revise). */
  answered: new Map<string, string>(),
  lastRequestIdByHospital: new Map<string, string>(),
  ambulanceLocks: new Map<string, Promise<void>>(),
};

const ms = (iso?: string) => (iso ? Date.parse(iso) : NaN);

export function getEpoch(): number {
  return engine.epoch;
}

export function resetEngines(): void {
  engine.epoch++;
  engine.processedResponseIds.clear();
  engine.requests.clear();
  engine.answered.clear();
  engine.lastRequestIdByHospital.clear();
  engine.ambulanceLocks.clear();
}

export function hasOutstandingRequest(caseId: string, hospitalId: string): boolean {
  return engine.requests.has(`${caseId}|${hospitalId}`);
}

export function outstandingRequestsForHospital(hospitalId: string) {
  return Array.from(engine.requests.entries())
    .filter(([key, r]) => r.hospitalId === hospitalId && !engine.answered.has(key))
    .map(([, r]) => r);
}

/** Cases a hospital is operationally involved in (asked to accept, or is the destination). */
export function relatedCasesForHospital(hospitalId: string): Set<string> {
  const cases = new Set<string>();
  for (const r of engine.requests.values()) if (r.hospitalId === hospitalId) cases.add(r.caseId);
  for (const a of ambulancesStore.values()) {
    if (a.destinationHospital === hospitalId && a.assignedPatient) cases.add(a.assignedPatient);
  }
  for (const h of hospitalsStore.values()) {
    if (h.hospitalId === hospitalId && h.operationalState.acceptanceCaseId) cases.add(h.operationalState.acceptanceCaseId);
  }
  return cases;
}

function publish(event: Record<string, unknown>): Promise<void> {
  return eventBus.publish({
    eventId: uuidv4(),
    timestamp: new Date().toISOString(),
    version: '1.0',
    ...event,
  } as unknown as AnyEvent);
}

/** Serialize all destination/route work per ambulance so concurrent events cannot interleave. */
function withAmbulanceLock(ambulanceId: string, fn: () => Promise<void>): Promise<void> {
  const prev = engine.ambulanceLocks.get(ambulanceId) || Promise.resolve();
  const next = prev.then(fn, fn).catch(err => {
    console.error(`[Routing] Ambulance ${ambulanceId} task failed: ${err instanceof Error ? err.message : err}`);
  });
  engine.ambulanceLocks.set(ambulanceId, next);
  return next;
}

/** Deterministic triage assessment: condition + severity -> required capabilities. */
export function assessRequiredCapabilities(condition: string, severity: string): CapabilityType[] {
  const caps: CapabilityType[] = ['EMERGENCY' as CapabilityType];
  if (/trauma|accident|injur|fracture|polytrauma|burn/i.test(condition)) caps.push('TRAUMA' as CapabilityType);
  if (severity === 'HIGH' || severity === 'CRITICAL') caps.push('ICU' as CapabilityType);
  return caps;
}

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Pick the best clinically eligible hospital that has a current, unexpired
 * ACCEPTED/LIMITED response for this ambulance's case. Mapping only orders
 * the eligible set by ETA; it never decides eligibility.
 */
async function selectDestination(amb: AmbulanceState, exclude: Set<string>): Promise<string | undefined> {
  const patient = patientsStore.get(amb.assignedPatient || '');
  if (!patient || !amb.currentLocation) return undefined;
  const requirement: CareRequirement = {
    requirementId: `sel-${amb.ambulanceId}`,
    caseId: patient.patientId,
    requiredCapabilities: patient.careRequirements as CapabilityType[],
    optionalCapabilities: [],
    severity: 'HIGH',
    createdAt: new Date().toISOString(),
    source: 'routing-engine',
  };
  const candidates = await evaluateHospitals(requirement, amb.currentLocation);
  const pick = candidates.find(c =>
    c.operationalEligibility === 'ELIGIBLE' &&
    !exclude.has(c.hospitalId) &&
    hospitalsStore.get(c.hospitalId)?.operationalState.acceptanceCaseId === patient.patientId
  );
  return pick?.hospitalId;
}

/** Compute a route to `hospitalId`, commit destination state, then publish the change. */
async function commitDestination(ambulanceId: string, hospitalId: string, reason: string, epoch: number): Promise<void> {
  const amb = ambulancesStore.get(ambulanceId);
  const hosp = hospitalsStore.get(hospitalId);
  if (!amb || !hosp?.location || !amb.currentLocation) return;
  const oldHospitalId = amb.destinationHospital || '';

  const route = await mappingProvider.calculateRoute({
    origin: amb.currentLocation,
    destination: { latitude: hosp.location.latitude, longitude: hosp.location.longitude },
    travelMode: 'DRIVING',
  });
  if (epoch !== engine.epoch) return; // reset happened while routing

  const current = ambulancesStore.get(ambulanceId);
  if (!current) return;
  const calculatedAt = new Date().toISOString();
  ambulancesStore.set(ambulanceId, {
    ...current,
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
  const patient = patientsStore.get(current.assignedPatient || '');
  if (patient) {
    patientsStore.set(patient.patientId, { ...patient, assignedHospital: hospitalId, currentStatus: 'IN_TRANSIT', lastUpdated: calculatedAt });
  }

  await publish({
    eventType: 'destination.changed',
    source: { type: 'system', id: 'routing-engine' },
    payload: { ambulanceId, hospitalId, reason },
  });
  await publish({
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

/** Assign an initial destination if the ambulance has none. */
function ensureDestination(ambulanceId: string, reason: string): Promise<void> {
  const epoch = engine.epoch;
  return withAmbulanceLock(ambulanceId, async () => {
    const amb = ambulancesStore.get(ambulanceId);
    if (!amb || amb.destinationHospital || !amb.assignedPatient || amb.status === 'ARRIVED') return;
    const target = await selectDestination(amb, new Set());
    if (epoch !== engine.epoch || !target) return;
    await commitDestination(ambulanceId, target, reason, epoch);
  });
}

/** Destination became invalid: choose the next eligible hospital, or mark unassigned. */
function rerouteAmbulance(ambulanceId: string, invalidHospitalId: string, reason: string): Promise<void> {
  const epoch = engine.epoch;
  return withAmbulanceLock(ambulanceId, async () => {
    const amb = ambulancesStore.get(ambulanceId);
    if (!amb || amb.destinationHospital !== invalidHospitalId || amb.status === 'ARRIVED') return;
    console.log(`[Rerouting] ${ambulanceId}: destination ${invalidHospitalId} invalid (${reason}).`);
    const target = await selectDestination(amb, new Set([invalidHospitalId]));
    if (epoch !== engine.epoch) return;
    if (target) {
      await commitDestination(ambulanceId, target, reason, epoch);
      return;
    }
    const current = ambulancesStore.get(ambulanceId);
    if (!current) return;
    ambulancesStore.set(ambulanceId, { ...current, destinationHospital: undefined, activeRoute: undefined, lastUpdated: new Date().toISOString() });
    await publish({
      eventType: 'destination.changed',
      source: { type: 'system', id: 'routing-engine' },
      payload: { ambulanceId, hospitalId: UNASSIGNED, reason: `${reason}; no eligible accepting hospital — awaiting responses` },
    });
  });
}

function reroutePredicate(match: (a: AmbulanceState) => boolean, hospitalId: string, reason: string) {
  for (const amb of ambulancesStore.values()) {
    if (amb.destinationHospital === hospitalId && match(amb)) void rerouteAmbulance(amb.ambulanceId, hospitalId, reason);
  }
}

// ---------------------------------------------------------------- handlers

eventBus.on('patient.emergency.created', async (event: PatientEmergencyCreated) => {
  const patientId = event.patientId || `CASE-${uuidv4().substring(0, 8).toUpperCase()}`;
  const existing = patientsStore.get(patientId);
  if (existing && existing.currentStatus !== 'DISCHARGED') {
    console.warn(`[StateEngine] Emergency for active case ${patientId} ignored (already open).`);
    return;
  }
  const { condition, severity, location } = event.payload;
  const required = assessRequiredCapabilities(condition, severity);
  patientsStore.set(patientId, {
    patientId,
    currentStatus: 'ASSESSED',
    currentLocation: { latitude: location.latitude, longitude: location.longitude },
    careRequirements: required,
    activeConditions: [condition],
    lastUpdated: event.timestamp,
    provenance: [{
      sourceType: event.source.type,
      sourceId: event.source.id,
      eventId: event.eventId,
      timestamp: event.timestamp,
      confidence: event.metadata?.confidence ?? 1.0,
    }],
  });

  await publish({
    eventType: 'care.requirement.created',
    source: { type: 'system', id: 'assessment-engine' },
    patientId,
    causationId: event.eventId,
    payload: {
      requirementId: `REQ-${uuidv4().substring(0, 8)}`,
      caseId: patientId,
      requiredCapabilities: required,
      optionalCapabilities: [],
      severity,
      createdAt: new Date().toISOString(),
    },
  });
});

eventBus.on('care.requirement.created', async (event: CareRequirementCreated) => {
  const epoch = engine.epoch;
  const req = event.payload;
  const patient = patientsStore.get(req.caseId);
  const origin = patient?.currentLocation || { latitude: 12.9716, longitude: 77.5946 };

  const candidates = await evaluateHospitals({
    requirementId: req.requirementId,
    caseId: req.caseId,
    requiredCapabilities: req.requiredCapabilities as CapabilityType[],
    optionalCapabilities: req.optionalCapabilities as CapabilityType[],
    severity: req.severity,
    createdAt: req.createdAt,
    source: event.source.id,
  }, origin);
  if (epoch !== engine.epoch) return;

  await publish({
    eventType: 'hospital.candidate.generated',
    source: { type: 'system', id: 'eligibility-engine' },
    causationId: event.eventId,
    payload: {
      caseId: req.caseId,
      candidates: candidates.map(c => ({
        hospitalId: c.hospitalId,
        hospitalName: c.hospitalName,
        capabilityMatch: c.capabilityMatch,
        missingCapabilities: c.missingCapabilities,
        operationalEligibility: c.operationalEligibility,
        distanceKm: c.distanceKm,
        etaMinutes: c.etaMinutes,
        reason: c.reason,
      })),
    },
  });

  // Only clinically capable, not operationally unavailable hospitals are asked.
  for (const c of candidates) {
    if (c.missingCapabilities.length > 0 || c.operationalEligibility === 'INELIGIBLE') continue;
    const payload = {
      requestId: `AR-${uuidv4().substring(0, 8)}`,
      caseId: req.caseId,
      hospitalId: c.hospitalId,
      requiredCapabilities: req.requiredCapabilities,
      optionalCapabilities: req.optionalCapabilities,
      ambulanceEtaMinutes: c.etaMinutes,
      requestedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS).toISOString(),
    };
    engine.requests.set(`${req.caseId}|${c.hospitalId}`, payload);
    await publish({
      eventType: 'hospital.acceptance.requested',
      source: { type: 'system', id: 'acceptance-protocol' },
      causationId: event.eventId,
      payload,
    });
  }
});

eventBus.on('hospital.acceptance.received', async (event: HospitalAcceptanceReceived) => {
  const p = event.payload;
  if (engine.processedResponseIds.has(p.responseId)) {
    console.warn(`[Acceptance] Duplicate response ${p.responseId} ignored.`);
    return;
  }
  const existing = hospitalsStore.get(p.hospitalId);
  if (!existing) return;
  const op = existing.operationalState;

  // Older than the response already applied -> stale, never overwrite.
  if (op.acceptanceAsOf && ms(p.respondedAt) < ms(op.acceptanceAsOf)) {
    console.warn(`[Acceptance] Stale response from ${p.hospitalId} (${p.respondedAt} < ${op.acceptanceAsOf}) ignored.`);
    return;
  }
  // A response that is already past its validity window is not current evidence.
  if ((p.status === 'ACCEPTED' || p.status === 'LIMITED') && ms(p.validUntil) <= Date.now()) {
    console.warn(`[Acceptance] Response ${p.responseId} from ${p.hospitalId} arrived already expired; ignored.`);
    return;
  }
  engine.processedResponseIds.add(p.responseId);
  engine.answered.set(`${p.caseId}|${p.hospitalId}`, p.status);
  engine.lastRequestIdByHospital.set(p.hospitalId, p.requestId);

  hospitalsStore.set(p.hospitalId, {
    ...existing,
    operationalState: {
      ...op,
      acceptance: p.status,
      acceptanceAsOf: p.respondedAt,
      acceptanceCaseId: p.caseId,
      lastConfirmedAt: p.respondedAt,
      expiresAt: p.validUntil,
      source: p.source,
    },
    provenance: [...existing.provenance, {
      sourceType: event.source.type,
      sourceId: event.source.id,
      sourceName: 'Acceptance Protocol',
      retrievedAt: new Date().toISOString(),
      asOf: p.respondedAt,
      verificationStatus: p.source,
      confidence: 1.0,
    }],
  });

  if (p.status === 'ACCEPTED' || p.status === 'LIMITED') {
    for (const amb of ambulancesStore.values()) {
      if (amb.assignedPatient === p.caseId && !amb.destinationHospital) {
        void ensureDestination(amb.ambulanceId, `Hospital ${p.hospitalId} ${p.status} the acceptance request`);
      }
    }
  } else if (p.status === 'REJECTED') {
    reroutePredicate(a => a.assignedPatient === p.caseId, p.hospitalId, `Destination ${p.hospitalId} REJECTED the case`);
  } else if (p.status === 'UNAVAILABLE') {
    reroutePredicate(() => true, p.hospitalId, `Destination ${p.hospitalId} reported UNAVAILABLE`);
  }
});

eventBus.on('hospital.capacity.updated', async (event: HospitalCapacityUpdated) => {
  const p = event.payload;
  const existing = hospitalsStore.get(p.hospitalId);
  if (!existing) return;
  const op = existing.operationalState;
  if (op.capacityAsOf && ms(event.timestamp) < ms(op.capacityAsOf)) {
    console.warn(`[Capacity] Stale capacity update for ${p.hospitalId} (${event.timestamp} < ${op.capacityAsOf}) ignored.`);
    return;
  }

  hospitalsStore.set(p.hospitalId, {
    ...existing,
    operationalState: {
      ...op,
      emergency: p.emergencyStatus,
      trauma: p.traumaStatus,
      icu: p.icuStatus,
      ventilator: p.ventilatorStatus,
      capacityAsOf: event.timestamp,
    },
    provenance: [...existing.provenance, {
      sourceType: event.source.type,
      sourceId: event.source.id,
      sourceName: 'Capacity Update',
      retrievedAt: new Date().toISOString(),
      asOf: event.timestamp,
      verificationStatus: (event.metadata?.sourceType as any) || 'UNVERIFIED',
      confidence: event.metadata?.confidence ?? 1.0,
    }],
  });

  if (p.emergencyStatus === 'UNAVAILABLE' || p.icuStatus === 'UNAVAILABLE' || p.traumaStatus === 'UNAVAILABLE') {
    // Only reroute when the lost capability is one the case actually needs.
    reroutePredicate(a => {
      const reqs = patientsStore.get(a.assignedPatient || '')?.careRequirements || [];
      return p.emergencyStatus === 'UNAVAILABLE' ||
        (p.icuStatus === 'UNAVAILABLE' && reqs.includes('ICU')) ||
        (p.traumaStatus === 'UNAVAILABLE' && reqs.includes('TRAUMA'));
    }, p.hospitalId, `Destination ${p.hospitalId} capacity became UNAVAILABLE`);
  }
});

eventBus.on('ambulance.dispatched', async (event: AmbulanceDispatched) => {
  const { ambulanceId, caseId } = event.payload;
  const existing = ambulancesStore.get(ambulanceId);
  if (!existing) return;
  ambulancesStore.set(ambulanceId, {
    ...existing,
    status: 'DISPATCHED',
    assignedPatient: caseId || existing.assignedPatient,
    // A new dispatch starts a new journey: never carry over a previous case's destination.
    destinationHospital: caseId && caseId !== existing.assignedPatient ? undefined : existing.destinationHospital,
    activeRoute: caseId && caseId !== existing.assignedPatient ? undefined : existing.activeRoute,
    lastUpdated: event.timestamp,
    provenance: [...existing.provenance, {
      sourceType: event.source.type,
      sourceId: event.source.id,
      eventId: event.eventId,
      timestamp: event.timestamp,
      confidence: event.metadata?.confidence ?? 1.0,
    }].slice(-50),
  });
  if (caseId) {
    const patient = patientsStore.get(caseId);
    if (patient) patientsStore.set(caseId, { ...patient, assignedAmbulance: ambulanceId, lastUpdated: event.timestamp });
    // A hospital may have accepted before the ambulance was dispatched.
    void ensureDestination(ambulanceId, 'Destination assigned from existing acceptance');
  }
});

eventBus.on('ambulance.location.updated', async (event: AmbulanceLocationUpdated) => {
  const { ambulanceId, coordinates, heading, speedKmh } = event.payload;
  const existing = ambulancesStore.get(ambulanceId);
  if (!existing) return;
  // GPS must never move backwards in time. Location updates do NOT trigger route recalculation.
  if (existing.locationAsOf && ms(event.timestamp) < ms(existing.locationAsOf)) {
    console.warn(`[Telemetry] Stale GPS for ${ambulanceId} (${event.timestamp} < ${existing.locationAsOf}) ignored.`);
    return;
  }
  const updated: AmbulanceState = {
    ...existing,
    currentLocation: { latitude: coordinates.latitude, longitude: coordinates.longitude },
    heading,
    speedKmh,
    locationAsOf: event.timestamp,
    lastUpdated: event.timestamp,
  };
  ambulancesStore.set(ambulanceId, updated);

  const dest = updated.destinationHospital ? hospitalsStore.get(updated.destinationHospital) : undefined;
  if (dest?.location && updated.status !== 'ARRIVED' &&
      distanceMeters(updated.currentLocation!, dest.location) <= ARRIVAL_RADIUS_METERS) {
    ambulancesStore.set(ambulanceId, { ...updated, status: 'ARRIVED' });
    const patient = patientsStore.get(updated.assignedPatient || '');
    if (patient) patientsStore.set(patient.patientId, { ...patient, currentStatus: 'ARRIVED', lastUpdated: event.timestamp });
    await publish({
      eventType: 'ambulance.arrived',
      source: { type: 'system', id: 'telemetry-engine' },
      patientId: updated.assignedPatient,
      payload: { ambulanceId, hospitalId: dest.hospitalId, caseId: updated.assignedPatient },
    });
  }
});

// ---------------------------------------------------------------- expiration

let expiryTimer: NodeJS.Timeout | undefined;

export function checkAcceptanceExpiry(now = Date.now()): void {
  for (const [hospitalId, hospital] of hospitalsStore.entries()) {
    const op = hospital.operationalState;
    if ((op.acceptance === 'ACCEPTED' || op.acceptance === 'LIMITED') && op.expiresAt && ms(op.expiresAt) < now) {
      console.log(`[Expiration] Hospital ${hospitalId} acceptance expired -> UNKNOWN.`);
      // Expired evidence becomes UNKNOWN, never AVAILABLE/UNAVAILABLE. Watermark kept so
      // older responses cannot resurrect the acceptance.
      hospitalsStore.set(hospitalId, { ...hospital, operationalState: { ...op, acceptance: 'UNKNOWN' } });
      void publish({
        eventType: 'hospital.acceptance.expired',
        source: { type: 'system', id: 'expiration-engine' },
        payload: { requestId: engine.lastRequestIdByHospital.get(hospitalId) || 'unknown', hospitalId },
      });
      reroutePredicate(() => true, hospitalId, `Acceptance from ${hospitalId} expired`);
    }
  }
  for (const [key, req] of engine.requests) {
    if (ms(req.expiresAt) < now) {
      engine.requests.delete(key);
      engine.answered.delete(key);
    }
  }
}

export function initializeStateEngines() {
  console.log('[StateEngines] Initialized local state engines listening to event bus.');
  if (expiryTimer) clearInterval(expiryTimer);
  const interval = parseInt(process.env.ACCEPTANCE_EXPIRY_CHECK_MS || '2000', 10);
  expiryTimer = setInterval(() => checkAcceptanceExpiry(), interval);
  expiryTimer.unref?.();
}
