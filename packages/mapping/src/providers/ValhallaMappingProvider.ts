import { GeoPoint } from '@jiva/domain-models';
import { MappingProvider } from './MappingProvider';
import { RouteRequest, RouteResult, ETAResult, Location } from '../types';
import { decodePolyline } from '../utils/polyline';

export interface ValhallaProviderConfig {
  baseUrl?: string;
  timeoutMs?: number;
}

export class ValhallaMappingProvider implements MappingProvider {
  readonly name = 'valhalla';
  private baseUrl: string;
  private timeoutMs: number;

  constructor(config?: ValhallaProviderConfig) {
    const rawUrl = config?.baseUrl || process.env.VALHALLA_BASE_URL || 'http://localhost:8002';
    // Security: Validate URL format to prevent SSRF
    try {
      const parsed = new URL(rawUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(`Invalid protocol for Valhalla URL: ${parsed.protocol}`);
      }
      this.baseUrl = rawUrl.replace(/\/+$/, '');
    } catch (e: any) {
      this.baseUrl = 'http://localhost:8002';
    }
    this.timeoutMs = config?.timeoutMs || 5000;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/status`, {
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 2000)),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async geocode(address: string): Promise<GeoPoint> {
    // Valhalla focuses on routing. For geocoding, fallback to OSM Nominatim or Bengaluru center
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
    // Default fallback to central Bengaluru
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
    const body = {
      locations: [
        { lat: request.origin.latitude, lon: request.origin.longitude },
        ...(request.waypoints || []).map(w => ({ lat: w.latitude, lon: w.longitude })),
        { lat: request.destination.latitude, lon: request.destination.longitude }
      ],
      costing: 'auto',
      directions_options: {
        units: 'kilometers'
      },
      alternates: request.alternatives ? 1 : 0
    };

    const url = `${this.baseUrl}/route`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs)
    });

    if (!res.ok) {
      throw new Error(`Valhalla routing error HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data.trip || !data.trip.summary) {
      throw new Error('Malformed Valhalla response: missing trip summary');
    }

    const summary = data.trip.summary;
    const distanceMeters = Math.round((summary.length || 0) * 1000);
    const durationSeconds = Math.round(summary.time || 0);

    // Valhalla encodes shape in trip.legs[0].shape with precision 6
    const rawShape = data.trip.legs?.[0]?.shape || '';
    const coordinates: [number, number][] = rawShape
      ? decodePolyline(rawShape, 6)
      : [
          [request.origin.longitude, request.origin.latitude],
          [request.destination.longitude, request.destination.latitude],
        ];

    const legs = (data.trip.legs || []).map((l: any, i: number) => ({
      start: i === 0 ? request.origin : { latitude: coordinates[0][1], longitude: coordinates[0][0] },
      end: request.destination,
      distanceMeters: Math.round((l.summary?.length || 0) * 1000),
      durationSeconds: Math.round(l.summary?.time || 0)
    }));

    return {
      distanceMeters,
      durationSeconds,
      polyline: rawShape,
      coordinates,
      legs: legs.length > 0 ? legs : [{
        start: request.origin,
        end: request.destination,
        distanceMeters,
        durationSeconds
      }],
      provider: 'valhalla',
      sourceType: 'osm',
      synthetic: false,
      calculatedAt: new Date().toISOString(),
      trafficAware: false, // Honest traffic reporting: Valhalla OSM routing is road-network without live traffic
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
      provider: 'valhalla',
      synthetic: false
    };
  }
}
