import { apiPost } from '../api';

/**
 * Demo controls. Each action is performed AS THE REAL ACTOR (demo persona) through the
 * normal event API, so it passes the same validation and authorization as any client.
 * No control fabricates system decisions (routing, destination) or AI output — those
 * are always produced by the backend engines.
 */
const HOSPITAL_PERSONA: Record<string, string> = {
  'HOSP-BLR-001': 'demo-hosp-1', 'HOSP-BLR-002': 'demo-hosp-2', 'HOSP-BLR-003': 'demo-hosp-3', 'HOSP-BLR-004': 'demo-hosp-4',
};
const AMBULANCE_PERSONA: Record<string, string> = { 'AMB-BLR-001': 'demo-amb-1', 'AMB-BLR-002': 'demo-amb-2', 'AMB-BLR-003': 'demo-amb-3' };
export const DEMO_CASE = 'CASE-BLR-876';
const SCENE = { latitude: 13.0431, longitude: 77.5891 };

async function send(persona: string, event: Record<string, unknown>): Promise<string | null> {
  const res = await apiPost('/api/events', { eventId: crypto.randomUUID(), timestamp: new Date().toISOString(), version: '1.0', ...event }, persona);
  if (res.ok) return null;
  const body = await res.json().catch(() => ({}));
  return `${res.status}: ${body.message || body.error || 'rejected'}`;
}

function respond(hospitalId: string, status: 'ACCEPTED' | 'LIMITED' | 'REJECTED', limitations: string[] = []) {
  const now = new Date().toISOString();
  return send(HOSPITAL_PERSONA[hospitalId], {
    eventType: 'hospital.acceptance.received',
    source: { type: 'hospital', id: hospitalId },
    payload: {
      responseId: `RESP-${crypto.randomUUID().substring(0, 8)}`,
      requestId: 'AR-demo-control',
      caseId: DEMO_CASE,
      hospitalId,
      status,
      acceptedCapabilities: status === 'REJECTED' ? [] : ['EMERGENCY', 'TRAUMA', 'ICU'],
      limitations,
      respondedAt: now,
      validUntil: new Date(Date.now() + 30 * 60000).toISOString(),
      responderRole: 'CLINICAL_COORDINATOR',
      source: 'SYNTHETIC_DEMO',
    },
  });
}

export const DemoSimulator = {
  resetScenario: async () => {
    const res = await apiPost('/api/demo/reset', undefined, 'demo-admin');
    return res.ok ? null : `Reset failed (${res.status})`;
  },

  startEmergency: async () => {
    const err = await send('demo-mgmt-1', {
      eventType: 'patient.emergency.created',
      source: { type: 'system', id: 'dispatch-blr-108' },
      patientId: DEMO_CASE,
      payload: { condition: 'Severe polytrauma (road traffic accident)', location: SCENE, severity: 'CRITICAL' },
      metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' },
    });
    if (err) return err;
    await new Promise(r => setTimeout(r, 800));
    return send('demo-mgmt-1', {
      eventType: 'ambulance.dispatched',
      source: { type: 'system', id: 'dispatch-blr-108' },
      payload: { ambulanceId: 'AMB-BLR-001', caseId: DEMO_CASE, destination: SCENE, estimatedEtaMinutes: 8 },
    });
  },

  accept: (hospitalId: string) => respond(hospitalId, 'ACCEPTED'),
  limited: (hospitalId: string) => respond(hospitalId, 'LIMITED', ['ICU bed unavailable; surgical stabilisation only']),
  reject: (hospitalId: string) => respond(hospitalId, 'REJECTED', ['Trauma team unavailable']),

  hospitalUnavailable: (hospitalId: string) => send(HOSPITAL_PERSONA[hospitalId], {
    eventType: 'hospital.capacity.updated',
    source: { type: 'hospital', id: hospitalId },
    payload: { hospitalId, emergencyStatus: 'UNAVAILABLE', traumaStatus: 'UNAVAILABLE', icuStatus: 'UNAVAILABLE', ventilatorStatus: 'UNKNOWN' },
    metadata: { confidence: 1.0, sourceType: 'SYNTHETIC_DEMO' },
  }),

  moveAmbulance: (ambulanceId: string, lat: number, lng: number) => send(AMBULANCE_PERSONA[ambulanceId], {
    eventType: 'ambulance.location.updated',
    source: { type: 'ambulance', id: ambulanceId },
    payload: { ambulanceId, coordinates: { latitude: lat, longitude: lng }, speedKmh: 45, heading: 180 },
  }),
};
