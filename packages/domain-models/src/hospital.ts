import { GeoPoint } from './patient';

export type DataStatus = 'CURRENT' | 'HISTORICAL' | 'PUBLIC_LISTED' | 'HOSPITAL_CONFIRMED' | 'AUTHORIZED_FEED' | 'SYNTHETIC_DEMO' | 'UNKNOWN' | 'NOT_DISCLOSED' | 'UNVERIFIED';

export interface DataProvenance {
  sourceId: string;
  sourceName: string;
  sourceType: string;
  sourceUrl?: string;
  retrievedAt: string;
  publishedAt?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  asOf?: string;
  /** As claimed by the submitter (legacy field). NOT trusted by the feasibility engine. */
  verificationStatus: DataStatus;
  /** Derived by the trusted ingestion adapter; the only status the feasibility engine reads for live evidence. */
  trustedStatus?: DataStatus;
  confidence: number;
  notes?: string;
}

export interface Address {
  fullAddress: string;
  locality?: string;
  ward?: string;
  zone?: string;
  pincode?: string;
  city: string;
  district: string;
  state: string;
  country: string;
}

export interface LocationData {
  latitude: number;
  longitude: number;
  coordinateSource: string;
  coordinateAccuracy?: string;
}

export interface ContactData {
  phone?: string;
  emergencyPhone?: string;
  email?: string;
  website?: string;
}

export interface Capabilities {
  emergency?: boolean;
  trauma?: boolean;
  icu?: boolean;
  nicu?: boolean;
  picu?: boolean;
  hdu?: boolean;
  ventilator?: boolean;
  cardiology?: boolean;
  cardiacSurgery?: boolean;
  neurology?: boolean;
  neurosurgery?: boolean;
  orthopaedics?: boolean;
  oncology?: boolean;
  paediatrics?: boolean;
  neonatology?: boolean;
  obstetrics?: boolean;
  gynaecology?: boolean;
  generalSurgery?: boolean;
  vascular?: boolean;
  burns?: boolean;
  dialysis?: boolean;
  transplant?: boolean;
  bloodBank?: boolean;
  radiology?: boolean;
  ct?: boolean;
  mri?: boolean;
}

export interface HistoricalCapacity {
  totalBeds?: number;
  icuBeds?: number;
  nicuBeds?: number;
  picuBeds?: number;
  hduBeds?: number;
  emergencyBeds?: number;
  ventilators?: number;
}

export type CapabilityStatus = 'AVAILABLE' | 'LIMITED' | 'UNAVAILABLE' | 'UNKNOWN';

export type AcceptanceStatus = 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE' | 'UNKNOWN' | 'EXPIRED' | 'PENDING';

export interface OperationalState {
  emergency: CapabilityStatus;
  icu: CapabilityStatus;
  trauma: CapabilityStatus;
  nicu: CapabilityStatus;
  picu: CapabilityStatus;
  ventilator: CapabilityStatus;
  acceptance: AcceptanceStatus;
  lastConfirmedAt?: string;
  expiresAt?: string;
  /** Event time of the acceptance response currently applied (ordering watermark). */
  acceptanceAsOf?: string;
  /** Event time of the capacity update currently applied (ordering watermark). */
  capacityAsOf?: string;
  /** Case the current acceptance response refers to. */
  acceptanceCaseId?: string;
  source: 'HOSPITAL_CONFIRMED' | 'AUTHORIZED_FEED' | 'SYNTHETIC_DEMO' | 'UNKNOWN';
}

export interface UtilizationIndicator {
  metricType: string;
  value: number;
  periodStart?: string;
  periodEnd?: string;
  asOf?: string;
  source: string;
  sourceUrl?: string;
  status: DataStatus;
}

export interface HospitalState {
  hospitalId: string;
  displayName: string;
  legalName?: string;
  facilityType?: string;
  ownership?: string;
  teachingStatus?: string;
  kpmeRegistrationNumber?: string;
  hfrId?: string;
  pmjayEmpanelled?: boolean;
  
  address: Address;
  location?: LocationData;
  contact?: ContactData;
  capabilities: Capabilities;
  historicalCapacity: HistoricalCapacity;
  operationalState: OperationalState;
  
  utilizationIndicators: UtilizationIndicator[];
  provenance: DataProvenance[];
  verificationStatus: DataStatus;
  dataStatus: DataStatus; // Root status for whether the record is synthetic or real
}
