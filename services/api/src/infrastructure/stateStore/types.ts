import { PatientState, HospitalState, AmbulanceState } from '@jiva/domain-models';
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

  // Data Loading & Health
  preloadData(): Promise<void>;
  isHealthy(): Promise<boolean>;
  getProviderName(): string;
}
