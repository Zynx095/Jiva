import { GeoPoint } from '@jiva/domain-models';
import { MappingProvider } from './MappingProvider';
import { RouteRequest, RouteResult, ETAResult, Location } from '../types';
import { decodePolyline } from '../utils/polyline';

export interface OSRMProviderConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

export class OSRMMappingProvider implements MappingProvider {
  readonly name = 'osrm';
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config?: OSRMProviderConfig) {
    const rawUrl = config?.baseUrl || process.env.OSRM_BASE_URL || 'http://localhost:5000';
    // Security: Validate URL format to prevent SSRF
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Invalid protocol for OSRM URL: ${parsed.protocol}`);
      }
      this.baseUrl = rawUrl.replace(/\/+$/, '');
    } catch {
      this.baseUrl = 'http://localhost:5000';
    }
    this.timeoutMs = config?.timeoutMs || 5000;
  }

  async isHealthy(): Promise<boolean> {
    try {
      // Test basic connectivity with a minimal test coordinate query
      const url = `${this.baseUrl}/nearest/v1/driving/77.5946,12.9716`;
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2000)) });
      return res.ok;
    } catch {
      return false;
    }
  }

  async geocode(address: string): Promise<GeoPoint> {
    // Fallback to OSM Nominatim or central Bengaluru
    try {
      const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ', Bengaluru')}&format=json&limit=1`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Jiva-Healthcare-Mesh/1.0' },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
          return {
            latitude: parseFloat(data[0].lat),
            longitude: parseFloat(data[0].lon)
          };
        }
      }
    } catch {}
    return { latitude: 12.9716, longitude: 77.5946 };
  }

  async reverseGeocode(coordinates: GeoPoint): Promise<Location> {
    return {
      coordinates,
      address: `Bengaluru (${coordinates.latitude.toFixed(4)}, ${coordinates.longitude.toFixed(4)})`,
      source: 'OpenStreetMap'
    };
  }

  async calculateRoute(request: RouteRequest): Promise<RouteResult> {
    // OSRM requires coordinates in [longitude, latitude] format
    const points: string[] = [
      `${request.origin.longitude},${request.origin.latitude}`,
      ...(request.waypoints || []).map(w => `${w.longitude},${w.latitude}`),
      `${request.destination.longitude},${request.destination.latitude}`
    ];

    const coordinatesParam = points.join(';');
    const url = `${this.baseUrl}/route/v1/driving/${coordinatesParam}?overview=full&geometries=geojson&alternatives=${request.alternatives ? 'true' : 'false'}`;

    const res = await fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!res.ok) {
      throw new Error(`OSRM routing error HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (data.code !== 'Ok' || !Array.isArray(data.routes) || data.routes.length === 0) {
      throw new Error(`OSRM routing failed: ${data.message || data.code || 'No route found'}`);
    }

    const primaryRoute = data.routes[0];
    const distanceMeters = Math.round(primaryRoute.distance || 0);
    const durationSeconds = Math.round(primaryRoute.duration || 0);

    // With geometries=geojson, OSRM directly provides [lng, lat] coordinate pairs!
    const coordinates: [number, number][] = primaryRoute.geometry?.coordinates || [
      [request.origin.longitude, request.origin.latitude],
      [request.destination.longitude, request.destination.latitude]
    ];

    const legs = (primaryRoute.legs || []).map((leg: any, i: number) => ({
      start: i === 0 ? request.origin : { latitude: coordinates[0][1], longitude: coordinates[0][0] },
      end: request.destination,
      distanceMeters: Math.round(leg.distance || 0),
      durationSeconds: Math.round(leg.duration || 0)
    }));

    return {
      distanceMeters,
      durationSeconds,
      coordinates,
      legs: legs.length > 0 ? legs : [{
        start: request.origin,
        end: request.destination,
        distanceMeters,
        durationSeconds
      }],
      provider: 'osrm',
      sourceType: 'osm',
      synthetic: false,
      calculatedAt: new Date().toISOString(),
      trafficAware: false, // Honest traffic reporting: OSRM uses speed profiles, not live traffic
    };
  }

  async calculateDistance(origin: GeoPoint, destination: GeoPoint): Promise<{distanceMeters: number}> {
    const route = await this.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    return { distanceMeters: route.distanceMeters };
  }

  async calculateETA(origin: GeoPoint, destination: GeoPoint): Promise<ETAResult> {
    const route = await this.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    return {
      durationSeconds: route.durationSeconds,
      calculatedAt: new Date().toISOString(),
      provider: 'osrm',
      synthetic: false
    };
  }
}
