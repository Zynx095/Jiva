export interface GeoPoint {
  latitude: number;
  longitude: number;
}

export interface Provenance {
  sourceType: string;
  sourceId: string;
  eventId: string;
  timestamp: string;
  confidence: number;
}

export interface PatientState {
  patientId: string;
  currentStatus: 'EMERGENCY_REPORTED' | 'ASSESSED' | 'IN_TRANSIT' | 'ARRIVED' | 'ADMITTED' | 'DISCHARGED';
  currentLocation?: GeoPoint;
  assignedHospital?: string;
  assignedAmbulance?: string;
  careRequirements: string[];
  activeConditions: string[];
  lastUpdated: string;
  provenance: Provenance[];
}
