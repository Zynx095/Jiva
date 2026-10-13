import { randomBytes } from 'crypto';
import {
  CATALOGUE_SCHEMA_VERSION,
  CatalogueFileEnvelopeSchema,
  MAX_CATALOGUE_ENTRIES,
  MedicationEntrySchema,
  ScanAssetEntrySchema,
  type CatalogueKind,
  type MedicationEntry,
  type ScanAssetEntry,
} from '@jiva/event-schema';
import { canonicalJson } from '@jiva/feasibility';
import { parseCsv, toCsv, unguardCell } from './csv';
import type { CatalogueAssets } from './assets';

/**
 * Versioned clinical catalogue (sample documents and medications), in memory like the rest of local state.
 *
 *  - Every entry is validated against its schema; a sample-document entry is also checked against its file
 *    (exists in the asset store, size, sha256, file signature).
 *  - The catalogue has a version (+1 per applied import); every entry a revision (+1 when it changes) and
 *    the time of its last change. Records that used an entry keep the revision they used.
 *  - Imports are two steps: a preview that changes nothing and lists, record by record, what would be new,
 *    changed, unchanged, invalid or duplicated; then an apply of exactly that preview. An import with any
 *    invalid or duplicated record is refused as a whole; changing existing entries needs explicit
 *    confirmation; an import never deletes entries (withdraw them with status WITHDRAWN instead).
 */

export type CatalogueEntry = ScanAssetEntry | MedicationEntry;

export interface StoredEntry<E extends CatalogueEntry = CatalogueEntry> {
  entry: E;
  revision: number;
  updatedAt: string;
}

export interface Issue {
  path: string;
  message: string;
}

export type RowOutcome = 'NEW' | 'CHANGED' | 'UNCHANGED' | 'INVALID' | 'DUPLICATE';

export interface RowResult {
  /** 1-based position of the record in the import. */
  record: number;
  /** CSV line where the record starts. */
  line?: number;
  id?: string;
  outcome: RowOutcome;
  issues?: Issue[];
  changedFields?: string[];
}

export interface ImportSummary {
  records: number;
  new: number;
  changed: number;
  unchanged: number;
  invalid: number;
  duplicate: number;
}

export interface ImportPreview {
  previewId: string;
  kind: CatalogueKind;
  format: 'csv' | 'json';
  baseVersion: number;
  userId: string;
  createdAt: string;
  expiresAt: string;
  fileProblems: Issue[];
  rows: RowResult[];
  summary: ImportSummary;
  /** Validated entries the apply step would write (kept on the server, never sent back). */
  candidates: CatalogueEntry[];
}

export type ApplyResult =
  | { ok: true; catalogueVersion: number; added: number; updated: number; unchanged: number }
  | { ok: false; status: 404 | 409 | 422; code: string; message: string };

const PREVIEW_TTL_MS = 15 * 60_000;
const MAX_PREVIEWS = 20;

export const idOf = (kind: CatalogueKind, e: CatalogueEntry): string =>
  kind === 'scan-assets' ? (e as ScanAssetEntry).assetId : (e as MedicationEntry).medicationId;

// ------------------------------------------------------------------ CSV columns

interface Column {
  name: string;
  required: boolean;
  type?: 'number' | 'list';
  get: (e: Record<string, unknown>) => unknown;
}

const col = (name: string, required = true, type?: Column['type'], get?: Column['get']): Column => ({ name, required, type, get: get ?? (e => e[name]) });
const provenance = [
  col('provenanceSource', true, undefined, e => (e.provenance as { source?: string } | undefined)?.source),
  col('provenanceLicence', true, undefined, e => (e.provenance as { licence?: string } | undefined)?.licence),
];

export const CSV_COLUMNS: Record<CatalogueKind, Column[]> = {
  'scan-assets': [
    col('schemaVersion', true, 'number'), col('assetId'), col('status'), col('category'), col('documentType'), col('title'),
    col('description', false), col('bodySite', false), col('assetRef'), col('contentType'), col('sizeBytes', true, 'number'), col('sha256'),
    col('designation'), ...provenance,
  ],
  medications: [
    col('schemaVersion', true, 'number'), col('medicationId'), col('status'), col('name'), col('strength'), col('formulation'),
    col('routes', true, 'list'), col('atcCode', false), ...provenance,
  ],
};

/** A CSV record → the entry object the schema validates (empty cells are absent fields). */
function objectFromCells(kind: CatalogueKind, header: string[], cells: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prov: Record<string, string> = {};
  header.forEach((name, i) => {
    const c = CSV_COLUMNS[kind].find(x => x.name === name)!;
    const raw = unguardCell(cells[i] ?? '').trim();
    if (raw === '') return;
    const value = c.type === 'number' ? (/^\d+$/.test(raw) ? Number(raw) : raw) : c.type === 'list' ? raw.split('|').map(v => v.trim()).filter(Boolean) : raw;
    if (name === 'provenanceSource') prov.source = raw;
    else if (name === 'provenanceLicence') prov.licence = raw;
    else out[name] = value;
  });
  if (Object.keys(prov).length) out.provenance = prov;
  return out;
}

function cellsFromEntry(kind: CatalogueKind, e: CatalogueEntry): string[] {
  return CSV_COLUMNS[kind].map(c => {
    const v = c.get(e as unknown as Record<string, unknown>);
    if (v === undefined || v === null) return '';
    return Array.isArray(v) ? v.join('|') : String(v);
  });
}

// ------------------------------------------------------------------ validation

export type EntryCheck = { ok: true; entry: CatalogueEntry } | { ok: false; issues: Issue[] };

/** Schema validation, plus (sample documents) verification of the referenced file. */
export function validateEntry(kind: CatalogueKind, raw: unknown, assets?: CatalogueAssets): EntryCheck {
  const parsed = kind === 'scan-assets' ? ScanAssetEntrySchema.safeParse(raw) : MedicationEntrySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.slice(0, 10).map(i => ({ path: i.path.join('.') || '(record)', message: i.message })) };
  if (kind === 'scan-assets' && assets) {
    const check = assets.verify(parsed.data as ScanAssetEntry);
    if (!check.ok) return { ok: false, issues: [{ path: 'assetRef', message: `${check.code}: ${check.message}` }] };
  }
  return { ok: true, entry: parsed.data };
}

interface ParsedRecord {
  record: number;
  line?: number;
  raw?: unknown;
  issues?: Issue[];
}

/** Parse an import payload into records (structure only; each record is validated afterwards). */
export function parseImport(kind: CatalogueKind, format: 'csv' | 'json', content: string): { fileProblems: Issue[]; records: ParsedRecord[] } {
  if (format === 'json') {
    let doc: unknown;
    try {
      doc = JSON.parse(content);
    } catch {
      return { fileProblems: [{ path: '(file)', message: 'The content is not valid JSON' }], records: [] };
    }
    let entries: unknown[];
    if (Array.isArray(doc)) entries = doc;
    else {
      const env = CatalogueFileEnvelopeSchema.safeParse(doc);
      if (!env.success) return { fileProblems: env.error.issues.slice(0, 10).map(i => ({ path: i.path.join('.') || '(file)', message: i.message })), records: [] };
      if (env.data.kind !== kind) return { fileProblems: [{ path: 'kind', message: `This is a ${env.data.kind} catalogue, not ${kind}` }], records: [] };
      entries = env.data.entries;
    }
    if (entries.length > MAX_CATALOGUE_ENTRIES) return { fileProblems: [{ path: 'entries', message: `At most ${MAX_CATALOGUE_ENTRIES} entries per import` }], records: [] };
    return { fileProblems: [], records: entries.map((raw, i) => ({ record: i + 1, raw })) };
  }

  const csv = parseCsv(content, MAX_CATALOGUE_ENTRIES);
  if (!csv.ok) return { fileProblems: [{ path: `line ${csv.line}`, message: csv.error }], records: [] };
  const known = new Set(CSV_COLUMNS[kind].map(c => c.name));
  const problems: Issue[] = [];
  const seen = new Set<string>();
  for (const h of csv.header) {
    if (!known.has(h)) problems.push({ path: 'header', message: `Unknown column "${h.slice(0, 40)}"` });
    if (seen.has(h)) problems.push({ path: 'header', message: `Column "${h}" appears twice` });
    seen.add(h);
  }
  for (const c of CSV_COLUMNS[kind]) if (c.required && !seen.has(c.name)) problems.push({ path: 'header', message: `Missing column "${c.name}"` });
  if (problems.length) return { fileProblems: problems, records: [] };
  if (csv.rows.length === 0) return { fileProblems: [{ path: '(file)', message: 'The file has a header but no records' }], records: [] };
  return {
    fileProblems: [],
    records: csv.rows.map((r, i) =>
      r.cells.length !== csv.header.length
        ? { record: i + 1, line: r.line, issues: [{ path: '(record)', message: `Expected ${csv.header.length} fields, found ${r.cells.length}` }] }
        : { record: i + 1, line: r.line, raw: objectFromCells(kind, csv.header, r.cells) }),
  };
}

function changedFields(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => canonicalJson(a[k] ?? null) !== canonicalJson(b[k] ?? null)).sort();
}

const rawId = (kind: CatalogueKind, raw: unknown): string | undefined => {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[kind === 'scan-assets' ? 'assetId' : 'medicationId'] : undefined;
  return typeof v === 'string' && v.length <= 60 ? v : undefined;
};

// ------------------------------------------------------------------ store

interface KindState {
  available: boolean;
  version: number;
  notice: string;
  entries: Map<string, StoredEntry>;
}

const emptyState = (available: boolean): KindState => ({ available, version: 0, notice: '', entries: new Map() });

export class CatalogueStore {
  private state: Record<CatalogueKind, KindState> = { 'scan-assets': emptyState(true), medications: emptyState(true) };
  private previews = new Map<string, ImportPreview>();

  constructor(readonly assets: CatalogueAssets) {}

  /** Empty both catalogues; `available` false makes a kind unavailable altogether (e.g. samples outside DEMO). */
  reset(available: Record<CatalogueKind, boolean>): void {
    this.state = { 'scan-assets': emptyState(available['scan-assets']), medications: emptyState(available.medications) };
    this.previews.clear();
  }

  isAvailable(kind: CatalogueKind): boolean {
    return this.state[kind].available;
  }

  version(kind: CatalogueKind): number {
    return this.state[kind].version;
  }

  notice(kind: CatalogueKind): string {
    return this.state[kind].notice;
  }

  /**
   * Load a canonical catalogue file (the bundled one). Invalid entries are skipped and reported; the
   * caller decides whether that is fatal (the validation script) or a warning (the API).
   */
  loadFile(kind: CatalogueKind, doc: unknown, now = new Date().toISOString()): Issue[] {
    const env = CatalogueFileEnvelopeSchema.safeParse(doc);
    if (!env.success) return env.error.issues.slice(0, 10).map(i => ({ path: i.path.join('.') || '(file)', message: i.message }));
    if (env.data.kind !== kind) return [{ path: 'kind', message: `Expected a ${kind} catalogue, found ${env.data.kind}` }];
    const problems: Issue[] = [];
    const entries = new Map<string, StoredEntry>();
    env.data.entries.forEach((raw, i) => {
      const v = validateEntry(kind, raw, this.assets);
      if (!v.ok) {
        problems.push(...v.issues.map(x => ({ path: `entries[${i}].${x.path}`, message: x.message })));
        return;
      }
      const id = idOf(kind, v.entry);
      if (entries.has(id)) {
        problems.push({ path: `entries[${i}]`, message: `Duplicate id ${id}` });
        return;
      }
      entries.set(id, { entry: v.entry, revision: 1, updatedAt: now });
    });
    this.state[kind] = { available: this.state[kind].available, version: env.data.catalogueVersion ?? 1, notice: env.data.notice, entries };
    return problems;
  }

  list(kind: CatalogueKind, opts: { includeWithdrawn?: boolean } = {}): StoredEntry[] {
    return [...this.state[kind].entries.values()]
      .filter(s => opts.includeWithdrawn || s.entry.status === 'ACTIVE')
      .sort((a, b) => idOf(kind, a.entry).localeCompare(idOf(kind, b.entry)));
  }

  get(kind: CatalogueKind, id: string): StoredEntry | undefined {
    return this.state[kind].entries.get(id);
  }

  // ---------------------------------------------------------------- import

  preview(kind: CatalogueKind, format: 'csv' | 'json', content: string, userId: string, now = Date.now()): ImportPreview {
    const { fileProblems, records } = parseImport(kind, format, content);
    const checks = records.map(r => (r.issues ? undefined : validateEntry(kind, r.raw, this.assets)));
    const ids = records.map((r, i) => {
      const c = checks[i];
      return c?.ok ? idOf(kind, c.entry) : rawId(kind, r.raw);
    });
    const count = new Map<string, number>();
    for (const id of ids) if (id) count.set(id, (count.get(id) ?? 0) + 1);

    const rows: RowResult[] = [];
    const candidates: CatalogueEntry[] = [];
    records.forEach((r, i) => {
      const base = { record: r.record, ...(r.line ? { line: r.line } : {}), ...(ids[i] ? { id: ids[i] } : {}) };
      const c = checks[i];
      const id = ids[i];
      if (id && (count.get(id) ?? 0) > 1) {
        rows.push({ ...base, outcome: 'DUPLICATE', issues: [{ path: kind === 'scan-assets' ? 'assetId' : 'medicationId', message: `The id ${id} appears ${count.get(id)} times in this import` }] });
        return;
      }
      if (!c || !c.ok) {
        rows.push({ ...base, outcome: 'INVALID', issues: r.issues ?? (c && !c.ok ? c.issues : []) });
        return;
      }
      const existing = this.state[kind].entries.get(idOf(kind, c.entry));
      if (!existing) rows.push({ ...base, outcome: 'NEW' });
      else {
        const diff = changedFields(existing.entry as unknown as Record<string, unknown>, c.entry as unknown as Record<string, unknown>);
        rows.push(diff.length ? { ...base, outcome: 'CHANGED', changedFields: diff } : { ...base, outcome: 'UNCHANGED' });
      }
      candidates.push(c.entry);
    });

    const n = (o: RowOutcome) => rows.filter(r => r.outcome === o).length;
    const preview: ImportPreview = {
      previewId: `CIP-${randomBytes(8).toString('hex').toUpperCase()}`,
      kind, format, baseVersion: this.state[kind].version, userId,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + PREVIEW_TTL_MS).toISOString(),
      fileProblems, rows,
      summary: { records: rows.length, new: n('NEW'), changed: n('CHANGED'), unchanged: n('UNCHANGED'), invalid: n('INVALID'), duplicate: n('DUPLICATE') },
      candidates,
    };
    for (const [id, p] of this.previews) if (Date.parse(p.expiresAt) < now) this.previews.delete(id);
    while (this.previews.size >= MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value as string);
    this.previews.set(preview.previewId, preview);
    return preview;
  }

  apply(kind: CatalogueKind, previewId: string, userId: string, confirmChanges: boolean, now = Date.now()): ApplyResult {
    const p = this.previews.get(previewId);
    // Someone else's preview, another catalogue's or an expired one: the same answer as an unknown id.
    if (!p || p.userId !== userId || p.kind !== kind || Date.parse(p.expiresAt) < now) {
      return { ok: false, status: 404, code: 'preview_not_found', message: 'This import preview does not exist or has expired. Preview the file again.' };
    }
    const s = this.state[kind];
    if (s.version !== p.baseVersion) {
      this.previews.delete(previewId);
      return { ok: false, status: 409, code: 'catalogue_changed', message: `The catalogue changed since the preview (now version ${s.version}). Preview the file again.` };
    }
    if (p.fileProblems.length || p.summary.invalid || p.summary.duplicate) {
      return { ok: false, status: 422, code: 'import_has_errors', message: 'Fix every invalid or duplicated record before importing; nothing was imported.' };
    }
    if (p.summary.changed && !confirmChanges) {
      return { ok: false, status: 409, code: 'changes_need_confirmation', message: `${p.summary.changed} existing entr${p.summary.changed === 1 ? 'y' : 'ies'} would change. Confirm the changes to import.` };
    }
    if (!p.summary.new && !p.summary.changed) {
      return { ok: false, status: 422, code: 'no_change', message: 'The import contains no new or changed entries.' };
    }
    const at = new Date(now).toISOString();
    let added = 0;
    let updated = 0;
    for (const e of p.candidates) {
      const id = idOf(kind, e);
      const prev = s.entries.get(id);
      if (!prev) {
        s.entries.set(id, { entry: e, revision: 1, updatedAt: at });
        added++;
      } else if (changedFields(prev.entry as unknown as Record<string, unknown>, e as unknown as Record<string, unknown>).length) {
        s.entries.set(id, { entry: e, revision: prev.revision + 1, updatedAt: at });
        updated++;
      }
    }
    s.version += 1;
    this.previews.delete(previewId);
    return { ok: true, catalogueVersion: s.version, added, updated, unchanged: p.summary.unchanged };
  }

  // ---------------------------------------------------------------- export

  exportJson(kind: CatalogueKind): string {
    const s = this.state[kind];
    return JSON.stringify({
      schemaVersion: CATALOGUE_SCHEMA_VERSION, kind, catalogueVersion: Math.max(s.version, 1), notice: s.notice || 'Exported from JIVA.',
      entries: this.list(kind, { includeWithdrawn: true }).map(x => x.entry),
    }, null, 2) + '\n';
  }

  exportCsv(kind: CatalogueKind): string {
    return toCsv(CSV_COLUMNS[kind].map(c => c.name), this.list(kind, { includeWithdrawn: true }).map(x => cellsFromEntry(kind, x.entry)));
  }
}
