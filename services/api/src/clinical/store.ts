import type {
  AuditRecord,
  ClinicalNote,
  DiagnosticDocument,
  DiagnosticReport,
  HospitalEncounter,
  Practitioner,
  PrehospitalEntry,
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
  countPractitioners(): number;

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
  /** Only to roll back a write whose canonical event could not be recorded. */
  removePrescription(id: string): void;
  getReport(id: string): DiagnosticReport | undefined;
  listReports(encounterId: string): DiagnosticReport[];
  putReport(r: DiagnosticReport): void;
  removeReport(id: string): void;
  getNote(id: string): ClinicalNote | undefined;
  listNotes(encounterId: string): ClinicalNote[];
  putNote(n: ClinicalNote): void;
  removeNote(id: string): void;
  getDocument(id: string): DiagnosticDocument | undefined;
  listDocuments(encounterId: string): DiagnosticDocument[];
  putDocument(d: DiagnosticDocument): void;
  /** Only to roll back a document whose canonical event could not be recorded. */
  removeDocument(id: string): void;
  addMeasurements(list: TelemetryMeasurement[]): void;
  listMeasurements(encounterId: string): TelemetryMeasurement[];
  /** Only to roll back a batch whose canonical event could not be recorded. */
  removeMeasurementBatch(encounterId: string, batchId: string): void;

  // pre-hospital record (per case; written by the attending crew before an encounter exists)
  addPrehospitalEntry(e: PrehospitalEntry): void;
  listPrehospitalEntries(caseId: string): PrehospitalEntry[];
  /** Only to roll back an entry whose canonical event could not be recorded. */
  removePrehospitalEntry(caseId: string, entryId: string): void;

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
const MAX_PREHOSPITAL_ENTRIES_PER_CASE = 500;
/** Remembered command results (idempotent replays); the oldest are forgotten first. */
const MAX_COMMAND_RESULTS = 20_000;

export class LocalClinicalStore implements IClinicalStore {
  private practitioners = new Map<string, Practitioner>();
  private encounters = new Map<string, HospitalEncounter>();
  private prescriptions = new Map<string, Prescription>();
  private reports = new Map<string, DiagnosticReport>();
  private notes = new Map<string, ClinicalNote>();
  private documents = new Map<string, DiagnosticDocument>();
  private measurements = new Map<string, TelemetryMeasurement[]>();
  private prehospital = new Map<string, PrehospitalEntry[]>();
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

  countPractitioners(): number {
    return this.practitioners.size;
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
  removePrescription(id: string) { this.prescriptions.delete(id); }

  getReport(id: string) { return this.reports.get(id); }
  listReports(encounterId: string) { return [...this.reports.values()].filter(r => r.encounterId === encounterId); }
  putReport(r: DiagnosticReport) { this.reports.set(r.reportId, r); }
  removeReport(id: string) { this.reports.delete(id); }

  getNote(id: string) { return this.notes.get(id); }
  listNotes(encounterId: string) { return [...this.notes.values()].filter(n => n.encounterId === encounterId); }
  putNote(n: ClinicalNote) { this.notes.set(n.noteId, n); }
  removeNote(id: string) { this.notes.delete(id); }

  getDocument(id: string) { return this.documents.get(id); }
  listDocuments(encounterId: string) { return [...this.documents.values()].filter(d => d.encounterId === encounterId); }
  putDocument(d: DiagnosticDocument) { this.documents.set(d.documentId, d); }
  removeDocument(id: string) { this.documents.delete(id); }

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

  removeMeasurementBatch(encounterId: string, batchId: string): void {
    const arr = this.measurements.get(encounterId);
    if (arr) this.measurements.set(encounterId, arr.filter(m => m.batchId !== batchId));
  }

  addPrehospitalEntry(e: PrehospitalEntry): void {
    const arr = this.prehospital.get(e.caseId) || [];
    arr.push(e);
    if (arr.length > MAX_PREHOSPITAL_ENTRIES_PER_CASE) arr.splice(0, arr.length - MAX_PREHOSPITAL_ENTRIES_PER_CASE);
    this.prehospital.set(e.caseId, arr);
  }

  listPrehospitalEntries(caseId: string): PrehospitalEntry[] {
    return [...(this.prehospital.get(caseId) || [])];
  }

  removePrehospitalEntry(caseId: string, entryId: string): void {
    const arr = this.prehospital.get(caseId);
    if (arr) this.prehospital.set(caseId, arr.filter(e => e.entryId !== entryId));
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
  putCommandResult(key: string, result: CommandResult) {
    this.commands.set(key, result);
    if (this.commands.size > MAX_COMMAND_RESULTS) this.commands.delete(this.commands.keys().next().value as string);
  }

  /** Demo reset: clears every clinical record; the roster is re-seeded by the caller. */
  reset(): void {
    this.encounters.clear();
    this.prescriptions.clear();
    this.reports.clear();
    this.notes.clear();
    this.documents.clear();
    this.measurements.clear();
    this.prehospital.clear();
    this.audit = [];
    this.commands.clear();
  }
}
