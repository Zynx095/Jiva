import { CapabilityStatus, DataStatus } from './hospital';

export type CapabilityType = 
  | 'EMERGENCY'
  | 'TRAUMA'
  | 'ICU'
  | 'HDU'
  | 'NICU'
  | 'PICU'
  | 'VENTILATOR'
  | 'CARDIOLOGY'
  | 'CARDIAC_SURGERY'
  | 'NEUROLOGY'
  | 'NEUROSURGERY'
  | 'ORTHOPAEDICS'
  | 'ONCOLOGY'
  | 'PAEDIATRICS'
  | 'NEONATOLOGY'
  | 'OBSTETRICS'
  | 'GENERAL_SURGERY'
  | 'VASCULAR'
  | 'BURNS'
  | 'DIALYSIS'
  | 'TRANSPLANT'
  | 'BLOOD_BANK'
  | 'CT'
  | 'MRI';

export interface CareRequirement {
  requirementId: string;
  caseId: string;
  requiredCapabilities: CapabilityType[];
  optionalCapabilities: CapabilityType[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  createdAt: string;
  expiresAt?: string;
  source: string;
}

export type RequestStatus = 'PENDING' | 'RESPONDED' | 'EXPIRED' | 'CANCELLED';

export interface HospitalAvailabilityRequest {
  requestId: string;
  caseId: string;
  hospitalId: string;
  requiredCapabilities: CapabilityType[];
  optionalCapabilities: CapabilityType[];
  ambulanceId?: string;
  ambulanceEtaMinutes?: number;
  patientSummaryReference?: string;
  requestedAt: string;
  expiresAt: string;
  status: RequestStatus;
}

export type ResponseStatus = 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE';

export interface HospitalAvailabilityResponse {
  responseId: string;
  requestId: string;
  caseId: string;
  hospitalId: string;
  status: ResponseStatus;
  acceptedCapabilities: CapabilityType[];
  limitations: string[];
  respondedAt: string;
  validUntil: string;
  responderRole: string;
  /** CLIENT-CLAIMED provenance. Informational only; the feasibility engine never trusts it. */
  source: 'HOSPITAL_CONFIRMED' | 'AUTHORIZED_FEED' | 'SYNTHETIC_DEMO';
  /**
   * Provenance derived by the trusted ingestion adapter (see services/api/src/evidenceTrust.ts).
   * Absent means the response never passed through a trusted adapter: treated as UNVERIFIED.
   */
  trustedSource?: DataStatus;
}

export interface HospitalCandidate {
  hospitalId: string;
  hospitalName: string;
  capabilityMatch: number;
  requiredCapabilitiesSatisfied: CapabilityType[];
  missingCapabilities: CapabilityType[];
  operationalEligibility: 'ELIGIBLE' | 'PENDING_ACCEPTANCE' | 'INELIGIBLE';
  acceptanceStatus: 'PENDING' | 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'EXPIRED' | 'UNKNOWN' | 'UNAVAILABLE';
  distanceKm: number;
  etaMinutes: number;
  dataFreshness?: string;
  reason: string;
}
