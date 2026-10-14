/**
 * State preconditions for submitted events, shared by POST /api/events and the AWS ingestion lambda
 * (regression: a dispatch of a unit transporting CASE-A to CASE-B was accepted and silently reassigned
 * the unit, leaving CASE-A "in transit" with no ambulance; a second emergency for an open case was
 * accepted and silently ignored).
 */
import { randomUUID } from 'crypto';
import type { AmbulanceState, PatientState } from '../../packages/domain-models/src';
import type { AnyEvent } from '../../packages/event-schema/src';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { createIngestionHandler } from '../../services/api/src/lambdas/core/ingestionCore';
import { checkSubmissionState } from '../../services/api/src/submissionState';
import { check, eq, ok, run } from './helpers/assert';

const now = new Date().toISOString();
const ambulance = (ambulanceId: string, status: AmbulanceState['status'], assignedPatient?: string): AmbulanceState =>
  ({ ambulanceId, status, assignedPatient, currentLocation: { latitude: 13, longitude: 77.6 }, lastUpdated: now, provenance: [] }) as unknown as AmbulanceState;
const patient = (patientId: string, currentStatus: PatientState['currentStatus'], eventId = randomUUID()): PatientState =>
  ({ patientId, currentStatus, careRequirements: [], activeConditions: [], lastUpdated: now, provenance: [{ sourceType: 'system', sourceId: 'x', eventId, timestamp: now, confidence: 1 }] }) as PatientState;
const dispatch = (ambulanceId: string, caseId: string) =>
  ({ eventId: randomUUID(), eventType: 'ambulance.dispatched', timestamp: now, version: '1.0', source: { type: 'system', id: 'dispatch' }, payload: { ambulanceId, caseId, destination: { latitude: 13, longitude: 77.6 }, estimatedEtaMinutes: 5 } }) as unknown as AnyEvent;
const emergency = (caseId: string, eventId = randomUUID()) =>
  ({ eventId, eventType: 'patient.emergency.created', timestamp: now, version: '1.0', source: { type: 'system', id: 'dispatch' }, patientId: caseId, payload: { condition: 'x', location: { latitude: 13, longitude: 77.6 }, severity: 'HIGH' } }) as unknown as AnyEvent;

const ambs = new Map<string, AmbulanceState>([
  ['AMB-BUSY', ambulance('AMB-BUSY', 'EN_ROUTE_TO_HOSPITAL', 'CASE-A')],
  ['AMB-FREE', ambulance('AMB-FREE', 'AVAILABLE')],
  ['AMB-RELEASED', ambulance('AMB-RELEASED', 'AVAILABLE', 'CASE-OLD')],
  ['AMB-OOS', ambulance('AMB-OOS', 'UNAVAILABLE')],
]);
const appliedEmergency = randomUUID();
const pats = new Map<string, PatientState>([
  ['CASE-A', patient('CASE-A', 'IN_TRANSIT', appliedEmergency)],
  ['CASE-DONE', patient('CASE-DONE', 'DISCHARGED')],
]);
const facts = { patient: (id: string) => pats.get(id), ambulance: (id: string) => ambs.get(id) };

run('Submission state preconditions', async () => {
  await check('a unit attending another case cannot be dispatched (409 ambulance_busy); its own case can be re-sent', async () => {
    const busy = await checkSubmissionState(dispatch('AMB-BUSY', 'CASE-B'), facts);
    ok(!busy.ok && busy.error === 'ambulance_busy', 'busy unit refused');
    ok((await checkSubmissionState(dispatch('AMB-BUSY', 'CASE-A'), facts)).ok, 'same case is not a conflict');
  });

  await check('free and released units can be dispatched; an out-of-service unit cannot', async () => {
    ok((await checkSubmissionState(dispatch('AMB-FREE', 'CASE-B'), facts)).ok, 'free');
    ok((await checkSubmissionState(dispatch('AMB-RELEASED', 'CASE-B'), facts)).ok, 'released after handover');
    const oos = await checkSubmissionState(dispatch('AMB-OOS', 'CASE-B'), facts);
    ok(!oos.ok && oos.error === 'ambulance_unavailable', 'out of service');
  });

  await check('a second emergency for an open case is refused; a discharged case and a retry of the applied event are not', async () => {
    const second = await checkSubmissionState(emergency('CASE-A'), facts);
    ok(!second.ok && second.error === 'case_exists', 'open case');
    ok((await checkSubmissionState(emergency('CASE-A', appliedEmergency), facts)).ok, 'retry of the applied event passes (ledger answers duplicate)');
    ok((await checkSubmissionState(emergency('CASE-DONE'), facts)).ok, 'discharged case may reopen');
    ok((await checkSubmissionState(emergency('CASE-NEW'), facts)).ok, 'new case');
  });

  await check('the AWS ingestion lambda applies the same rule before publishing', async () => {
    const store = new LocalStateStore();
    await store.setAmbulance(ambs.get('AMB-BUSY')!);
    const puts: unknown[] = [];
    const handler = createIngestionHandler({ store, put: async e => { puts.push(e); } });
    const r = await handler({ requestContext: { authorizer: { claims: { sub: 'u-mgmt', 'cognito:groups': ['MANAGEMENT'] } } }, body: JSON.stringify(dispatch('AMB-BUSY', 'CASE-B')) });
    eq(r.statusCode, 409, 'status');
    eq(JSON.parse(r.body).error, 'ambulance_busy', 'error');
    eq(puts.length, 0, 'nothing published');
  });
});
