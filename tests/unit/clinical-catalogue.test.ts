/**
 * Clinical catalogue: entry schemas (sample documents and medications), the CSV codec, the asset store's
 * reference checks (path, type, size, hash), import preview/apply (new, changed, unchanged, invalid,
 * duplicate; no silent overwrite; stale previews) and export round trips. Also validates the bundled
 * catalogues exactly as the API loads them.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { MedicationEntrySchema, ScanAssetEntrySchema } from '../../packages/event-schema/src';
import { CatalogueAssets, defaultCatalogueDir } from '../../services/api/src/catalogue/assets';
import { CatalogueStore, validateEntry } from '../../services/api/src/catalogue/catalogue';
import { csvCell, parseCsv, toCsv, unguardCell } from '../../services/api/src/catalogue/csv';
import { loadBundledCatalogue } from '../../services/api/src/catalogue';
import { check, eq, ok, run } from './helpers/assert';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic test image '.repeat(8))]);
const PDF = Buffer.from('%PDF-1.4\nsynthetic test report\n%%EOF\n', 'latin1');
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-catalogue-'));
const assetDir = path.join(tmp, 'assets');
fs.mkdirSync(assetDir);
fs.writeFileSync(path.join(assetDir, 'sample-a.png'), PNG);
fs.writeFileSync(path.join(assetDir, 'sample-b.pdf'), PDF);
fs.writeFileSync(path.join(assetDir, 'fake.png'), HTML);
fs.mkdirSync(path.join(assetDir, 'folder.png'));
const assets = new CatalogueAssets(assetDir);

const prov = { source: 'Unit test fixture', licence: 'Synthetic test data' };
const scan = (o: Record<string, unknown> = {}) => ({
  schemaVersion: 1, assetId: 'SCAN-TEST-A', status: 'ACTIVE', category: 'IMAGING', documentType: 'XRAY', title: 'Test X-ray',
  assetRef: 'sample-a.png', contentType: 'image/png', sizeBytes: PNG.length, sha256: sha(PNG), designation: 'SYNTHETIC', provenance: prov, ...o,
});
const med = (o: Record<string, unknown> = {}) => ({
  schemaVersion: 1, medicationId: 'MED-TEST-500-TAB', status: 'ACTIVE', name: 'Testamol', strength: '500 mg', formulation: 'TABLET',
  routes: ['ORAL'], atcCode: 'N02BE01', provenance: prov, ...o,
});
const file = (kind: string, entries: unknown[], version = 1) => ({ schemaVersion: 1, kind, catalogueVersion: version, notice: 'Test catalogue', entries });
const issuesOf = (r: ReturnType<typeof ScanAssetEntrySchema.safeParse>) => (r.success ? [] : r.error.issues.map(i => i.path.join('.')));

run('Clinical catalogue', async () => {
  await check('the bundled catalogues are valid exactly as the API loads them (files present, sizes, hashes, types)', () => {
    const store = new CatalogueStore(new CatalogueAssets(path.join(defaultCatalogueDir(), 'assets')));
    eq(loadBundledCatalogue(store, 'scan-assets'), [], 'scan-assets problems');
    eq(loadBundledCatalogue(store, 'medications'), [], 'medication problems');
    ok(store.list('scan-assets').length >= 8 && store.list('medications').length >= 20, 'entries loaded');
    const types = new Set(store.list('scan-assets').map(s => (s.entry as { documentType: string }).documentType));
    for (const t of ['XRAY', 'CT', 'MRI', 'ULTRASOUND', 'ECG', 'LAB_REPORT']) ok(types.has(t), `sample of type ${t}`);
    ok(store.list('scan-assets').every(s => (s.entry as { designation: string }).designation === 'SYNTHETIC'), 'every bundled sample is synthetic');
  });

  await check('sample entries: type must fit the category, extension must fit the content type, ids and sizes bounded', () => {
    ok(ScanAssetEntrySchema.safeParse(scan()).success, 'valid entry');
    eq(issuesOf(ScanAssetEntrySchema.safeParse(scan({ category: 'LABORATORY' }))), ['documentType'], 'an X-ray filed as laboratory');
    eq(issuesOf(ScanAssetEntrySchema.safeParse(scan({ contentType: 'application/pdf' }))), ['assetRef'], '.png declared as PDF');
    ok(!ScanAssetEntrySchema.safeParse(scan({ sizeBytes: 5 * 1024 * 1024 + 1 })).success, 'larger than 5 MB');
    ok(!ScanAssetEntrySchema.safeParse(scan({ assetId: 'xray-1' })).success, 'id pattern');
    ok(!ScanAssetEntrySchema.safeParse(scan({ designation: 'REAL_PATIENT' })).success, 'only SYNTHETIC or EDUCATIONAL samples');
    ok(!ScanAssetEntrySchema.safeParse(scan({ pixels: 'iVBORw0KGgo=' })).success, 'no embedded binary (unknown fields refused)');
  });

  await check('asset references are bare file names: no directories, no traversal, no absolute paths', () => {
    for (const bad of ['../sample-a.png', 'sub/sample-a.png', 'sub\\sample-a.png', 'C:\\x.png', '/etc/x.png', '.hidden.png', 'sample-a.png.exe', 'SAMPLE.PNG', 'a..b.png', '']) {
      ok(!ScanAssetEntrySchema.safeParse(scan({ assetRef: bad })).success, `schema refuses ${JSON.stringify(bad)}`);
      eq(assets.resolve(bad), undefined, `store refuses ${JSON.stringify(bad)}`);
    }
    eq(assets.resolve('sample-a.png'), path.join(path.resolve(assetDir), 'sample-a.png'), 'plain name resolves inside the store');
  });

  await check('asset files are verified: existence, regular file, size, sha256 and file signature', () => {
    const v = (o: Record<string, unknown>) => validateEntry('scan-assets', scan(o), assets);
    ok(v({}).ok, 'genuine file');
    const code = (o: Record<string, unknown>) => {
      const r = v(o);
      return r.ok ? 'OK' : r.issues[0].message.split(':')[0];
    };
    eq(code({ assetRef: 'missing.png' }), 'ASSET_MISSING', 'missing file');
    eq(code({ assetRef: 'folder.png' }), 'ASSET_NOT_A_FILE', 'a directory');
    eq(code({ sizeBytes: PNG.length + 1 }), 'ASSET_SIZE_MISMATCH', 'size');
    eq(code({ sha256: sha(PDF) }), 'ASSET_HASH_MISMATCH', 'hash');
    eq(code({ assetRef: 'fake.png', sizeBytes: HTML.length, sha256: sha(HTML) }), 'ASSET_TYPE_MISMATCH', 'HTML disguised as PNG');
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, 1);
    fs.writeFileSync(path.join(assetDir, 'huge.png'), big);
    eq(assets.verify({ assetRef: 'huge.png', contentType: 'image/png', sizeBytes: big.length, sha256: sha(big) }).ok ? 'OK' : (assets.verify({ assetRef: 'huge.png', contentType: 'image/png', sizeBytes: big.length, sha256: sha(big) }) as { code: string }).code, 'ASSET_TOO_LARGE', 'oversized file');
  });

  await check('medication entries identify a product only: strict fields, ATC format, unique routes, no dosing', () => {
    ok(MedicationEntrySchema.safeParse(med()).success, 'valid');
    ok(!MedicationEntrySchema.safeParse(med({ routes: ['ORAL', 'ORAL'] })).success, 'duplicate route');
    ok(!MedicationEntrySchema.safeParse(med({ routes: [] })).success, 'no route');
    ok(!MedicationEntrySchema.safeParse(med({ atcCode: 'N2BE1' })).success, 'ATC format');
    ok(!MedicationEntrySchema.safeParse(med({ strength: undefined })).success, 'strength required');
    ok(!MedicationEntrySchema.safeParse(med({ defaultDose: '1 g every 6 hours' })).success, 'dosing advice is not a catalogue field');
    ok(!MedicationEntrySchema.safeParse(med({ formulation: 'PILL' })).success, 'unknown dosage form');
  });

  await check('CSV codec: quotes, escaped quotes, separators and line breaks in fields, CRLF, BOM, blank lines', () => {
    const r = parseCsv('\ufeffa,b,c\r\n"x, y","say ""hi""","line\nbreak"\r\n\r\n1,,3\n', 10);
    ok(r.ok, 'parsed');
    if (!r.ok) return;
    eq(r.header, ['a', 'b', 'c'], 'header (BOM removed)');
    eq(r.rows.map(x => x.cells), [['x, y', 'say "hi"', 'line\nbreak'], ['1', '', '3']], 'cells');
    eq(r.rows.map(x => x.line), [2, 5], 'record start lines (multi-line field counted, blank line skipped)');
    const bad = (t: string) => {
      const p = parseCsv(t, 10);
      return p.ok ? 'OK' : `${p.line}: ${p.error}`;
    };
    ok(bad('a,b\n"open,1\n').startsWith('2:'), 'unterminated quote names its line');
    ok(bad('a,b\nx"y,1\n').includes('quote inside'), 'stray quote');
    ok(bad('a,b\n"x"y,1\n').includes('after a closing quote'), 'text after a closing quote');
    eq(bad(''), '1: The file is empty', 'empty');
    ok(bad('a\n' + '1\n'.repeat(12)).includes('more than 10'), 'record limit');
  });

  await check('CSV export guards against spreadsheet formulas, and import undoes the guard', () => {
    eq(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`, 'formula guarded and quoted');
    eq(csvCell('@SUM(1)'), "'@SUM(1)", 'at-sign guarded');
    eq(csvCell('Paracetamol'), 'Paracetamol', 'plain text unchanged');
    eq(unguardCell("'=1+1"), '=1+1', 'guard removed on import');
    eq(unguardCell("'quoted"), "'quoted", 'an ordinary apostrophe stays');
    eq(toCsv(['h'], [['a,b']]), 'h\r\n"a,b"\r\n', 'CRLF lines');
  });

  const fresh = () => {
    const store = new CatalogueStore(assets);
    store.reset({ 'scan-assets': true, medications: true });
    eq(store.loadFile('medications', file('medications', [med(), med({ medicationId: 'MED-TEST-250-TAB', strength: '250 mg' })])), [], 'fixture loads');
    return store;
  };

  await check('import preview: new / changed (with fields) / unchanged / invalid / duplicate, and nothing changes yet', () => {
    const store = fresh();
    const json = JSON.stringify(file('medications', [
      med(),
      med({ medicationId: 'MED-TEST-250-TAB', strength: '250 mg', routes: ['ORAL', 'SUBLINGUAL'] }),
      med({ medicationId: 'MED-NEW-1-TAB', name: 'Newamol', strength: '1 mg' }),
      med({ medicationId: 'MED-BAD', formulation: 'PILL' }),
      med({ medicationId: 'MED-TWICE-TAB' }),
      med({ medicationId: 'MED-TWICE-TAB', strength: '10 mg' }),
    ]));
    const p = store.preview('medications', 'json', json, 'admin-1');
    eq(p.rows.map(r => r.outcome), ['UNCHANGED', 'CHANGED', 'NEW', 'INVALID', 'DUPLICATE', 'DUPLICATE'], 'outcomes');
    eq(p.rows[1].changedFields, ['routes'], 'changed fields named');
    eq(p.rows[3].issues?.[0].path, 'formulation', 'invalid field named');
    eq(p.summary, { records: 6, new: 1, changed: 1, unchanged: 1, invalid: 1, duplicate: 2 }, 'summary');
    eq(store.version('medications'), 1, 'preview changes nothing');
    eq((store.get('medications', 'MED-TEST-250-TAB')!.entry as { routes: string[] }).routes, ['ORAL'], 'existing entry untouched');
  });

  await check('import file problems: invalid JSON, another kind, unknown or missing CSV columns, too many fields', () => {
    const store = fresh();
    eq(store.preview('medications', 'json', '{not json', 'a').fileProblems[0].message, 'The content is not valid JSON', 'json');
    ok(store.preview('medications', 'json', JSON.stringify(file('scan-assets', [])), 'a').fileProblems[0].message.includes('not medications'), 'wrong kind');
    const header = 'schemaVersion,medicationId,status,name,strength,formulation,routes,atcCode,provenanceSource,provenanceLicence';
    ok(store.preview('medications', 'csv', header.replace('atcCode', 'dose') + '\n', 'a').fileProblems.some(p => p.message.includes('Unknown column "dose"')), 'unknown column');
    ok(store.preview('medications', 'csv', header.replace(',name', '') + '\n1,MED-X-1,ACTIVE,1 mg,TABLET,ORAL,,s,l\n', 'a').fileProblems.some(p => p.message.includes('Missing column "name"')), 'missing column');
    const p = store.preview('medications', 'csv', `${header}\n1,MED-X-1,ACTIVE,X,1 mg,TABLET,ORAL\n`, 'a');
    eq(p.rows[0].outcome, 'INVALID', 'short record');
    ok(p.rows[0].issues?.[0].message.includes('Expected 10 fields'), 'field count named');
  });

  await check('apply: refuses errors, stale previews, other users and unconfirmed changes; never overwrites silently', () => {
    const store = fresh();
    const withError = store.preview('medications', 'json', JSON.stringify([med({ medicationId: 'MED-BAD', formulation: 'PILL' })]), 'admin-1');
    const e1 = store.apply('medications', withError.previewId, 'admin-1', true);
    eq(!e1.ok && [e1.status, e1.code], [422, 'import_has_errors'], 'invalid records block the whole import');

    const change = store.preview('medications', 'json', JSON.stringify([med({ routes: ['ORAL', 'SUBLINGUAL'] })]), 'admin-1');
    const e2 = store.apply('medications', change.previewId, 'admin-2', true);
    eq(!e2.ok && e2.status, 404, "another administrator cannot apply someone else's preview");
    const e3 = store.apply('medications', change.previewId, 'admin-1', false);
    eq(!e3.ok && [e3.status, e3.code], [409, 'changes_need_confirmation'], 'changes need explicit confirmation');
    eq((store.get('medications', 'MED-TEST-500-TAB')!.entry as { routes: string[] }).routes, ['ORAL'], 'still unchanged');

    const add = store.preview('medications', 'json', JSON.stringify([med({ medicationId: 'MED-NEW-1-TAB', strength: '1 mg' })]), 'admin-1');
    const ok1 = store.apply('medications', add.previewId, 'admin-1', false);
    eq(ok1.ok && [ok1.catalogueVersion, ok1.added, ok1.updated], [2, 1, 0], 'new entries need no confirmation');
    const e4 = store.apply('medications', change.previewId, 'admin-1', true);
    eq(!e4.ok && [e4.status, e4.code], [409, 'catalogue_changed'], 'a preview made before another import is stale');

    const again = store.preview('medications', 'json', JSON.stringify([med({ routes: ['ORAL', 'SUBLINGUAL'] })]), 'admin-1');
    const ok2 = store.apply('medications', again.previewId, 'admin-1', true);
    eq(ok2.ok && [ok2.catalogueVersion, ok2.updated], [3, 1], 'confirmed change applied');
    eq([store.get('medications', 'MED-TEST-500-TAB')!.revision, store.get('medications', 'MED-TEST-250-TAB')!.revision], [2, 1], 'only the changed entry gets a new revision');
    ok(!!store.get('medications', 'MED-NEW-1-TAB'), 'entries absent from an import are never deleted');
    const reuse = store.apply('medications', again.previewId, 'admin-1', true);
    eq(!reuse.ok && reuse.status, 404, 'a preview is applied once');
    const none = store.preview('medications', 'json', JSON.stringify([med({ routes: ['ORAL', 'SUBLINGUAL'] })]), 'admin-1');
    const e5 = store.apply('medications', none.previewId, 'admin-1', true);
    eq(!e5.ok && e5.code, 'no_change', 'an import without changes is refused');
    const expired = store.preview('medications', 'json', JSON.stringify([med({ medicationId: 'MED-LATE-TAB' })]), 'admin-1', Date.now() - 16 * 60_000);
    const e6 = store.apply('medications', expired.previewId, 'admin-1', true);
    eq(!e6.ok && e6.status, 404, 'an expired preview cannot be applied');
  });

  await check('sample-document imports verify the referenced files', () => {
    const store = new CatalogueStore(assets);
    store.reset({ 'scan-assets': true, medications: true });
    const p = store.preview('scan-assets', 'json', JSON.stringify([
      scan(),
      scan({ assetId: 'SCAN-TEST-B', category: 'LABORATORY', documentType: 'LAB_REPORT', assetRef: 'sample-b.pdf', contentType: 'application/pdf', sizeBytes: PDF.length, sha256: sha(PDF) }),
      scan({ assetId: 'SCAN-TEST-C', assetRef: 'missing.png' }),
      scan({ assetId: 'SCAN-TEST-D', assetRef: '../outside.png' }),
    ]), 'admin-1');
    eq(p.rows.map(r => r.outcome), ['NEW', 'NEW', 'INVALID', 'INVALID'], 'outcomes');
    ok(p.rows[2].issues?.[0].message.startsWith('ASSET_MISSING'), 'missing file reported');
    eq(p.rows[3].issues?.[0].path, 'assetRef', 'traversal refused by the schema');
  });

  await check('exports round-trip: CSV and JSON re-import as unchanged', () => {
    const store = new CatalogueStore(new CatalogueAssets(path.join(defaultCatalogueDir(), 'assets')));
    store.reset({ 'scan-assets': true, medications: true });
    loadBundledCatalogue(store, 'scan-assets');
    loadBundledCatalogue(store, 'medications');
    for (const kind of ['scan-assets', 'medications'] as const) {
      for (const format of ['csv', 'json'] as const) {
        const content = format === 'csv' ? store.exportCsv(kind) : store.exportJson(kind);
        const p = store.preview(kind, format, content, 'admin-1');
        eq([p.fileProblems.length, p.summary.unchanged, p.summary.records], [0, store.list(kind, { includeWithdrawn: true }).length, store.list(kind, { includeWithdrawn: true }).length], `${kind} ${format}`);
      }
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
});
