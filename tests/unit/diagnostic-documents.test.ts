/**
 * Phase 8 — diagnostic documents: file signatures, display-name sanitising, download headers, the local
 * storage provider (server-generated names only, clears only its own files) and upload tickets.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DiagnosticDocument } from '../../packages/domain-models/src';
import {
  contentDisposition, defaultDocumentDir, LocalDocumentStorage, newDocumentId, sanitizeFileName, signatureMatches, UploadTickets,
} from '../../services/api/src/clinical/documents';
import { check, eq, ok, run } from './helpers/assert';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR-rest')]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n%%EOF\n', 'latin1');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const DICOM = Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), Buffer.from('rest')]);
const HTML = Buffer.from('<!doctype html><script>alert(1)</script>');

run('Phase 8 — diagnostic documents', async () => {
  await check('file signatures: each accepted type is recognised, and nothing else passes as it', () => {
    ok(signatureMatches('image/png', PNG) && signatureMatches('application/pdf', PDF) && signatureMatches('image/jpeg', JPEG) && signatureMatches('application/dicom', DICOM), 'genuine files');
    ok(!signatureMatches('application/pdf', HTML), 'HTML declared as PDF');
    ok(!signatureMatches('image/png', PDF), 'PDF declared as PNG');
    ok(!signatureMatches('image/jpeg', PNG), 'PNG declared as JPEG');
    ok(!signatureMatches('application/dicom', Buffer.from('DICM')), 'DICOM without its 128-byte preamble');
    ok(!signatureMatches('image/png', Buffer.alloc(0)), 'empty file');
  });

  await check('file names are display names only: no directories, no control characters, bounded', () => {
    eq(sanitizeFileName('../../etc/passwd'), 'passwd', 'unix path');
    eq(sanitizeFileName('C:\\scans\\chest x-ray.png'), 'chest x-ray.png', 'windows path');
    eq(sanitizeFileName('ecg\u0000\u0007"trace".pdf'), 'ecgtrace.pdf', 'control characters and quotes');
    eq(sanitizeFileName('   '), 'document', 'empty');
    eq(sanitizeFileName('a'.repeat(300)).length, 160, 'bounded');
  });

  await check('downloads are attachments with an ASCII fallback and a UTF-8 name', () => {
    eq(contentDisposition('ECG trace.pdf'), `attachment; filename="ECG trace.pdf"; filename*=UTF-8''ECG%20trace.pdf`, 'ascii');
    const d = contentDisposition('ರಕ್ತ ಪರೀಕ್ಷೆ.pdf');
    ok(d.startsWith('attachment; filename="') && /^[\x20-\x7e]*$/.test(d) && d.includes(encodeURIComponent('ರಕ್ತ')), 'non-ASCII name encoded, header stays ASCII');
  });

  await check('local storage: server-generated names only, atomic commit, clears only its own files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-docs-'));
    try {
      const store = new LocalDocumentStorage(dir);
      const id = newDocumentId();
      ok(/^DOC-[0-9A-F]{16}$/.test(id), 'id format');
      const tmp = store.tempPath(id);
      ok(path.dirname(tmp) === dir && /\.part$/.test(tmp), 'temporary file inside the store');
      fs.writeFileSync(tmp, PNG);
      await store.commit(tmp, id);
      ok(!fs.existsSync(tmp) && fs.existsSync(path.join(dir, `${id}.bin`)), 'committed by rename');
      const chunks: Buffer[] = [];
      for await (const c of store.open(id)!) chunks.push(c as Buffer);
      ok(Buffer.concat(chunks).equals(PNG), 'reads back the same bytes');
      eq(store.open(newDocumentId()), undefined, 'missing document');
      let threw = false;
      try {
        store.tempPath('DOC-../../outside');
      } catch {
        threw = true;
      }
      ok(threw, 'a crafted id cannot escape the directory');
      fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
      await store.clear();
      eq(fs.readdirSync(dir), ['notes.txt'], 'only files the provider created are removed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await check('each API port has its own default document directory (a test API cannot wipe a running demo)', () => {
    const saved = { port: process.env.PORT, dir: process.env.JIVA_DOCUMENT_DIR };
    delete process.env.JIVA_DOCUMENT_DIR;
    try {
      process.env.PORT = '4000';
      const demo = defaultDocumentDir();
      process.env.PORT = '4100';
      const test = defaultDocumentDir();
      ok(demo !== test && demo.endsWith(path.join('documents', '4000')) && test.endsWith(path.join('documents', '4100')), `${demo} vs ${test}`);
    } finally {
      if (saved.port === undefined) delete process.env.PORT; else process.env.PORT = saved.port;
      if (saved.dir !== undefined) process.env.JIVA_DOCUMENT_DIR = saved.dir;
    }
  });

  await check('upload tickets: single document, single user, only a hash of the token kept', () => {
    const tickets = new UploadTickets();
    const doc = { documentId: 'DOC-0000000000000001', contentType: 'image/png', sizeBytes: PNG.length, sha256: 'a'.repeat(64) } as DiagnosticDocument;
    const { token, expiresAt } = tickets.issue(doc, 'demo-doc-3', 1_000);
    ok(token.length >= 43 && expiresAt === 1_000 + 10 * 60_000, 'random token, 10-minute window');
    eq(tickets.find(token)?.userId, 'demo-doc-3', 'bound to the uploader');
    eq(tickets.find(`${token}x`), undefined, 'a different token finds nothing');
    ok(!JSON.stringify([...(tickets as unknown as { tickets: Map<string, unknown> }).tickets.keys()]).includes(token), 'token not stored in clear');
    tickets.revoke(token);
    eq(tickets.find(token), undefined, 'revoked');
  });
});
