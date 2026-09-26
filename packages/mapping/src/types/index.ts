import { GeoPoint } from '@jiva/domain-models';

export type RouteProviderType = 'valhalla' | 'osrm' | 'mock' | 'fallback';

export interface Location {
  coordinates: GeoPoint;
  address?: string;
  source?: string;
}

export interface RouteRequest {
  origin: GeoPoint;
  destination: GeoPoint;
  waypoints?: GeoPoint[];
  travelMode: 'DRIVING';
  alternatives?: boolean;
}

export interface RouteLeg {
  start: GeoPoint;
  end: GeoPoint;
  distanceMeters: number;
  durationSeconds: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  polyline?: string;
  coordinates?: [number, number][]; // [longitude, latitude] for MapLibre GeoJSON
  legs: RouteLeg[];
  provider?: RouteProviderType;
  sourceType?: 'osm' | 'synthetic';
  synthetic?: boolean;
  calculatedAt?: string;
  trafficAware?: boolean;
  alternatives?: RouteResult[];
}

export interface ETAResult {
  durationSeconds: number;
  calculatedAt: string;
  provider?: RouteProviderType;
  synthetic?: boolean;
}

export interface MappingConfig {
  provider?: 'auto' | 'valhalla' | 'osrm' | 'mock';
  valhallaBaseUrl?: string;
  osrmBaseUrl?: string;
  timeoutMs?: number;
}
