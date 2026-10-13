import fs from 'fs';
import path from 'path';
import { CATALOGUE_KINDS, type CatalogueKind } from '@jiva/event-schema';
import type { AuthContext } from '@jiva/auth';
import { runtimeMode } from '../mode';
import type { Decision } from '../clinical/policy';
import { CatalogueAssets, defaultCatalogueDir } from './assets';
import { CatalogueStore, type Issue } from './catalogue';

/**
 * The process-wide clinical catalogue.
 *
 * DEMO: the bundled catalogues (data/catalogue/*.json) — synthetic sample documents and an illustrative
 * medication list — are loaded at start and again on every demo reset (which also discards demo imports).
 * OPERATIONAL: nothing synthetic is loaded. The sample-document catalogue does not exist there at all (its
 * routes answer 404, so a synthetic sample can never be attached to a real encounter); the medication
 * catalogue starts empty until an administrator imports an authoritative one. Imports live in memory, like
 * every other piece of local state, and are lost when the API stops.
 */
const DIR = defaultCatalogueDir();
export const catalogueAssets = new CatalogueAssets(path.join(DIR, 'assets'));
export const catalogue = new CatalogueStore(catalogueAssets);

export function loadBundledCatalogue(store: CatalogueStore, kind: CatalogueKind, dir = DIR): Issue[] {
  try {
    return store.loadFile(kind, JSON.parse(fs.readFileSync(path.join(dir, `${kind}.json`), 'utf8')));
  } catch (err) {
    return [{ path: `${kind}.json`, message: err instanceof Error ? err.message : String(err) }];
  }
}

export function initialiseCatalogues(): void {
  const demo = runtimeMode() === 'DEMO';
  catalogue.reset({ 'scan-assets': demo, medications: true });
  if (!demo) return;
  for (const kind of CATALOGUE_KINDS) {
    const problems = loadBundledCatalogue(catalogue, kind);
    if (problems.length) console.warn(`[Catalogue] ${kind}: ${problems.length} problem(s) in the bundled catalogue; affected entries are not offered (run npm run catalogue:validate).`);
  }
}

/** Reading the catalogue: clinicians (to choose) and administrators (to manage). */
export function authorizeCatalogueRead(auth: AuthContext): Decision {
  return auth.role === 'CLINICIAN' || auth.role === 'ADMIN'
    ? { allowed: true }
    : { allowed: false, status: 403, code: 'CATALOGUE_READ_DENIED', reason: 'Only clinicians and administrators use the clinical catalogue' };
}

/** Importing and exporting: administrators only. */
export function authorizeCatalogueAdmin(auth: AuthContext): Decision {
  return auth.role === 'ADMIN' ? { allowed: true } : { allowed: false, status: 403, code: 'ADMIN_ONLY', reason: 'Only administrators may import or export the catalogue' };
}
