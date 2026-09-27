import { PatientState, HospitalState, AmbulanceState, CareRequirement, HospitalAvailabilityResponse } from '@jiva/domain-models';
import { AnyEvent } from '@jiva/event-schema';
import { IStateStore, RecordEventResult } from './types';
import {
  CaseHospitalRecord, rebuildFromEvents, shouldAcceptCancellation, shouldAcceptNewestAccepting,
  shouldAcceptRequest, shouldAcceptRequirement, shouldAcceptResponse, shouldAcceptWideUnavailable,
} from './materializedAcceptance';
import fs from 'fs';
import path from 'path';

export class LocalStateStore implements IStateStore {
  private patients = new Map<string, PatientState>();
  private hospitals = new Map<string, HospitalState>();
  private ambulances = new Map<string, AmbulanceState>();

  // Event sourcing / audit ledger
  private eventHistory: AnyEvent[] = [];
  // Idempotency deduplication set
  private processedEventIds = new Set<string>();

  // Expose raw maps for backward compatibility with existing synchronous code where needed
  public readonly patientsStore = this.patients;
  public readonly hospitalsStore = this.hospitals;
  public readonly ambulancesStore = this.ambulances;

  async getPatient(patientId: string): Promise<PatientState | undefined> {
    return this.patients.get(patientId);
  }

  async setPatient(patient: PatientState): Promise<void> {
    const existing = this.patients.get(patient.patientId);
    // Out-of-order protection
    if (existing && existing.lastUpdated && patient.lastUpdated) {
      if (new Date(patient.lastUpdated).getTime() < new Date(existing.lastUpdated).getTime()) {
        console.warn(`[LocalStateStore] Ignored out-of-order patient update for ${patient.patientId}`);
        return;
      }
    }
    this.patients.set(patient.patientId, patient);
  }

  async listPatients(): Promise<PatientState[]> {
    return Array.from(this.patients.values());
  }

  async getHospital(hospitalId: string): Promise<HospitalState | undefined> {
    return this.hospitals.get(hospitalId);
  }

  async setHospital(hospital: HospitalState): Promise<void> {
    const existing = this.hospitals.get(hospital.hospitalId);
    if (existing?.operationalState?.lastConfirmedAt && hospital?.operationalState?.lastConfirmedAt) {
      if (new Date(hospital.operationalState.lastConfirmedAt).getTime() < new Date(existing.operationalState.lastConfirmedAt).getTime()) {
        console.warn(`[LocalStateStore] Ignored out-of-order hospital state update for ${hospital.hospitalId}`);
        return;
      }
    }
    this.hospitals.set(hospital.hospitalId, hospital);
  }

  async listHospitals(): Promise<HospitalState[]> {
    return Array.from(this.hospitals.values());
  }

  async getAmbulance(ambulanceId: string): Promise<AmbulanceState | undefined> {
    return this.ambulances.get(ambulanceId);
  }

  async setAmbulance(ambulance: AmbulanceState): Promise<void> {
    const existing = this.ambulances.get(ambulance.ambulanceId);
    if (existing && existing.lastUpdated && ambulance.lastUpdated) {
      if (new Date(ambulance.lastUpdated).getTime() < new Date(existing.lastUpdated).getTime()) {
        console.warn(`[LocalStateStore] Ignored out-of-order ambulance update for ${ambulance.ambulanceId}`);
        return;
      }
    }
    this.ambulances.set(ambulance.ambulanceId, ambulance);
  }

  async listAmbulances(): Promise<AmbulanceState[]> {
    return Array.from(this.ambulances.values());
  }

  /**
   * Idempotency & Audit recording:
   * Returns isDuplicate: true if this eventId was already recorded.
   */
  async recordEvent(event: AnyEvent): Promise<RecordEventResult> {
    if (this.processedEventIds.has(event.eventId)) {
      console.warn(`[LocalStateStore] Duplicate event detected and safely dropped: ${event.eventType} (${event.eventId})`);
      return { isDuplicate: true, eventId: event.eventId };
    }

    this.processedEventIds.add(event.eventId);
    this.eventHistory.push(event);

    // Keep memory bounded to 10,000 events in local mode
    if (this.eventHistory.length > 10000) {
      this.eventHistory.shift();
    }

    return { isDuplicate: false, eventId: event.eventId };
  }

  /**
   * Append an internally-generated (system) event to the audit ledger.
   * External events are recorded by recordEvent() before publication.
   */
  appendHistory(event: AnyEvent): void {
    if (this.eventHistory.length && this.eventHistory[this.eventHistory.length - 1] === event) return;
    this.eventHistory.push(event);
    if (this.eventHistory.length > 10000) this.eventHistory.shift();
  }

  /** Deterministic demo reset: drop all runtime state and re-seed reference data. */
  async reset(): Promise<void> {
    this.patients.clear();
    this.hospitals.clear();
    this.ambulances.clear();
    this.eventHistory = [];
    this.processedEventIds.clear();
    await this.preloadData();
  }

  async queryEventsByCase(caseId: string): Promise<AnyEvent[]> {
    return this.eventHistory.filter((e: any) =>
      e.patientId === caseId ||
      e.payload?.caseId === caseId ||
      e.payload?.patientId === caseId ||
      e.correlationId === caseId
    );
  }

  async listRecentEvents(limit: number = 100): Promise<AnyEvent[]> {
    return this.eventHistory.slice(-limit).reverse();
  }

  async preloadData(): Promise<void> {
    let hospitalsData: HospitalState[] = [];
    const baseDir = path.resolve(__dirname, '../../../../../data');

    if (process.env.USE_CANONICAL) {
      const canonicalPath = path.join(baseDir, 'canonical/hospitals.json');
      if (fs.existsSync(canonicalPath)) hospitalsData = JSON.parse(fs.readFileSync(canonicalPath, 'utf8'));
    } else {
      const syntheticPath = path.join(baseDir, 'synthetic/bengaluru/hospitals.json');
      if (fs.existsSync(syntheticPath)) hospitalsData = JSON.parse(fs.readFileSync(syntheticPath, 'utf8'));
    }

    for (const h of hospitalsData) {
      this.hospitals.set(h.hospitalId, h);
    }
    console.log(`[LocalStateStore] Preloaded ${hospitalsData.length} hospitals.`);

    // Load ambulances
    const ambPath = path.join(baseDir, 'synthetic/bengaluru/ambulances.json');
    if (fs.existsSync(ambPath)) {
      const ambData = JSON.parse(fs.readFileSync(ambPath, 'utf8'));
      for (const a of ambData) {
        this.ambulances.set(a.ambulanceId, {
          ambulanceId: a.ambulanceId,
          status: a.status || 'AVAILABLE',
          currentLocation: a.currentLocation,
          requiredCapabilities: a.requiredCapabilities || [],
          lastUpdated: new Date().toISOString(),
          provenance: [],
        });
      }
      console.log(`[LocalStateStore] Preloaded ${ambData.length} ambulances.`);
    }
  }

  async isHealthy(): Promise<boolean> {
    return true;
  }

  getProviderName(): string {
    return 'LocalStateStore';
  }

  // ---- Materialized acceptance/requirement indexes (see materializedAcceptance.ts) ----
  private acceptanceRecords = new Map<string, CaseHospitalRecord>();
  private wideUnavailable = new Map<string, { response?: HospitalAvailabilityResponse; newestAcceptingAt?: string }>();
  private latestRequirement = new Map<string, CareRequirement>();

  async getAcceptanceRecord(caseId: string, hospitalId: string): Promise<CaseHospitalRecord | undefined> {
    return this.acceptanceRecords.get(`${caseId}|${hospitalId}`);
  }

  async putAcceptanceRequest(caseId: string, hospitalId: string, request: { requestId: string; requestedAt: string; expiresAt: string }): Promise<void> {
    const key = `${caseId}|${hospitalId}`;
    const rec = this.acceptanceRecords.get(key) || {};
    if (shouldAcceptRequest(rec.request, request)) this.acceptanceRecords.set(key, { ...rec, request: { ...request } });
  }

  async putAcceptanceResponse(caseId: string, hospitalId: string, response: HospitalAvailabilityResponse): Promise<'APPLIED' | 'STALE' | 'DUPLICATE'> {
    const key = `${caseId}|${hospitalId}`;
    const rec = this.acceptanceRecords.get(key) || {};
    if (rec.response?.responseId === response.responseId) return 'DUPLICATE';
    if (!shouldAcceptResponse(rec.response, response)) return 'STALE';
    this.acceptanceRecords.set(key, { ...rec, response: { ...response, acceptedCapabilities: [...response.acceptedCapabilities], limitations: [...response.limitations] } });
    const wide = this.wideUnavailable.get(hospitalId) || {};
    let changed = false;
    if (shouldAcceptWideUnavailable(wide.response, response)) { wide.response = response; changed = true; }
    if (shouldAcceptNewestAccepting(wide.newestAcceptingAt, response)) { wide.newestAcceptingAt = response.respondedAt; changed = true; }
    if (changed) this.wideUnavailable.set(hospitalId, wide);
    return 'APPLIED';
  }

  async putAcceptanceCancellation(caseId: string, hospitalId: string, requestId: string, cancelledAt: string): Promise<void> {
    const key = `${caseId}|${hospitalId}`;
    const rec = this.acceptanceRecords.get(key);
    if (!rec?.request || rec.request.requestId !== requestId) return;
    if (shouldAcceptCancellation(rec.request.cancelledAt, cancelledAt)) {
      this.acceptanceRecords.set(key, { ...rec, request: { ...rec.request, cancelledAt } });
    }
  }

  async getHospitalWideUnavailable(hospitalId: string) {
    return this.wideUnavailable.get(hospitalId);
  }

  async getLatestRequirement(caseId: string): Promise<CareRequirement | undefined> {
    return this.latestRequirement.get(caseId);
  }

  async putLatestRequirement(caseId: string, requirement: CareRequirement): Promise<void> {
    if (shouldAcceptRequirement(this.latestRequirement.get(caseId), requirement)) this.latestRequirement.set(caseId, { ...requirement });
  }

  async listAllEvents(): Promise<AnyEvent[]> {
    return [...this.eventHistory];
  }

  async rebuildAcceptanceRecords(): Promise<{ casesHospitalPairs: number; hospitals: number }> {
    const { byKey, wideByHospital } = rebuildFromEvents(this.eventHistory);
    this.acceptanceRecords = byKey;
    this.wideUnavailable = wideByHospital;
    return { casesHospitalPairs: byKey.size, hospitals: wideByHospital.size };
  }
}
