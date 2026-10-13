import { createContext, useContext } from 'react';
import type { NameResolver } from '@jiva/ui/src';
import type { CaseFacts } from './derive';
import type {
  AmbulanceState,
  CandidateSummary,
  CaseResponse,
  HospitalState,
  JivaEvent,
  PanelTab,
  PatientState,
  Selection,
} from './types';

/** Everything the command-center views read, derived once per render in App. */
export interface NetworkModel {
  now: number;
  patients: PatientState[];
  hospitals: HospitalState[];
  ambulances: AmbulanceState[];
  events: JivaEvent[];
  hospitalById: Map<string, HospitalState>;
  ambulanceById: Map<string, AmbulanceState>;
  patientById: Map<string, PatientState>;
  name: NameResolver;
  responses: Map<string, Map<string, CaseResponse>>;
  facts: Map<string, CaseFacts>;
  candidates: Map<string, CandidateSummary[]>;
  pending: Set<string>;
  hospitalStatus: (h: HospitalState) => string;
  ambulanceForCase: (caseId: string) => AmbulanceState | undefined;
  selection: Selection | null;
  select: (s: Selection | null) => void;
  openTab: (tab: PanelTab) => void;
  /** Fit the map to an ambulance's active route. */
  fitRoute: (ambulanceId: string) => void;
}

export const NetworkContext = createContext<NetworkModel | null>(null);

export function useModel(): NetworkModel {
  const m = useContext(NetworkContext);
  if (!m) throw new Error('useModel must be used inside NetworkContext');
  return m;
}
