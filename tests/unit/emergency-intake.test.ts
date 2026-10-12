/**
 * Phase 2 — emergency intake rules (shared by the local engine and the AWS emergency lambda):
 *  - the care requirement is the frozen rule-based assessment PLUS what the crew asked for, never less
 *  - symptoms and the suspected cause stay separate; the cause is always labelled "Suspected"
 *  - the reporting crew is assigned only when free to attend
 *  - the service-area guard
 */
import { randomUUID } from 'crypto';
import type { PatientEmergencyCreated } from '../../packages/event-schema/src';
import { ambulanceCanAttend, composeCondition, deriveCareRequirement, patientFromEmergency, reportingAmbulanceOf } from '../../services/api/src/intake';
import { assessRequiredCapabilities } from '../../services/api/src/stateTransitions';
import { isWithinServiceArea, serviceArea } from '../../services/api/src/serviceArea';
import { check, eq, ok, run } from './helpers/assert';

const emergency = (payload: Partial<PatientEmergencyCreated['payload']>, source = { type: 'ambulance' as const, id: 'AMB-BLR-001' }): PatientEmergencyCreated => ({
  eventId: randomUUID(),
  eventType: 'patient.emergency.created',
  timestamp: '2026-10-12T10:00:00.000Z',
  version: '1.0',
  source,
  patientId: 'CASE-T1',
  payload: { condition: 'x', location: { latitude: 13.04, longitude: 77.59 }, severity: 'HIGH', ...payload },
});

run('Phase 2 — emergency intake rules', async () => {
  await check('rule-derived capabilities are always kept; reporter additions are appended once', () => {
    const r = deriveCareRequirement({ condition: 'Suspected: road traffic accident · Reported: bleeding', severity: 'CRITICAL', requestedCapabilities: ['ORTHOPAEDICS', 'ICU', 'ORTHOPAEDICS'] });
    eq(r.ruleDerived, ['EMERGENCY', 'TRAUMA', 'ICU'], 'frozen legacy assessment');
    eq(r.reporterRequested, ['ORTHOPAEDICS', 'ICU'], 'deduplicated reporter list');
    eq(r.required, ['EMERGENCY', 'TRAUMA', 'ICU', 'ORTHOPAEDICS'], 'union, rule-derived first, no duplicates');
  });

  await check('without reporter input the requirement is exactly the legacy assessment (existing flows unchanged)', () => {
    for (const [condition, severity] of [['Severe polytrauma', 'CRITICAL'], ['Cardiac arrest', 'HIGH'], ['Fever', 'LOW']] as const) {
      eq(deriveCareRequirement({ condition, severity }).required, assessRequiredCapabilities(condition, severity), `${condition}/${severity}`);
    }
  });

  await check('a reporter cannot remove a rule-derived need (an empty request still yields the rules)', () => {
    eq(deriveCareRequirement({ condition: 'fracture', severity: 'HIGH', requestedCapabilities: [] }).required, ['EMERGENCY', 'TRAUMA', 'ICU'], 'rules kept');
  });

  await check('condition line keeps the suspected cause labelled as unconfirmed and separate from symptoms', () => {
    eq(composeCondition(['chest pain', 'sweating'], 'Cardiac event'), 'Suspected: Cardiac event · Reported: chest pain, sweating', 'with cause');
    eq(composeCondition(['seizure']), 'Reported: seizure', 'without cause');
  });

  await check('patient state from a crew intake: symptoms, suspected cause, requested care and intake provenance are separate fields', () => {
    const e = emergency({
      condition: composeCondition(['chest pain'], 'Cardiac event'),
      reportedSymptoms: ['chest pain'], suspectedCause: 'Cardiac event', requestedCapabilities: ['CARDIOLOGY'], notes: 'Conscious',
      intake: { channel: 'AMBULANCE_CREW', locationMethod: 'DEVICE_GPS', locationAccuracyMeters: 12 },
    });
    const req = deriveCareRequirement(e.payload);
    const p = patientFromEmergency(e, 'CASE-T1', req);
    eq(p.reportedSymptoms, ['chest pain'], 'symptoms');
    eq(p.suspectedCause, 'Cardiac event', 'suspected cause');
    eq(p.requestedCapabilities, ['CARDIOLOGY'], 'requested care');
    eq(p.careRequirements, ['EMERGENCY', 'ICU', 'CARDIOLOGY'], 'requirement');
    eq(p.intake, { channel: 'AMBULANCE_CREW', reportedByAmbulanceId: 'AMB-BLR-001', locationMethod: 'DEVICE_GPS', locationAccuracyMeters: 12, notes: 'Conscious' }, 'intake provenance');
    eq(p.currentStatus, 'ASSESSED', 'status');
    ok(!('diagnosis' in p), 'no diagnosis field is ever produced');
  });

  await check('legacy dispatch-reported emergency projects exactly the legacy patient shape (no new fields)', () => {
    const e = emergency({ condition: 'Severe polytrauma', severity: 'CRITICAL' }, { type: 'system', id: 'dispatch' } as never);
    const p = patientFromEmergency(e, 'CASE-T1', deriveCareRequirement(e.payload));
    eq(Object.keys(p).sort(), ['activeConditions', 'careRequirements', 'currentLocation', 'currentStatus', 'lastUpdated', 'patientId', 'provenance'], 'legacy keys only');
  });

  await check('only an ambulance source identifies a reporting crew', () => {
    eq(reportingAmbulanceOf(emergency({})), 'AMB-BLR-001', 'crew');
    eq(reportingAmbulanceOf(emergency({}, { type: 'system', id: 'dispatch' } as never)), undefined, 'dispatch');
  });

  await check('a crew can attend only when free: available, not out of service, no active assignment', () => {
    ok(ambulanceCanAttend({ status: 'AVAILABLE' }), 'available');
    ok(ambulanceCanAttend({ status: 'AVAILABLE', assignedPatient: 'CASE-OLD' }), 'available after release');
    ok(!ambulanceCanAttend({ status: 'UNAVAILABLE' }), 'out of service');
    ok(!ambulanceCanAttend({ status: 'EN_ROUTE_TO_HOSPITAL', assignedPatient: 'CASE-1' }), 'on a job');
    ok(!ambulanceCanAttend({ status: 'ARRIVED', assignedPatient: 'CASE-1' }), 'arrived but not handed over');
    ok(!ambulanceCanAttend(undefined), 'unknown unit');
  });

  await check('service area: default Bengaluru Urban box, override via env, malformed override ignored', () => {
    ok(isWithinServiceArea(13.0431, 77.5891), 'Hebbal inside');
    ok(!isWithinServiceArea(19.076, 72.8777), 'Mumbai outside');
    ok(!isWithinServiceArea(0, 0), 'null island outside');
    const prev = process.env.JIVA_SERVICE_AREA;
    try {
      process.env.JIVA_SERVICE_AREA = '18.8,72.7,19.3,73.1,Mumbai';
      ok(isWithinServiceArea(19.076, 72.8777), 'override applies');
      eq(serviceArea().name, 'Mumbai', 'override name');
      process.env.JIVA_SERVICE_AREA = 'nonsense';
      eq(serviceArea().name, 'Bengaluru Urban', 'malformed override ignored');
    } finally {
      if (prev === undefined) delete process.env.JIVA_SERVICE_AREA;
      else process.env.JIVA_SERVICE_AREA = prev;
    }
  });
});
