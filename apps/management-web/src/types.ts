import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import type { JivaEvent } from '@jiva/ui/src';

export type { AmbulanceState, HospitalState, PatientState, JivaEvent };

export interface ComponentHealth {
  status?: string;
  provider?: string;
}

/** What the running system is made of (GET /api/health → provenance). */
export interface ProvenanceReport {
  mode: 'DEMO' | 'OPERATIONAL';
  statement: string;
  datasets: {
    network: { hospitals: number; syntheticHospitals: number; ambulances: number; syntheticAmbulances: number };
    directory: { dataStatus: string; connectedToJiva: boolean; note: string };
    clinicians: { count: number; dataStatus: string };
  };
  providers: {
    auth: string;
    mapping: { active: string; synthetic: boolean };
    ai: { provider: string; synthetic: boolean };
    telemetry: { simulator: boolean; medicalDevices: boolean };
  };
  liveIntegrations: Record<string, boolean>;
}

export interface Health {
  status: string;
  environment?: string;
  mode?: 'DEMO' | 'OPERATIONAL';
  demoAuth?: boolean;
  provenance?: ProvenanceReport;
  timestamp?: string;
  components?: {
    eventBus?: ComponentHealth;
    database?: ComponentHealth;
    realtime?: ComponentHealth & { activeConnections?: number };
    mapping?: ComponentHealth & {
      synthetic?: boolean;
      activeProvider?: string;
      chain?: string[];
      fallbackActive?: boolean;
      lastFallbackReason?: string;
      lastRouteAt?: string;
    };
    ai?: ComponentHealth & { failures?: number };
  };
}

export type SelectionKind = 'case' | 'hospital' | 'ambulance';
export interface Selection {
  kind: SelectionKind;
  id: string;
}

export type PanelTab = 'incidents' | 'hospitals' | 'ambulances' | 'directory' | 'activity';

export type { CaseResponse, CaseResponseStatus } from '@jiva/ui/src';

/** Simplified view of the legacy candidate list the eligibility engine published for a case. */
export interface CandidateSummary {
  hospitalId: string;
  hospitalName: string;
  operationalEligibility: string;
  distanceKm?: number;
  etaMinutes?: number;
  reason?: string;
  missingCapabilities: string[];
}
