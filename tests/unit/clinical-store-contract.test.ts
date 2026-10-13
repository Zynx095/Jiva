/**
 * The IClinicalStore contract, as an executable conformance suite. Today it runs against the in-memory
 * LocalClinicalStore; a durable implementation (docs/persistence-plan.md) must pass exactly the same suite
 * before it may replace it. It pins the semantics the command handlers rely on: lookups never cross an
 * encounter or a case, returned lists are copies, rollback helpers remove only what they name, audit and
 * command results are bounded and ordered, and a demo reset clears every record but keeps the roster
 * (which the caller re-seeds).
 */
import type {
  AuditRecord, ClinicalNote, DiagnosticDocument, DiagnosticReport, HospitalEncounter, Practitioner, PrehospitalEntry, Prescription, TelemetryMeasurement,
} from '../../packages/domain-models/src';
import { LocalClinicalStore, type IClinicalStore } from '../../services/api/src/clinical/store';
import { check, eq, ok, run } from './helpers/assert';

const T = '2026-10-13T10:00:00.000Z';
const actor = { userId: 'u', role: 'CLINICIAN' as const, hospitalId: 'H1', practitionerId: 'P1' };
const practitioner = (id: string, hospitalId: string): Practitioner => ({ practitionerId: id, hospitalId, displayName: id, specialty: 'Emergency medicine', active: true, dataStatus: 'SYNTHETIC_DEMO', source: 'test' });
const encounter = (id: string, caseId: string, hospitalId: string, doctor?: string): HospitalEncounter => ({
  encounterId: id, caseId, hospitalId, status: 'IN_CARE', arrival: { arrivedAt: T, recordedBy: actor, eventId: 'e' }, assignmentHistory: [],
  ...(doctor ? { assignedDoctor: { practitionerId: doctor, displayName: doctor, assignedAt: T, assignedBy: actor, reason: 'INITIAL_ASSIGNMENT', eventId: 'e2' } } : {}),
  dataStatus: 'SYNTHETIC_DEMO', createdAt: T, updatedAt: T, version: 1,
});
const version = { version: 1, recordedAt: T, recordedBy: actor, action: 'CREATED' as const, contentHash: 'h', eventId: 'e' };
const rx = (id: string, encounterId: string): Prescription => {
  const v = { medication: 'M', dose: 'd', route: 'ORAL' as const, frequency: 'f', status: 'ACTIVE' as const, ...version };
  return { prescriptionId: id, encounterId, caseId: 'C', hospitalId: 'H1', current: v, history: [v], dataStatus: 'SYNTHETIC_DEMO' };
};
const report = (id: string, encounterId: string): DiagnosticReport => {
  const v = { category: 'LABORATORY' as const, title: 't', effectiveAt: T, documentIds: [], patientVisible: false, status: 'PRELIMINARY' as const, ...version };
  return { reportId: id, encounterId, caseId: 'C', hospitalId: 'H1', current: v, history: [v], dataStatus: 'SYNTHETIC_DEMO' };
};
const note = (id: string, encounterId: string): ClinicalNote => {
  const v = { noteType: 'PROGRESS' as const, title: 't', text: 'x', ...version };
  return { noteId: id, encounterId, caseId: 'C', hospitalId: 'H1', current: v, history: [v], dataStatus: 'SYNTHETIC_DEMO' };
};
const doc = (id: string, encounterId: string): DiagnosticDocument => ({
  documentId: id, encounterId, caseId: 'C', hospitalId: 'H1', category: 'IMAGING', title: 't', fileName: 'f.png', contentType: 'image/png', sizeBytes: 1, sha256: 'a'.repeat(64),
  status: 'AVAILABLE', patientVisible: false, uploadedBy: actor, createdAt: T, dataStatus: 'SYNTHETIC_DEMO',
});
const measurement = (n: number, encounterId: string, batchId: string): TelemetryMeasurement => ({
  measurementId: `${batchId}-${n}`, batchId, encounterId, caseId: 'C', hospitalId: 'H1', type: 'HEART_RATE', value: 60 + (n % 100), unit: 'bpm', observedAt: T, recordedAt: T, source: 'MANUAL_CLINICIAN', dataStatus: 'SYNTHETIC_DEMO',
});
const entry = (id: string, caseId: string): PrehospitalEntry => ({
  entryId: id, caseId, ambulanceId: 'A1', recordedAt: T, recordedBy: { userId: 'crew', role: 'AMBULANCE', ambulanceId: 'A1' }, source: 'MANUAL_CREW', observations: [], dataStatus: 'SYNTHETIC_DEMO', eventId: 'e',
});
const auditEntry = (n: number, o: Partial<AuditRecord> = {}): AuditRecord => ({ auditId: `A${n}`, at: T, actor, action: `act.${n}`, outcome: 'ALLOWED', entityType: 'ENCOUNTER', ...o });

export async function conformance(name: string, make: () => IClinicalStore) {
  await check(`${name}: roster — replaced as a whole, copied on input, read per hospital`, () => {
    const s = make();
    const list = [practitioner('P1', 'H1'), practitioner('P2', 'H2')];
    s.setRoster(list);
    list[0].displayName = 'mutated';
    eq([s.countPractitioners(), s.getPractitioner('P1')?.displayName, s.listPractitioners('H2').map(p => p.practitionerId)], [2, 'P1', ['P2']], 'roster');
    s.setRoster([practitioner('P3', 'H1')]);
    eq([s.countPractitioners(), s.getPractitioner('P1')], [1, undefined], 'replaced, not merged');
  });

  await check(`${name}: encounters — lookups by id, case+hospital, case and hospital never cross`, () => {
    const s = make();
    s.putEncounter(encounter('E1', 'C1', 'H1', 'P1'));
    s.putEncounter(encounter('E2', 'C2', 'H1'));
    s.putEncounter(encounter('E3', 'C1', 'H2'));
    eq([s.findEncounter('C1', 'H1')?.encounterId, s.findEncounter('C1', 'H3')], ['E1', undefined], 'find');
    eq(s.listEncountersByCase('C1').map(e => e.encounterId).sort(), ['E1', 'E3'], 'by case');
    eq(s.listEncountersByHospital('H1').map(e => e.encounterId).sort(), ['E1', 'E2'], 'by hospital');
    eq(s.listEncounters().length, 3, 'all');
    eq(s.encounterFacts('E1'), { encounterId: 'E1', caseId: 'C1', hospitalId: 'H1', status: 'IN_CARE', assignedPractitionerId: 'P1' }, 'authorization facts');
    eq(s.encounterFacts('E9'), undefined, 'unknown');
  });

  await check(`${name}: records — per encounter, replace by id, rollback helpers remove only what they name`, () => {
    const s = make();
    s.putPrescription(rx('RX1', 'E1'));
    s.putPrescription(rx('RX2', 'E2'));
    s.putReport(report('R1', 'E1'));
    s.putNote(note('N1', 'E1'));
    s.putNote(note('N2', 'E2'));
    s.putDocument(doc('D1', 'E1'));
    s.putDocument(doc('D2', 'E1'));
    eq([s.listPrescriptions('E1').map(r => r.prescriptionId), s.listReports('E2'), s.listNotes('E1').map(n => n.noteId), s.listDocuments('E1').length], [['RX1'], [], ['N1'], 2], 'per encounter');
    s.putPrescription({ ...rx('RX1', 'E1'), dataStatus: 'UNVERIFIED' });
    eq([s.listPrescriptions('E1').length, s.getPrescription('RX1')?.dataStatus], [1, 'UNVERIFIED'], 'replaced by id');
    s.removePrescription('RX1');
    s.removeReport('R1');
    s.removeNote('N1');
    s.removeDocument('D1');
    eq([s.getPrescription('RX1'), s.getPrescription('RX2')?.prescriptionId, s.getReport('R1'), s.getNote('N2')?.noteId, s.listDocuments('E1').map(d => d.documentId)], [undefined, 'RX2', undefined, 'N2', ['D2']], 'removed exactly');
  });

  await check(`${name}: measurements — appended per encounter, bounded, copies out, batch rollback`, () => {
    const s = make();
    s.addMeasurements([measurement(1, 'E1', 'B1'), measurement(2, 'E1', 'B1'), measurement(1, 'E2', 'B2')]);
    s.addMeasurements([measurement(1, 'E1', 'B3')]);
    const out = s.listMeasurements('E1');
    out.pop();
    eq([s.listMeasurements('E1').length, s.listMeasurements('E2').length], [3, 1], 'copies out');
    s.removeMeasurementBatch('E1', 'B1');
    eq(s.listMeasurements('E1').map(m => m.batchId), ['B3'], 'only that batch');
    s.addMeasurements(Array.from({ length: 5_010 }, (_, i) => measurement(i, 'E3', 'BIG')));
    const kept = s.listMeasurements('E3');
    eq([kept.length, kept[0].measurementId], [5_000, 'BIG-10'], 'oldest dropped beyond 5,000');
  });

  await check(`${name}: pre-hospital entries — per case, copies out, entry rollback, bounded`, () => {
    const s = make();
    s.addPrehospitalEntry(entry('PH1', 'C1'));
    s.addPrehospitalEntry(entry('PH2', 'C1'));
    s.addPrehospitalEntry(entry('PH3', 'C2'));
    const out = s.listPrehospitalEntries('C1');
    out.length = 0;
    eq(s.listPrehospitalEntries('C1').map(e => e.entryId), ['PH1', 'PH2'], 'per case, copied');
    s.removePrehospitalEntry('C1', 'PH1');
    eq([s.listPrehospitalEntries('C1').map(e => e.entryId), s.listPrehospitalEntries('C2').length], [['PH2'], 1], 'removed exactly');
    for (let i = 0; i < 505; i++) s.addPrehospitalEntry(entry(`X${i}`, 'C3'));
    eq([s.listPrehospitalEntries('C3').length, s.listPrehospitalEntries('C3')[0].entryId], [500, 'X5'], 'oldest dropped beyond 500');
  });

  await check(`${name}: audit — append-only, newest first, filtered, limited, bounded`, () => {
    const s = make();
    s.appendAudit(auditEntry(1, { encounterId: 'E1', caseId: 'C1' }));
    s.appendAudit(auditEntry(2, { caseId: 'C2' }));
    s.appendAudit(auditEntry(3, { encounterId: 'E1', caseId: 'C1' }));
    eq(s.listAudit().map(a => a.auditId), ['A3', 'A2', 'A1'], 'newest first');
    eq(s.listAudit({ encounterId: 'E1' }).map(a => a.auditId), ['A3', 'A1'], 'by encounter');
    eq(s.listAudit({ caseId: 'C2' }).map(a => a.auditId), ['A2'], 'by case');
    eq(s.listAudit({ limit: 1 }).map(a => a.auditId), ['A3'], 'limit');
    eq(s.listAudit({ limit: 0 }).length, 1, 'limit at least 1');
    const big = make();
    for (let i = 0; i < 20_005; i++) big.appendAudit(auditEntry(i));
    eq([big.listAudit({ limit: 5000 }).length, big.listAudit({ limit: 1 })[0].auditId], [2_000, 'A20004'], 'limit at most 2,000; newest kept');
  });

  await check(`${name}: command results (idempotency) — exact key, oldest forgotten first`, () => {
    const s = make();
    s.putCommandResult('k1', { fingerprint: 'f1', status: 201, body: { a: 1 } });
    eq([s.getCommandResult('k1')?.status, s.getCommandResult('k2')], [201, undefined], 'by key');
    for (let i = 0; i < 20_001; i++) s.putCommandResult(`n${i}`, { fingerprint: 'f', status: 200, body: null });
    eq([s.getCommandResult('k1'), s.getCommandResult('n20000')?.status], [undefined, 200], 'oldest evicted beyond 20,000');
  });

  await check(`${name}: reset clears every record, audit and command result, but keeps the roster`, () => {
    const s = make();
    s.setRoster([practitioner('P1', 'H1')]);
    s.putEncounter(encounter('E1', 'C1', 'H1'));
    s.putPrescription(rx('RX1', 'E1'));
    s.putReport(report('R1', 'E1'));
    s.putNote(note('N1', 'E1'));
    s.putDocument(doc('D1', 'E1'));
    s.addMeasurements([measurement(1, 'E1', 'B1')]);
    s.addPrehospitalEntry(entry('PH1', 'C1'));
    s.appendAudit(auditEntry(1));
    s.putCommandResult('k', { fingerprint: 'f', status: 200, body: null });
    s.reset();
    eq([s.listEncounters().length, s.getPrescription('RX1'), s.getReport('R1'), s.getNote('N1'), s.getDocument('D1'), s.listMeasurements('E1').length, s.listPrehospitalEntries('C1').length, s.listAudit().length, s.getCommandResult('k')],
      [0, undefined, undefined, undefined, undefined, 0, 0, 0, undefined], 'cleared');
    ok(s.countPractitioners() === 1, 'roster kept (the caller re-seeds it)');
  });
}

run('Clinical store contract', async () => {
  await conformance('LocalClinicalStore', () => new LocalClinicalStore());
});
