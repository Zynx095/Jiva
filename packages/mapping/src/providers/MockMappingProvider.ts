import { GeoPoint } from '@jiva/domain-models';
import { MappingProvider } from './MappingProvider';
import { RouteRequest, RouteResult, ETAResult, Location } from '../types';
import { encodePolyline } from '../utils/polyline';

export class MockMappingProvider implements MappingProvider {
  readonly name = 'mock';

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async geocode(address: string): Promise<GeoPoint> {
    // Default to Bengaluru center
    return { latitude: 12.9716, longitude: 77.5946 };
  }

  async reverseGeocode(coordinates: GeoPoint): Promise<Location> {
    return { coordinates, address: 'Bengaluru, Karnataka, India (Mock)' };
  }

  async calculateRoute(request: RouteRequest): Promise<RouteResult> {
    const dist = await this.calculateDistance(request.origin, request.destination);
    // Simple heuristic: 1 km = 2 min in Bengaluru road conditions roughly
    const durationSec = Math.floor((dist.distanceMeters / 1000) * 120);

    // Generate interpolated points for realistic route line rendering on MapLibre
    const steps = 8;
    const coordinates: [number, number][] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      // Add slight jitter for non-straight mock road lines
      const jitterLat = i > 0 && i < steps ? (Math.sin(i * 1.5) * 0.002) : 0;
      const jitterLng = i > 0 && i < steps ? (Math.cos(i * 1.5) * 0.002) : 0;
      const lat = request.origin.latitude + (request.destination.latitude - request.origin.latitude) * t + jitterLat;
      const lng = request.origin.longitude + (request.destination.longitude - request.origin.longitude) * t + jitterLng;
      coordinates.push([lng, lat]);
    }

    return {
      distanceMeters: dist.distanceMeters,
      durationSeconds: durationSec,
      polyline: encodePolyline(coordinates),
      coordinates,
      legs: [{
        start: request.origin,
        end: request.destination,
        distanceMeters: dist.distanceMeters,
        durationSeconds: durationSec
      }],
      provider: 'mock',
      sourceType: 'synthetic',
      synthetic: true,
      calculatedAt: new Date().toISOString(),
      trafficAware: false,
    };
  }

  async calculateDistance(origin: GeoPoint, destination: GeoPoint): Promise<{distanceMeters: number}> {
    // Haversine formula mock
    const R = 6371e3; // metres
    const p1 = origin.latitude * Math.PI / 180;
    const p2 = destination.latitude * Math.PI / 180;
    const dp = (destination.latitude - origin.latitude) * Math.PI / 180;
    const dl = (destination.longitude - origin.longitude) * Math.PI / 180;

    const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
              Math.cos(p1) * Math.cos(p2) *
              Math.sin(dl / 2) * Math.sin(dl / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c;

    // Add a 1.5 multiplier for road distance approximation
    return { distanceMeters: Math.floor(d * 1.5) };
  }

  async calculateETA(origin: GeoPoint, destination: GeoPoint): Promise<ETAResult> {
    const route = await this.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    return {
      durationSeconds: route.durationSeconds,
      calculatedAt: new Date().toISOString(),
      provider: 'mock',
      synthetic: true,
    };
  }
}
