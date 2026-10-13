import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { AssetRefSchema, MAX_CATALOGUE_ASSET_BYTES } from '@jiva/event-schema';
import { signatureMatches } from '../clinical/documents';

/**
 * The catalogue's asset store: a directory of sample files that catalogue entries reference by bare file
 * name. Nothing outside this directory can ever be read through a reference — the name is validated by
 * pattern, resolved inside the directory and checked to stay there, and must be a regular file (not a link
 * or a directory). Each file must match its entry's declared size, sha256 and type (by file signature)
 * before it is offered or copied.
 *
 * The directory is not served by any web server; files reach clients only through authorized API routes.
 */

export type AssetProblemCode =
  | 'ASSET_PATH_INVALID'
  | 'ASSET_MISSING'
  | 'ASSET_NOT_A_FILE'
  | 'ASSET_TOO_LARGE'
  | 'ASSET_SIZE_MISMATCH'
  | 'ASSET_HASH_MISMATCH'
  | 'ASSET_TYPE_MISMATCH';

export interface AssetRefDeclaration {
  assetRef: string;
  contentType: 'image/png' | 'image/jpeg' | 'application/pdf';
  sizeBytes: number;
  sha256: string;
}

export type AssetCheck = { ok: true; path: string } | { ok: false; code: AssetProblemCode; message: string };

const MESSAGES: Record<AssetProblemCode, string> = {
  ASSET_PATH_INVALID: 'assetRef is not a plain file name inside the catalogue asset store',
  ASSET_MISSING: 'The referenced file does not exist in the catalogue asset store',
  ASSET_NOT_A_FILE: 'The reference does not point to a regular file',
  ASSET_TOO_LARGE: `The file is larger than ${MAX_CATALOGUE_ASSET_BYTES / (1024 * 1024)} MB`,
  ASSET_SIZE_MISMATCH: 'The file size differs from sizeBytes',
  ASSET_HASH_MISMATCH: 'The file content differs from sha256',
  ASSET_TYPE_MISMATCH: 'The file content is not of the declared contentType',
};

const problem = (code: AssetProblemCode): AssetCheck => ({ ok: false, code, message: MESSAGES[code] });

export class CatalogueAssets {
  readonly root: string;
  /** sha256 + signature verdict per (path, size, mtime): a file is hashed once until it changes. */
  private cache = new Map<string, { sha256: string; head: Buffer }>();

  constructor(dir: string) {
    this.root = path.resolve(dir);
  }

  /** Absolute path for a valid reference, or undefined. Never leaves the asset directory. */
  resolve(assetRef: string): string | undefined {
    if (!AssetRefSchema.safeParse(assetRef).success) return undefined;
    const p = path.resolve(this.root, assetRef);
    return path.dirname(p) === this.root && path.basename(p) === assetRef ? p : undefined;
  }

  verify(ref: AssetRefDeclaration): AssetCheck {
    const p = this.resolve(ref.assetRef);
    if (!p) return problem('ASSET_PATH_INVALID');
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      return problem('ASSET_MISSING');
    }
    if (!st.isFile()) return problem('ASSET_NOT_A_FILE');
    if (st.size > MAX_CATALOGUE_ASSET_BYTES) return problem('ASSET_TOO_LARGE');
    if (st.size !== ref.sizeBytes) return problem('ASSET_SIZE_MISMATCH');
    const key = `${p}|${st.size}|${st.mtimeMs}`;
    let seen = this.cache.get(key);
    if (!seen) {
      const bytes = fs.readFileSync(p);
      seen = { sha256: createHash('sha256').update(bytes).digest('hex'), head: bytes.subarray(0, 132) };
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(key, seen);
    }
    if (seen.sha256 !== ref.sha256) return problem('ASSET_HASH_MISMATCH');
    if (!signatureMatches(ref.contentType, seen.head)) return problem('ASSET_TYPE_MISMATCH');
    return { ok: true, path: p };
  }

  /** A read stream of a verified asset (the caller verified it just before). */
  open(ref: AssetRefDeclaration): fs.ReadStream | undefined {
    const check = this.verify(ref);
    return check.ok ? fs.createReadStream(check.path) : undefined;
  }
}

/** Bundled catalogue location (data/catalogue). JIVA_CATALOGUE_DIR points elsewhere, e.g. for tests. */
export function defaultCatalogueDir(): string {
  return process.env.JIVA_CATALOGUE_DIR || path.resolve(__dirname, '../../../../data/catalogue');
}
