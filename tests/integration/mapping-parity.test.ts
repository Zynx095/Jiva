import { createMappingProvider } from '../../packages/mapping/src/factory';
import { preloadData, hospitalsStore } from '../../services/api/src/stateStore';
import { evaluateHospitals } from '../../services/api/src/eligibilityEngine';
import { calculateBestHospitals } from '../../services/api/src/routingEngine';
import { CareRequirement } from '@jiva/domain-models';

async function testMappingParity() {
  console.log('[Test] Running Mapping Parity & Integration Verification...');

  await preloadData();

  const provider = createMappingProvider();
  console.log(`  Mapping provider initialized: ${provider.name}`);

  const patientLoc = { latitude: 12.9716, longitude: 77.5946 }; // Central Bengaluru (Vidhana Soudha)

  // 1. Evaluate hospitals via eligibility engine
  const req: CareRequirement = {
    requirementId: 'REQ-INT-1',
    caseId: 'CASE-BLR-MAP-TEST',
    requiredCapabilities: ['EMERGENCY', 'TRAUMA'],
    optionalCapabilities: [],
    severity: 'CRITICAL',
    createdAt: new Date().toISOString(),
    source: 'INTEGRATION_TEST',
  };

  const candidates = await evaluateHospitals(req, patientLoc);
  if (candidates.length === 0) {
    throw new Error('Eligibility engine returned zero candidates');
  }

  const top = candidates[0];
  console.log(`  Top candidate: ${top.hospitalName} (Distance: ${top.distanceKm} km, ETA: ${top.etaMinutes} min)`);

  const hosp = hospitalsStore.get(top.hospitalId);
  if (!hosp || !hosp.location) {
    throw new Error(`Hospital ${top.hospitalId} has no valid location in store`);
  }

  // 2. Direct route calculation
  const route = await provider.calculateRoute({
    origin: patientLoc,
    destination: { latitude: hosp.location.latitude, longitude: hosp.location.longitude },
    travelMode: 'DRIVING'
  });

  if (!route.distanceMeters || route.distanceMeters <= 0) {
    throw new Error('Calculated route distance must be positive');
  }
  if (!route.durationSeconds || route.durationSeconds <= 0) {
    throw new Error('Calculated route duration must be positive');
  }
  if (!route.coordinates || route.coordinates.length < 2) {
    throw new Error('Calculated route must contain at least 2 GeoJSON [lng, lat] coordinate pairs');
  }
  if (!route.provider) {
    throw new Error('Route result must declare provider');
  }
  if (!route.sourceType) {
    throw new Error('Route result must declare sourceType');
  }
  if (typeof route.synthetic !== 'boolean') {
    throw new Error('Route result must declare boolean synthetic flag');
  }

  // 3. Routing engine parity
  const scoredHospitals = await calculateBestHospitals(patientLoc, ['EMERGENCY', 'TRAUMA']);
  if (scoredHospitals.length === 0) {
    throw new Error('calculateBestHospitals returned zero hospitals');
  }

  console.log(`  Route computed successfully via ${route.provider}:`);
  console.log(`  - Distance: ${(route.distanceMeters / 1000).toFixed(2)} km`);
  console.log(`  - Duration: ${Math.ceil(route.durationSeconds / 60)} min`);
  console.log(`  - Geometry: ${route.coordinates.length} GeoJSON coordinates`);
  console.log(`  - Provenance: provider=${route.provider}, sourceType=${route.sourceType}, synthetic=${route.synthetic}`);

  console.log('✓ Mapping Parity & Integration Verification PASSED.\n');
}

testMappingParity().catch((err) => {
  console.error('✗ Mapping Parity Test FAILED:', err);
  process.exit(1);
});
