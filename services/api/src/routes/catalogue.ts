import { Router, type Request, type Response } from 'express';
import type { AuthContext } from '@jiva/auth';
import {
  CatalogueImportApplyCommandSchema,
  CatalogueImportPreviewCommandSchema,
  CatalogueKindSchema,
  type CatalogueKind,
  type MedicationEntry,
  type ScanAssetEntry,
} from '@jiva/event-schema';
import { authorizeCatalogueAdmin, authorizeCatalogueRead, catalogue, catalogueAssets } from '../catalogue';
import type { StoredEntry } from '../catalogue/catalogue';
import { contentDisposition } from '../clinical/documents';
import type { Decision } from '../clinical/policy';
import { audit, denied, idempotent, replayOr, validationError } from '../commands/support';

type AuthedRequest = Request & { auth?: AuthContext };

/** An entry as clients see it: the canonical entry plus its revision and last change. */
const project = (s: StoredEntry) => ({ ...s.entry, revision: s.revision, updatedAt: s.updatedAt });

function allowed(req: AuthedRequest, res: Response, decision: Decision, action?: string, kind?: string): boolean {
  if (decision.allowed) return true;
  if (action) audit(req.auth!, action, 'DENIED', { entityType: 'CATALOGUE', ...(kind ? { entityId: kind } : {}), reasonCode: decision.code });
  denied(res, decision);
  return false;
}

/** The catalogue named in the path, if it exists in this mode (sample documents exist in DEMO mode only). */
function kindOf(req: AuthedRequest, res: Response): CatalogueKind | undefined {
  const k = CatalogueKindSchema.safeParse(req.params.kind);
  if (!k.success || !catalogue.isAvailable(k.data)) {
    res.status(404).json({ error: 'not_found' });
    return undefined;
  }
  return k.data;
}

const text = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/**
 * Clinical catalogue: sample documents (DEMO only) and medication metadata. Clinicians and administrators
 * read it; administrators import (preview → apply) and export it. Nothing here touches a patient record:
 * attaching a sample or prescribing goes through the encounter's own commands.
 */
export function catalogueRouter(): Router {
  const router = Router();

  router.get('/catalogue', (req: AuthedRequest, res) => {
    if (!allowed(req, res, authorizeCatalogueRead(req.auth!))) return;
    const kinds = Object.fromEntries((['medications', 'scan-assets'] as CatalogueKind[]).map(k => [k, catalogue.isAvailable(k)
      ? { available: true, catalogueVersion: catalogue.version(k), entries: catalogue.list(k).length, notice: catalogue.notice(k) }
      : { available: false }]));
    res.json({ schemaVersion: 1, kinds });
  });

  router.get('/catalogue/:kind', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    if (!allowed(req, res, authorizeCatalogueRead(auth))) return;
    const kind = kindOf(req, res);
    if (!kind) return;
    const q = text(req.query.q);
    const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '200'), 10) || 200, 1), 500);
    // Withdrawn entries are history: administrators may list them, prescribers never choose them.
    const includeWithdrawn = auth.role === 'ADMIN' && req.query.includeWithdrawn === 'true';
    let list = catalogue.list(kind, { includeWithdrawn });
    if (kind === 'medications' && q) {
      list = list.filter(s => {
        const m = s.entry as MedicationEntry;
        return m.name.toLowerCase().includes(q) || m.medicationId.toLowerCase().includes(q) || (m.atcCode ?? '').toLowerCase() === q;
      });
    }
    if (kind === 'scan-assets') {
      const type = String(req.query.documentType ?? '');
      list = list.filter(s => {
        const e = s.entry as ScanAssetEntry;
        return (!type || e.documentType === type) && (!q || e.title.toLowerCase().includes(q) || e.assetId.toLowerCase().includes(q));
      });
    }
    res.json({ kind, catalogueVersion: catalogue.version(kind), notice: catalogue.notice(kind), entries: list.slice(0, limit).map(project) });
  });

  router.get('/catalogue/scan-assets/:assetId/content', (req: AuthedRequest, res) => {
    if (!allowed(req, res, authorizeCatalogueRead(req.auth!))) return;
    if (!catalogue.isAvailable('scan-assets')) return res.status(404).json({ error: 'not_found' });
    const stored = catalogue.get('scan-assets', String(req.params.assetId));
    const e = stored?.entry as ScanAssetEntry | undefined;
    if (!e || e.status !== 'ACTIVE') return res.status(404).json({ error: 'not_found' });
    const stream = catalogueAssets.open(e);
    if (!stream) {
      console.error(`[Catalogue] Asset of ${e.assetId} is missing or no longer matches its entry.`);
      return res.status(503).json({ error: 'asset_unavailable' });
    }
    res.set({
      'Content-Type': e.contentType,
      'Content-Length': String(e.sizeBytes),
      'Content-Disposition': contentDisposition(e.assetRef),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  router.get('/catalogue/:kind/export', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    if (!allowed(req, res, authorizeCatalogueAdmin(auth), 'catalogue.export', String(req.params.kind))) return;
    const kind = kindOf(req, res);
    if (!kind) return;
    const format = req.query.format === 'csv' ? 'csv' : 'json';
    audit(auth, 'catalogue.export', 'ALLOWED', { entityType: 'CATALOGUE', entityId: kind });
    res.set('Content-Disposition', contentDisposition(`jiva-${kind}-v${catalogue.version(kind)}.${format}`));
    if (format === 'csv') res.type('text/csv; charset=utf-8').send(catalogue.exportCsv(kind));
    else res.type('application/json; charset=utf-8').send(catalogue.exportJson(kind));
  });

  router.post('/catalogue/:kind/import/preview', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    if (!allowed(req, res, authorizeCatalogueAdmin(auth), 'catalogue.import.preview', String(req.params.kind))) return;
    const kind = kindOf(req, res);
    if (!kind) return;
    const parsed = CatalogueImportPreviewCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const { candidates: _kept, userId: _user, ...preview } = catalogue.preview(kind, parsed.data.format, parsed.data.content, auth.userId);
    audit(auth, 'catalogue.import.preview', 'ALLOWED', { entityType: 'CATALOGUE', entityId: kind });
    res.status(200).json(preview);
  });

  router.post('/catalogue/:kind/import/apply', (req: AuthedRequest, res) => {
    const auth = req.auth!;
    if (!allowed(req, res, authorizeCatalogueAdmin(auth), 'catalogue.import', String(req.params.kind))) return;
    const kind = kindOf(req, res);
    if (!kind) return;
    const parsed = CatalogueImportApplyCommandSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const idem = idempotent('catalogue.import', auth, parsed.data.clientRequestId, { kind, ...parsed.data });
    if (replayOr(res, idem)) return;
    const result = catalogue.apply(kind, parsed.data.previewId, auth.userId, parsed.data.confirmChanges);
    if (!result.ok) {
      audit(auth, 'catalogue.import', 'DENIED', { entityType: 'CATALOGUE', entityId: kind, reasonCode: result.code.toUpperCase() });
      return res.status(result.status).json({ error: result.code, message: result.message });
    }
    audit(auth, 'catalogue.import', 'ALLOWED', { entityType: 'CATALOGUE', entityId: kind });
    const { ok: _ok, ...body } = result;
    const response = { status: 'imported', kind, ...body };
    idem.remember(200, response);
    return res.status(200).json(response);
  });

  return router;
}
