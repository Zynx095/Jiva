import { useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  JivaButton,
  JivaCard,
  JivaStatus,
  MEASUREMENT_ORDER,
  MEASUREMENT_TEXT,
  SkeletonRows,
  cx,
  formatDateTime,
  formatMeasurementValue,
  fromDateTimeLocal,
  measurementFreshness,
  measurementSource,
  timeAgo,
  toDateTimeLocal,
  type VitalsResponse,
} from '@jiva/ui/src';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from '../ui';

const path = (encounterId: string) => `/api/encounters/${encodeURIComponent(encounterId)}/vitals`;

interface Draft {
  hr: string;
  spo2: string;
  sys: string;
  dia: string;
  temp: string;
  rr: string;
  at: string;
}

const num = (s: string) => (s.trim() === '' ? undefined : Number(s));

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
              <JivaButton size="sm" icon="plus" onClick={() => setEntering(true)}>
                Enter values
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
                  </div>
                  <p className="mt-1 text-xs text-ink-500">
                    {formatDateTime(m.observedAt)} ({timeAgo(m.observedAt, now)})
                    {m.recordedByName ? (m.source === 'DEVICE_SIMULATED' ? ` · simulator started by ${m.recordedByName}` : ` · ${m.recordedByName}`) : ''}
                  </p>
                </li>
              );
            })}
          </ul>
          <details className="mt-2 text-xs text-ink-600">
            <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">All entries ({vitals.measurements.length})</summary>
            <ul className="mt-1.5 space-y-0.5">
              {vitals.measurements.map((m) => (
                <li key={m.measurementId}>
                  {formatDateTime(m.observedAt)} · {MEASUREMENT_TEXT[m.type].label} {formatMeasurementValue(m)} {MEASUREMENT_TEXT[m.type].unit} · {measurementSource(m.source).label}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
    </JivaCard>
  );
}

function VitalsForm({ encounterId, onSaved, onCancel }: { encounterId: string; onSaved: () => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => ({ hr: '', spo2: '', sys: '', dia: '', temp: '', rr: '', at: toDateTimeLocal(Date.now()) }));
  const [error, setError] = useState<string | null>(null);
  // Upper bound for the picker, fixed when the form opens (the server re-checks the time anyway).
  const [latest] = useState(() => toDateTimeLocal(Date.now() + 60_000));
  const keyFor = useIdempotencyKey();
  const id = (k: string) => `vit-${encounterId}-${k}`;
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setD((prev) => ({ ...prev, [k]: e.target.value }));
  const observedAt = fromDateTimeLocal(d.at);

  const measurements = () => {
    const list: Array<Record<string, unknown>> = [];
    const add = (type: string, value: number | undefined, unit: string, extra: Record<string, unknown> = {}) => {
      if (value !== undefined && Number.isFinite(value)) list.push({ type, value, unit, observedAt, ...extra });
    };
    add('HEART_RATE', num(d.hr), 'bpm');
    add('SPO2', num(d.spo2), '%');
    if (num(d.sys) !== undefined || num(d.dia) !== undefined) add('BLOOD_PRESSURE', num(d.sys), 'mmHg', { secondaryValue: num(d.dia) });
    add('TEMPERATURE', num(d.temp), 'degC');
    add('RESPIRATORY_RATE', num(d.rr), 'breaths/min');
    return list;
  };
  const ready = !!observedAt && measurements().length > 0;

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-sm font-semibold text-ink-900">Enter measured values</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Heart rate (bpm)" htmlFor={id('hr')}>
          <input id={id('hr')} inputMode="numeric" className={cx(inputClass, 'h-9')} value={d.hr} onChange={set('hr')} />
        </Field>
        <Field label="SpO₂ (%)" htmlFor={id('spo2')}>
          <input id={id('spo2')} inputMode="numeric" className={cx(inputClass, 'h-9')} value={d.spo2} onChange={set('spo2')} />
        </Field>
        <Field label="Breathing rate (/min)" htmlFor={id('rr')}>
          <input id={id('rr')} inputMode="numeric" className={cx(inputClass, 'h-9')} value={d.rr} onChange={set('rr')} />
        </Field>
        <Field label="Blood pressure (mmHg)" htmlFor={id('sys')}>
          <div className="flex items-center gap-1.5">
            <input id={id('sys')} aria-label="Systolic" inputMode="numeric" placeholder="sys" className={cx(inputClass, 'h-9')} value={d.sys} onChange={set('sys')} />
            <span className="text-ink-500">/</span>
            <input aria-label="Diastolic" inputMode="numeric" placeholder="dia" className={cx(inputClass, 'h-9')} value={d.dia} onChange={set('dia')} />
          </div>
        </Field>
        <Field label="Temperature (°C)" htmlFor={id('temp')}>
          <input id={id('temp')} inputMode="decimal" className={cx(inputClass, 'h-9')} value={d.temp} onChange={set('temp')} />
        </Field>
        <Field label="Measured at" htmlFor={id('at')} required>
          <input id={id('at')} type="datetime-local" className={cx(inputClass, 'h-9')} value={d.at} max={latest} onChange={set('at')} />
        </Field>
      </div>
      <p className="text-xs text-ink-500">Fill in what you measured; empty fields are not recorded. Implausible values are refused by the server.</p>
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="primary"
          icon="check"
          disabled={!ready}
          pendingText="Saving…"
          onAction={async () => {
            const body = { measurements: measurements() };
            const r = await sendCommand(path(encounterId), { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onSaved();
            return r.error;
          }}
        >
          Record
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}
