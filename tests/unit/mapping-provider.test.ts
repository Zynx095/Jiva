import { MockMappingProvider } from '../../packages/mapping/src/providers/MockMappingProvider';
import { ValhallaMappingProvider } from '../../packages/mapping/src/providers/ValhallaMappingProvider';
import { OSRMMappingProvider } from '../../packages/mapping/src/providers/OSRMMappingProvider';
import { decodePolyline } from '../../packages/mapping/src/utils/polyline';

async function testMappingProviders() {
  console.log('[Test] Running Mapping Provider Unit Tests...');

  // 1. Polyline decoding test
  console.log('  Testing Polyline Decoder...');
  // Encoded polyline with precision 5 for (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
  const encodedP5 = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
  const coordsP5 = decodePolyline(encodedP5, 5);
  if (coordsP5.length !== 3) {
    throw new Error(`Expected 3 coordinates from decoded polyline, got ${coordsP5.length}`);
  }
  // Coords are [lng, lat]
  const [firstLng, firstLat] = coordsP5[0];
  if (Math.abs(firstLat - 38.5) > 0.001 || Math.abs(firstLng - (-120.2)) > 0.001) {
    throw new Error(`Expected [~-120.2, ~38.5], got [${firstLng}, ${firstLat}]`);
  }
  console.log('  ✓ Polyline decoding passed.');

  // 2. MockMappingProvider test
  console.log('  Testing MockMappingProvider...');
  const mockProvider = new MockMappingProvider();
  const origin = { latitude: 12.9716, longitude: 77.5946 };
  const destination = { latitude: 12.9352, longitude: 77.6245 };
  
  const mockRoute = await mockProvider.calculateRoute({
    origin,
    destination,
    travelMode: 'DRIVING'
  });

  if (mockRoute.provider !== 'mock') {
    throw new Error(`Expected provider 'mock', got '${mockRoute.provider}'`);
  }
  if (mockRoute.sourceType !== 'synthetic') {
    throw new Error(`Expected sourceType 'synthetic', got '${mockRoute.sourceType}'`);
  }
  if (mockRoute.synthetic !== true) {
    throw new Error('Expected synthetic to be true for MockMappingProvider');
  }
  if (!mockRoute.coordinates || mockRoute.coordinates.length < 2) {
    throw new Error('Expected at least 2 GeoJSON coordinates in route');
  }
  if (mockRoute.trafficAware !== false) {
    throw new Error('Expected trafficAware to be false for mock route');
  }
  if (mockRoute.distanceMeters <= 0 || mockRoute.durationSeconds <= 0) {
    throw new Error('Expected positive distance and duration');
  }
  console.log(`  ✓ MockMappingProvider passed (${mockRoute.distanceMeters}m, ${mockRoute.durationSeconds}s, ${mockRoute.coordinates.length} points).`);

  // 3. ValhallaMappingProvider parsing test (mocking fetch)
  console.log('  Testing ValhallaMappingProvider response parsing...');
  const origFetch = global.fetch;
  try {
    // Mock successful Valhalla response
    global.fetch = async (url: any, opts: any) => {
      const urlStr = url.toString();
      if (urlStr.includes('/status')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: 'ready' })
        } as any;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          trip: {
            summary: {
              length: 5.234, // km
              time: 650     // seconds
            },
            legs: [
              {
                shape: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' // Precision 6 encoded shape
              }
            ]
          }
        })
      } as any;
    };

    const valhalla = new ValhallaMappingProvider({ baseUrl: 'http://localhost:8002' });
    const isHealthy = await valhalla.isHealthy();
    if (!isHealthy) throw new Error('Expected Valhalla isHealthy to return true');

    const vRoute = await valhalla.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    if (vRoute.provider !== 'valhalla') throw new Error(`Expected provider 'valhalla', got ${vRoute.provider}`);
    if (vRoute.sourceType !== 'osm') throw new Error(`Expected sourceType 'osm', got ${vRoute.sourceType}`);
    if (vRoute.synthetic !== false) throw new Error('Expected synthetic=false for Valhalla');
    if (vRoute.trafficAware !== false) throw new Error('Expected trafficAware=false (honest traffic contract)');
    if (vRoute.distanceMeters !== 5234) throw new Error(`Expected distanceMeters=5234, got ${vRoute.distanceMeters}`);
    if (vRoute.durationSeconds !== 650) throw new Error(`Expected durationSeconds=650, got ${vRoute.durationSeconds}`);
    if (!vRoute.coordinates || vRoute.coordinates.length !== 3) {
      throw new Error(`Expected 3 decoded coordinates, got ${vRoute.coordinates?.length}`);
    }
    console.log('  ✓ ValhallaMappingProvider parsing & metadata passed.');

    // 4. OSRMMappingProvider parsing test (mocking fetch)
    console.log('  Testing OSRMMappingProvider response parsing...');
    global.fetch = async (url: any, opts: any) => {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          code: 'Ok',
          routes: [
            {
              distance: 4320.5,
              duration: 540.2,
              geometry: {
                type: 'LineString',
                coordinates: [
                  [77.5946, 12.9716],
                  [77.6000, 12.9500],
                  [77.6245, 12.9352]
                ]
              }
            }
          ]
        })
      } as any;
    };

    const osrm = new OSRMMappingProvider({ baseUrl: 'http://localhost:5000' });
    const oRoute = await osrm.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    if (oRoute.provider !== 'osrm') throw new Error(`Expected provider 'osrm', got ${oRoute.provider}`);
    if (oRoute.sourceType !== 'osm') throw new Error(`Expected sourceType 'osm', got ${oRoute.sourceType}`);
    if (oRoute.synthetic !== false) throw new Error('Expected synthetic=false for OSRM');
    if (oRoute.trafficAware !== false) throw new Error('Expected trafficAware=false');
    if (oRoute.distanceMeters !== 4321) throw new Error(`Expected rounded distance 4321, got ${oRoute.distanceMeters}`);
    if (oRoute.durationSeconds !== 540) throw new Error(`Expected rounded duration 540, got ${oRoute.durationSeconds}`);
    if (!oRoute.coordinates || oRoute.coordinates.length !== 3) {
      throw new Error(`Expected 3 coordinates, got ${oRoute.coordinates?.length}`);
    }
    console.log('  ✓ OSRMMappingProvider parsing & metadata passed.');

  } finally {
    global.fetch = origFetch;
  }

  console.log('✓ All Mapping Provider Unit Tests PASSED.\n');
}

testMappingProviders().catch((err) => {
  console.error('✗ Mapping Provider Unit Tests FAILED:', err);
  process.exit(1);
});
