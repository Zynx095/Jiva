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

/**
 * HANDED_OVER: a hospital user recorded the handover from the ambulance crew (authoritative start of
 * in-hospital care). ARRIVED can come from the GPS geofence or from a hospital-confirmed arrival.
 */
export type PatientCaseStatus = 'EMERGENCY_REPORTED' | 'ASSESSED' | 'IN_TRANSIT' | 'ARRIVED' | 'HANDED_OVER' | 'ADMITTED' | 'DISCHARGED';

/** How the emergency was reported. Reported information only: never a diagnosis. */
export interface EmergencyIntake {
  channel: 'AMBULANCE_CREW' | 'DISPATCH' | 'PATIENT_APP';
  /** Ambulance whose crew reported the emergency (AMBULANCE_CREW only). */
  reportedByAmbulanceId?: string;
  locationMethod?: 'DEVICE_GPS' | 'MAP_PIN' | 'MANUAL_ENTRY';
  locationAccuracyMeters?: number;
  notes?: string;
}

export interface PatientState {
  patientId: string;
  currentStatus: PatientCaseStatus;
  currentLocation?: GeoPoint;
  assignedHospital?: string;
  assignedAmbulance?: string;
  careRequirements: string[];
  /** Legacy single-line description of the presenting condition (kept for existing consumers). */
  activeConditions: string[];
  /** Symptoms as reported at the scene, kept separate from any suspected cause. */
  reportedSymptoms?: string[];
  /** What the reporter suspects caused the emergency. Unconfirmed; never a diagnosis. */
  suspectedCause?: string;
  /** Capabilities the reporter asked for, in addition to the rule-derived assessment. */
  requestedCapabilities?: string[];
  intake?: EmergencyIntake;
  /** Hospital encounter, once a hospital has recorded the patient's arrival. */
  encounterId?: string;
  lastUpdated: string;
  provenance: Provenance[];
}
