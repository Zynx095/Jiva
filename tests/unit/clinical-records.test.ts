/**
 * Phase 7 — clinical records: versioned, append-only prescriptions and diagnostic reports, the version
 * and status rules, content hashing, and what the patient's projection leaves out.
 */
import { randomUUID } from 'crypto';
import type { PrescriptionContent, ReportContent } from '../../packages/domain-models/src';
import {
  amendPrescription, amendReport, createPrescription, createReport, discontinuePrescription, prescriptionHash, type RecordMeta,
} from '../../services/api/src/clinical/records';
import { projectPrescription, projectReport } from '../../services/api/src/clinical/views';
import { check, eq, ok, run } from './helpers/assert';

const T = (min: number) => new Date(Date.parse('2026-10-12T10:00:00.000Z') + min * 60_000).toISOString();
const doctor = { userId: 'demo-doc-3', role: 'CLINICIAN' as const, hospitalId: 'HOSP-BLR-001', practitionerId: 'PRAC-BLR-001-01' };
const meta = (min: number, actor = doctor): RecordMeta => ({
  encounterId: 'ENC-BLR-001-0000AAAA', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-001', actor, at: T(min), eventId: randomUUID(), dataStatus: 'SYNTHETIC_DEMO',
});
const amox: PrescriptionContent = { medication: 'Amoxicillin', strength: '500 mg', dose: '1 capsule', route: 'ORAL', frequency: 'Every 8 hours', duration: '5 days' };
const cbc: ReportContent = { category: 'LABORATORY', title: 'Complete blood count', findings: 'Hb 13.1 g/dL', effectiveAt: T(0), documentIds: [], patientVisible: false };
const names = () => ({ displayName: 'Dr. Ravi Kumar', specialty: 'Emergency medicine' });

run('Phase 7 — clinical records', async () => {
  await check('a prescription starts ACTIVE at version 1 with author, time and a content hash', () => {
    const rx = createPrescription('RX-1', amox, meta(0));
    eq([rx.current.version, rx.current.status, rx.current.action, rx.current.recordedAt, rx.history.length], [1, 'ACTIVE', 'CREATED', T(0), 1], 'v1');
    eq(rx.current.recordedBy, doctor, 'author from the principal');
    ok(/^[0-9a-f]{64}$/.test(rx.current.contentHash), 'sha256 hex');
    eq(createPrescription('RX-2', { ...amox }, meta(1)).current.contentHash, rx.current.contentHash, 'same content → same hash');
    ok(createPrescription('RX-3', { ...amox, dose: '2 capsules' }, meta(1)).current.contentHash !== rx.current.contentHash, 'different content → different hash');
    ok(prescriptionHash(amox, 'DISCONTINUED') !== prescriptionHash(amox, 'ACTIVE'), 'the status is part of the hash');
  });

  await check('amendments: based on the current version, must change something, append-only with the reason', () => {
    const rx = createPrescription('RX-1', amox, meta(0));
    const stale = amendPrescription(rx, 2, { ...amox, dose: '2 capsules' }, 'Weight-based dose', meta(5));
    eq(stale.ok ? 'ok' : [stale.status, stale.code], [409, 'version_conflict'], 'stale edit');
    const same = amendPrescription(rx, 1, { ...amox }, 'No change', meta(5));
    eq(same.ok ? 'ok' : [same.status, same.code], [422, 'no_change'], 'no change');
    const r = amendPrescription(rx, 1, { ...amox, dose: '2 capsules' }, 'Weight-based dose', meta(5));
    ok(r.ok, 'amended');
    if (!r.ok) return;
    eq([r.record.current.version, r.record.current.action, r.record.current.dose, r.record.current.changeReason], [2, 'AMENDED', '2 capsules', 'Weight-based dose'], 'v2');
    eq(r.record.history.map(v => [v.version, v.dose]), [[1, '1 capsule'], [2, '2 capsules']], 'v1 kept unchanged');
    eq(rx.current.version, 1, 'the input record is not mutated');
  });

  await check('discontinuation is final: no further amendment or second discontinuation', () => {
    const rx = createPrescription('RX-1', amox, meta(0));
    const d = discontinuePrescription(rx, 1, 'Allergic reaction', meta(10));
    ok(d.ok, 'discontinued');
    if (!d.ok) return;
    eq([d.record.current.version, d.record.current.status, d.record.current.action, d.record.current.medication], [2, 'DISCONTINUED', 'DISCONTINUED', 'Amoxicillin'], 'v2 keeps the content');
    const again = discontinuePrescription(d.record, 2, 'Again', meta(11));
    eq(again.ok ? 'ok' : again.code, 'already_discontinued', 'second discontinuation');
    const amend = amendPrescription(d.record, 2, { ...amox, dose: '2 capsules' }, 'Restart', meta(12));
    eq(amend.ok ? 'ok' : amend.code, 'discontinued', 'amending a discontinued prescription');
  });

  await check('reports: PRELIMINARY → FINAL → AMENDED; never back to PRELIMINARY; release alone keeps the clinical status', () => {
    const r1 = createReport('RPT-1', cbc, 'PRELIMINARY', meta(0));
    eq([r1.current.status, r1.current.patientVisible], ['PRELIMINARY', false], 'v1');
    const fin = amendReport(r1, 1, { ...cbc, findings: 'Hb 13.0 g/dL' }, 'FINAL', 'Verified', meta(5));
    ok(fin.ok, 'finalised');
    if (!fin.ok) return;
    eq(fin.record.current.status, 'FINAL', 'final');
    const released = amendReport(fin.record, 2, { ...cbc, findings: 'Hb 13.0 g/dL', patientVisible: true }, 'FINAL', 'Released to patient', meta(6));
    ok(released.ok, 'released');
    if (!released.ok) return;
    eq([released.record.current.status, released.record.current.patientVisible, released.record.current.version], ['FINAL', true, 3], 'release does not make it AMENDED');
    const back = amendReport(released.record, 3, { ...cbc, patientVisible: true }, 'PRELIMINARY', 'Oops', meta(7));
    eq(back.ok ? 'ok' : [back.status, back.code], [409, 'final_report'], 'final → preliminary refused');
    const corrected = amendReport(released.record, 3, { ...cbc, findings: 'Hb 12.9 g/dL', patientVisible: true }, 'FINAL', 'Transcription error', meta(8));
    ok(corrected.ok, 'corrected');
    if (!corrected.ok) return;
    eq(corrected.record.current.status, 'AMENDED', 'changed final report is AMENDED');
    const none = amendReport(corrected.record, 4, { ...cbc, findings: 'Hb 12.9 g/dL', patientVisible: true }, 'FINAL', 'Nothing', meta(9));
    eq(none.ok ? 'ok' : none.code, 'no_change', 'no change');
    eq(corrected.record.history.length, 4, 'every version kept');
  });

  await check("the patient's projections: no staff ids, no internal change reasons, only released attachments", () => {
    const rx = createPrescription('RX-1', amox, meta(0));
    const d = discontinuePrescription(rx, 1, 'Allergic reaction', meta(10));
    if (!d.ok) throw new Error('setup');
    const pv = projectPrescription(d.record, 'PATIENT', names) as Record<string, unknown>;
    const text = JSON.stringify(pv);
    ok(!text.includes('demo-doc-3') && !text.includes('userId') && !text.includes('Allergic reaction'), 'no user id, no change reason');
    eq([pv.status, pv.medication, (pv.prescribedBy as { displayName: string }).displayName, pv.discontinuedAt], ['DISCONTINUED', 'Amoxicillin', 'Dr. Ravi Kumar', T(10)], 'what the patient sees');
    const report = createReport('RPT-1', { ...cbc, documentIds: ['DOC-A', 'DOC-B'], patientVisible: true }, 'FINAL', meta(0));
    const rv = projectReport(report, 'PATIENT', names, ids => ids.filter(id => id === 'DOC-B')) as Record<string, unknown>;
    eq(rv.documentIds, ['DOC-B'], 'only released documents');
    ok(!JSON.stringify(rv).includes('demo-doc-3'), 'no staff id');
    const cv = projectReport(report, 'CLINICIAN', names) as { history: unknown[]; current: { author: { displayName: string } } };
    eq([cv.history.length, cv.current.author.displayName], [1, 'Dr. Ravi Kumar'], 'clinician sees history and author names');
  });
});
