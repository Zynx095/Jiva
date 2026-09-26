/**
 * JIVA Mapping Simulation Script (simulate:mapping:blr)
 * 
 * Verifies live road-network route calculation, provider fallback,
 * coordinate generation, and simulated telemetry progression.
 */

import { createMappingProvider } from '../packages/mapping/src/factory';
import { preloadData, hospitalsStore } from '../services/api/src/stateStore';
import { evaluateHospitals } from '../services/api/src/eligibilityEngine';
import { CareRequirement } from '@jiva/domain-models';

async function runMappingSimulation() {
  console.log('============================================================');
  console.log('JIVA MAPPING & ROUTING SIMULATION (BENGALURU CORRIDORS)');
  console.log('============================================================\n');

  await preloadData();

  console.log('[1/4] Initializing Mapping Provider Stack...');
  const provider = createMappingProvider();
  console.log(`      Active Provider: ${provider.name.toUpperCase()}\n`);

  console.log('[2/4] Setting Incident Origin in Central Bengaluru...');
  const patientLocation = { latitude: 12.9716, longitude: 77.5946 }; // MG Road / Cubbon Park
  console.log(`      Coordinates: ${patientLocation.latitude}, ${patientLocation.longitude}\n`);

  console.log('[3/4] Finding Best Hospital Candidate via Eligibility Engine...');
  const req: CareRequirement = {
    requirementId: 'REQ-SIM-MAP-001',
    caseId: 'CASE-BLR-SIM-001',
    requiredCapabilities: ['EMERGENCY', 'TRAUMA'],
    optionalCapabilities: ['ICU'],
    severity: 'CRITICAL',
    createdAt: new Date().toISOString(),
    source: 'SIMULATOR',
  };

  const candidates = await evaluateHospitals(req, patientLocation);
  if (candidates.length === 0) {
    throw new Error('No eligible hospitals found for simulation');
  }

  const destinationHospitalCandidate = candidates[0];
  const targetHospital = hospitalsStore.get(destinationHospitalCandidate.hospitalId);
  if (!targetHospital || !targetHospital.location) {
    throw new Error(`Target hospital ${destinationHospitalCandidate.hospitalId} not found in store`);
  }

  console.log(`      Target Hospital: ${targetHospital.displayName}`);
  console.log(`      Destination: ${targetHospital.location.latitude}, ${targetHospital.location.longitude}\n`);

  console.log('[4/4] Computing Road-Network Route...');
  const route = await provider.calculateRoute({
    origin: patientLocation,
    destination: { latitude: targetHospital.location.latitude, longitude: targetHospital.location.longitude },
    travelMode: 'DRIVING'
  });

  console.log('\n============================================================');
  console.log('ROUTE CALCULATION RESULT');
  console.log('============================================================');
  console.log(`Provider:        ${route.provider.toUpperCase()}`);
  console.log(`Data Source:     ${route.sourceType.toUpperCase()}`);
  console.log(`Synthetic:       ${route.synthetic}`);
  console.log(`Traffic Aware:   ${route.trafficAware}`);
  console.log(`Distance:        ${(route.distanceMeters / 1000).toFixed(2)} km (${route.distanceMeters} meters)`);
  console.log(`Estimated ETA:   ${Math.ceil(route.durationSeconds / 60)} minutes (${route.durationSeconds} seconds)`);
  console.log(`Coordinates:     ${route.coordinates?.length || 0} waypoints`);
  console.log(`Polyline:        ${route.polyline?.substring(0, 40)}...`);
  console.log('============================================================\n');

  if (route.coordinates && route.coordinates.length > 0) {
    console.log('Simulating Ambulance Telemetry Progression along Route:');
    const waypoints = route.coordinates;
    const stepCount = Math.min(5, waypoints.length);
    const stepInterval = Math.floor(waypoints.length / stepCount);

    for (let i = 0; i < stepCount; i++) {
      const idx = Math.min(i * stepInterval, waypoints.length - 1);
      const [lng, lat] = waypoints[idx];
      const progressPct = Math.round(((i + 1) / stepCount) * 100);
      console.log(`  [Progress ${progressPct}%] Waypoint ${idx + 1}/${waypoints.length}: Lat ${lat.toFixed(5)}, Lng ${lng.toFixed(5)}`);
    }
  }

  console.log('\n✓ Simulation completed successfully.\n');
}

runMappingSimulation().catch((err) => {
  console.error('\n✗ Simulation failed:', err);
  process.exit(1);
});
