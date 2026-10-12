import { inflateRawSync } from 'zlib';

/**
 * Dependency-free readers for the repository's source spreadsheets: RFC 4180 CSV and the first sheet of
 * an .xlsx workbook (ZIP + SpreadsheetML). Enough for plain data tables; formulas, styles and merged
 * cells are ignored.
 */

/** Parse RFC 4180 CSV (quoted fields, doubled quotes, CRLF/LF). Returns rows of cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(v => v !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some(v => v !== '')) rows.push(row);
  return rows;
}

/** CSV rows as objects keyed by the header row. */
export function csvRecords(text: string): Array<Record<string, string>> {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

// ------------------------------------------------------------------ xlsx

interface ZipEntry { name: string; method: number; compressedSize: number; localHeaderOffset: number }

function zipEntries(buf: Buffer): ZipEntry[] {
  // End of central directory record (scan backwards; the comment can be up to 64 KiB).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf: Buffer, entry: ZipEntry): Buffer {
  const h = entry.localHeaderOffset;
  if (buf.readUInt32LE(h) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for ${entry.name}`);
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(data);
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
}

const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');

/** Rows of the first worksheet, each a map of column letter → cell text. */
export function readXlsxFirstSheet(buf: Buffer): Array<Record<string, string>> {
  const entries = zipEntries(buf);
  const get = (name: string) => entries.find(e => e.name === name);
  const shared: string[] = [];
  const ss = get('xl/sharedStrings.xml');
  if (ss) {
    const xml = zipRead(buf, ss).toString('utf8');
    for (const si of xml.match(/<si>[\s\S]*?<\/si>/g) || []) {
      shared.push(decodeXml((si.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g) || []).map(t => t.replace(/<[^>]+>/g, '')).join('')));
    }
  }
  const sheet = get('xl/worksheets/sheet1.xml');
  if (!sheet) throw new Error('Workbook has no xl/worksheets/sheet1.xml');
  const xml = zipRead(buf, sheet).toString('utf8');
  const rows: Array<Record<string, string>> = [];
  for (const rowXml of xml.match(/<row[\s\S]*?<\/row>/g) || []) {
    const row: Record<string, string> = {};
    for (const c of rowXml.match(/<c\s[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = c.match(/\sr="([A-Z]+)\d+"/)?.[1];
      if (!ref) continue;
      const type = c.match(/\st="([^"]+)"/)?.[1];
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      const inline = c.match(/<is>([\s\S]*?)<\/is>/)?.[1];
      let text = '';
      if (type === 's' && v !== undefined) text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr' && inline) text = decodeXml(inline.replace(/<[^>]+>/g, ''));
      else if (v !== undefined) text = decodeXml(v);
      row[ref] = text.trim();
    }
    rows.push(row);
  }
  return rows;
}
