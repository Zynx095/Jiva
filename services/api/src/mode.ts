import { evidenceEnvironment } from './evidenceTrust';

/**
 * Operational vs demo mode — one switch for the whole API.
 *
 *   OPERATIONAL: JIVA_ENVIRONMENT=production|prod, or running on AWS Lambda. Demo personas are refused;
 *                no synthetic network, clinicians or measurements are loaded or generated; demo reset does
 *                not exist; anything not reported by an authoritative source stays unknown.
 *   DEMO:        everything else (the default for local development). Every synthetic element is labelled
 *                SYNTHETIC_DEMO, and every case created here is a demo case.
 *
 * The two never mix in one process: the mode is fixed at start-up, and local state lives in memory.
 * It is the same switch the evidence-trust layer already uses (evidenceEnvironment), so provenance stamps
 * and data loading cannot disagree.
 */
export type RuntimeMode = 'DEMO' | 'OPERATIONAL';

export const runtimeMode = (): RuntimeMode => (evidenceEnvironment() === 'PRODUCTION' ? 'OPERATIONAL' : 'DEMO');
export const isDemoMode = (): boolean => runtimeMode() === 'DEMO';

export interface ProvenanceInputs {
  hospitals: number;
  syntheticHospitals: number;
  ambulances: number;
  syntheticAmbulances: number;
  clinicians: number;
  mappingProvider: string;
  mappingSynthetic: boolean;
  aiProvider: string;
}

/** What the running system is made of, stated plainly (served by GET /api/health). */
export function provenanceReport(i: ProvenanceInputs) {
  const mode = runtimeMode();
  return {
    mode,
    statement:
      mode === 'DEMO'
        ? 'Demonstration: hospitals, ambulances, patients, clinicians, hospital answers and vital signs are synthetic. Nothing shown is real or live.'
        : 'Operational: only data from authenticated users and authoritative sources is used. Missing information is shown as unknown.',
    datasets: {
      network: { hospitals: i.hospitals, syntheticHospitals: i.syntheticHospitals, ambulances: i.ambulances, syntheticAmbulances: i.syntheticAmbulances },
      directory: { dataStatus: 'PUBLIC_LISTED', connectedToJiva: false, note: 'Public facility listings: what a facility offers, never live capacity.' },
      clinicians: { count: i.clinicians, dataStatus: mode === 'DEMO' && i.clinicians > 0 ? 'SYNTHETIC_DEMO' : 'NONE' },
    },
    providers: {
      auth: mode === 'DEMO' ? 'DEMO_PERSONAS' : 'COGNITO_JWT',
      mapping: { active: i.mappingProvider, synthetic: i.mappingSynthetic },
      ai: { provider: i.aiProvider, synthetic: i.aiProvider !== 'BedrockAIProvider' },
      telemetry: { simulator: mode === 'DEMO', medicalDevices: false },
    },
    // No live external integration exists in this codebase; this is stated, not assumed.
    liveIntegrations: { hospitalCapacityFeeds: false, hospitalStaffDirectory: false, medicalDevices: false, documentObjectStorage: false },
  };
}
