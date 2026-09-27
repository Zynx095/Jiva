import { z } from 'zod';
import {
  PatientState,
  HospitalState,
  AmbulanceState,
  CareRequirement,
  HospitalDigitalTwin,
  DecisionTraceRecord,
  EvidenceRecord,
} from '@jiva/domain-models';

/**
 * Read-only clinical and situational context supplied to advisory intelligence models.
 * STRICT INVARIANT: Contains zero mutating methods. AI can only observe, synthesize, and explain.
 */
export interface AdvisoryContextInput {
  caseId: string;
  patient: PatientState;
  ambulance?: AmbulanceState;
  careRequirement?: CareRequirement;
  decisionTrace?: DecisionTraceRecord;
  candidateTwins?: HospitalDigitalTwin[];
  timestamp: string;
}

/**
 * Plain-language family and patient explanation regarding hospital choice,
 * estimated financial considerations, and cashless insurance coverage.
 */
export const FamilyAdvisorySummarySchema = z.object({
  caseId: z.string(),
  hospitalName: z.string(),
  plainLanguageRationale: z.string(),
  clinicalSuitabilityNote: z.string(),
  transitEtaMinutes: z.number(),
  financialSummary: z.object({
    pricingTierDescription: z.string(),
    depositExpectationNote: z.string(),
    cashlessAssistanceNote: z.string(),
  }),
  safetyReassurance: z.string(),
  generatedAt: z.string(),
});

export type FamilyAdvisorySummary = z.infer<typeof FamilyAdvisorySummarySchema>;

/**
 * High-acuity dispatcher briefing synthesizing multi-criteria trade-offs.
 */
export const DispatcherAdvisoryBriefSchema = z.object({
  caseId: z.string(),
  topRecommendationId: z.string(),
  topRecommendationName: z.string(),
  keyClinicalFactors: z.array(z.string()),
  operationalReadinessRisk: z.enum(['LOW', 'MODERATE', 'HIGH']),
  transitRiskNote: z.string(),
  financialInsuranceFlags: z.array(z.string()),
  contingencyHospitalId: z.string().optional(),
  advisoryDisclaimer: z.string().default('Advisory intelligence only. Routing decisions remain with clinical coordinators.'),
  generatedAt: z.string(),
});

export type DispatcherAdvisoryBrief = z.infer<typeof DispatcherAdvisoryBriefSchema>;

/**
 * Future Intelligence Layer interface for multi-criteria reasoning and synthesis.
 * All methods are asynchronous and return validated advisory data structures.
 */
export interface AdvisoryIntelligenceProvider {
  /**
   * Generates a plain-language briefing for patient families regarding destination and financial guidance.
   */
  generateFamilyAdvisory(context: AdvisoryContextInput): Promise<FamilyAdvisorySummary>;

  /**
   * Synthesizes complex multi-criteria decision traces into concise coordinator briefs.
   */
  generateDispatcherBrief(context: AdvisoryContextInput): Promise<DispatcherAdvisoryBrief>;
}

// ---------------------------------------------------------------------------
// STRICT SAFETY BOUNDARY ENFORCEMENT
// ---------------------------------------------------------------------------

/**
 * Guard confirming that intelligence operations possess ZERO authority to mutate core state.
 */
export function assertAdvisoryAuthorityOnly(actionName: string): void {
  const prohibitedPatterns = [
    /mutate/i,
    /reroute/i,
    /dispatch_ambulance/i,
    /trigger_dispatch/i,
    /execute_dispatch/i,
    /override_eligibility/i,
    /confirm_acceptance/i,
    /publish_route/i,
  ];
  for (const pattern of prohibitedPatterns) {
    if (pattern.test(actionName)) {
      throw new Error(
        `Safety Boundary Violation: Intelligence layer attempted unauthorized action '${actionName}'. AI is strictly advisory and cannot execute operational mutations.`
      );
    }
  }
}
