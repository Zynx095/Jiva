import { Provenance, GeoPoint } from './patient';
import type { DataStatus } from './hospital';

export interface AmbulanceState {
  ambulanceId: string;
  status: 'AVAILABLE' | 'DISPATCHED' | 'EN_ROUTE_TO_PATIENT' | 'ON_SCENE' | 'PATIENT_ONBOARD' | 'EN_ROUTE_TO_HOSPITAL' | 'ARRIVED' | 'UNAVAILABLE';
  currentLocation?: GeoPoint;
  heading?: number;
  speedKmh?: number;
  assignedPatient?: string;
  destinationHospital?: string;
  requiredCapabilities: string[];
  lastUpdated: string;
  /** Timestamp of the GPS fix currently applied (event time, not receive time). */
  locationAsOf?: string;
  /** Last route computed for the current destination, including provider provenance. */
  activeRoute?: {
    hospitalId: string;
    distanceMeters: number;
    durationSeconds: number;
    coordinates?: [number, number][];
    provider?: string;
    sourceType?: string;
    synthetic?: boolean;
    trafficAware?: boolean;
    calculatedAt: string;
  };
  provenance: Provenance[];
  /** SYNTHETIC_DEMO for the demo fleet; absent for units registered by an operator. */
  dataStatus?: DataStatus;
}
