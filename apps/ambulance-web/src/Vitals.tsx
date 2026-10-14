import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  Icon,
  JivaButton,
  JivaCard,
  JivaStatus,
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  UNAVAILABLE_REASONS,
  UNAVAILABLE_REASON_TEXT,
  cx,
  formatClock,
  formatMeasurementValue,
  measurementQuality,
  measurementSource,
  timeAgo,
  toDateTimeLocal,
  type MeasurementTypeCode,
  type PrehospitalResponse,
} from '@jiva/ui/src';
import { apiGet, postCommand } from './api';
import { emptyVitals, vitalsPayload, vitalsProblems, type Reason, type VitalRow, type VitalsDraft } from './vitalsDraft';

/**
 * Vital signs the crew records at the scene and en route. Every value carries the time it was measured and
 * may be flagged as questionable; a vital sign that could not be taken is recorded with the reason, so it is
 * never mistaken for a normal value. The values go to JIVA's clinical record of the case (never onto the
 * operational event stream) and reach the doctor assigned at the receiving hospital. No ambulance monitor is
 * connected to JIVA: values are typed in, or simulated in the demo and labelled so.
 */

const inputCls = 'h-9 w-full min-w-0 rounded-lg bg-white px-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 transition-shadow duration-150 placeholder:text-ink-400 hover:ring-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-600';

export function VitalsFields({ value, onChange, idPrefix }: { value: VitalsDraft; onChange: (d: VitalsDraft) => void; idPrefix: string }) {
  const set = (t: MeasurementTypeCode, patch: Partial<VitalRow>) => onChange({ ...value, rows: { ...value.rows, [t]: { ...value.rows[t], ...patch } } });
  const [latest] = useState(() => toDateTimeLocal(Date.now() + 60_000));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="block min-w-0 flex-1 space-y-1">
          <span className="block text-xs font-semibold text-ink-700">Measured at</span>
          <input type="datetime-local" className={inputCls} value={value.at} max={latest} onChange={(e) => onChange({ ...value, at: e.target.value })} />
        </label>
        <JivaButton size="sm" variant="ghost" icon="clock" onClick={() => onChange({ ...value, at: toDateTimeLocal(Date.now()) })}>
          Now
        </JivaButton>
      </div>
      <ul className="divide-y divide-ink-100 rounded-lg ring-1 ring-inset ring-ink-200">
        {MEASUREMENT_ORDER.map((t) => {
          const r = value.rows[t];
          const filled = !!(r.value.trim() || r.secondary.trim());
          const id = `${idPrefix}-${t}`;
          return (
            <li key={t} className="grid grid-cols-[minmax(0,1fr)] gap-1.5 px-2.5 py-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto] sm:items-center">
              <label htmlFor={id} className="text-[13px] font-semibold text-ink-800">
                {MEASUREMENT_TEXT[t].label} <span className="font-normal text-ink-500">{MEASUREMENT_TEXT[t].unit}</span>
              </label>
              {t === 'BLOOD_PRESSURE' ? (
                <div className="flex items-center gap-1.5">
                  <input id={id} aria-label="Systolic" inputMode="numeric" placeholder="sys" className={inputCls} value={r.value} onChange={(e) => set(t, { value: e.target.value, unavailable: '' })} />
                  <span className="text-ink-500">/</span>
                  <input aria-label="Diastolic" inputMode="numeric" placeholder="dia" className={inputCls} value={r.secondary} onChange={(e) => set(t, { secondary: e.target.value, unavailable: '' })} />
                </div>
              ) : (
                <input id={id} inputMode="decimal" className={inputCls} value={r.value} onChange={(e) => set(t, { value: e.target.value, unavailable: '' })} />
              )}
              {filled ? (
                <label className="inline-flex items-center gap-1.5 text-xs text-ink-700">
                  <input type="checkbox" aria-label={`${MEASUREMENT_TEXT[t].label}: questionable reading`} className="h-4 w-4 accent-brand-700" checked={r.questionable} onChange={(e) => set(t, { questionable: e.target.checked })} />
                  Questionable
                </label>
              ) : (
                <select aria-label={`${MEASUREMENT_TEXT[t].label} not available`} className={cx(inputCls, 'h-8 text-xs', !r.unavailable && 'text-ink-500')} value={r.unavailable} onChange={(e) => set(t, { unavailable: e.target.value as Reason })}>
                  <option value="">Not recorded</option>
                  {UNAVAILABLE_REASONS.map((x) => (
                    <option key={x} value={x}>
                      Not available: {UNAVAILABLE_REASON_TEXT[x].toLowerCase()}
                    </option>
                  ))}
                </select>
              )}
            </li>
          );
        })}
      </ul>
      <p className="flex items-start gap-1.5 text-xs text-ink-500">
        <Icon name="info" size={13} className="mt-px shrink-0" />
        Leave a vital sign empty if you did not take it, or say why it is not available. Flag a value you doubt (movement, poor signal).
      </p>
    </div>
  );
}

/**
 * The case's pre-hospital record in the job view: what the crew recorded so far, and the form to add more
 * while the crew attends the patient (until the hospital records the handover).
 */
export function PrehospitalCard({ caseId, version }: { caseId: string; version: number }) {
  const [data, setData] = useState<PrehospitalResponse | null | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const load = useCallback(() => {
    apiGet<PrehospitalResponse>(`/api/cases/${encodeURIComponent(caseId)}/prehospital`)
      .then(setData)
      .catch(() => setData((prev) => (prev === undefined ? null : prev)));
  }, [caseId]);
  useEffect(() => {
    load();
  }, [load, version]);

  return (
    <JivaCard>
      <CardHeader
        title="Patient observations"
        icon="heart"
        subtitle="For the receiving hospital's doctor · not shared with dispatch"
        level={2}
        actions={
          !adding && (
            <JivaButton size="sm" icon="plus" onClick={() => setAdding(true)}>
              Record
            </JivaButton>
          )
        }
      />
      {adding && (
        <AddObservations
          caseId={caseId}
          onSaved={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {data === undefined ? (
        <p className="mt-3 text-sm text-ink-500">Loading…</p>
      ) : data === null ? (
        <p className="mt-3 text-sm text-danger-700">Observations could not be loaded. They are retried automatically.</p>
      ) : (
        <>
          {Object.keys(data.latest).length === 0 && data.entries.length === 0 ? (
            !adding && <p className="mt-3 text-sm text-ink-500">No vital signs recorded yet.</p>
          ) : (
            <ul className="mt-3 grid grid-cols-2 gap-2" aria-label="Latest vital signs">
              {MEASUREMENT_ORDER.filter((t) => data.latest[t]).map((t) => {
                const m = data.latest[t]!;
                const q = measurementQuality(m.quality);
                return (
                  <li key={t} className={cx('rounded-lg p-2 ring-1 ring-inset', m.source === 'DEVICE_SIMULATED' ? 'bg-warn-50/50 ring-warn-200' : 'bg-ink-25 ring-ink-200')}>
                    <p className="text-[11px] font-semibold text-ink-500">{MEASUREMENT_TEXT[t].label}</p>
                    <p className="text-lg font-semibold tabular-nums text-ink-900">
                      {m.value !== undefined ? formatMeasurementValue({ type: t, value: m.value, secondaryValue: m.secondaryValue }) : '—'} <span className="text-xs font-medium text-ink-500">{MEASUREMENT_TEXT[t].unit}</span>
                    </p>
                    <p className="text-[11px] text-ink-500">
                      {formatClock(m.observedAt)} ({timeAgo(m.observedAt)}) · {measurementSource(m.source).label}
                    </p>
                    {q && <JivaStatus meta={q} className="mt-1" />}
                  </li>
                );
              })}
            </ul>
          )}
          {data.entries.length > 0 && (
            <details className="mt-2 text-xs text-ink-600">
              <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">Recorded entries ({data.entries.length})</summary>
              <ul className="mt-1.5 space-y-1">
                {data.entries.map((e) => (
                  <li key={e.entryId} className="rounded-md bg-ink-25 px-2 py-1 ring-1 ring-inset ring-ink-100">
                    <span className="font-semibold">{formatClock(e.recordedAt)}</span> · {measurementSource(e.source).label}
                    {e.observations.length > 0 &&
                      ` · ${e.observations
                        .map((o) => (o.status === 'MEASURED' && o.value !== undefined ? `${MEASUREMENT_TEXT[o.type].label} ${formatMeasurementValue({ type: o.type, value: o.value, secondaryValue: o.secondaryValue })}${o.quality === 'QUESTIONABLE' ? ' (?)' : ''}` : `${MEASUREMENT_TEXT[o.type].label} n/a`))
                        .join(', ')}`}
                    {e.symptomDescription && <span className="block text-ink-700">“{e.symptomDescription}”</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {data.sources.simulationAvailable && (
              <AsyncButton
                size="sm"
                variant="warn-soft"
                icon="activity"
                pendingText="Simulating…"
                title="Adds one synthetic reading, labelled as simulated"
                onAction={async () => {
                  const r = await postCommand(`/api/cases/${encodeURIComponent(caseId)}/prehospital/simulate`, { clientRequestId: crypto.randomUUID() }).catch(() => null);
                  const err = !r ? 'Cannot reach JIVA.' : r.status === 201 ? null : r.body.message ?? `Rejected (${r.status})`;
                  setSimError(err);
                  load();
                  return err;
                }}
              >
                Simulated monitor (demo)
              </AsyncButton>
            )}
            <span className="text-[11px] text-ink-500">No monitoring device is connected to JIVA.</span>
          </div>
          {simError && <p role="alert" className="mt-1 text-[13px] text-danger-700">{simError}</p>}
        </>
      )}
    </JivaCard>
  );
}

function AddObservations({ caseId, onSaved, onCancel }: { caseId: string; onSaved: () => void; onCancel: () => void }) {
  const [vitals, setVitals] = useState<VitalsDraft>(emptyVitals);
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const key = useRef({ id: crypto.randomUUID(), body: '' });
  const problems = vitalsProblems(vitals);
  const payload = { ...vitalsPayload(vitals), ...(description.trim() ? { symptomDescription: description.trim() } : {}) };
  const empty = payload.measurements.length === 0 && payload.unavailable.length === 0 && !payload.symptomDescription;
  return (
    <div className="mt-3 space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <VitalsFields value={vitals} onChange={setVitals} idPrefix={`ph-${caseId}`} />
      <label className="block space-y-1">
        <span className="block text-xs font-semibold text-ink-700">Change in symptoms (optional)</span>
        <textarea rows={2} maxLength={1000} className={cx(inputCls, 'h-auto py-2')} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. More drowsy since 10:52" />
      </label>
      {problems.length > 0 && (
        <ul className="space-y-0.5 text-[13px] text-danger-700">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="primary"
          icon="check"
          disabled={empty || problems.length > 0}
          pendingText="Sending…"
          onAction={async () => {
            const body = JSON.stringify(payload);
            // The same content is the same intent: a retry after a network error reuses the key.
            if (key.current.body !== body) key.current = { id: crypto.randomUUID(), body };
            const r = await postCommand(`/api/cases/${encodeURIComponent(caseId)}/prehospital`, { clientRequestId: key.current.id, ...payload }).catch(() => null);
            const err = !r
              ? 'Cannot reach JIVA. Nothing was lost — send again; a retry is safe.'
              : r.status === 201
                ? null
                : r.status === 400
                  ? r.body.issues?.map((i) => i.message).join('; ') || 'Check the values.'
                  : r.body.message ?? `JIVA rejected the observations (${r.status}).`;
            setError(err);
            if (!err) onSaved();
            return err;
          }}
        >
          Save observations
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <p role="alert" className="text-[13px] text-danger-700">{error}</p>}
    </div>
  );
}
