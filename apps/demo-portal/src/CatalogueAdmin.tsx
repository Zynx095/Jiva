import { useState } from 'react';
import { AsyncButton, CardHeader, Icon, JivaButton, JivaCard, cx } from '@jiva/ui/src';
import { API_URL, call, failure } from './api';
import { DEMO } from './workflows';

type Kind = 'medications' | 'scan-assets';
type Format = 'csv' | 'json';

interface RowResult {
  record: number;
  line?: number;
  id?: string;
  outcome: 'NEW' | 'CHANGED' | 'UNCHANGED' | 'INVALID' | 'DUPLICATE';
  issues?: Array<{ path: string; message: string }>;
  changedFields?: string[];
}

interface Preview {
  previewId: string;
  kind: Kind;
  baseVersion: number;
  expiresAt: string;
  fileProblems: Array<{ path: string; message: string }>;
  summary: { records: number; new: number; changed: number; unchanged: number; invalid: number; duplicate: number };
  rows: RowResult[];
}

const OUTCOME: Record<RowResult['outcome'], string> = {
  NEW: 'bg-brand-50 text-brand-800 ring-brand-200',
  CHANGED: 'bg-warn-50 text-warn-800 ring-warn-200',
  UNCHANGED: 'bg-ink-50 text-ink-600 ring-ink-200',
  INVALID: 'bg-danger-50 text-danger-700 ring-danger-200',
  DUPLICATE: 'bg-danger-50 text-danger-700 ring-danger-200',
};

/**
 * Catalogue administration as the demo administrator, through the same admin-only API an operator would use:
 * export the catalogue (CSV or JSON), paste or load an edited file, preview what would change record by record,
 * and apply exactly that preview. Invalid or duplicated records block the import; changes to existing entries
 * need an explicit confirmation; nothing is deleted.
 */
export function CatalogueAdmin({ onImported }: { onImported: () => void }) {
  const [kind, setKind] = useState<Kind>('medications');
  const [format, setFormat] = useState<Format>('csv');
  const [content, setContent] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const exportFile = async (f: Format) => {
    const res = await fetch(`${API_URL}/api/catalogue/${kind}/export?format=${f}`, { headers: { 'x-jiva-demo-user': DEMO.admin } }).catch(() => null);
    if (!res?.ok) return `Export failed (${res?.status ?? 'no answer'})`;
    const text = await res.text();
    setContent(text);
    setFormat(f);
    setPreview(null);
    setMessage({ ok: true, text: `Loaded the current ${kind} catalogue as ${f.toUpperCase()} into the editor (edit it, then preview).` });
    return null;
  };

  const loadFile = async (file: File) => {
    if (file.size > 90_000) {
      setMessage({ ok: false, text: 'Import files are limited to 90,000 characters.' });
      return;
    }
    setContent(await file.text());
    setFormat(file.name.toLowerCase().endsWith('.json') ? 'json' : 'csv');
    setPreview(null);
  };

  return (
    <JivaCard>
      <CardHeader title="Catalogue administration" icon="list" subtitle={`As the demo administrator (persona ${DEMO.admin}) · admin-only API · preview before import`} />
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-xs font-semibold text-ink-700">
          <span className="block">Catalogue</span>
          <select className="h-9 rounded-lg bg-white px-2.5 text-sm ring-1 ring-inset ring-ink-200" value={kind} onChange={(e) => { setKind(e.target.value as Kind); setPreview(null); }}>
            <option value="medications">Medications</option>
            <option value="scan-assets">Sample documents (synthetic)</option>
          </select>
        </label>
        <label className="space-y-1 text-xs font-semibold text-ink-700">
          <span className="block">Format</span>
          <select className="h-9 rounded-lg bg-white px-2.5 text-sm ring-1 ring-inset ring-ink-200" value={format} onChange={(e) => setFormat(e.target.value as Format)}>
            <option value="csv">CSV</option>
            <option value="json">JSON</option>
          </select>
        </label>
        <AsyncButton size="sm" icon="arrowDown" onAction={() => exportFile('csv')}>
          Load current as CSV
        </AsyncButton>
        <AsyncButton size="sm" icon="arrowDown" onAction={() => exportFile('json')}>
          Load current as JSON
        </AsyncButton>
        <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-white px-3 text-[13px] font-semibold text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-50">
          <Icon name="file" size={14} />
          Open a file…
          <input type="file" accept=".csv,.json,text/csv,application/json" className="sr-only" onChange={(e) => e.target.files?.[0] && void loadFile(e.target.files[0])} />
        </label>
      </div>
      <label className="mt-3 block space-y-1">
        <span className="block text-xs font-semibold text-ink-700">Import content ({content.length.toLocaleString()} / 90,000 characters)</span>
        <textarea
          aria-label="Catalogue import content"
          className="h-40 w-full rounded-lg bg-white px-2.5 py-2 font-mono text-xs text-ink-900 ring-1 ring-inset ring-ink-200 focus:outline-none focus:ring-2 focus:ring-warn-500"
          value={content}
          maxLength={90_000}
          onChange={(e) => {
            setContent(e.target.value);
            setPreview(null);
          }}
          placeholder="Load the current catalogue or open a file, edit it, then preview the import."
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <AsyncButton
          variant="primary"
          icon="eye"
          disabled={!content.trim()}
          pendingText="Validating…"
          onAction={async () => {
            const r = await call<Preview>(DEMO.admin, 'POST', `/api/catalogue/${kind}/import/preview`, { format, content }).catch(() => null);
            if (!r || !r.ok) {
              const m = r ? failure(r) : 'Cannot reach JIVA.';
              setMessage({ ok: false, text: m });
              return m;
            }
            setPreview(r.body);
            setConfirm(false);
            setMessage(null);
            return null;
          }}
        >
          Preview import (changes nothing)
        </AsyncButton>
      </div>

      {preview && (
        <div className="mt-3 space-y-2">
          <p className="text-[13px] text-ink-800">
            Preview of {preview.summary.records} record(s) against catalogue version {preview.baseVersion}:{' '}
            <b>{preview.summary.new}</b> new · <b>{preview.summary.changed}</b> changed · {preview.summary.unchanged} unchanged ·{' '}
            <b className={preview.summary.invalid ? 'text-danger-700' : ''}>{preview.summary.invalid}</b> invalid ·{' '}
            <b className={preview.summary.duplicate ? 'text-danger-700' : ''}>{preview.summary.duplicate}</b> duplicate
          </p>
          {preview.fileProblems.length > 0 && (
            <ul className="rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger-700 ring-1 ring-inset ring-danger-200">
              {preview.fileProblems.map((p, i) => (
                <li key={i}>
                  {p.path}: {p.message}
                </li>
              ))}
            </ul>
          )}
          {preview.rows.length > 0 && (
            <div className="max-h-72 overflow-auto rounded-lg ring-1 ring-inset ring-ink-200">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-ink-50 text-ink-600">
                  <tr>
                    <th className="px-2 py-1.5">#</th>
                    <th className="px-2 py-1.5">Id</th>
                    <th className="px-2 py-1.5">Outcome</th>
                    <th className="px-2 py-1.5">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-100">
                  {preview.rows.map((r) => (
                    <tr key={r.record}>
                      <td className="px-2 py-1 tabular-nums text-ink-500">{r.line ? `line ${r.line}` : r.record}</td>
                      <td className="px-2 py-1 font-mono">{r.id ?? '—'}</td>
                      <td className="px-2 py-1">
                        <span className={cx('rounded-full px-1.5 py-px font-semibold ring-1 ring-inset', OUTCOME[r.outcome])}>{r.outcome.toLowerCase()}</span>
                      </td>
                      <td className="px-2 py-1 text-ink-700">
                        {r.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')}
                        {r.changedFields?.length ? `changes: ${r.changedFields.join(', ')}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {preview.summary.changed > 0 && (
            <label className="flex items-center gap-2 text-[13px] text-ink-800">
              <input type="checkbox" className="h-4 w-4 accent-warn-700" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              I confirm that {preview.summary.changed} existing entr{preview.summary.changed === 1 ? 'y' : 'ies'} will change (a new revision each; records that used an entry keep the revision they used).
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <AsyncButton
              variant="primary"
              icon="check"
              disabled={!!preview.fileProblems.length || preview.summary.invalid > 0 || preview.summary.duplicate > 0 || (preview.summary.changed > 0 && !confirm) || preview.summary.new + preview.summary.changed === 0}
              pendingText="Importing…"
              onAction={async () => {
                const r = await call<{ catalogueVersion: number; added: number; updated: number }>(DEMO.admin, 'POST', `/api/catalogue/${kind}/import/apply`, { clientRequestId: crypto.randomUUID(), previewId: preview.previewId, confirmChanges: confirm }).catch(() => null);
                if (!r || !r.ok) {
                  const m = r ? failure(r) : 'Cannot reach JIVA.';
                  setMessage({ ok: false, text: m });
                  return m;
                }
                setMessage({ ok: true, text: `Imported: catalogue version ${r.body.catalogueVersion} (${r.body.added} added, ${r.body.updated} updated). A demo reset restores the bundled catalogue.` });
                setPreview(null);
                onImported();
                return null;
              }}
            >
              Import exactly this preview
            </AsyncButton>
            <JivaButton variant="ghost" onClick={() => setPreview(null)}>
              Discard preview
            </JivaButton>
          </div>
          <p className="text-xs text-ink-500">Invalid or duplicated records block the whole import. Entries missing from the file are never deleted (set status WITHDRAWN instead).</p>
        </div>
      )}
      {message && <p role="status" className={cx('mt-2 text-[13px]', message.ok ? 'text-brand-800' : 'text-danger-700')}>{message.text}</p>}
    </JivaCard>
  );
}
