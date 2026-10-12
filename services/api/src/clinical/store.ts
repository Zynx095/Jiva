import type {
  AuditRecord,
  DiagnosticDocument,
  DiagnosticReport,
  HospitalEncounter,
  Practitioner,
  Prescription,
  TelemetryMeasurement,
} from '@jiva/domain-models';
import type { EncounterFacts } from './policy';

/**
 * Clinical store: encounters (projected from encounter.* events), clinical records (written by the
 * clinical command handlers) and the clinical audit log.
 *
 * Kept apart from the operational LocalStateStore on purpose: nothing here is ever placed on the
 * operational event bus or returned by the operational read endpoints. Local mode is in-memory and
 * reset by the demo reset; a production implementation would be an encrypted, access-logged store
 * owned per hospital (not implemented — see IMPLEMENTATION_PROGRESS.md).
 */
export interface CommandResult {
  /** sha256 of the canonical request body, to detect an idempotency key reused for a different request. */
  fingerprint: string;
  status: number;
  body: unknown;
}

export interface IClinicalStore {
  // practitioners (staff directory)
  setRoster(practitioners: Practitioner[]): void;
  getPractitioner(practitionerId: string): Practitioner | undefined;
  listPractitioners(hospitalId: string): Practitioner[];

  // encounters
  getEncounter(encounterId: string): HospitalEncounter | undefined;
  findEncounter(caseId: string, hospitalId: string): HospitalEncounter | undefined;
  listEncountersByCase(caseId: string): HospitalEncounter[];
  listEncountersByHospital(hospitalId: string): HospitalEncounter[];
  listEncounters(): HospitalEncounter[];
  putEncounter(encounter: HospitalEncounter): void;
  encounterFacts(encounterId: string): EncounterFacts | undefined;

  // records
  getPrescription(id: string): Prescription | undefined;
  listPrescriptions(encounterId: string): Prescription[];
  putPrescription(p: Prescription): void;
  getReport(id: string): DiagnosticReport | undefined;
  listReports(encounterId: string): DiagnosticReport[];
  putReport(r: DiagnosticReport): void;
  getDocument(id: string): DiagnosticDocument | undefined;
  listDocuments(encounterId: string): DiagnosticDocument[];
  putDocument(d: DiagnosticDocument): void;
  addMeasurements(list: TelemetryMeasurement[]): void;
  listMeasurements(encounterId: string): TelemetryMeasurement[];

  // audit (append-only; content-free)
  appendAudit(record: AuditRecord): void;
  listAudit(filter?: { encounterId?: string; caseId?: string; limit?: number }): AuditRecord[];

  // command idempotency
  getCommandResult(key: string): CommandResult | undefined;
  putCommandResult(key: string, result: CommandResult): void;

  reset(): void;
}

const MAX_AUDIT = 20_000;
const MAX_MEASUREMENTS_PER_ENCOUNTER = 5_000;

export class LocalClinicalStore implements IClinicalStore {
  private practitioners = new Map<string, Practitioner>();
  private encounters = new Map<string, HospitalEncounter>();
  private prescriptions = new Map<string, Prescription>();
  private reports = new Map<string, DiagnosticReport>();
  private documents = new Map<string, DiagnosticDocument>();
  private measurements = new Map<string, TelemetryMeasurement[]>();
  private audit: AuditRecord[] = [];
  private commands = new Map<string, CommandResult>();

  setRoster(practitioners: Practitioner[]): void {
    this.practitioners = new Map(practitioners.map(p => [p.practitionerId, { ...p }]));
  }

  getPractitioner(practitionerId: string): Practitioner | undefined {
    return this.practitioners.get(practitionerId);
  }

  listPractitioners(hospitalId: string): Practitioner[] {
    return [...this.practitioners.values()].filter(p => p.hospitalId === hospitalId);
  }

  getEncounter(encounterId: string): HospitalEncounter | undefined {
    return this.encounters.get(encounterId);
  }

  findEncounter(caseId: string, hospitalId: string): HospitalEncounter | undefined {
    for (const e of this.encounters.values()) if (e.caseId === caseId && e.hospitalId === hospitalId) return e;
    return undefined;
  }

  listEncountersByCase(caseId: string): HospitalEncounter[] {
    return [...this.encounters.values()].filter(e => e.caseId === caseId);
  }

  listEncountersByHospital(hospitalId: string): HospitalEncounter[] {
    return [...this.encounters.values()].filter(e => e.hospitalId === hospitalId);
  }

  listEncounters(): HospitalEncounter[] {
    return [...this.encounters.values()];
  }

  putEncounter(encounter: HospitalEncounter): void {
    this.encounters.set(encounter.encounterId, encounter);
  }

  encounterFacts(encounterId: string): EncounterFacts | undefined {
    const e = this.encounters.get(encounterId);
    return e && { encounterId: e.encounterId, caseId: e.caseId, hospitalId: e.hospitalId, status: e.status, assignedPractitionerId: e.assignedDoctor?.practitionerId };
  }

  getPrescription(id: string) { return this.prescriptions.get(id); }
  listPrescriptions(encounterId: string) { return [...this.prescriptions.values()].filter(p => p.encounterId === encounterId); }
  putPrescription(p: Prescription) { this.prescriptions.set(p.prescriptionId, p); }

  getReport(id: string) { return this.reports.get(id); }
  listReports(encounterId: string) { return [...this.reports.values()].filter(r => r.encounterId === encounterId); }
  putReport(r: DiagnosticReport) { this.reports.set(r.reportId, r); }

  getDocument(id: string) { return this.documents.get(id); }
  listDocuments(encounterId: string) { return [...this.documents.values()].filter(d => d.encounterId === encounterId); }
  putDocument(d: DiagnosticDocument) { this.documents.set(d.documentId, d); }

  addMeasurements(list: TelemetryMeasurement[]): void {
    for (const m of list) {
      const arr = this.measurements.get(m.encounterId) || [];
      arr.push(m);
      if (arr.length > MAX_MEASUREMENTS_PER_ENCOUNTER) arr.splice(0, arr.length - MAX_MEASUREMENTS_PER_ENCOUNTER);
      this.measurements.set(m.encounterId, arr);
    }
  }

  listMeasurements(encounterId: string): TelemetryMeasurement[] {
    return [...(this.measurements.get(encounterId) || [])];
  }

  appendAudit(record: AuditRecord): void {
    this.audit.push(record);
    if (this.audit.length > MAX_AUDIT) this.audit.shift();
  }

  listAudit(filter: { encounterId?: string; caseId?: string; limit?: number } = {}): AuditRecord[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
    return this.audit
      .filter(a => (!filter.encounterId || a.encounterId === filter.encounterId) && (!filter.caseId || a.caseId === filter.caseId))
      .slice(-limit)
      .reverse();
  }

  getCommandResult(key: string) { return this.commands.get(key); }
  putCommandResult(key: string, result: CommandResult) { this.commands.set(key, result); }

  /** Demo reset: clears every clinical record; the roster is re-seeded by the caller. */
  reset(): void {
    this.encounters.clear();
    this.prescriptions.clear();
    this.reports.clear();
    this.documents.clear();
    this.measurements.clear();
    this.audit = [];
    this.commands.clear();
  }
}
