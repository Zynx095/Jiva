/**
 * Prescription drafts and explicit authorisation: the draft → authorised / discarded lifecycle, what the
 * patient can ever see, the catalogue agreement check (a catalogue match identifies a product, it never
 * prescribes), and the command contracts (authorisation must be attested explicitly).
 */
import { randomUUID } from 'crypto';
import type { PrescriptionContent } from '../../packages/domain-models/src';
import {
  AuthorisePrescriptionCommandSchema, CreatePrescriptionCommandSchema, DiscardPrescriptionDraftCommandSchema, MEDICATION_FORMULATIONS, type MedicationEntry,
} from '../../packages/event-schema/src';
import type { MedicationFormulation } from '../../packages/domain-models/src';
import {
  amendPrescription, authorisePrescription, createPrescription, discardPrescriptionDraft, discontinuePrescription, everAuthorised, prescriptionHash, type RecordMeta,
} from '../../services/api/src/clinical/records';
import { checkAgainstCatalogue } from '../../services/api/src/clinical/medication';
import { projectPrescription } from '../../services/api/src/clinical/views';
import { check, eq, ok, run } from './helpers/assert';

const T = (min: number) => new Date(Date.parse('2026-10-13T10:00:00.000Z') + min * 60_000).toISOString();
const doctor = { userId: 'demo-doc-3', role: 'CLINICIAN' as const, hospitalId: 'HOSP-BLR-001', practitionerId: 'PRAC-BLR-001-01' };
const colleague = { userId: 'demo-doc-x', role: 'CLINICIAN' as const, hospitalId: 'HOSP-BLR-001', practitionerId: 'PRAC-BLR-001-02' };
const meta = (min: number, actor = doctor): RecordMeta => ({
  encounterId: 'ENC-BLR-001-0000AAAA', caseId: 'CASE-BLR-876', hospitalId: 'HOSP-BLR-001', actor, at: T(min), eventId: randomUUID(), dataStatus: 'SYNTHETIC_DEMO',
});
const para: PrescriptionContent = { medication: 'Paracetamol', strength: '500 mg', formulation: 'TABLET', dose: '1 tablet', route: 'ORAL', frequency: 'Every 6 hours as needed' };
const names = () => ({ displayName: 'Dr. Ravi Kumar' });
const result = <T>(r: { ok: true; record: T } | { ok: false; status: number; code: string }) => (r.ok ? 'ok' : `${r.status} ${r.code}`);

const entry = (o: Partial<MedicationEntry> = {}): MedicationEntry => ({
  schemaVersion: 1, medicationId: 'MED-PARACETAMOL-500-TAB', status: 'ACTIVE', name: 'Paracetamol', strength: '500 mg', formulation: 'TABLET',
  routes: ['ORAL'], provenance: { source: 'test', licence: 'test' }, ...o,
});

run('Prescription drafts and authorisation', async () => {
  await check('a draft is not in force: DRAFT v1, no authorisation, and the patient can never see it', () => {
    const rx = createPrescription('RX-1', para, meta(0), { draft: true });
    eq([rx.current.status, rx.current.action, rx.current.version, rx.authorisation], ['DRAFT', 'CREATED', 1, undefined], 'draft v1');
    eq(everAuthorised(rx), false, 'never authorised');
    const direct = createPrescription('RX-2', para, meta(0));
    eq([direct.current.status, direct.authorisation], ['ACTIVE', { authorisedAt: T(0), authorisedBy: doctor, version: 1 }], 'written and authorised in one explicit action');
    ok(prescriptionHash(para, 'DRAFT') !== prescriptionHash(para, 'ACTIVE'), 'status is part of the hash');
  });

  await check('drafts are edited as drafts, then authorised exactly as reviewed (stale versions refused)', () => {
    const d1 = createPrescription('RX-1', para, meta(0), { draft: true });
    const d2 = amendPrescription(d1, 1, { ...para, frequency: 'Every 8 hours as needed' }, 'Draft revised', meta(1));
    ok(d2.ok, 'draft amended');
    if (!d2.ok) return;
    eq([d2.record.current.status, d2.record.current.version, d2.record.authorisation], ['DRAFT', 2, undefined], 'still a draft');
    eq(result(authorisePrescription(d2.record, 1, meta(2))), '409 version_conflict', 'authorising an older version than the one shown');
    const a = authorisePrescription(d2.record, 2, meta(3, colleague));
    ok(a.ok, 'authorised');
    if (!a.ok) return;
    eq([a.record.current.status, a.record.current.action, a.record.current.version, a.record.current.frequency], ['ACTIVE', 'AUTHORISED', 3, 'Every 8 hours as needed'], 'v3 ACTIVE with the reviewed content');
    eq(a.record.authorisation, { authorisedAt: T(3), authorisedBy: colleague, version: 3 }, 'who authorised, when, which version');
    eq(a.record.history.map(v => v.status), ['DRAFT', 'DRAFT', 'ACTIVE'], 'append-only history');
    eq(result(authorisePrescription(a.record, 3, meta(4))), '409 not_a_draft', 'authorised twice');
    eq(result(discardPrescriptionDraft(a.record, 3, 'Oops', meta(4))), '409 not_a_draft', 'an authorised prescription cannot be discarded');
    eq(d1.current.status, 'DRAFT', 'inputs are not mutated');
  });

  await check('discarding: only drafts, final, and never visible to the patient; stopping applies to authorised ones', () => {
    const d = createPrescription('RX-1', para, meta(0), { draft: true });
    eq(result(discontinuePrescription(d, 1, 'Stop', meta(1))), '409 draft', 'a draft is discarded, not stopped');
    const c = discardPrescriptionDraft(d, 1, 'Wrong patient selected', meta(1));
    ok(c.ok, 'discarded');
    if (!c.ok) return;
    eq([c.record.current.status, c.record.current.action, c.record.current.changeReason], ['CANCELLED', 'CANCELLED', 'Wrong patient selected'], 'v2 CANCELLED');
    eq(everAuthorised(c.record), false, 'never in force');
    eq(result(amendPrescription(c.record, 2, { ...para, dose: '2 tablets' }, 'Revive', meta(2))), '409 cancelled', 'no revival');
    eq(result(authorisePrescription(c.record, 2, meta(2))), '409 not_a_draft', 'no late authorisation');
    const active = createPrescription('RX-2', para, meta(0));
    const stopped = discontinuePrescription(active, 1, 'Course complete', meta(5));
    ok(stopped.ok && everAuthorised(stopped.record), 'a stopped prescription was in force (the patient keeps seeing it as stopped)');
  });

  await check('amending an authorised prescription re-authorises it in the name of the amending clinician', () => {
    const rx = createPrescription('RX-1', para, meta(0));
    const r = amendPrescription(rx, 1, { ...para, dose: '2 tablets' }, 'Dose change', meta(5, colleague));
    ok(r.ok, 'amended');
    if (!r.ok) return;
    eq(r.record.authorisation, { authorisedAt: T(5), authorisedBy: colleague, version: 2 }, 'authorisation follows the change');
  });

  await check("the patient's view starts at the authorisation and ignores draft edits", () => {
    const d1 = createPrescription('RX-1', para, meta(0), { draft: true });
    const d2 = amendPrescription(d1, 1, { ...para, dose: '2 tablets' }, 'Draft revised', meta(1));
    const a = d2.ok ? authorisePrescription(d2.record, 2, meta(7)) : d2;
    ok(a.ok, 'authorised');
    if (!a.ok) return;
    const p = projectPrescription(a.record, 'PATIENT', names) as Record<string, unknown>;
    eq([p.prescribedAt, p.changed, p.status, p.formulation], [T(7), false, 'ACTIVE', 'TABLET'], 'prescribed at the authorisation, draft edits are not changes');
    ok(!('history' in p) && !('authorisation' in p) && !JSON.stringify(p).includes('demo-doc'), 'no history, authorisation details or staff ids');
  });

  await check('the content hash covers dosage form and catalogue reference, and absent optionals change nothing', () => {
    const base: PrescriptionContent = { medication: 'Paracetamol', dose: '1 tablet', route: 'ORAL', frequency: 'Every 6 hours' };
    eq(prescriptionHash({ ...base, formulation: undefined, catalogueRef: undefined }, 'ACTIVE'), prescriptionHash(base, 'ACTIVE'), 'undefined optionals');
    ok(prescriptionHash({ ...base, formulation: 'TABLET' }, 'ACTIVE') !== prescriptionHash(base, 'ACTIVE'), 'dosage form');
    ok(prescriptionHash({ ...base, catalogueRef: { medicationId: 'MED-X-1', revision: 2, catalogueVersion: 3 } }, 'ACTIVE') !== prescriptionHash(base, 'ACTIVE'), 'catalogue reference');
  });

  await check('catalogue agreement: the named entry must exist, be active and match name, strength, form and route', () => {
    const lookup = (id: string) => (id === 'MED-PARACETAMOL-500-TAB' ? { entry: entry(), revision: 4 } : id === 'MED-OLD-TAB' ? { entry: entry({ medicationId: 'MED-OLD-TAB', status: 'WITHDRAWN' }), revision: 1 } : undefined);
    const fields = { medicationId: 'MED-PARACETAMOL-500-TAB', medication: 'paracetamol', strength: '500  MG', formulation: 'TABLET', route: 'ORAL' as const };
    eq(checkAgainstCatalogue({ ...fields, medicationId: undefined }, lookup, 7), { ok: true }, 'free text needs no catalogue');
    eq(checkAgainstCatalogue(fields, lookup, 7), { ok: true, ref: { medicationId: 'MED-PARACETAMOL-500-TAB', revision: 4, catalogueVersion: 7 } }, 'case and spacing do not matter; revision recorded');
    const code = (o: Record<string, unknown>) => {
      const r = checkAgainstCatalogue({ ...fields, ...o }, lookup, 7);
      return r.ok ? 'ok' : `${r.error}${r.error === 'catalogue_mismatch' ? `: ${r.message.split(' do')[0].replace('The ', '')}` : ''}`;
    };
    eq(code({ medicationId: 'MED-NOPE-1' }), 'unknown_medication', 'unknown entry');
    eq(code({ medicationId: 'MED-OLD-TAB' }), 'unknown_medication', 'withdrawn entry');
    eq(code({ strength: '1 g' }), 'catalogue_mismatch: strength', 'strength');
    eq(code({ formulation: 'CAPSULE', route: 'IV' }), 'catalogue_mismatch: formulation, route', 'form and route');
    eq(code({ formulation: undefined }), 'catalogue_mismatch: formulation', 'the dosage form must be stated');
    eq(code({ medication: 'Ibuprofen' }), 'catalogue_mismatch: medication', 'another medication under this id');
  });

  await check('contracts: authorisation must be attested explicitly; drafts and catalogue ids are validated; nothing else is accepted', () => {
    const key = randomUUID();
    ok(AuthorisePrescriptionCommandSchema.safeParse({ clientRequestId: key, expectedVersion: 2, attestation: true }).success, 'attested');
    ok(!AuthorisePrescriptionCommandSchema.safeParse({ clientRequestId: key, expectedVersion: 2 }).success, 'no attestation');
    ok(!AuthorisePrescriptionCommandSchema.safeParse({ clientRequestId: key, expectedVersion: 2, attestation: false }).success, 'attestation false');
    ok(!AuthorisePrescriptionCommandSchema.safeParse({ clientRequestId: key, expectedVersion: 2, attestation: 'yes' }).success, 'attestation not boolean true');
    ok(!AuthorisePrescriptionCommandSchema.safeParse({ clientRequestId: key, expectedVersion: 2, attestation: true, authorisedBy: 'demo-doc-1' }).success, 'no identity from the body');
    ok(!DiscardPrescriptionDraftCommandSchema.safeParse({ clientRequestId: key, expectedVersion: 1 }).success, 'discarding needs a reason');
    const create = { clientRequestId: key, medication: 'Paracetamol', dose: '1 tablet', route: 'ORAL', frequency: 'Every 6 hours' };
    ok(CreatePrescriptionCommandSchema.safeParse({ ...create, draft: true, formulation: 'TABLET', medicationId: 'MED-PARACETAMOL-500-TAB' }).success, 'draft from the catalogue');
    ok(!CreatePrescriptionCommandSchema.safeParse({ ...create, medicationId: '../MED' }).success, 'catalogue id pattern');
    ok(!CreatePrescriptionCommandSchema.safeParse({ ...create, formulation: 'PILL' }).success, 'unknown dosage form');
    ok(!CreatePrescriptionCommandSchema.safeParse({ ...create, catalogueRef: { medicationId: 'MED-X-1', revision: 1, catalogueVersion: 1 } }).success, 'catalogue reference is set by the server only');
    ok(!CreatePrescriptionCommandSchema.safeParse({ ...create, status: 'ACTIVE' }).success, 'status cannot be sent');
    const forms: MedicationFormulation[] = [...MEDICATION_FORMULATIONS];
    eq(forms.length, 15, 'domain and contract dosage forms agree');
  });
});
