/**
 * Minimal RFC 4180 CSV for catalogue import/export: comma separated, double-quoted fields (with "" for a
 * quote, and commas or line breaks inside quotes), CRLF or LF line endings, an optional UTF-8 byte-order
 * mark. Malformed input is refused with the line number instead of being guessed at.
 *
 * Spreadsheet formula injection: on export, a cell that starts with = + - @ (or a tab / carriage return)
 * is prefixed with an apostrophe, so opening the file in a spreadsheet never executes it; on import, that
 * apostrophe is removed again (round trip).
 */

export interface CsvRow {
  /** Line number in the file where the record starts (1-based; the header is line 1). */
  line: number;
  cells: string[];
}

export type CsvParseResult =
  | { ok: true; header: string[]; rows: CsvRow[] }
  | { ok: false; error: string; line: number };

export function parseCsv(text: string, maxRows: number): CsvParseResult {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRow[] = [];
  let field = '';
  let cells: string[] = [];
  let inQuotes = false;
  let afterQuote = false;
  let quoted = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(field);
    // A blank line is skipped; a record that is a single quoted empty field is kept.
    if (!(cells.length === 1 && cells[0] === '' && !quoted)) records.push({ line: recordLine, cells });
    cells = [];
    field = '';
    afterQuote = false;
    quoted = false;
  };

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '\r' && s[i + 1] === '\n') continue;
    if (ch === ',') {
      cells.push(field);
      field = '';
      afterQuote = false;
      quoted = false;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endRecord();
      line++;
      recordLine = line;
      if (records.length > maxRows + 1) return { ok: false, error: `The file has more than ${maxRows} records`, line };
      continue;
    }
    if (afterQuote) return { ok: false, error: 'Unexpected character after a closing quote', line };
    if (ch === '"') {
      if (field.length > 0) return { ok: false, error: 'A quote inside an unquoted field (quote the whole field and double the quote)', line };
      inQuotes = true;
      quoted = true;
      continue;
    }
    field += ch;
  }
  if (inQuotes) return { ok: false, error: 'A quoted field is never closed', line: recordLine };
  if (field.length > 0 || cells.length > 0 || quoted) endRecord();
  if (records.length === 0) return { ok: false, error: 'The file is empty', line: 1 };
  if (records.length > maxRows + 1) return { ok: false, error: `The file has more than ${maxRows} records`, line: records[records.length - 1].line };
  const [head, ...rows] = records;
  return { ok: true, header: head.cells.map(h => h.trim()), rows };
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Undo the export's formula guard ("'=…" → "=…"). */
export const unguardCell = (v: string) => (v.startsWith("'") && FORMULA_START.test(v.slice(1)) ? v.slice(1) : v);

export function csvCell(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) || /^\s|\s$/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const toCsv = (header: string[], rows: string[][]) => [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
