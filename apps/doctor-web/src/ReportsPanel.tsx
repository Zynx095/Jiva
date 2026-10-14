import { useState } from 'react';
import {
  AsyncButton,
  CATEGORY_TEXT,
  CardHeader,
  DIAGNOSTIC_CATEGORIES,
  JivaButton,
  JivaCard,
  JivaStatus,
  SkeletonRows,
  cx,
  formatDateTime,
  fromDateTimeLocal,
  reportStatus,
  toDateTimeLocal,
  type DocumentRecord,
  type ReportRecord,
} from '@jiva/ui/src';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from './ui';
import { useUnsaved } from './unsaved';

interface ReportDraft {
  category: string;
  title: string;
  findings: string;
  conclusion: string;
  effectiveAt: string; // datetime-local
  status: 'PRELIMINARY' | 'FINAL';
  patientVisible: boolean;
}

const isFinal = (r: ReportRecord) => r.current.status === 'FINAL' || r.current.status === 'AMENDED';

function draftOf(r?: ReportRecord): ReportDraft {
  if (!r) return { category: 'LABORATORY', title: '', findings: '', conclusion: '', effectiveAt: toDateTimeLocal(Date.now()), status: 'PRELIMINARY', patientVisible: false };
  const c = r.current;
  return { category: c.category, title: c.title, findings: c.findings ?? '', conclusion: c.conclusion ?? '', effectiveAt: toDateTimeLocal(c.effectiveAt), status: isFinal(r) ? 'FINAL' : 'PRELIMINARY', patientVisible: c.patientVisible };
}

/** The body the API expects from a draft (attachments are kept as they are). */
function bodyOf(d: ReportDraft, documentIds: string[]) {
  return {
    category: d.category,
    title: d.title.trim(),
    ...(d.findings.trim() ? { findings: d.findings.trim() } : {}),
    ...(d.conclusion.trim() ? { conclusion: d.conclusion.trim() } : {}),
    effectiveAt: fromDateTimeLocal(d.effectiveAt) ?? '',
    documentIds,
    patientVisible: d.patientVisible,
    status: d.status,
  };
}

const reportsPath = (encounterId: string, reportId?: string) =>
  `/api/encounters/${encodeURIComponent(encounterId)}/reports${reportId ? `/${encodeURIComponent(reportId)}/amend` : ''}`;

/**
 * Diagnostic reports of one encounter, for the assigned clinician. A report reaches the patient only when
 * it is explicitly shared; a final report can be corrected (it becomes "Amended") but never returns to
 * preliminary.
 */
export function ReportsPanel({ encounterId, list, documents, onChanged }: { encounterId: string; list: ReportRecord[] | null | undefined; documents: DocumentRecord[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <JivaCard>
      <CardHeader
        title="Diagnostic reports"
        icon="file"
        subtitle="Shared with the patient only when you choose to"
        actions={
          !creating && (
            <JivaButton size="sm" icon="plus" onClick={() => setCreating(true)}>
              New report
            </JivaButton>
          )
        }
      />
      {creating && (
        <ReportForm
          encounterId={encounterId}
          documents={documents}
          onSaved={() => {
            setCreating(false);
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setCreating(false)}
        />
      )}
      {list === undefined ? (
        <SkeletonRows rows={2} className="mt-3" />
      ) : list === null ? (
        <p className="mt-3 text-sm text-danger-700">Reports could not be loaded. They will be retried automatically.</p>
      ) : list.length === 0 ? (
        !creating && <p className="mt-3 text-sm text-ink-500">No reports for this encounter yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {list.map((r) => (
            <li key={r.reportId} className="py-3">
              <ReportItem report={r} encounterId={encounterId} documents={documents} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </JivaCard>
  );
}

function ReportItem({ report, encounterId, documents, onChanged }: { report: ReportRecord; encounterId: string; documents: DocumentRecord[]; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const c = report.current;

  /** Quick changes (finalise, share, stop sharing) are amendments with an explicit, recorded reason. */
  const quick = async (patch: Partial<ReportDraft>, changeReason: string) => {
    const body = { ...bodyOf({ ...draftOf(report), ...patch }, c.documentIds), expectedVersion: c.version, changeReason };
    const r = await sendCommand(reportsPath(encounterId, report.reportId), { clientRequestId: keyFor(body), ...body });
    setError(r.error);
    if (!r.error || r.status === 409) onChanged();
    return r.error;
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-ink-500">
            {CATEGORY_TEXT[c.category] ?? c.category} · performed {formatDateTime(c.effectiveAt)}
          </p>
          <p className="text-sm font-semibold text-ink-900">{c.title}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <JivaStatus meta={reportStatus(c.status)} />
          <JivaStatus meta={c.patientVisible ? { label: 'Shared with patient', tone: 'ok', icon: 'eye' } : { label: 'Not shared', tone: 'neutral', icon: 'eye' }} />
        </div>
      </div>
      {c.findings && <p className="mt-1.5 whitespace-pre-line text-[13px] text-ink-800">{c.findings}</p>}
      {c.conclusion && (
        <p className="mt-1 text-[13px] text-ink-800">
          <span className="font-semibold">Conclusion: </span>
          {c.conclusion}
        </p>
      )}
      {c.documentIds.length > 0 && (
        <p className="mt-1 text-xs text-ink-600">
          Attached: {c.documentIds.map((id) => documents.find((d) => d.documentId === id)?.title ?? id).join(', ')}
          {c.patientVisible ? ' (shared with the report)' : ''}
        </p>
      )}
      <p className="mt-1 text-xs text-ink-500">
        v{c.version} · {c.action === 'CREATED' ? 'written' : 'updated'} {formatDateTime(c.recordedAt)} by {c.author.displayName}
        {c.changeReason ? ` · “${c.changeReason}”` : ''}
      </p>
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <JivaButton size="sm" variant="ghost" icon="file" onClick={() => setEditing(true)}>
            {isFinal(report) ? 'Correct' : 'Edit'}
          </JivaButton>
          {!isFinal(report) && (
            <AsyncButton size="sm" variant="secondary" icon="checkCircle" pendingText="Saving…" onAction={() => quick({ status: 'FINAL' }, 'Finalised')}>
              Mark final
            </AsyncButton>
          )}
          {c.patientVisible ? (
            <AsyncButton size="sm" variant="ghost" icon="eye" pendingText="Saving…" onAction={() => quick({ patientVisible: false }, 'Withdrawn from the patient view')}>
              Stop sharing
            </AsyncButton>
          ) : (
            <AsyncButton size="sm" variant="ok-soft" icon="eye" pendingText="Sharing…" onAction={() => quick({ patientVisible: true }, 'Shared with the patient')}>
              Share with patient
            </AsyncButton>
          )}
        </div>
      )}
      {error && !editing && <CommandError message={error} />}
      {editing && (
        <ReportForm
          encounterId={encounterId}
          base={report}
          documents={documents}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setEditing(false)}
        />
      )}
      {report.history.length > 1 && (
        <details className="mt-1.5 text-xs text-ink-600">
          <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">History ({report.history.length} versions)</summary>
          <ol className="mt-1.5 space-y-1.5">
            {[...report.history].reverse().map((v) => (
              <li key={v.version} className="rounded-lg bg-ink-25 px-2.5 py-1.5 ring-1 ring-inset ring-ink-100">
                <p className="font-semibold text-ink-800">
                  v{v.version} · {reportStatus(v.status).label} · {v.patientVisible ? 'shared' : 'not shared'} · {formatDateTime(v.recordedAt)} · {v.author.displayName}
                </p>
                {v.findings && <p className="whitespace-pre-line">{v.findings}</p>}
                {v.changeReason && <p className="text-ink-500">Reason: {v.changeReason}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function ReportForm({ encounterId, base, documents, onSaved, onRefresh, onCancel }: { encounterId: string; base?: ReportRecord; documents: DocumentRecord[]; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [d, setD] = useState<ReportDraft>(() => draftOf(base));
  const [attached, setAttached] = useState<string[]>(() => base?.current.documentIds ?? []);
  // Upper bound for the picker, fixed when the form opens (the server re-checks the time anyway).
  const [latest] = useState(() => toDateTimeLocal(Date.now() + 60_000));
  const attachable = documents.filter((x) => x.status === 'AVAILABLE');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const [initial] = useState(() => JSON.stringify([d, attached]));
  useUnsaved(JSON.stringify([d, attached]) !== initial || reason.trim() !== '', base ? 'report changes' : 'a new report');
  const id = (k: string) => `rpt-${base?.reportId ?? 'new'}-${k}`;
  const set = (k: keyof ReportDraft) => (e: { target: { value: string } }) => setD((prev) => ({ ...prev, [k]: e.target.value }));
  const final = !!base && isFinal(base);
  const ready = d.title.trim() && fromDateTimeLocal(d.effectiveAt) && (!base || reason.trim());

  const submit = async () => {
    const content = bodyOf(d, attached);
    const body = base ? { ...content, expectedVersion: base.current.version, changeReason: reason.trim() } : content;
    const r = await sendCommand(reportsPath(encounterId, base?.reportId), { clientRequestId: keyFor(body), ...body });
    setError(r.error);
    if (!r.error) onSaved();
    else if (r.status === 409) onRefresh();
    return r.error;
  };

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-sm font-semibold text-ink-900">{base ? `${final ? 'Correct' : 'Edit'} report (based on v${base.current.version})` : 'New diagnostic report'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type" htmlFor={id('cat')} required>
          <select id={id('cat')} className={cx(inputClass, 'h-9')} value={d.category} onChange={set('category')}>
            {DIAGNOSTIC_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_TEXT[c]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Performed at" htmlFor={id('at')} required>
          <input id={id('at')} type="datetime-local" className={cx(inputClass, 'h-9')} value={d.effectiveAt} max={latest} onChange={set('effectiveAt')} />
        </Field>
        <Field label="Title" htmlFor={id('title')} required className="sm:col-span-2">
          <input id={id('title')} className={cx(inputClass, 'h-9')} value={d.title} onChange={set('title')} maxLength={120} placeholder="e.g. Chest X-ray, PA view" />
        </Field>
        <Field label="Findings" htmlFor={id('find')} className="sm:col-span-2">
          <textarea id={id('find')} className={cx(inputClass, 'min-h-20 py-2')} value={d.findings} onChange={set('findings')} maxLength={4000} />
        </Field>
        <Field label="Conclusion" htmlFor={id('conc')} className="sm:col-span-2">
          <textarea id={id('conc')} className={cx(inputClass, 'min-h-14 py-2')} value={d.conclusion} onChange={set('conclusion')} maxLength={1000} />
        </Field>
        <Field label="Status" htmlFor={id('status')} hint={final ? 'Changes to a final report mark it as amended.' : undefined}>
          <select id={id('status')} className={cx(inputClass, 'h-9')} value={d.status} disabled={final} onChange={set('status')}>
            <option value="PRELIMINARY">Preliminary</option>
            <option value="FINAL">Final</option>
          </select>
        </Field>
        <div className="flex items-end pb-1.5">
          <label className="inline-flex items-center gap-2 text-sm text-ink-800">
            <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={d.patientVisible} onChange={(e) => setD((prev) => ({ ...prev, patientVisible: e.target.checked }))} />
            Share with the patient
          </label>
        </div>
        {attachable.length > 0 && (
          <fieldset className="space-y-1 sm:col-span-2">
            <legend className="text-xs font-semibold text-ink-700">Attach verified documents</legend>
            {attachable.map((x) => (
              <label key={x.documentId} className="flex items-center gap-2 text-sm text-ink-800">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-brand-700"
                  checked={attached.includes(x.documentId)}
                  onChange={(e) => setAttached((prev) => (e.target.checked ? [...prev, x.documentId] : prev.filter((y) => y !== x.documentId)))}
                />
                {x.title} <span className="text-xs text-ink-500">({x.fileName})</span>
              </label>
            ))}
            <p className="text-xs text-ink-500">Sharing the report with the patient also shares its attachments.</p>
          </fieldset>
        )}
        {base && (
          <Field label="Reason for the change" htmlFor={id('why')} required className="sm:col-span-2" hint="Kept in the report history.">
            <input id={id('why')} className={cx(inputClass, 'h-9')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <AsyncButton variant="primary" icon="check" disabled={!ready} pendingText="Saving…" onAction={submit}>
          {base ? 'Save report changes' : 'Save report'}
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}
