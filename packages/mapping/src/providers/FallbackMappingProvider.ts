import { GeoPoint } from '@jiva/domain-models';
import { MappingProvider } from './MappingProvider';
import { RouteRequest, RouteResult, ETAResult, Location } from '../types';

export interface FallbackLogger {
  warn(msg: string, metadata?: Record<string, any>): void;
  info(msg: string, metadata?: Record<string, any>): void;
}

export class FallbackMappingProvider implements MappingProvider {
  readonly name = 'fallback';
  private primary: MappingProvider;
  private secondary: MappingProvider;
  private offlineFallback: MappingProvider;
  private logger?: FallbackLogger;
  /** Provider that produced the most recent route (what the UI should report). */
  private lastProvider?: string;
  private lastFallbackReason?: string;
  private lastRouteAt?: string;

  constructor(
    primary: MappingProvider,
    secondary: MappingProvider,
    offlineFallback: MappingProvider,
    logger?: FallbackLogger
  ) {
    this.primary = primary;
    this.secondary = secondary;
    this.offlineFallback = offlineFallback;
    this.logger = logger;
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  async geocode(address: string): Promise<GeoPoint> {
    try {
      return await this.primary.geocode(address);
    } catch {
      try {
        return await this.secondary.geocode(address);
      } catch {
        return await this.offlineFallback.geocode(address);
      }
    }
  }

  async reverseGeocode(coordinates: GeoPoint): Promise<Location> {
    try {
      return await this.primary.reverseGeocode(coordinates);
    } catch {
      try {
        return await this.secondary.reverseGeocode(coordinates);
      } catch {
        return await this.offlineFallback.reverseGeocode(coordinates);
      }
    }
  }

  async calculateRoute(request: RouteRequest): Promise<RouteResult> {
    // 1. Try Primary (Valhalla)
    try {
      const result = await this.primary.calculateRoute(request);
      this.record(this.primary.name);
      return result;
    } catch (errPrimary: any) {
      this.logFallback(this.primary.name, this.secondary.name, errPrimary.message);

      // 2. Try Secondary (OSRM)
      try {
        const result = await this.secondary.calculateRoute(request);
        this.record(this.secondary.name, errPrimary.message);
        return result;
      } catch (errSecondary: any) {
        this.logFallback(this.secondary.name, this.offlineFallback.name, errSecondary.message);

        // 3. Guaranteed Offline Fallback (Mock)
        const result = await this.offlineFallback.calculateRoute(request);
        this.record(this.offlineFallback.name, `${errPrimary.message}; ${errSecondary.message}`);
        return result;
      }
    }
  }

  async calculateDistance(origin: GeoPoint, destination: GeoPoint): Promise<{ distanceMeters: number }> {
    const route = await this.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    return { distanceMeters: route.distanceMeters };
  }

  async calculateETA(origin: GeoPoint, destination: GeoPoint): Promise<ETAResult> {
    const route = await this.calculateRoute({ origin, destination, travelMode: 'DRIVING' });
    return {
      durationSeconds: route.durationSeconds,
      calculatedAt: route.calculatedAt || new Date().toISOString(),
      provider: route.provider,
      synthetic: route.synthetic
    };
  }

  private record(provider: string, fallbackReason?: string): void {
    this.lastProvider = provider;
    this.lastFallbackReason = fallbackReason;
    this.lastRouteAt = new Date().toISOString();
  }

  /** Observable routing status: which provider actually answered and why. */
  getStatus() {
    return {
      mode: 'auto',
      chain: [this.primary.name, this.secondary.name, this.offlineFallback.name],
      activeProvider: this.lastProvider || 'none-yet',
      fallbackActive: !!this.lastFallbackReason,
      lastFallbackReason: this.lastFallbackReason,
      lastRouteAt: this.lastRouteAt,
    };
  }

  private logFallback(from: string, to: string, reason: string): void {
    const payload = {
      event: 'mapping.provider.fallback',
      from,
      to,
      fromProvider: from,
      toProvider: to,
      reason,
      timestamp: new Date().toISOString()
    };
    if (this.logger) {
      this.logger.warn(`[Mapping] Provider fallback from ${from} to ${to}: ${reason}`, payload);
    } else {
      console.warn(`[Mapping Fallback] ${JSON.stringify(payload)}`);
    }
  }
}
