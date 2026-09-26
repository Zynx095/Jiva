import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';

const API_URL = 'http://localhost:4000/api/events';


// DEMO-ONLY auth: act as the persona that matches the event's source (server enforces scope).
function personaHeaders(event: any): Record<string, string> {
  const id: string = event?.source?.id || '';
  const hosp = id.match(/^HOSP-BLR-00(\d)$/);
  const amb = id.match(/^AMB-BLR-00(\d)$/);
  const persona = hosp ? `demo-hosp-${hosp[1]}` : amb ? `demo-amb-${amb[1]}` : 'demo-mgmt-1';
  return { 'Content-Type': 'application/json', 'x-jiva-demo-user': persona };
}

async function sendEvent(event: any) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: personaHeaders(event),
      body: JSON.stringify(event)
    });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    console.log(`[Simulator] Sent ${event.eventType} for ${event.source?.id || 'unknown'}`);
  } catch (err) {
    console.error(`[Simulator] Failed to send ${event.eventType}:`, err);
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function checkServer(): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:4000/api/health', { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function runEmergencyScenario() {
  const isServerRunning = await checkServer();
  if (!isServerRunning) {
    console.error('\n============================================================');
    console.error('❌ JIVA API SERVER NOT FOUND ON http://localhost:4000');
    console.error('============================================================');
    console.error('The simulation pushes live events to the JIVA backend to');
    console.error('demonstrate real-time coordination, routing, and AI handoffs.\n');
    console.error('👉 HOW TO RUN:');
    console.error('  1. In Terminal 1, start the backend server (or full app):');
    console.error('     npm run dev:api     (or: npm run dev)');
    console.error('');
    console.error('  2. In Terminal 2, re-run this simulation:');
    console.error('     npm run simulate:emergency:blr');
    console.error('============================================================\n');
    process.exit(1);
  }

  console.log('--- STARTING BENGALURU EMERGENCY SCENARIO (DEMO MODE) ---');
  
  // 1. Initial State - Preload Mock or Canonical Hospitals
  let hospitalsData: any[] = [];
  if (process.env.USE_CANONICAL) {
     const canonicalPath = path.join(__dirname, '../data/canonical/hospitals.json');
     if (fs.existsSync(canonicalPath)) hospitalsData = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
     console.log(`Loaded ${hospitalsData.length} Canonical Hospitals.`);
  } else {
     const syntheticPath = path.join(__dirname, '../data/synthetic/bengaluru/hospitals.json');
     if (fs.existsSync(syntheticPath)) hospitalsData = JSON.parse(fs.readFileSync(syntheticPath, 'utf8'));
     console.log(`Loaded ${hospitalsData.length} Synthetic Hospitals.`);
  }

  for (const h of hospitalsData) {
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'hospital.capacity.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: h.hospitalId },
      version: '1.0',
      payload: {
        hospitalId: h.hospitalId,
        emergencyStatus: h.operationalState?.emergency || 'UNKNOWN',
        traumaStatus: h.operationalState?.trauma || 'UNKNOWN',
        icuStatus: h.operationalState?.icu || 'UNKNOWN',
        ventilatorStatus: h.operationalState?.ventilator || 'UNKNOWN'
      },
      metadata: { confidence: 0.98, sourceType: h.operationalState?.source || 'UNKNOWN' }
    });
  }
  await sleep(1000);

  // Load ambulances
  const ambData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/synthetic/bengaluru/ambulances.json'), 'utf8'));
  for (const a of ambData) {
    await sendEvent({
      eventId: uuidv4(),
      eventType: 'ambulance.location.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'ambulance', id: a.ambulanceId },
      version: '1.0',
      payload: {
        ambulanceId: a.ambulanceId,
        coordinates: a.currentLocation
      }
    });
  }
  await sleep(1000);

  // 2. Patient Emergency at Hebbal
  const patientId = `CASE-BLR-001`;
  const patientLocation = { latitude: 13.0358, longitude: 77.5970 }; // Hebbal
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'patient.emergency.created',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'dispatch-blr-1' },
    version: '1.0',
    patientId,
    payload: {
      condition: 'Severe Trauma',
      location: patientLocation,
      severity: 'CRITICAL'
    },
    metadata: { confidence: 1.0, sourceType: '911-dispatch' }
  });
  console.log('Emergency registered at Hebbal.');
  await sleep(2000);

  // 3. Ambulance Dispatched
  const ambulanceId = 'AMB-BLR-001';
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'ambulance.dispatched',
    timestamp: new Date().toISOString(),
    source: { type: 'system', id: 'dispatch-blr-1' },
    version: '1.0',
    payload: {
      ambulanceId,
      destination: patientLocation,
      estimatedEtaMinutes: 8
    }
  });
  console.log(`Ambulance ${ambulanceId} dispatched to Hebbal.`);
  await sleep(3000);

  // 4. Ambulance moves
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'ambulance.location.updated',
    timestamp: new Date().toISOString(),
    source: { type: 'ambulance', id: ambulanceId },
    version: '1.0',
    payload: {
      ambulanceId,
      coordinates: { latitude: 13.0500, longitude: 77.5960 },
      speedKmh: 45,
      heading: 180
    }
  });
  console.log(`Ambulance ${ambulanceId} moving...`);
  await sleep(3000);

  // 5. Hospital A becomes UNAVAILABLE (triggers reroute)
  console.log('--- DYNAMIC REROUTING DEMO ---');
  await sendEvent({
    eventId: uuidv4(),
    eventType: 'hospital.capacity.updated',
    timestamp: new Date().toISOString(),
    source: { type: 'hospital', id: 'HOSP-BLR-002' },
    version: '1.0',
    payload: {
      hospitalId: 'HOSP-BLR-002',
      emergencyStatus: 'UNAVAILABLE',
      traumaStatus: 'UNAVAILABLE',
      icuStatus: 'UNAVAILABLE',
      ventilatorStatus: 'UNAVAILABLE'
    },
    metadata: { confidence: 1.0, sourceType: 'hospital-confirmed' }
  });
  console.log('HOSP-BLR-002 became UNAVAILABLE. Backend should automatically emit reroute events for any affected ambulance.');
  
  await sleep(2000);
  console.log('--- SCENARIO COMPLETE ---');
}

const scenario = process.argv[2];
if (scenario === 'emergency:blr') {
  runEmergencyScenario();
} else {
  console.log('Usage: npx ts-node simulate-events.ts emergency:blr');
}
