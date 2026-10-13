/**
 * Validates the bundled clinical catalogues (data/catalogue/*.json) with the same code the API uses:
 * every entry against its schema, every sample document against its file (exists inside the asset store,
 * size, sha256, file signature), and no duplicate ids. Also lists asset files no entry references.
 *
 *   npm run catalogue:validate        (exit code 1 on any problem)
 */
import fs from 'fs';
import path from 'path';
import { CATALOGUE_KINDS } from '@jiva/event-schema';
import { CatalogueAssets, defaultCatalogueDir } from '../services/api/src/catalogue/assets';
import { CatalogueStore, type StoredEntry } from '../services/api/src/catalogue/catalogue';
import { loadBundledCatalogue } from '../services/api/src/catalogue';

const dir = defaultCatalogueDir();
const assets = new CatalogueAssets(path.join(dir, 'assets'));
const store = new CatalogueStore(assets);
let failed = false;

for (const kind of CATALOGUE_KINDS) {
  const problems = loadBundledCatalogue(store, kind, dir);
  const entries = store.list(kind, { includeWithdrawn: true });
  if (problems.length) {
    failed = true;
    console.error(`✗ ${kind}: ${problems.length} problem(s)`);
    for (const p of problems) console.error(`    ${p.path}: ${p.message}`);
  } else {
    console.log(`✓ ${kind}: ${entries.length} entries valid (catalogue version ${store.version(kind)})`);
  }
}

const referenced = new Set(store.list('scan-assets', { includeWithdrawn: true }).map((s: StoredEntry) => (s.entry as { assetRef: string }).assetRef));
const files = fs.existsSync(assets.root) ? fs.readdirSync(assets.root) : [];
const orphans = files.filter(f => !referenced.has(f));
if (orphans.length) console.warn(`! ${orphans.length} asset file(s) not referenced by any entry: ${orphans.join(', ')}`);

process.exit(failed ? 1 : 0);
