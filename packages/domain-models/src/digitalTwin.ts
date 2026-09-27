import {
  Address,
  LocationData,
  ContactData,
  Capabilities,
  HistoricalCapacity,
  OperationalState,
  CapabilityStatus,
  DataStatus,
} from './hospital';
import { EvidenceRecord } from './evidence';

export type FacilityTier =
  | 'APEX_TRAUMA_CENTER'
  | 'TERTIARY_CARE'
  | 'SECONDARY_CARE'
  | 'PRIMARY_CARE'
  | 'SPECIALTY_CARDIAC'
  | 'SPECIALTY_NEURO'
  | 'SPECIALTY_PEDIATRIC'
  | 'SPECIALTY_MATERNITY'
  | 'UNKNOWN';

export type EquipmentReadinessStatus = 'FUNCTIONAL_READY' | 'MAINTENANCE' | 'OCCUPIED' | 'STANDBY' | 'UNKNOWN';

/**
 * Specialized equipment availability with granular state and evidence.
 */
export interface CriticalEquipmentTwin {
  equipmentType:
    | 'CATH_LAB'
    | 'CT_SCANNER'
    | 'MRI_SCANNER'
    | 'VENTILATOR'
    | 'ECMO'
    | 'DIALYSIS_MACHINE'
    | 'BLOOD_BANK_REFRIGERATION'
    | 'EMERGENCY_OT';
  status: EvidenceRecord<EquipmentReadinessStatus>;
  totalUnits?: EvidenceRecord<number>;
  availableUnits?: EvidenceRecord<number>;
  specifications?: string; // e.g. "128-slice CT", "3.0T MRI", "Biplane Cath Lab"
}

/**
 * Emergency department live intake and throughput state.
 */
export interface EmergencyDepartmentTwin {
  intakeStatus: EvidenceRecord<CapabilityStatus>;
  triageBacklogCount?: EvidenceRecord<number>;
  ambulanceBayOccupancy?: EvidenceRecord<number>;
  divertStatusReason?: EvidenceRecord<string>;
  lastIntakeConfirmation?: EvidenceRecord<string>;
}

/**
 * Intensive care digital twin capturing sub-specialty units.
 */
export interface IntensiveCareTwin {
  generalIcu: EvidenceRecord<CapabilityStatus>;
  cardiacIcu?: EvidenceRecord<CapabilityStatus>;
  neuroIcu?: EvidenceRecord<CapabilityStatus>;
  pediatricIcu?: EvidenceRecord<CapabilityStatus>;
  neonatalIcu?: EvidenceRecord<CapabilityStatus>;
  ventilatorsAvailable?: EvidenceRecord<number>;
  burnsUnit?: EvidenceRecord<CapabilityStatus>;
}

/**
 * Specialist clinical team availability for emergency care.
 */
export interface ClinicalStaffingTwin {
  emergencyPhysicianOnDuty: EvidenceRecord<boolean>;
  interventionalCardiologistOnCall: EvidenceRecord<boolean>;
  neurosurgeonOnCall: EvidenceRecord<boolean>;
  traumaSurgeonOnCall: EvidenceRecord<boolean>;
  intensivistOnDuty: EvidenceRecord<boolean>;
}

/**
 * Hospital Digital Twin representation.
 * Unifies baseline regulatory records with live operational evidence,
 * physical equipment, and clinical staffing readiness while strictly isolating
 * historical public records from real-time operational availability.
 */
export interface HospitalDigitalTwin {
  /** Canonical JIVA hospital identifier (e.g., 'HOSP-BLR-001'). */
  hospitalId: string;

  /** Common display name. */
  displayName: string;

  /** Formal legal entity name. */
  legalName?: string;

  /** Facility classification tier. */
  tier: EvidenceRecord<FacilityTier>;

  /** Regulatory identifiers. */
  regulatory: {
    kpmeRegistrationNumber?: EvidenceRecord<string>;
    hfrId?: EvidenceRecord<string>;
    pmjayId?: EvidenceRecord<string>;
    rohsId?: EvidenceRecord<string>;
  };

  /** Physical facility geolocations (main gate vs designated ambulance ER bay). */
  geography: {
    address: Address;
    facilityLocation: EvidenceRecord<LocationData>;
    ambulanceEmergencyBayLocation?: EvidenceRecord<LocationData>;
  };

  /** Primary contact channels for emergency coordination. */
  contact: ContactData;

  /**
   * Static / Historical Baseline Capacity.
   * STRICT INVARIANT: Sourced from public health audits or KPME records.
   * NEVER used as a proxy for real-time bed availability.
   */
  historicalBaseline: {
    totalBeds: EvidenceRecord<number>;
    historicalIcuBeds?: EvidenceRecord<number>;
    historicalVentilators?: EvidenceRecord<number>;
    registeredCapabilities: EvidenceRecord<Capabilities>;
  };

  /**
   * Live Operational Twin.
   * STRICT INVARIANT: Must be UNKNOWN until explicitly confirmed via
   * HOSPITAL_CONFIRMED or AUTHORIZED_FEED.
   */
  liveOperations: {
    state: EvidenceRecord<OperationalState>;
    emergencyDepartment: EmergencyDepartmentTwin;
    intensiveCare: IntensiveCareTwin;
    equipment: CriticalEquipmentTwin[];
    staffing: ClinicalStaffingTwin;
  };

  /** Financial profile reference. */
  financialProfileId?: string;

  /** Insurance profile reference. */
  insuranceProfileId?: string;

  /** Overall synchronization timestamp (ISO 8601). */
  lastSynchronizedAt: string;

  /** Data status of the digital twin root entity. */
  rootDataStatus: DataStatus;
}
