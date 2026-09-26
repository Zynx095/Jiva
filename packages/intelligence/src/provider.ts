import { CareRequirement, PatientState, HospitalState, AmbulanceState } from '@jiva/domain-models';

// Domain inputs for AI
export interface ClinicalHandoffInput {
  patient: PatientState;
  hospital: HospitalState;
  ambulance: AmbulanceState;
  events: any[]; // The event timeline
}

export interface AnomalyExplanationInput {
  patient: PatientState;
  anomalies: string[];
  events: any[];
}

export interface EmergencySummaryInput {
  patient: PatientState;
  events: any[];
}

// Structured Outputs
export interface ClinicalHandoffOutput {
  summary: string;
  criticalAlerts: string[];
  recommendedPreparations: string[];
}

export interface AnomalyExplanationOutput {
  explanation: string;
  severityAssessment: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  suggestedActions: string[];
}

export interface EmergencySummaryOutput {
  briefSummary: string;
  timelineHighlights: string[];
}

export interface AIProvider {
  generateClinicalHandoff(input: ClinicalHandoffInput): Promise<ClinicalHandoffOutput>;
  explainAnomaly(input: AnomalyExplanationInput): Promise<AnomalyExplanationOutput>;
  summarizeEmergency(input: EmergencySummaryInput): Promise<EmergencySummaryOutput>;
}
