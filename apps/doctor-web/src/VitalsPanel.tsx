import { useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  JivaButton,
  JivaCard,
  JivaStatus,
  MEASUREMENT_LIMITS,
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  SkeletonRows,
  enteredValueProblem,
  parseEntered,
  cx,
  formatDateTime,
  formatMeasurementValue,
  fromDateTimeLocal,
  measurementFreshness,
  measurementQuality,
  measurementSource,
  timeAgo,
  toDateTimeLocal,
  type MeasurementTypeCode,
  type MeasurementView,
  type VitalsResponse,
} from '@jiva/ui/src';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from './ui';
import { useUnsaved } from './unsaved';

const path = (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}/vitals`;

/** One typed value per measurement type (blood pressure also has the diastolic value). Empty = not recorded. */
type Values = Record<MeasurementTypeCode, { value: string; secondary: string }>;
const emptyValues = (): Values => Object.fromEntries(MEASUREMENT_ORDER.map((t) => [t, { value: '', secondary: '' }])) as Values;

/** Which keyboard to offer for a field. */
const INPUT_MODE: Record<MeasurementTypeCode, 'numeric' | 'decimal'> = {
  HEART_RATE: 'numeric', SPO2: 'numeric', BLOOD_PRESSURE: 'numeric', TEMPERATURE: 'decimal', RESPIRATORY_RATE: 'numeric', BLOOD_GLUCOSE: 'numeric',
};

/**
 * Vital signs of one encounter: latest value per type with its source and age, the entries over time,
 * a form to enter measured values, and — in demo mode only — a clearly labelled simulated monitor.
 */
export function VitalsPanel({ encounterId, vitals, onChanged, now }: { encounterId: string; vitals: VitalsResponse | null | undefined; onChanged: () => void; now: number }) {
  const [entering, setEntering] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  return (
    <JivaCard>
      <CardHeader
        title="Vital signs"
        icon="heart"
        subtitle="Entered by the care team · no medical device is connected to JIVA"
        actions={
          !entering && (
            <div className="flex flex-wrap gap-1.5">
              <JivaButton size="sm" variant="primary" icon="plus" onClick={() => setEntering(true)}>
                Record vital signs
              </JivaButton>
              {vitals?.sources.simulationAvailable && (
                <AsyncButton
                  size="sm"
                  variant="warn-soft"
                  icon="activity"
                  pendingText="Simulating…"
                  title="Adds one synthetic reading, labelled as simulated"
                  onAction={async () => {
                    // Each press is a new synthetic reading.
                    const r = await sendCommand(`${path(encounterId)}/simulate`, { clientRequestId: crypto.randomUUID() });
                    setSimError(r.error);
                    onChanged();
                    return r.error;
                  }}
                >
                  Simulated monitor (demo)
                </AsyncButton>
              )}
            </div>
          )
        }
      />
      {simError && <CommandError message={simError} />}
      {entering && (
        <VitalsForm
          encounterId={encounterId}
          onSaved={() => {
            setEntering(false);
            onChanged();
          }}
          onCancel={() => setEntering(false)}
        />
      )}
      {vitals === undefined ? (
        <SkeletonRows rows={2} className="mt-3" />
      ) : vitals === null ? (
        <p className="mt-3 text-sm text-danger-700">Vital signs could not be loaded. They will be retried automatically.</p>
      ) : Object.keys(vitals.latest).length === 0 ? (
        !entering && <p className="mt-3 text-sm text-ink-500">No vital signs recorded for this encounter.</p>
      ) : (
        <>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {MEASUREMENT_ORDER.filter((t) => vitals.latest[t]).map((t) => {
              const m = vitals.latest[t]!;
              return (
                <li key={t} className={cx('rounded-xl p-3 ring-1 ring-inset', m.source === 'DEVICE_SIMULATED' ? 'bg-warn-50/40 ring-warn-200' : 'bg-ink-25 ring-ink-200')}>
                  <p className="text-xs font-semibold text-ink-500">{MEASUREMENT_TEXT[t].label}</p>
                  <p className="text-xl font-semibold tabular-nums text-ink-900">
                    {formatMeasurementValue(m)} <span className="text-sm font-medium text-ink-500">{MEASUREMENT_TEXT[t].unit}</span>
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <JivaStatus meta={measurementSource(m.source)} />
                    <JivaStatus meta={measurementFreshness(m.freshness)} />
                    {measurementQuality(m.quality) && <JivaStatus meta={measurementQuality(m.quality)!} />}
                    {m.corrects && <JivaStatus meta={{ label: 'Corrected value', tone: 'neutral', icon: 'refresh', hint: 'Replaces a value that was entered in error; the original is kept in the history.' }} />}
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    {formatDateTime(m.observedAt)} ({timeAgo(m.observedAt, now)})
                    {m.recordedByName ? (m.source === 'DEVICE_SIMULATED' ? ` · simulator started by ${m.recordedByName}` : ` · ${m.recordedByName}`) : ''}
                  </p>
                </li>
              );
            })}
          </ul>
          <ObservationHistory encounterId={encounterId} list={vitals.measurements} onChanged={onChanged} />
        </>
      )}
    </JivaCard>
  );
}

/**
 * Every observation of the encounter, newest first, with its source. A value the care team typed in can be
 * corrected (replaced) or withdrawn as entered in error, with a reason; the original stays visible here,
 * struck through, with who withdrew it and why. Simulated readings are never edited.
 */
function ObservationHistory({ encounterId, list, onChanged }: { encounterId: string; list: MeasurementView[]; onChanged: () => void }) {
  const [correcting, setCorrecting] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const byId = new Map(list.map((m) => [m.measurementId, m]));
  return (
    <details className="mt-3 rounded-lg ring-1 ring-inset ring-ink-200" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="flex cursor-pointer select-none items-center justify-between gap-2 px-3 py-2 text-[13px] font-semibold text-ink-700 hover:text-ink-900">
        Observation history ({list.length})
        <span className="text-xs font-normal text-ink-500">Correct a value entered in error here</span>
      </summary>
      <ul className="divide-y divide-ink-100 border-t border-ink-200">
        {list.map((m) => {
          const withdrawn = !!m.withdrawn;
          const replacement = m.withdrawn?.replacedBy ? byId.get(m.withdrawn.replacedBy) : undefined;
          return (
            <li key={m.measurementId} className="px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                <p className={cx('min-w-0 text-ink-800', withdrawn && 'text-ink-500 line-through decoration-ink-400')}>
                  <span className="font-semibold">{MEASUREMENT_TEXT[m.type].label}</span> {formatMeasurementValue(m)} {MEASUREMENT_TEXT[m.type].unit}
                  <span className="text-ink-500">
                    {' '}
                    · {formatDateTime(m.observedAt)} · {measurementSource(m.source).label}
                    {m.recordedByName ? ` · ${m.recordedByName}` : ''}
                    {m.quality === 'QUESTIONABLE' ? ' · questionable' : ''}
                  </span>
                </p>
                {!withdrawn && m.source === 'MANUAL_CLINICIAN' && correcting !== m.measurementId && (
                  <JivaButton size="sm" variant="tertiary" icon="refresh" onClick={() => setCorrecting(m.measurementId)} aria-label={`Correct ${MEASUREMENT_TEXT[m.type].label} ${formatMeasurementValue(m)} measured ${formatDateTime(m.observedAt)}`}>
                    Correct
                  </JivaButton>
                )}
              </div>
              {m.withdrawn && (
                <p className="mt-0.5 text-xs text-ink-600">
                  {replacement ? `Corrected to ${formatMeasurementValue(replacement)} ${MEASUREMENT_TEXT[m.type].unit}` : 'Withdrawn as entered in error'} · {formatDateTime(m.withdrawn.at)} · “{m.withdrawn.reason}”
                </p>
              )}
              {m.corrects && !withdrawn && <p className="mt-0.5 text-xs text-ink-500">Corrected value (replaces an entry made in error)</p>}
              {correcting === m.measurementId && (
                <CorrectionForm
                  encounterId={encounterId}
                  m={m}
                  onDone={() => {
                    setCorrecting(null);
                    onChanged();
                  }}
                  onCancel={() => setCorrecting(null)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Replace one entered value, or withdraw it as entered in error — always with a reason. */
function CorrectionForm({ encounterId, m, onDone, onCancel }: { encounterId: string; m: MeasurementView; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState(String(m.value));
  const [secondary, setSecondary] = useState(m.secondaryValue !== undefined ? String(m.secondaryValue) : '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const changed = value !== String(m.value) || (m.type === 'BLOOD_PRESSURE' && secondary !== String(m.secondaryValue ?? ''));
  useUnsaved(changed || reason.trim() !== '', 'a vital-sign correction');
  const problem = enteredValueProblem(m.type, value, secondary) ?? (value.trim() === '' ? 'Enter the corrected value, or withdraw the entry instead.' : null);
  const id = (k: string) => `corr-${m.measurementId}-${k}`;
  const text = MEASUREMENT_TEXT[m.type];
  const send = async (withReplacement: boolean) => {
    const body = {
      reason: reason.trim(),
      ...(withReplacement ? { replacement: { value: parseEntered(value), ...(m.type === 'BLOOD_PRESSURE' ? { secondaryValue: parseEntered(secondary) } : {}) } } : {}),
    };
    const r = await sendCommand(`${path(encounterId)}/${encodeURIComponent(m.measurementId)}/correct`, { clientRequestId: keyFor(body), ...body });
    setError(r.error);
    if (!r.error || r.status === 409) onDone();
    return r.error;
  };
  return (
    <div className="mt-2 animate-fade space-y-2 rounded-lg bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-[13px] font-semibold text-ink-900">
        Correct {text.label.toLowerCase()} measured {formatDateTime(m.observedAt)}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label={`Corrected value (${text.unit})`} htmlFor={id('value')}>
          {m.type === 'BLOOD_PRESSURE' ? (
            <div className="flex items-center gap-1.5">
              <input id={id('value')} aria-label="Corrected systolic" inputMode="numeric" className={cx(inputClass, 'h-9 tabular-nums')} value={value} onChange={(e) => setValue(e.target.value)} />
              <span className="text-ink-500" aria-hidden="true">/</span>
              <input aria-label="Corrected diastolic" inputMode="numeric" className={cx(inputClass, 'h-9 tabular-nums')} value={secondary} onChange={(e) => setSecondary(e.target.value)} />
            </div>
          ) : (
            <input id={id('value')} inputMode={INPUT_MODE[m.type]} className={cx(inputClass, 'h-9 tabular-nums')} value={value} onChange={(e) => setValue(e.target.value)} />
          )}
          {problem && changed && <p className="text-xs text-danger-700">{problem}</p>}
        </Field>
        <Field label="Reason" htmlFor={id('why')} required hint="Kept in the history with your name.">
          <input id={id('why')} className={cx(inputClass, 'h-9')} value={reason} maxLength={300} placeholder="e.g. Typed 140 instead of 104" onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <AsyncButton size="sm" variant="primary" icon="check" disabled={!reason.trim() || !changed || !!problem} pendingText="Saving…" onAction={() => send(true)}>
          Save correction
        </AsyncButton>
        <AsyncButton size="sm" variant="danger-soft" icon="ban" disabled={!reason.trim()} pendingText="Withdrawing…" onAction={() => send(false)}>
          Withdraw as entered in error
        </AsyncButton>
        <JivaButton size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      <p className="text-xs text-ink-500">The original value is kept in the history, marked as corrected or withdrawn.</p>
      {error && <CommandError message={error} />}
    </div>
  );
}

/**
 * Values the care team measured, typed in (no device is connected). Every field is optional: an empty field
 * is not recorded, never given a default. Typing errors are explained next to the field before anything is
 * sent; the server checks everything again. One time applies to the whole entry.
 */
function VitalsForm({ encounterId, onSaved, onCancel }: { encounterId: string; onSaved: () => void; onCancel: () => void }) {
  const [values, setValues] = useState<Values>(emptyValues);
  const [at, setAt] = useState(() => toDateTimeLocal(Date.now()));
  const [error, setError] = useState<string | null>(null);
  const [questionable, setQuestionable] = useState(false);
  // Upper bound for the picker, fixed when the form opens (the server re-checks the time anyway).
  const [latest] = useState(() => toDateTimeLocal(Date.now() + 60_000));
  const keyFor = useIdempotencyKey();
  const filled = MEASUREMENT_ORDER.filter((t) => values[t].value.trim() !== '' || values[t].secondary.trim() !== '');
  useUnsaved(filled.length > 0 || questionable, 'vital signs');
  const id = (k: string) => `vit-${encounterId}-${k}`;
  const setValue = (t: MeasurementTypeCode, patch: Partial<Values[MeasurementTypeCode]>) => setValues((prev) => ({ ...prev, [t]: { ...prev[t], ...patch } }));
  const observedAt = fromDateTimeLocal(at);
  const problems = Object.fromEntries(MEASUREMENT_ORDER.map((t) => [t, enteredValueProblem(t, values[t].value, values[t].secondary)])) as Record<MeasurementTypeCode, string | null>;
  const hasProblem = MEASUREMENT_ORDER.some((t) => problems[t]);

  const measurements = () =>
    filled.map((t) => ({
      type: t,
      value: parseEntered(values[t].value),
      ...(t === 'BLOOD_PRESSURE' ? { secondaryValue: parseEntered(values[t].secondary) } : {}),
      unit: MEASUREMENT_LIMITS[t].unit,
      observedAt,
      ...(questionable ? { quality: 'QUESTIONABLE' } : {}),
    }));
  const ready = !!observedAt && filled.length > 0 && !hasProblem;
  const why = !observedAt ? 'Set the time the values were measured.' : filled.length === 0 ? 'Enter at least one measured value.' : hasProblem ? 'Correct the highlighted values first.' : null;

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink-900">Enter measured values</p>
        <p className="text-xs text-ink-500">Entered manually · no monitoring device is connected</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {MEASUREMENT_ORDER.map((t) => {
          const text = MEASUREMENT_TEXT[t];
          const problem = problems[t];
          const errId = id(`${t}-error`);
          const field = cx(inputClass, 'h-9 pr-14 tabular-nums', problem && 'ring-2 ring-danger-400 hover:ring-danger-500');
          return (
            <Field key={t} label={`${text.label} (${text.unit})`} htmlFor={id(t)}>
              {t === 'BLOOD_PRESSURE' ? (
                <div className="flex items-center gap-1.5">
                  <input id={id(t)} aria-label="Systolic" aria-describedby={problem ? errId : undefined} aria-invalid={!!problem} inputMode="numeric" placeholder="systolic" className={cx(inputClass, 'h-9 tabular-nums', problem && 'ring-2 ring-danger-400')} value={values[t].value} onChange={(e) => setValue(t, { value: e.target.value })} />
                  <span className="text-ink-500" aria-hidden="true">/</span>
                  <input aria-label="Diastolic" aria-describedby={problem ? errId : undefined} aria-invalid={!!problem} inputMode="numeric" placeholder="diastolic" className={cx(inputClass, 'h-9 tabular-nums', problem && 'ring-2 ring-danger-400')} value={values[t].secondary} onChange={(e) => setValue(t, { secondary: e.target.value })} />
                </div>
              ) : (
                <div className="relative">
                  <input id={id(t)} aria-describedby={problem ? errId : undefined} aria-invalid={!!problem} inputMode={INPUT_MODE[t]} className={field} value={values[t].value} onChange={(e) => setValue(t, { value: e.target.value })} />
                  <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-ink-500">
                    {text.unit}
                  </span>
                </div>
              )}
              {problem && (
                <p id={errId} className="text-xs text-danger-700">
                  {problem}
                </p>
              )}
            </Field>
          );
        })}
        <Field label="Measured at" htmlFor={id('at')} required>
          <div className="flex items-center gap-1.5">
            <input id={id('at')} type="datetime-local" className={cx(inputClass, 'h-9')} value={at} max={latest} onChange={(e) => setAt(e.target.value)} />
            <JivaButton size="sm" variant="ghost" icon="clock" onClick={() => setAt(toDateTimeLocal(Date.now()))}>
              Now
            </JivaButton>
          </div>
        </Field>
      </div>
      <label className="flex items-center gap-2 text-[13px] text-ink-800">
        <input type="checkbox" className="h-4 w-4 accent-brand-700" checked={questionable} onChange={(e) => setQuestionable(e.target.checked)} />
        Flag these values as questionable (movement, poor signal …)
      </label>
      <p className="text-xs text-ink-500">Fill in only what you measured — empty fields are not recorded. The limits only catch typing errors; JIVA does not judge whether a value is normal.</p>
      <div className="flex flex-wrap items-center gap-2">
        <AsyncButton
          variant="primary"
          icon="check"
          disabled={!ready}
          title={why ?? undefined}
          pendingText="Saving…"
          onAction={async () => {
            const body = { measurements: measurements() };
            const r = await sendCommand(path(encounterId), { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onSaved();
            return r.error;
          }}
        >
          Save vital signs
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
        {why && filled.length > 0 && <span className="text-xs text-ink-500">{why}</span>}
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}
