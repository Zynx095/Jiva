import { useState } from 'react';
import {
  AsyncButton,
  CardHeader,
  JivaButton,
  JivaCard,
  JivaStatus,
  MEDICATION_ROUTES,
  ROUTE_TEXT,
  SkeletonRows,
  cx,
  formatDateTime,
  medicationLine,
  prescriptionStatus,
  type PrescriptionFields,
  type PrescriptionRecord,
} from '@jiva/ui/src';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from '../ui';

const EMPTY: PrescriptionFields = { medication: '', strength: '', dose: '', route: 'ORAL', frequency: '', duration: '', instructions: '' };

/** Only filled fields are sent; the server validates everything again. */
const clean = (f: PrescriptionFields) =>
  Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]).filter(([, v]) => v !== '' && v !== undefined));

/**
 * Prescriptions of one encounter, for the assigned clinician: write, change (with a reason, based on the
 * version you saw) and stop. Every version is kept and shown in the history.
 */
export function PrescriptionsPanel({ encounterId, list, onChanged }: { encounterId: string; list: PrescriptionRecord[] | null | undefined; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  return (
    <JivaCard>
      <CardHeader
        title="Prescriptions"
        icon="pill"
        subtitle="The patient sees their medication list (not your change notes)"
        actions={
          !creating && (
            <JivaButton size="sm" icon="plus" onClick={() => setCreating(true)}>
              New prescription
            </JivaButton>
          )
        }
      />
      {creating && (
        <PrescriptionForm
          encounterId={encounterId}
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
        <p className="mt-3 text-sm text-danger-700">Prescriptions could not be loaded. They will be retried automatically.</p>
      ) : list.length === 0 ? (
        !creating && <p className="mt-3 text-sm text-ink-500">No prescriptions for this encounter yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {list.map((rx) => (
            <li key={rx.prescriptionId} className="py-3">
              <PrescriptionItem rx={rx} encounterId={encounterId} onChanged={onChanged} />
            </li>
          ))}
        </ul>
      )}
    </JivaCard>
  );
}

function PrescriptionItem({ rx, encounterId, onChanged }: { rx: PrescriptionRecord; encounterId: string; onChanged: () => void }) {
  const [mode, setMode] = useState<'view' | 'amend' | 'stop'>('view');
  const c = rx.current;
  const active = c.status === 'ACTIVE';
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cx('text-sm font-semibold', active ? 'text-ink-900' : 'text-ink-500 line-through decoration-ink-300')}>{medicationLine(c)}</p>
          {c.instructions && <p className="text-[13px] text-ink-700">{c.instructions}</p>}
          <p className="mt-0.5 text-xs text-ink-500">
            v{c.version} · {c.action === 'CREATED' ? 'prescribed' : c.action === 'AMENDED' ? 'changed' : 'stopped'} {formatDateTime(c.recordedAt)} by {c.author.displayName}
            {c.changeReason ? ` · “${c.changeReason}”` : ''}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <JivaStatus meta={prescriptionStatus(c.status)} />
          {active && mode === 'view' && (
            <>
              <JivaButton size="sm" variant="ghost" onClick={() => setMode('amend')}>
                Change
              </JivaButton>
              <JivaButton size="sm" variant="danger-soft" onClick={() => setMode('stop')}>
                Stop
              </JivaButton>
            </>
          )}
        </div>
      </div>
      {mode === 'amend' && (
        <PrescriptionForm
          encounterId={encounterId}
          base={rx}
          onSaved={() => {
            setMode('view');
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setMode('view')}
        />
      )}
      {mode === 'stop' && (
        <StopForm
          rx={rx}
          encounterId={encounterId}
          onSaved={() => {
            setMode('view');
            onChanged();
          }}
          onRefresh={onChanged}
          onCancel={() => setMode('view')}
        />
      )}
      {rx.history.length > 1 && (
        <details className="mt-1.5 text-xs text-ink-600">
          <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">History ({rx.history.length} versions)</summary>
          <ol className="mt-1.5 space-y-1.5">
            {[...rx.history].reverse().map((v) => (
              <li key={v.version} className="rounded-lg bg-ink-25 px-2.5 py-1.5 ring-1 ring-inset ring-ink-100">
                <p className="font-semibold text-ink-800">
                  v{v.version} · {v.action.toLowerCase()} · {formatDateTime(v.recordedAt)} · {v.author.displayName}
                </p>
                <p>{medicationLine(v)}</p>
                {v.changeReason && <p className="text-ink-500">Reason: {v.changeReason}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

function PrescriptionForm({ encounterId, base, onSaved, onRefresh, onCancel }: { encounterId: string; base?: PrescriptionRecord; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [f, setF] = useState<PrescriptionFields>(() => (base ? { ...EMPTY, ...stripVersion(base) } : EMPTY));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const id = (k: string) => `rx-${base?.prescriptionId ?? 'new'}-${k}`;
  const set = (k: keyof PrescriptionFields) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const ready = f.medication.trim() && f.dose.trim() && f.frequency.trim() && (!base || reason.trim());

  const submit = async () => {
    const content = clean(f);
    const body = base ? { ...content, expectedVersion: base.current.version, changeReason: reason.trim() } : content;
    const path = base
      ? `/api/encounters/${encodeURIComponent(encounterId)}/prescriptions/${encodeURIComponent(base.prescriptionId)}/amend`
      : `/api/encounters/${encodeURIComponent(encounterId)}/prescriptions`;
    const r = await sendCommand(path, { clientRequestId: keyFor(body), ...body });
    setError(r.error);
    if (!r.error) onSaved();
    else if (r.status === 409) onRefresh(); // changed meanwhile: load the current version, keep the edits
    return r.error;
  };

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-sm font-semibold text-ink-900">{base ? `Change prescription (based on v${base.current.version})` : 'New prescription'}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Medication" htmlFor={id('med')} required>
          <input id={id('med')} className={cx(inputClass, 'h-9')} value={f.medication} onChange={set('medication')} maxLength={120} autoComplete="off" />
        </Field>
        <Field label="Strength" htmlFor={id('str')}>
          <input id={id('str')} className={cx(inputClass, 'h-9')} value={f.strength ?? ''} onChange={set('strength')} maxLength={40} placeholder="e.g. 500 mg" />
        </Field>
        <Field label="Dose" htmlFor={id('dose')} required>
          <input id={id('dose')} className={cx(inputClass, 'h-9')} value={f.dose} onChange={set('dose')} maxLength={60} placeholder="e.g. 1 tablet" />
        </Field>
        <Field label="Route" htmlFor={id('route')} required>
          <select id={id('route')} className={cx(inputClass, 'h-9')} value={f.route} onChange={set('route')}>
            {MEDICATION_ROUTES.map((r) => (
              <option key={r} value={r}>
                {ROUTE_TEXT[r]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Frequency" htmlFor={id('freq')} required>
          <input id={id('freq')} className={cx(inputClass, 'h-9')} value={f.frequency} onChange={set('frequency')} maxLength={60} placeholder="e.g. every 8 hours" />
        </Field>
        <Field label="Duration" htmlFor={id('dur')}>
          <input id={id('dur')} className={cx(inputClass, 'h-9')} value={f.duration ?? ''} onChange={set('duration')} maxLength={60} placeholder="e.g. 5 days" />
        </Field>
        <Field label="Instructions for the patient" htmlFor={id('ins')} className="sm:col-span-2">
          <textarea id={id('ins')} className={cx(inputClass, 'min-h-16 py-2')} value={f.instructions ?? ''} onChange={set('instructions')} maxLength={500} />
        </Field>
        {base && (
          <Field label="Reason for the change" htmlFor={id('why')} required className="sm:col-span-2" hint="Kept in the record history for the care team; not shown to the patient.">
            <input id={id('why')} className={cx(inputClass, 'h-9')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <AsyncButton variant="primary" icon="check" disabled={!ready} pendingText="Saving…" onAction={submit}>
          {base ? 'Save change' : 'Prescribe'}
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}

function StopForm({ rx, encounterId, onSaved, onRefresh, onCancel }: { rx: PrescriptionRecord; encounterId: string; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const id = `stop-${rx.prescriptionId}`;
  return (
    <div className="mt-3 animate-fade space-y-2 rounded-xl bg-danger-50/50 p-3 ring-1 ring-inset ring-danger-200">
      <Field label={`Stop ${rx.current.medication}: reason`} htmlFor={id} required hint="Stopping is final; write a new prescription to restart.">
        <input id={id} className={cx(inputClass, 'h-9')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="danger"
          icon="ban"
          disabled={!reason.trim()}
          pendingText="Stopping…"
          onAction={async () => {
            const body = { expectedVersion: rx.current.version, changeReason: reason.trim() };
            const r = await sendCommand(`/api/encounters/${encodeURIComponent(encounterId)}/prescriptions/${encodeURIComponent(rx.prescriptionId)}/discontinue`, { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onSaved();
            else if (r.status === 409) onRefresh();
            return r.error;
          }}
        >
          Stop medication
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}

function stripVersion(rx: PrescriptionRecord): PrescriptionFields {
  const c = rx.current;
  return { medication: c.medication, strength: c.strength ?? '', dose: c.dose, route: c.route, frequency: c.frequency, duration: c.duration ?? '', instructions: c.instructions ?? '' };
}
