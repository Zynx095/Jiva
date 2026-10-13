/**
 * Phase 12 — AWS realtime isolation: the WebSocket fan-out applies the same per-principal rules as the
 * local Socket.IO server, fails closed without a verified principal, and never stores a token.
 */
import { randomUUID } from 'crypto';
import type { AnyEvent } from '../../packages/event-schema/src';
import { setCustomVerifier } from '../../services/api/src/authVerification';
import { deliveriesFor, principalFromConnect, type ConnectionRecord } from '../../services/api/src/lambdas/websocketHandler';
import { check, eq, ok, run } from './helpers/assert';

const ev = (eventType: string, payload: Record<string, unknown>, patientId?: string): AnyEvent =>
  ({ eventId: randomUUID(), eventType, timestamp: new Date().toISOString(), version: '1.0', source: { type: 'system', id: 'test' }, ...(patientId ? { patientId } : {}), payload }) as unknown as AnyEvent;

const connections: ConnectionRecord[] = [
  { connectionId: 'patient-A', principal: { userId: 'p-a', role: 'PATIENT', caseId: 'CASE-A' } },
  { connectionId: 'patient-B', principal: { userId: 'p-b', role: 'PATIENT', caseId: 'CASE-B' } },
  { connectionId: 'hosp-1', principal: { userId: 'h-1', role: 'HOSPITAL', hospitalId: 'HOSP-1' } },
  { connectionId: 'hosp-2', principal: { userId: 'h-2', role: 'HOSPITAL', hospitalId: 'HOSP-2' } },
  { connectionId: 'mgmt', principal: { userId: 'm', role: 'MANAGEMENT' } },
  { connectionId: 'anonymous' },
];
const to = (e: AnyEvent) => deliveriesFor(connections, e).map(d => d.connectionId).sort();

run('Phase 12 — AWS realtime isolation', async () => {
  await check('a case event reaches only that patient and network coordination; never another patient or an anonymous connection', () => {
    eq(to(ev('patient.emergency.created', { condition: 'Reported: chest pain', location: { latitude: 1, longitude: 1 }, severity: 'HIGH' }, 'CASE-A')), ['mgmt', 'patient-A'], 'emergency');
  });

  await check("a referral reaches only the hospital asked (and coordination), not another hospital", () => {
    eq(to(ev('hospital.acceptance.requested', { requestId: 'AR-1', caseId: 'CASE-A', hospitalId: 'HOSP-1', requiredCapabilities: [], optionalCapabilities: [], requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString() })), ['hosp-1', 'mgmt'], 'referral');
  });

  await check("encounter events: the patient's copy names the role only; another hospital gets nothing", () => {
    const arrival = ev('encounter.arrival.recorded', { encounterId: 'ENC-1', caseId: 'CASE-A', hospitalId: 'HOSP-1', arrivedAt: new Date().toISOString(), recordedBy: { userId: 'staff-7', role: 'HOSPITAL', hospitalId: 'HOSP-1' }, basis: 'HOSPITAL_CONFIRMED' }, 'CASE-A');
    const d = deliveriesFor(connections, arrival);
    eq(d.map(x => x.connectionId).sort(), ['hosp-1', 'mgmt', 'patient-A'], 'recipients');
    const copy = (id: string) => JSON.parse(d.find(x => x.connectionId === id)!.data).data;
    eq(copy('patient-A').payload.recordedBy, { role: 'HOSPITAL', hospitalId: 'HOSP-1' }, 'patient copy');
    eq(copy('hosp-1').payload.recordedBy.userId, 'staff-7', 'same-hospital staff copy');
  });

  await check('clinical record events: the released patient by case id only — never coordination or another hospital; clinicians need encounter state the fan-out does not hold (fail closed)', () => {
    eq(to(ev('clinical.prescription.recorded', { prescriptionId: 'RX-1', encounterId: 'ENC-1', caseId: 'CASE-A', hospitalId: 'HOSP-1', recordedAt: new Date().toISOString(), recordedBy: { userId: 'd', role: 'CLINICIAN' }, version: 1, action: 'CREATED', status: 'ACTIVE', contentHash: 'a'.repeat(64), patientVisible: true }, 'CASE-A')), ['patient-A'], 'only the patient, by case id; never coordination');
  });

  await check('$connect: unsigned and absent credentials give no principal; a verified token does; demo personas only in demo mode', async () => {
    eq(await principalFromConnect({ headers: {} }), undefined, 'no credentials');
    eq(await principalFromConnect({ headers: { 'x-cognito-claims': '{"cognito:groups":["ADMIN"]}' } }), undefined, 'unsigned claims refused');
    setCustomVerifier({ verify: async (t: string) => (t === 'good' ? { authenticated: true, context: { userId: 'u1', role: 'HOSPITAL', hospitalId: 'HOSP-1' } } : { authenticated: false, error: 'bad' }) } as never);
    try {
      eq(await principalFromConnect({ queryStringParameters: { token: 'good' } }), { userId: 'u1', role: 'HOSPITAL', hospitalId: 'HOSP-1' }, 'verified token');
      eq(await principalFromConnect({ queryStringParameters: { token: 'forged' } }), undefined, 'invalid token');
    } finally {
      setCustomVerifier(undefined);
    }
    const saved = process.env.JIVA_ENVIRONMENT;
    process.env.JIVA_ENVIRONMENT = 'production';
    try {
      eq(await principalFromConnect({ headers: { 'x-jiva-demo-user': 'demo-admin' } }), undefined, 'demo persona refused in production');
    } finally {
      if (saved === undefined) delete process.env.JIVA_ENVIRONMENT;
      else process.env.JIVA_ENVIRONMENT = saved;
    }
    const demo = await principalFromConnect({ headers: { 'X-Jiva-Demo-User': 'demo-hosp-1' } });
    ok(demo?.role === 'HOSPITAL' && demo.hospitalId === 'HOSP-BLR-001' && !('token' in demo), 'demo persona in demo mode; nothing token-like stored');
  });
});
