import fs from 'fs';
import path from 'path';
import { createHash, randomBytes } from 'crypto';
import type { DiagnosticDocument, DocumentContentType } from '@jiva/domain-models';

/**
 * Diagnostic documents (X-rays, ECG traces, lab PDFs…): storage abstraction, upload tickets and the
 * integrity rules. The bytes never travel through the JSON API or the event bus.
 *
 * Workflow
 *   1. Upload intent (JSON command): the assigned clinician declares title, type, size and sha256. The API
 *      creates the document record (PENDING_UPLOAD) and a single-use upload ticket (10 minutes), bound to
 *      that document, that user, that size, type and hash.
 *   2. Upload (PUT /api/uploads/:token, raw body): streamed to a temporary file while counting and hashing;
 *      accepted only if the size, the sha256 and the file signature (magic bytes) match the declaration.
 *      Then moved into storage and the document becomes AVAILABLE; otherwise REJECTED with the reason.
 *   3. Download: only through the API, after the encounter-level authorization check, with download
 *      headers; every download is audited. There is no public URL.
 *
 * Providers: `LocalDocumentStorage` (development: files under a git-ignored directory, named by the
 * server-generated document id, never by the uploaded file name). A production provider would be an
 * encrypted, private object store (S3: presigned PUT bound to Content-Length / Content-Type /
 * x-amz-checksum-sha256, SSE-KMS, Block Public Access, verification on ObjectCreated) — documented, not
 * deployed (see IMPLEMENTATION_PROGRESS.md, Phase 8).
 */

export interface DocumentStorage {
  readonly kind: 'local-filesystem';
  /** A new temporary path for an incoming upload (same volume as the store, so the commit is a rename). */
  tempPath(documentId: string): string;
  /** Move verified bytes into the store. */
  commit(tempPath: string, documentId: string): Promise<void>;
  /** Readable stream of a stored document, or undefined when the bytes are missing. */
  open(documentId: string): fs.ReadStream | undefined;
  /** Discard a temporary file (best effort). */
  discard(tempPath: string): Promise<void>;
  /** Remove a stored document (only to roll back a commit whose event could not be recorded). */
  remove(documentId: string): Promise<void>;
  /** Remove every stored and temporary file (demo reset / start of an ephemeral local run). */
  clear(): Promise<void>;
}

const STORED = /^DOC-[0-9A-F]{16}\.bin$/;
const TEMP = /^DOC-[0-9A-F]{16}\.[0-9a-f]{12}\.part$/;

export class LocalDocumentStorage implements DocumentStorage {
  readonly kind = 'local-filesystem' as const;
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private finalPath(documentId: string): string {
    if (!/^DOC-[0-9A-F]{16}$/.test(documentId)) throw new Error('invalid document id');
    return path.join(this.dir, `${documentId}.bin`);
  }

  tempPath(documentId: string): string {
    this.finalPath(documentId); // validates the id
    return path.join(this.dir, `${documentId}.${randomBytes(6).toString('hex')}.part`);
  }

  async commit(tempPath: string, documentId: string): Promise<void> {
    await fs.promises.rename(tempPath, this.finalPath(documentId));
  }

  open(documentId: string): fs.ReadStream | undefined {
    const p = this.finalPath(documentId);
    return fs.existsSync(p) ? fs.createReadStream(p) : undefined;
  }

  async discard(tempPath: string): Promise<void> {
    await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
  }

  async remove(documentId: string): Promise<void> {
    await fs.promises.rm(this.finalPath(documentId), { force: true }).catch(() => undefined);
  }

  /** Only files this provider created (by name pattern) are ever removed. */
  async clear(): Promise<void> {
    const names = await fs.promises.readdir(this.dir).catch(() => [] as string[]);
    await Promise.all(names.filter(n => STORED.test(n) || TEMP.test(n)).map(n => fs.promises.rm(path.join(this.dir, n), { force: true }).catch(() => undefined)));
  }
}

/**
 * Where local documents live: JIVA_DOCUMENT_DIR, else data/local/documents/<port> (git-ignored). The port
 * keeps API processes apart: local documents are cleared when an API starts, so a test API started while a
 * demo is running must never wipe the demo's uploads.
 */
export function defaultDocumentDir(): string {
  return process.env.JIVA_DOCUMENT_DIR || path.resolve(__dirname, '../../../../data/local/documents', String(process.env.PORT || 4000));
}

export const newDocumentId = () => `DOC-${randomBytes(8).toString('hex').toUpperCase()}`;

// ------------------------------------------------------------------ integrity

/** File signatures of the accepted types. A declared type must match the bytes actually received. */
export function signatureMatches(contentType: DocumentContentType, head: Buffer): boolean {
  switch (contentType) {
    case 'application/pdf':
      return head.subarray(0, 5).toString('latin1') === '%PDF-';
    case 'image/png':
      return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    case 'image/jpeg':
      return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case 'application/dicom':
      // 128-byte preamble followed by "DICM" (DICOM Part 10 file).
      return head.length >= 132 && head.subarray(128, 132).toString('latin1') === 'DICM';
    default:
      return false;
  }
}

/** Bytes of the head needed for the signature check. */
export const SIGNATURE_BYTES = 132;

/** A display name only: no directories, no control characters, bounded. Never used as a storage path. */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 160);
  return clean || 'document';
}

/** RFC 6266 / 5987 Content-Disposition for a download (ASCII fallback + UTF-8 name). */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\;]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

// ------------------------------------------------------------------ upload tickets

/** How long an upload ticket stays valid (JIVA_UPLOAD_TICKET_TTL_MS, default 10 minutes). */
export const UPLOAD_TICKET_TTL_MS = Number(process.env.JIVA_UPLOAD_TICKET_TTL_MS) > 0 ? Number(process.env.JIVA_UPLOAD_TICKET_TTL_MS) : 10 * 60_000;

export interface UploadTicket {
  documentId: string;
  userId: string;
  contentType: DocumentContentType;
  sizeBytes: number;
  sha256: string;
  expiresAt: number;
  /** An upload for this ticket is being received right now (no parallel uploads). */
  inProgress: boolean;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Single-use upload tickets. Only a hash of each token is kept, so the tickets cannot be recovered from
 * memory or logs; the token itself is returned once, to the clinician who declared the upload.
 */
export class UploadTickets {
  private tickets = new Map<string, UploadTicket>();

  issue(doc: DiagnosticDocument, userId: string, now = Date.now()): { token: string; expiresAt: number } {
    // Lapsed tickets are dropped here, so the table cannot grow without bound.
    for (const [k, t] of this.tickets) if (t.expiresAt < now && !t.inProgress) this.tickets.delete(k);
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + UPLOAD_TICKET_TTL_MS;
    this.tickets.set(tokenHash(token), { documentId: doc.documentId, userId, contentType: doc.contentType, sizeBytes: doc.sizeBytes, sha256: doc.sha256, expiresAt, inProgress: false });
    return { token, expiresAt };
  }

  /** The ticket for a token, if any (expired ones included, so the caller can say "expired"). */
  find(token: string): UploadTicket | undefined {
    return this.tickets.get(tokenHash(token));
  }

  /** The ticket of a document (to answer an upload-status question without the token). */
  forDocument(documentId: string): UploadTicket | undefined {
    for (const t of this.tickets.values()) if (t.documentId === documentId) return t;
    return undefined;
  }

  revoke(token: string): void {
    this.tickets.delete(tokenHash(token));
  }

  revokeDocument(documentId: string): void {
    for (const [k, t] of this.tickets) if (t.documentId === documentId) this.tickets.delete(k);
  }

  clear(): void {
    this.tickets.clear();
  }
}
