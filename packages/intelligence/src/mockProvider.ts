import { 
  AIProvider, 
  ClinicalHandoffInput, ClinicalHandoffOutput, 
  AnomalyExplanationInput, AnomalyExplanationOutput,
  EmergencySummaryInput, EmergencySummaryOutput 
} from './provider';

export class MockAIProvider implements AIProvider {
  async generateClinicalHandoff(input: ClinicalHandoffInput): Promise<ClinicalHandoffOutput> {
    return {
      summary: `Patient ${input.patient.patientId} is arriving via ${input.ambulance.ambulanceId} with ${input.patient.careRequirements.join(', ')}.`,
      criticalAlerts: ['High severity trauma', 'Prepare trauma bay'],
      recommendedPreparations: ['Trauma team activation', 'Blood products on standby']
    };
  }

  async explainAnomaly(input: AnomalyExplanationInput): Promise<AnomalyExplanationOutput> {
    return {
      explanation: `The system detected anomalies: ${input.anomalies.join(', ')}. This suggests a deviation from expected protocols.`,
      severityAssessment: 'MEDIUM',
      suggestedActions: ['Review routing logs', 'Verify hospital capacity manually']
    };
  }

  async summarizeEmergency(input: EmergencySummaryInput): Promise<EmergencySummaryOutput> {
    return {
      briefSummary: `Emergency case ${input.patient.patientId} requiring ${input.patient.careRequirements.join(', ')}.`,
      timelineHighlights: [
        'Emergency reported',
        'Ambulance dispatched',
        'Hospital accepted'
      ]
    };
  }
}
