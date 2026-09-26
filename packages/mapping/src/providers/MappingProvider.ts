import { GeoPoint } from '@jiva/domain-models';
import { RouteRequest, RouteResult, ETAResult, Location } from '../types';

export interface MappingProvider {
  readonly name: string;
  geocode(address: string): Promise<GeoPoint>;
  reverseGeocode(coordinates: GeoPoint): Promise<Location>;
  calculateRoute(request: RouteRequest): Promise<RouteResult>;
  calculateDistance(origin: GeoPoint, destination: GeoPoint): Promise<{distanceMeters: number}>;
  calculateETA(origin: GeoPoint, destination: GeoPoint): Promise<ETAResult>;
  isHealthy?(): Promise<boolean>;
}
