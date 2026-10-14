import { useState, type ReactNode } from 'react';
import {
  AsyncButton,
  CardHeader,
  FORMULATION_TEXT,
  Icon,
  JivaButton,
  JivaCard,
  JivaStatus,
  MEDICATION_FORMULATIONS,
  MEDICATION_ROUTES,
  ROUTE_TEXT,
  SkeletonRows,
  cx,
  formatDateTime,
  medicationLine,
  prescriptionStatus,
  type MedicationCatalogueEntry,
  type PrescriptionRecord,
  type PrescriptionVersionView,
} from '@jiva/ui/src';
import { MedicationPicker } from './MedicationPicker';
import { CommandError, Field, inputClass, sendCommand, useIdempotencyKey } from './ui';
import { useUnsaved } from './unsaved';

interface Form {
  medication: string;
  strength: string;
  formulation: string;
  dose: string;
  route: string;
  frequency: string;
  duration: string;
  instructions: string;
}

/** The catalogue entry the form was filled from (product fields are then locked to it). */
interface Chosen {
  medicationId: string;
  routes: string[];
}

const EMPTY: Form = { medication: '', strength: '', formulation: '', dose: '', route: 'ORAL', frequency: '', duration: '', instructions: '' };

const rxPath = (encounterId: string, rxId?: string, action?: string) =>
  `/api/encounters/${encodeURIComponent(encounterId)}/prescriptions${rxId ? `/${encodeURIComponent(rxId)}/${action}` : ''}`;

/** Only filled fields are sent; the server validates everything again. */
function bodyOf(f: Form, chosen: Chosen | null) {
  const fields = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''));
  return { ...fields, ...(chosen ? { medicationId: chosen.medicationId } : {}) };
}

const isOpen = (rx: PrescriptionRecord) => rx.current.status === 'DRAFT' || rx.current.status === 'ACTIVE';

const ACTION_TEXT = (v: PrescriptionVersionView) =>
  v.action === 'AUTHORISED' ? 'authorised'
    : v.action === 'CANCELLED' ? 'draft discarded'
      : v.action === 'DISCONTINUED' ? 'stopped'
        : v.status === 'DRAFT' ? (v.action === 'AMENDED' ? 'draft edited' : 'draft saved')
          : v.action === 'AMENDED' ? 'changed and re-authorised' : 'prescribed and authorised';

/**
 * Prescriptions of one encounter for the assigned clinician. A prescription is either written and authorised
 * in one explicit step, or saved as a draft — not in force, never shown to the patient — and authorised
 * later with an explicit attestation. Every version is kept with who did what, when and why.
 */
export function PrescriptionsPanel({ encounterId, list, onChanged }: { encounterId: string; list: PrescriptionRecord[] | null | undefined; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const drafts = list?.filter((rx) => rx.current.status === 'DRAFT').length ?? 0;
  return (
    <JivaCard>
      <CardHeader
        title="Prescriptions"
        icon="pill"
        subtitle={drafts ? `${drafts} draft${drafts === 1 ? '' : 's'} awaiting your authorisation` : 'The patient sees authorised prescriptions only (not drafts or your change notes)'}
        actions={
          !creating && (
            <JivaButton size="sm" variant="primary" icon="plus" onClick={() => setCreating(true)}>
              New prescription
            </JivaButton>
          )
        }
      />
      <p className="mt-2 flex items-start gap-1.5 text-xs text-ink-500">
        <Icon name="info" size={13} className="mt-px shrink-0" />
        JIVA never suggests a medication or a dose. The catalogue only identifies a product; you decide and authorise every prescription.
      </p>
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
          {[...list].sort((a, b) => Number(b.current.status === 'DRAFT') - Number(a.current.status === 'DRAFT') || Number(!isOpen(a)) - Number(!isOpen(b))).map((rx) => (
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
  const [mode, setMode] = useState<'view' | 'amend' | 'stop' | 'authorise' | 'discard'>('view');
  const c = rx.current;
  const done = () => {
    setMode('view');
    onChanged();
  };
  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className={cx('text-sm font-semibold', isOpen(rx) ? 'text-ink-900' : 'text-ink-500 line-through decoration-ink-300')}>{medicationLine(c)}</p>
          {c.instructions && <p className="text-[13px] text-ink-700">{c.instructions}</p>}
          <p className="mt-0.5 text-xs text-ink-500">
            v{c.version} · {ACTION_TEXT(c)} {formatDateTime(c.recordedAt)} by {c.author.displayName}
            {c.changeReason ? ` · “${c.changeReason}”` : ''}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-500">
            {c.catalogueRef ? `From the catalogue: ${c.catalogueRef.medicationId} (revision ${c.catalogueRef.revision})` : 'Entered without a catalogue reference'}
            {rx.dataStatus === 'SYNTHETIC_DEMO' ? ' · synthetic demo record' : ''}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <JivaStatus meta={prescriptionStatus(c.status)} />
          {mode === 'view' && c.status === 'DRAFT' && (
            <>
              <JivaButton size="sm" variant="primary" icon="check" onClick={() => setMode('authorise')}>
                Review and authorise
              </JivaButton>
              <JivaButton size="sm" variant="ghost" onClick={() => setMode('amend')}>
                Edit draft
              </JivaButton>
              <JivaButton size="sm" variant="danger-soft" onClick={() => setMode('discard')}>
                Discard
              </JivaButton>
            </>
          )}
          {mode === 'view' && c.status === 'ACTIVE' && (
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
      {mode === 'amend' && <PrescriptionForm encounterId={encounterId} base={rx} onSaved={done} onRefresh={onChanged} onCancel={() => setMode('view')} />}
      {mode === 'authorise' && <AuthoriseForm rx={rx} encounterId={encounterId} onSaved={done} onRefresh={onChanged} onCancel={() => setMode('view')} />}
      {(mode === 'stop' || mode === 'discard') && <ReasonForm rx={rx} encounterId={encounterId} kind={mode} onSaved={done} onRefresh={onChanged} onCancel={() => setMode('view')} />}
      {rx.history.length > 1 && (
        <details className="mt-1.5 text-xs text-ink-600">
          <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">History ({rx.history.length} versions)</summary>
          <ol className="mt-1.5 space-y-1.5">
            {[...rx.history].reverse().map((v) => (
              <li key={v.version} className="rounded-lg bg-ink-25 px-2.5 py-1.5 ring-1 ring-inset ring-ink-100">
                <p className="font-semibold text-ink-800">
                  v{v.version} · {ACTION_TEXT(v)} · {formatDateTime(v.recordedAt)} · {v.author.displayName}
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
  const [f, setF] = useState<Form>(() => (base ? formOf(base.current) : EMPTY));
  const [chosen, setChosen] = useState<Chosen | null>(() => (base?.current.catalogueRef ? { medicationId: base.current.catalogueRef.medicationId, routes: [] } : null));
  const [reason, setReason] = useState(base?.current.status === 'DRAFT' ? 'Draft revised' : '');
  const [attest, setAttest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const [initial] = useState(() => JSON.stringify(base ? formOf(base.current) : EMPTY));
  useUnsaved(JSON.stringify(f) !== initial || (!base && chosen !== null) || (!!base && reason !== (base.current.status === 'DRAFT' ? 'Draft revised' : '')) || attest, base ? 'prescription changes' : 'a new prescription');
  const id = (k: string) => `rx-${base?.prescriptionId ?? 'new'}-${k}`;
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF((prev) => ({ ...prev, [k]: e.target.value }));
  const draftEdit = base?.current.status === 'DRAFT';
  const activeEdit = base?.current.status === 'ACTIVE';
  const complete = !!(f.medication.trim() && f.dose.trim() && f.frequency.trim() && (!base || reason.trim()) && (!chosen || f.formulation));
  const routes = chosen?.routes.length ? chosen.routes : [...MEDICATION_ROUTES];

  const pick = (m: MedicationCatalogueEntry) => {
    setChosen({ medicationId: m.medicationId, routes: m.routes });
    setF((prev) => ({ ...prev, medication: m.name, strength: m.strength, formulation: m.formulation, route: m.routes.includes(prev.route) ? prev.route : m.routes[0] }));
  };

  const submit = async (asDraft: boolean) => {
    const content = bodyOf(f, chosen);
    const body = base ? { ...content, expectedVersion: base.current.version, changeReason: reason.trim() } : { ...content, ...(asDraft ? { draft: true } : {}) };
    const r = await sendCommand(base ? rxPath(encounterId, base.prescriptionId, 'amend') : rxPath(encounterId), { clientRequestId: keyFor(body), ...body });
    setError(r.error);
    if (!r.error) onSaved();
    else if (r.status === 409) onRefresh(); // changed meanwhile: load the current version, keep the edits
    return r.error;
  };

  return (
    <div className="mt-3 animate-fade space-y-3 rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
      <p className="text-sm font-semibold text-ink-900">
        {draftEdit ? `Edit draft (based on v${base!.current.version})` : activeEdit ? `Change prescription (based on v${base!.current.version})` : 'New prescription'}
      </p>
      {chosen ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-brand-50/60 px-2.5 py-1.5 text-xs text-brand-900 ring-1 ring-inset ring-brand-100">
          <Icon name="list" size={13} />
          <span>
            Product from the catalogue: <span className="font-semibold">{chosen.medicationId}</span> — name, strength and dosage form are locked to the entry.
          </span>
          <button type="button" className="ml-auto font-semibold underline-offset-2 hover:underline" onClick={() => setChosen(null)}>
            Enter without the catalogue
          </button>
        </div>
      ) : (
        <MedicationPicker id={id('search')} onPick={pick} />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Medication" htmlFor={id('med')} required>
          <input id={id('med')} className={cx(inputClass, 'h-9')} value={f.medication} onChange={set('medication')} maxLength={120} autoComplete="off" readOnly={!!chosen} />
        </Field>
        <Field label="Strength" htmlFor={id('str')}>
          <input id={id('str')} className={cx(inputClass, 'h-9')} value={f.strength} onChange={set('strength')} maxLength={40} placeholder="e.g. 500 mg" readOnly={!!chosen} />
        </Field>
        <Field label="Dosage form" htmlFor={id('form')} required={!!chosen}>
          <select id={id('form')} className={cx(inputClass, 'h-9')} value={f.formulation} onChange={set('formulation')} disabled={!!chosen}>
            <option value="">Not stated</option>
            {MEDICATION_FORMULATIONS.map((x) => (
              <option key={x} value={x}>
                {FORMULATION_TEXT[x]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Route" htmlFor={id('route')} required>
          <select id={id('route')} className={cx(inputClass, 'h-9')} value={f.route} onChange={set('route')}>
            {routes.map((r) => (
              <option key={r} value={r}>
                {ROUTE_TEXT[r] ?? r}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Dose" htmlFor={id('dose')} required>
          <input id={id('dose')} className={cx(inputClass, 'h-9')} value={f.dose} onChange={set('dose')} maxLength={60} placeholder="e.g. 1 tablet" />
        </Field>
        <Field label="Frequency" htmlFor={id('freq')} required>
          <input id={id('freq')} className={cx(inputClass, 'h-9')} value={f.frequency} onChange={set('frequency')} maxLength={60} placeholder="e.g. every 8 hours" />
        </Field>
        <Field label="Duration" htmlFor={id('dur')}>
          <input id={id('dur')} className={cx(inputClass, 'h-9')} value={f.duration} onChange={set('duration')} maxLength={60} placeholder="e.g. 5 days" />
        </Field>
        <Field label="Instructions for the patient" htmlFor={id('ins')} className="sm:col-span-2">
          <textarea id={id('ins')} className={cx(inputClass, 'min-h-16 py-2')} value={f.instructions} onChange={set('instructions')} maxLength={500} />
        </Field>
        {base && (
          <Field label="Reason for the change" htmlFor={id('why')} required className="sm:col-span-2" hint="Kept in the record history for the care team; not shown to the patient.">
            <input id={id('why')} className={cx(inputClass, 'h-9')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </Field>
        )}
      </div>
      {!draftEdit && (
        <label className="flex items-start gap-2 text-[13px] text-ink-800">
          <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          <span>
            {activeEdit
              ? 'I have reviewed this change and authorise the changed prescription for this patient.'
              : 'I have reviewed this prescription and authorise it for this patient (to decide later, save it as a draft instead).'}
          </span>
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        {!base && (
          <AsyncButton variant="secondary" icon="file" disabled={!complete} pendingText="Saving draft…" onAction={() => submit(true)}>
            Save as draft
          </AsyncButton>
        )}
        {draftEdit ? (
          <AsyncButton variant="primary" icon="check" disabled={!complete} pendingText="Saving…" onAction={() => submit(true)}>
            Save draft
          </AsyncButton>
        ) : (
          <AsyncButton variant="primary" icon="check" disabled={!complete || !attest} pendingText="Saving…" onAction={() => submit(false)}>
            {activeEdit ? 'Save and re-authorise' : 'Prescribe and authorise'}
          </AsyncButton>
        )}
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}

/** The explicit authorisation of a draft: exactly the version shown, with an attestation. */
function AuthoriseForm({ rx, encounterId, onSaved, onRefresh, onCancel }: { rx: PrescriptionRecord; encounterId: string; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [attest, setAttest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  const c = rx.current;
  return (
    <div className="mt-3 animate-fade space-y-2 rounded-xl bg-brand-50/40 p-3 ring-1 ring-inset ring-brand-200">
      <p className="text-sm font-semibold text-ink-900">Authorise draft v{c.version}</p>
      <dl className="grid gap-x-4 gap-y-1 text-[13px] sm:grid-cols-2">
        <Row label="Medication">{[c.medication, c.strength, c.formulation && (FORMULATION_TEXT[c.formulation] ?? c.formulation)].filter(Boolean).join(' · ')}</Row>
        <Row label="Dose and route">{`${c.dose} · ${ROUTE_TEXT[c.route] ?? c.route}`}</Row>
        <Row label="Frequency">{c.frequency}</Row>
        <Row label="Duration">{c.duration ?? '—'}</Row>
        {c.instructions && <Row label="Instructions">{c.instructions}</Row>}
      </dl>
      <label className="flex items-start gap-2 text-[13px] text-ink-800">
        <input type="checkbox" className="mt-0.5 h-4 w-4 accent-brand-700" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
        <span>I have reviewed this prescription and authorise it for this patient. Once authorised it is in force and the patient can see it.</span>
      </label>
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="primary"
          icon="check"
          disabled={!attest}
          pendingText="Authorising…"
          onAction={async () => {
            const body = { expectedVersion: c.version, attestation: true };
            const r = await sendCommand(rxPath(encounterId, rx.prescriptionId, 'authorise'), { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onSaved();
            else if (r.status === 409) onRefresh();
            return r.error;
          }}
        >
          Authorise prescription
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}

function ReasonForm({ rx, encounterId, kind, onSaved, onRefresh, onCancel }: { rx: PrescriptionRecord; encounterId: string; kind: 'stop' | 'discard'; onSaved: () => void; onRefresh: () => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keyFor = useIdempotencyKey();
  useUnsaved(reason.trim() !== '', kind === 'stop' ? 'a reason for stopping a medication' : 'a reason for discarding a draft');
  const id = `${kind}-${rx.prescriptionId}`;
  const stop = kind === 'stop';
  return (
    <div className="mt-3 animate-fade space-y-2 rounded-xl bg-danger-50/50 p-3 ring-1 ring-inset ring-danger-200">
      <Field
        label={`${stop ? 'Stop' : 'Discard draft of'} ${rx.current.medication}: reason`}
        htmlFor={id}
        required
        hint={stop ? 'Stopping is final; write a new prescription to restart.' : 'The draft was never in force; it stays in the history only.'}
      >
        <input id={id} className={cx(inputClass, 'h-9')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <AsyncButton
          variant="danger"
          icon="ban"
          disabled={!reason.trim()}
          pendingText={stop ? 'Stopping…' : 'Discarding…'}
          onAction={async () => {
            const body = { expectedVersion: rx.current.version, changeReason: reason.trim() };
            const r = await sendCommand(rxPath(encounterId, rx.prescriptionId, stop ? 'discontinue' : 'discard'), { clientRequestId: keyFor(body), ...body });
            setError(r.error);
            if (!r.error) onSaved();
            else if (r.status === 409) onRefresh();
            return r.error;
          }}
        >
          {stop ? 'Stop medication' : 'Discard draft'}
        </AsyncButton>
        <JivaButton variant="ghost" onClick={onCancel}>
          Cancel
        </JivaButton>
      </div>
      {error && <CommandError message={error} />}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-ink-500">{label}</dt>
      <dd className="text-ink-900">{children}</dd>
    </div>
  );
}

function formOf(c: PrescriptionVersionView): Form {
  return {
    medication: c.medication, strength: c.strength ?? '', formulation: c.formulation ?? '', dose: c.dose, route: c.route,
    frequency: c.frequency, duration: c.duration ?? '', instructions: c.instructions ?? '',
  };
}
