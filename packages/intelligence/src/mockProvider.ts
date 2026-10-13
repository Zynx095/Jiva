import {
  AIProvider,
  ClinicalHandoffInput, ClinicalHandoffOutput,
  AnomalyExplanationInput, AnomalyExplanationOutput,
  EmergencySummaryInput, EmergencySummaryOutput
} from './provider';

/** Timeline milestones the mock may mention, each only when the matching event is in the input. */
const MILESTONES: Array<{ text: string; matches: (e: { eventType?: string; payload?: Record<string, unknown> }) => boolean }> = [
  { text: 'Emergency reported', matches: (e) => e.eventType === 'patient.emergency.created' },
  { text: 'Ambulance dispatched', matches: (e) => e.eventType === 'ambulance.dispatched' },
  { text: 'Hospital accepted', matches: (e) => e.eventType === 'hospital.acceptance.received' && (e.payload?.status === 'ACCEPTED' || e.payload?.status === 'LIMITED') },
  { text: 'Ambulance arrived', matches: (e) => e.eventType === 'ambulance.arrived' },
];

/**
 * Deterministic stand-in for the LLM. It only restates facts it was given (care assessed for the case,
 * symptoms reported by the crew, events that happened): it never asserts a diagnosis, a severity or a
 * milestone that is not in its input — the same patient summary must not say "trauma" for chest pain.
 */
export class MockAIProvider implements AIProvider {
  async generateClinicalHandoff(input: ClinicalHandoffInput): Promise<ClinicalHandoffOutput> {
    const { patient } = input;
    const symptoms = patient.reportedSymptoms ?? [];
    return {
      summary: `Patient ${patient.patientId} is arriving via ${input.ambulance.ambulanceId} with ${patient.careRequirements.join(', ')}.`,
      criticalAlerts: [
        ...(symptoms.length ? [`Reported by the crew: ${symptoms.join(', ')} (not a diagnosis)`] : []),
        ...(patient.suspectedCause ? [`Suspected cause (unconfirmed): ${patient.suspectedCause}`] : []),
      ],
      recommendedPreparations: patient.careRequirements.map((c) => `Confirm ${c} readiness (care assessed for this case)`),
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
    const events = Array.isArray(input.events) ? input.events : [];
    return {
      briefSummary: `Emergency case ${input.patient.patientId} requiring ${input.patient.careRequirements.join(', ')}.`,
      timelineHighlights: MILESTONES.filter((m) => events.some((e) => m.matches(e))).map((m) => m.text),
    };
  }
}
