import { PatientState, HospitalState, AmbulanceState, CareRequirement, HospitalAvailabilityResponse } from '@jiva/domain-models';
import { AnyEvent } from '@jiva/event-schema';

export interface RecordEventResult {
  isDuplicate: boolean;
  eventId: string;
}

export interface IStateStore {
  // Patients (Current State)
  getPatient(patientId: string): Promise<PatientState | undefined>;
  setPatient(patient: PatientState): Promise<void>;
  listPatients(): Promise<PatientState[]>;

  // Hospitals (Current State)
  getHospital(hospitalId: string): Promise<HospitalState | undefined>;
  setHospital(hospital: HospitalState): Promise<void>;
  listHospitals(): Promise<HospitalState[]>;

  // Ambulances (Current State)
  getAmbulance(ambulanceId: string): Promise<AmbulanceState | undefined>;
  setAmbulance(ambulance: AmbulanceState): Promise<void>;
  listAmbulances(): Promise<AmbulanceState[]>;

  // Event History (Event Sourcing / Ledger) with Idempotency Guard
  recordEvent(event: AnyEvent): Promise<RecordEventResult>;
  queryEventsByCase(caseId: string): Promise<AnyEvent[]>;
  listRecentEvents(limit?: number): Promise<AnyEvent[]>;

  // ---- Materialized acceptance/requirement indexes (derived state; event history above is unaffected) ----
  // O(1)-indexed replacement for scanning event history to answer feasibility questions. Optional so
  // stores that do not implement them fall back to the (windowed / unbounded) event-replay path.
  // Ordering: a write is applied only if it is strictly newer under the SAME rule the AcceptanceLedger
  // uses (see services/api/src/infrastructure/stateStore/materializedAcceptance.ts); a stale or
  // duplicate write is a harmless no-op.
  getAcceptanceRecord?(caseId: string, hospitalId: string): Promise<{ request?: { requestId: string; requestedAt: string; expiresAt: string; cancelledAt?: string }; response?: HospitalAvailabilityResponse } | undefined>;
  putAcceptanceRequest?(caseId: string, hospitalId: string, request: { requestId: string; requestedAt: string; expiresAt: string }): Promise<void>;
  putAcceptanceResponse?(caseId: string, hospitalId: string, response: HospitalAvailabilityResponse): Promise<'APPLIED' | 'STALE' | 'DUPLICATE'>;
  putAcceptanceCancellation?(caseId: string, hospitalId: string, requestId: string, cancelledAt: string): Promise<void>;
  getHospitalWideUnavailable?(hospitalId: string): Promise<{ response?: HospitalAvailabilityResponse; newestAcceptingAt?: string } | undefined>;
  getLatestRequirement?(caseId: string): Promise<CareRequirement | undefined>;
  putLatestRequirement?(caseId: string, requirement: CareRequirement): Promise<void>;
  /** All events ever recorded, unbounded, paginated. Needed only to rebuild materialized indexes. */
  listAllEvents?(): Promise<AnyEvent[]>;
  /** Replay the complete history through the shared reducer and (re)write the materialized indexes. */
  rebuildAcceptanceRecords?(): Promise<{ casesHospitalPairs: number; hospitals: number }>;

  // Data Loading & Health
  preloadData(): Promise<void>;
  isHealthy(): Promise<boolean>;
  getProviderName(): string;
}
