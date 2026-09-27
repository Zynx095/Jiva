import { EvidenceRecord } from './evidence';
import { DataStatus } from './hospital';

export type GovernmentSchemeId =
  | 'PMJAY'
  | 'AB_ARK'
  | 'CGHS'
  | 'ECHS'
  | 'ESIS'
  | 'SAST';

export type TpaIdentifier =
  | 'MEDI_ASSIST'
  | 'VIDAL_HEALTH'
  | 'PARAMOUNT_TPA'
  | 'MD_INDIA'
  | 'HERITAGE_TPA'
  | 'FAMILY_HEALTH_PLAN'
  | 'STAR_HEALTH_DIRECT'
  | 'CARE_HEALTH_DIRECT'
  | 'HDFC_ERGO_DIRECT'
  | 'ICICI_LOMBARD_DIRECT'
  | 'OTHER_TPA';

/**
 * Public government health scheme empanelment details.
 */
export interface GovernmentSchemeEmpanelment {
  schemeId: GovernmentSchemeId;
  schemeName: string;
  isEmpanelled: EvidenceRecord<boolean>;
  empanelledSpecialties: EvidenceRecord<string[]>;
  portalVerificationId?: string;
  preauthMode: EvidenceRecord<'ONLINE_PORTAL' | 'DESK_SUBMISSION' | 'EMERGENCY_PROVISIONAL'>;
}

/**
 * Third-Party Administrator (TPA) / Private Insurer cashless agreement at the hospital.
 */
export interface TpaCashlessAgreement {
  tpaId: TpaIdentifier | string;
  tpaName: string;
  isCashlessSupported: EvidenceRecord<boolean>;
  deskOperational24x7: EvidenceRecord<boolean>;
  typicalPreauthTurnaroundMinutes?: EvidenceRecord<number>;
  excludedProcedures?: EvidenceRecord<string[]>;
}

/**
 * Comprehensive insurance profile for a hospital.
 */
export interface HospitalInsuranceProfile {
  hospitalId: string;

  /** Active government health scheme empanelments. */
  governmentSchemes: GovernmentSchemeEmpanelment[];

  /** Private insurer and TPA cashless agreements. */
  tpaNetworks: TpaCashlessAgreement[];

  /** Whether the hospital insurance desk can process provisional emergency pre-authorizations at night. */
  emergencyCashlessDeskAvailable: EvidenceRecord<boolean>;

  /** Overall insurance data provenance status. */
  dataStatus: DataStatus;
}

/**
 * Patient insurance coverage details presented during emergency intake.
 */
export interface PatientInsuranceProfile {
  patientId: string;
  payerType: 'GOVERNMENT_SCHEME' | 'PRIVATE_TPA' | 'CORPORATE_GIPSA' | 'NONE_SELF_PAY' | 'UNKNOWN';
  schemeId?: GovernmentSchemeId;
  tpaId?: TpaIdentifier | string;
  policyNumberMasked?: string;
  sumInsuredEstimatedInr?: number;
  cashlessFeasibility: 'LIKELY_CASHLESS' | 'REIMBURSEMENT_RISK' | 'NON_EMPANELLED' | 'UNKNOWN';
}
