import { EvidenceRecord } from './evidence';
import { DataStatus } from './hospital';

export type PricingCategory =
  | 'GOVERNMENT_FREE'
  | 'GOVERNMENT_SUBSIDIZED'
  | 'CHARITABLE_TRUST'
  | 'STANDARD_PRIVATE'
  | 'PREMIUM_PRIVATE'
  | 'UNKNOWN';

export type PaymentMethod = 'UPI' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'NET_BANKING' | 'CASH';

/**
 * Standard INR cost range for a medical procedure or care package.
 */
export interface InrCostRange {
  minInr: number;
  maxInr: number;
  medianInr: number;
  includesIcuPerDiem?: boolean;
  includesStandardImplants?: boolean;
}

/**
 * Estimated cost breakdown for high-acuity emergency procedures.
 */
export interface EmergencyProcedureCostEstimate {
  /** Standard clinical procedure code (e.g., 'ACUTE_STEMI_PRIMARY_PCI'). */
  procedureCode: string;

  /** Human-readable procedure title. */
  procedureName: string;

  /** Typical out-of-pocket or package estimate for uninsured / private patients. */
  estimatedCost: EvidenceRecord<InrCostRange>;

  /** Government benchmark ceiling rate (e.g. CGHS, KPME capped rates), where applicable. */
  governmentBenchmarkRateInr?: EvidenceRecord<number>;

  /** PMJAY package tariff benchmark, where applicable. */
  pmjayPackageRateInr?: EvidenceRecord<number>;
}

/**
 * Hospital emergency admission deposit requirements.
 * Critical in the Indian context where unexpected admission deposits create acute delays.
 */
export interface EmergencyDepositPolicy {
  /** Whether the facility mandates an upfront cash deposit prior to ICU/bed assignment. */
  depositRequired: EvidenceRecord<boolean>;

  /** Estimated initial deposit amount in INR. */
  estimatedDepositAmountInr?: EvidenceRecord<number>;

  /**
   * Whether statutory emergency stabilization mandates apply (e.g. legal obligation
   * to stabilize life-threatening emergencies without upfront deposit).
   */
  statutoryWaiverApplies: EvidenceRecord<boolean>;

  /** Accepted payment methods at emergency registration desk. */
  acceptedPaymentMethods: EvidenceRecord<PaymentMethod[]>;
}

/**
 * Comprehensive financial profile for a hospital facility.
 * Enables the coordinator to estimate financial exposure and identify out-of-pocket barriers
 * without compromising emergency stabilization.
 */
export interface HospitalFinancialProfile {
  hospitalId: string;

  /** Overall pricing category / tier. */
  pricingCategory: EvidenceRecord<PricingCategory>;

  /** Emergency deposit policy and statutory waiver rules. */
  depositPolicy: EmergencyDepositPolicy;

  /** Catalog of standard emergency procedural estimates. */
  standardEmergencyProcedures: EmergencyProcedureCostEstimate[];

  /** Public price transparency status conforming to data provenance standards. */
  priceTransparencyStatus: EvidenceRecord<DataStatus>;

  /** Verification of statutory emergency stabilization compliance. */
  statutoryComplianceEmergencyStabilization: EvidenceRecord<boolean>;
}

/**
 * Patient-level financial capability or constraints context.
 * Used for financial alignment advisory (strictly non-exclusionary for acute emergencies).
 */
export interface PatientFinancialContext {
  patientId: string;
  selfReportedBudgetConstraintInr?: number;
  willingnessToPayCategory?: 'GOVERNMENT_ONLY' | 'AFFORDABLE_MODERATE' | 'PRIVATE_COMPREHENSIVE' | 'UNKNOWN';
  hasEmergencySavingsFund?: boolean;
}
