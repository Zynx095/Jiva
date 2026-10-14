import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { AmbulanceState, HospitalState } from '@jiva/domain-models';
import { CardHeader, Icon, JivaButton, JivaCard, Spinner, capabilityLabel, cx, formatDateTime, fromDateTimeLocal, positionSource, timeAgo, toDateTimeLocal, useNow } from '@jiva/ui/src';
import { postCommand } from './api';
import { VitalsFields } from './Vitals';
import { emptyVitals, vitalsPayload, vitalsProblems, vitalsSummary, type VitalsDraft } from './vitalsDraft';

/**
 * Crew emergency intake (Journey A, step 1). The crew records what it observes: where, how serious,
 * the reported symptoms and — separately, and only as a suspicion — the likely cause, plus the care the
 * patient needs. JIVA never turns this into a diagnosis, and asks for no identity details.
 *
 * Success is confirmed from authoritative state (the case appears in this ambulance's own job), not from
 * the submit response; the parent tracks that via `pending`.
 */

export type LocationMethod = 'DEVICE_GPS' | 'MAP_PIN' | 'MANUAL_ENTRY';
export interface DraftLocation {
  latitude: number;
  longitude: number;
  method: LocationMethod;
  accuracyMeters?: number;
  /** Where the coordinates came from, in words. */
  source: string;
}

type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

const SEVERITIES: Array<{ value: Severity; label: string; hint: string }> = [
  { value: 'CRITICAL', label: 'Critical', hint: 'Immediate threat to life' },
  { value: 'HIGH', label: 'High', hint: 'Serious — needs urgent hospital care' },
  { value: 'MEDIUM', label: 'Medium', hint: 'Needs hospital care, stable for now' },
  { value: 'LOW', label: 'Low', hint: 'Minor and stable' },
];

const COMMON_SYMPTOMS = [
  'Chest pain', 'Difficulty breathing', 'Unresponsive', 'Severe bleeding', 'Head injury', 'Suspected fracture',
  'Burns', 'Seizure', 'Stroke signs (face, arm, speech)', 'Severe abdominal pain', 'Pregnancy complication', 'Allergic reaction',
];
const CAUSE_SUGGESTIONS = ['Road traffic accident', 'Fall', 'Assault', 'Cardiac event', 'Stroke', 'Respiratory illness', 'Poisoning or overdose', 'Fire or burns', 'Obstetric emergency', 'Unknown'];
const CARE_OPTIONS = ['TRAUMA', 'ICU', 'VENTILATOR', 'CARDIOLOGY', 'NEUROLOGY', 'NEUROSURGERY', 'ORTHOPAEDICS', 'BURNS', 'OBSTETRICS', 'PAEDIATRICS', 'NICU', 'PICU', 'CT', 'BLOOD_BANK'];

const CASE_REF = /^CASE-[A-Z0-9][A-Z0-9-]{2,40}$/;
const FIELD_LABEL: Record<string, string> = {
  location: 'Location', severity: 'Severity', reportedSymptoms: 'Symptoms', suspectedCause: 'Suspected cause',
  requiredCapabilities: 'Care needed', notes: 'Notes', caseRef: 'Patient reference', clinical: 'Vital signs or symptom details',
};

/** Capability code → facility capability key, as the eligibility engine reads it (ICU → icu, BLOOD_BANK → bloodBank). */
const capabilityKey = (code: string) => code.toLowerCase().replace(/_([a-z])/g, (g) => g[1].toUpperCase());

interface SubmitState {
  state: 'idle' | 'sending' | 'error';
  message?: string;
  fields?: string[];
}

export function EmergencyIntake({ ambulance, hospitals, location, onLocation, onCancel, onSubmitted, pending }: {
  ambulance: AmbulanceState | null;
  hospitals: HospitalState[];
  location: DraftLocation | null;
  onLocation: (l: DraftLocation | null) => void;
  onCancel: () => void;
  onSubmitted: (caseId: string, assignedHere: boolean) => void;
  pending: { caseId: string; timedOut: boolean } | null;
}) {
  const [step, setStep] = useState<'form' | 'review'>('form');
  const [severity, setSeverity] = useState<Severity | null>(null);
  const [symptoms, setSymptoms] = useState<string[]>([]);
  const [otherSymptom, setOtherSymptom] = useState('');
  const [cause, setCause] = useState('');
  const [care, setCare] = useState<string[]>([]);
  const [caseRef, setCaseRef] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [vitals, setVitals] = useState<VitalsDraft>(emptyVitals);
  const [description, setDescription] = useState('');
  const [onset, setOnset] = useState('');
  const now = useNow(30_000);
  // The time pickers' upper bound, fixed when the form opens (the server checks every time again).
  const [latest] = useState(() => toDateTimeLocal(Date.now() + 60_000));
  const [manual, setManual] = useState<{ lat: string; lng: string } | null>(null);
  const [geo, setGeo] = useState<{ busy: boolean; error?: string }>({ busy: false });
  const [submit, setSubmit] = useState<SubmitState>({ state: 'idle' });
  const [touched, setTouched] = useState(false);
  // One idempotency key per distinct report: a retry of the SAME report reuses it (no duplicate case).
  const sent = useRef<{ key: string; fingerprint: string } | null>(null);

  const listedBy = useMemo(() => {
    const m = new Map<string, number>();
    for (const code of CARE_OPTIONS) m.set(code, hospitals.filter((h) => (h.capabilities as Record<string, boolean | undefined>)?.[capabilityKey(code)]).length);
    return m;
  }, [hospitals]);

  const ref = caseRef.trim().toUpperCase();
  const problems: string[] = [];
  if (!location) problems.push('Choose where the patient is.');
  if (!severity) problems.push('Choose how serious it is.');
  if (symptoms.length === 0) problems.push('Add at least one reported symptom.');
  if (ref && !CASE_REF.test(ref)) problems.push('The patient reference looks like CASE-XXXX.');
  problems.push(...vitalsProblems(vitals));
  const onsetAt = onset ? fromDateTimeLocal(onset) : undefined;
  if (onset && (!onsetAt || Date.parse(onsetAt) > now + 60_000)) problems.push('The symptom onset cannot be in the future.');
  const ready = problems.length === 0;
  const clinicalPart = () => {
    const v = vitalsPayload(vitals);
    const c = { ...v, ...(description.trim() ? { symptomDescription: description.trim() } : {}), ...(onsetAt ? { symptomOnsetAt: onsetAt } : {}) };
    return c.measurements.length || c.unavailable.length || c.symptomDescription || c.symptomOnsetAt ? c : undefined;
  };

  const toggle = (list: string[], set: (v: string[]) => void, v: string) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const addOther = () => {
    const s = otherSymptom.trim().slice(0, 80);
    if (s && !symptoms.some((x) => x.toLowerCase() === s.toLowerCase())) setSymptoms([...symptoms, s]);
    setOtherSymptom('');
  };

  const useDevice = () => {
    if (!('geolocation' in navigator)) {
      setGeo({ busy: false, error: 'This device cannot share its location. Tap the map or enter coordinates.' });
      return;
    }
    setGeo({ busy: true });
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ busy: false });
        onLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracyMeters: Math.round(pos.coords.accuracy), method: 'DEVICE_GPS', source: 'This device' });
      },
      (err) => setGeo({ busy: false, error: err.code === err.PERMISSION_DENIED ? 'Location permission was denied. Tap the map or enter coordinates instead.' : 'Location is unavailable right now. Tap the map or enter coordinates instead.' }),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 },
    );
  };
  const useAmbulancePosition = () => {
    const loc = ambulance?.currentLocation;
    if (!loc) return;
    // The unit's last known position is GPS only if it came from a GPS device; otherwise it counts as entered.
    const gps = ambulance?.locationSource === 'DEVICE_GPS';
    onLocation({ latitude: loc.latitude, longitude: loc.longitude, method: gps ? 'DEVICE_GPS' : 'MANUAL_ENTRY', source: `Ambulance position (${positionSource(ambulance?.locationSource).label.toLowerCase()})${ambulance?.locationAsOf ? ` · ${timeAgo(ambulance.locationAsOf)}` : ''}` });
  };
  const applyManual = () => {
    if (!manual) return;
    const lat = Number(manual.lat);
    const lng = Number(manual.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      setGeo({ busy: false, error: 'Enter a latitude between -90 and 90 and a longitude between -180 and 180.' });
      return;
    }
    setGeo({ busy: false });
    onLocation({ latitude: lat, longitude: lng, method: 'MANUAL_ENTRY', source: 'Entered coordinates' });
    setManual(null);
  };

  const send = async () => {
    if (!location || !severity) return;
    const payload = {
      location: { latitude: location.latitude, longitude: location.longitude, method: location.method, ...(location.accuracyMeters !== undefined ? { accuracyMeters: location.accuracyMeters } : {}), ...(address.trim() ? { address: address.trim() } : {}) },
      severity,
      reportedSymptoms: symptoms,
      ...(cause.trim() ? { suspectedCause: cause.trim() } : {}),
      requiredCapabilities: care,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      ...(ref ? { caseRef: ref } : {}),
      ...(clinicalPart() ? { clinical: clinicalPart() } : {}),
    };
    const fingerprint = JSON.stringify(payload);
    if (!sent.current || sent.current.fingerprint !== fingerprint) sent.current = { key: crypto.randomUUID(), fingerprint };
    setSubmit({ state: 'sending' });
    try {
      const r = await postCommand<{ caseId: string; assignedToThisAmbulance: boolean }>('/api/emergencies', { clientRequestId: sent.current.key, ...payload });
      if (r.status === 202 && r.body.caseId) {
        setSubmit({ state: 'idle' });
        onSubmitted(r.body.caseId, r.body.assignedToThisAmbulance);
        return;
      }
      sent.current = null; // a definite answer: an edited report gets a new key
      const fields = (r.body.issues ?? []).map((i) => i.path.split('.')[0]);
      const err = r.body.error;
      const message =
        err === 'validation_failed' ? `Check: ${[...new Set(fields.map((f) => FIELD_LABEL[f] ?? f))].join(', ')}.`
        : err === 'outside_service_area' ? r.body.message ?? 'The location is outside the service area.'
        : r.body.message ?? `JIVA rejected the report (${r.status}).`;
      setSubmit({ state: 'error', message, fields: err === 'outside_service_area' ? ['location'] : err === 'case_exists' ? ['caseRef'] : fields });
      if (err === 'outside_service_area' || err === 'case_exists' || err === 'validation_failed') setStep('form');
    } catch {
      setSubmit({ state: 'error', message: 'Could not reach JIVA. Your report may not have been received — try again (a retry never creates a duplicate case).' });
    }
  };

  // ---------------------------------------------------------------- confirming / confirmed
  if (pending) {
    return (
      <JivaCard accent={pending.timedOut ? 'warn' : 'ok'} role="status" className="animate-enter">
        <div className="flex items-start gap-3">
          {pending.timedOut ? <Icon name="alertTriangle" size={20} className="mt-0.5 text-warn-700" /> : <Spinner size={20} className="mt-0.5 text-brand-700" />}
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-ink-900">{pending.timedOut ? `Recorded as ${pending.caseId} — not visible here yet` : `Emergency recorded as ${pending.caseId}`}</p>
            <p className="mt-1 text-sm text-ink-600">
              {pending.timedOut
                ? 'JIVA accepted the report but this screen has not received the case yet. Check the connection; it appears here automatically.'
                : 'Confirming with JIVA… the case, care needs and hospital referrals appear here in a moment.'}
            </p>
          </div>
        </div>
      </JivaCard>
    );
  }

  const fieldError = (f: string) => submit.state === 'error' && submit.fields?.includes(f);

  // ---------------------------------------------------------------- review
  if (step === 'review' && location && severity) {
    return (
      <JivaCard accent="danger" className="animate-enter">
        <CardHeader title="Review the emergency" icon="siren" subtitle="Nothing is sent until you submit." level={2} />
        <dl className="mt-3 divide-y divide-ink-100 text-sm">
          <Row label="Location">
            {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
            <span className="block text-xs font-normal text-ink-500">{location.source}{location.accuracyMeters !== undefined ? ` · ±${location.accuracyMeters} m` : ''}{address.trim() ? ` · ${address.trim()}` : ''}</span>
          </Row>
          <Row label="Severity">{SEVERITIES.find((s) => s.value === severity)?.label}</Row>
          <Row label="Reported symptoms">{symptoms.join(', ')}</Row>
          <Row label="Suspected cause">{cause.trim() ? <>{cause.trim()} <span className="text-xs font-normal text-ink-500">(unconfirmed)</span></> : <span className="text-ink-500">Not given</span>}</Row>
          <Row label="Care needed">
            {['Emergency', ...care.map((c) => capabilityLabel(c))].join(', ')}
            <span className="block text-xs font-normal text-ink-500">JIVA may add more from its assessment (ICU for high severity, trauma for injuries).</span>
          </Row>
          <Row label="Patient reference">{ref || <span className="text-ink-500">New — JIVA creates one</span>}</Row>
          {notes.trim() && <Row label="Notes">{notes.trim()}</Row>}
          <Row label="Vital signs">{vitalsSummary(vitals) || <span className="text-ink-500">None recorded</span>}</Row>
          {description.trim() && <Row label="Symptom description">{description.trim()}</Row>}
          {onsetAt && <Row label="Symptoms started">{formatDateTime(onsetAt)}</Row>}
        </dl>
        {submit.state === 'error' && <ErrorBox>{submit.message}</ErrorBox>}
        <div className="mt-4 flex flex-wrap gap-2">
          <JivaButton variant="critical" size="lg" icon="send" loading={submit.state === 'sending'} onClick={() => void send()}>
            {submit.state === 'sending' ? 'Sending…' : submit.state === 'error' ? 'Try again' : 'Submit emergency'}
          </JivaButton>
          <JivaButton variant="ghost" size="lg" disabled={submit.state === 'sending'} onClick={() => setStep('form')}>
            Edit
          </JivaButton>
        </div>
        <p className="mt-2 text-xs text-ink-500">On submit, JIVA opens the case, assigns your ambulance to it and asks the hospitals that list the needed care to accept. Vital signs and the symptom description go only to the case's clinical record (the receiving doctor reads them), not to dispatch.</p>
      </JivaCard>
    );
  }

  // ---------------------------------------------------------------- form
  return (
    <JivaCard accent="danger" className="animate-enter">
      <CardHeader
        title="Report an emergency"
        icon="siren"
        subtitle="Record what you observe. JIVA does not diagnose."
        level={2}
        actions={<JivaButton size="sm" variant="ghost" onClick={onCancel}>Cancel</JivaButton>}
      />

      <form
        className="mt-4 space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          setTouched(true);
          if (ready) {
            setSubmit({ state: 'idle' });
            setStep('review');
          }
        }}
      >
        <fieldset className={cx('space-y-2', fieldError('location') && 'rounded-lg ring-2 ring-danger-300 ring-offset-4')}>
          <legend className="text-sm font-semibold text-ink-900">Where is the patient?</legend>
          <div className="flex flex-wrap gap-2">
            <JivaButton size="sm" icon="crosshair" loading={geo.busy} onClick={useDevice}>This device's location</JivaButton>
            <JivaButton size="sm" icon="ambulance" disabled={!ambulance?.currentLocation} onClick={useAmbulancePosition}>Ambulance position</JivaButton>
            <JivaButton size="sm" icon="pin" variant="ghost" onClick={() => setManual(manual ? null : { lat: '', lng: '' })} aria-expanded={!!manual}>Enter coordinates</JivaButton>
          </div>
          <p className="text-xs text-ink-500">Or tap the map to drop a pin where the patient is.</p>
          {manual && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Latitude"><input inputMode="decimal" value={manual.lat} onChange={(e) => setManual({ ...manual, lat: e.target.value })} className={inputCls} placeholder="12.97" /></Field>
              <Field label="Longitude"><input inputMode="decimal" value={manual.lng} onChange={(e) => setManual({ ...manual, lng: e.target.value })} className={inputCls} placeholder="77.59" /></Field>
              <JivaButton size="sm" onClick={applyManual}>Use these</JivaButton>
            </div>
          )}
          {geo.error && <p role="alert" className="text-[13px] text-danger-700">{geo.error}</p>}
          {location ? (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-ink-25 px-3 py-2 ring-1 ring-inset ring-ink-200">
              <div className="min-w-0 text-[13px]">
                <p className="font-semibold tabular-nums text-ink-900">{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</p>
                <p className="text-xs text-ink-500">{location.source}{location.accuracyMeters !== undefined ? ` · ±${location.accuracyMeters} m` : ''}</p>
              </div>
              <button type="button" onClick={() => onLocation(null)} className="rounded-md p-1 text-ink-500 hover:bg-ink-100" aria-label="Clear location">
                <Icon name="x" size={14} />
              </button>
            </div>
          ) : touched && <p className="text-[13px] text-danger-700">Choose where the patient is.</p>}
          <Field label="Landmark or address (optional)">
            <input value={address} maxLength={200} onChange={(e) => setAddress(e.target.value)} className={cx(inputCls, 'w-full')} placeholder="e.g. Hebbal flyover, near bus stop" />
          </Field>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-ink-900">How serious is it?</legend>
          <div className="grid grid-cols-2 gap-2">
            {SEVERITIES.map((s) => (
              <button
                key={s.value}
                type="button"
                aria-pressed={severity === s.value}
                onClick={() => setSeverity(s.value)}
                className={cx(
                  'rounded-lg px-3 py-2 text-left ring-1 ring-inset transition-colors',
                  severity === s.value ? (s.value === 'CRITICAL' || s.value === 'HIGH' ? 'bg-danger-50 ring-2 ring-danger-500' : 'bg-warn-50 ring-2 ring-warn-500') : 'bg-white ring-ink-200 hover:bg-ink-25',
                )}
              >
                <span className="block text-sm font-semibold text-ink-900">{s.label}</span>
                <span className="block text-xs text-ink-600">{s.hint}</span>
              </button>
            ))}
          </div>
          {touched && !severity && <p className="text-[13px] text-danger-700">Choose how serious it is.</p>}
        </fieldset>

        <fieldset className={cx('space-y-2', fieldError('reportedSymptoms') && 'rounded-lg ring-2 ring-danger-300 ring-offset-4')}>
          <legend className="text-sm font-semibold text-ink-900">Reported symptoms</legend>
          <p className="text-xs text-ink-500">What the patient or bystanders report, or what you observe.</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Common symptoms">
            {[...new Set([...COMMON_SYMPTOMS, ...symptoms])].map((s) => (
              <Chip key={s} on={symptoms.includes(s)} onClick={() => toggle(symptoms, setSymptoms, s)}>{s}</Chip>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={otherSymptom}
              maxLength={80}
              onChange={(e) => setOtherSymptom(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addOther();
                }
              }}
              className={cx(inputCls, 'flex-1')}
              placeholder="Other symptom"
              aria-label="Other symptom"
            />
            <JivaButton size="sm" icon="plus" onClick={addOther} disabled={!otherSymptom.trim()}>Add</JivaButton>
          </div>
          {touched && symptoms.length === 0 && <p className="text-[13px] text-danger-700">Add at least one reported symptom.</p>}
        </fieldset>

        <Field label="Suspected cause (optional, unconfirmed)" hint="Recorded separately from the symptoms. It is never treated as a diagnosis.">
          <input value={cause} maxLength={160} onChange={(e) => setCause(e.target.value)} list="jiva-cause-suggestions" className={cx(inputCls, 'w-full')} placeholder="e.g. Road traffic accident" />
          <datalist id="jiva-cause-suggestions">
            {CAUSE_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
          </datalist>
        </Field>

        <fieldset className="space-y-2">
          <legend className="text-sm font-semibold text-ink-900">Care the patient needs</legend>
          <p className="text-xs text-ink-500">Emergency care is always included. JIVA adds needs from its assessment (ICU for high severity, trauma for injuries) — it never removes yours.</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Care needed">
            {CARE_OPTIONS.map((c) => {
              const n = listedBy.get(c) ?? 0;
              return (
                <Chip key={c} on={care.includes(c)} onClick={() => toggle(care, setCare, c)} title={n ? `Listed by ${n} connected hospital${n === 1 ? '' : 's'}` : 'No connected hospital lists this'}>
                  {capabilityLabel(c)}
                  <span className={cx('ml-1 text-[11px] font-medium', n ? 'opacity-70' : 'text-warn-700')}>{n || 'none'}</span>
                </Chip>
              );
            })}
          </div>
          {care.some((c) => !listedBy.get(c)) && (
            <p className="flex items-start gap-1.5 text-[13px] text-warn-800">
              <Icon name="alertTriangle" size={14} className="mt-0.5 shrink-0" />
              No connected hospital lists {care.filter((c) => !listedBy.get(c)).map((c) => capabilityLabel(c)).join(', ')}. JIVA cannot send a referral that requires it — call ahead if the patient needs it.
            </p>
          )}
        </fieldset>

        <fieldset className={cx('space-y-2', fieldError('clinical') && 'rounded-lg ring-2 ring-danger-300 ring-offset-4')}>
          <legend className="text-sm font-semibold text-ink-900">Vital signs and symptom details (optional)</legend>
          <p className="text-xs text-ink-500">For the receiving doctor. Typed in by you — no monitor is connected to JIVA. They are not used to choose the hospital.</p>
          <VitalsFields value={vitals} onChange={setVitals} idPrefix="intake" />
          <Field label="Describe the symptoms (optional)">
            <textarea value={description} maxLength={1000} onChange={(e) => setDescription(e.target.value)} rows={3} className={cx(inputCls, 'h-auto w-full py-2')} placeholder="What the patient or bystanders report, and what you see" />
          </Field>
          <Field label="When did the symptoms start? (optional)">
            <input type="datetime-local" value={onset} max={latest} onChange={(e) => setOnset(e.target.value)} className={cx(inputCls, 'w-full')} />
          </Field>
        </fieldset>

        <Field label="Patient reference (optional)" hint="Only if the patient shows you their JIVA case reference. Leave empty and JIVA creates one. No names or ID numbers.">
          <input value={caseRef} maxLength={45} onChange={(e) => setCaseRef(e.target.value)} className={cx(inputCls, 'w-full font-mono uppercase', fieldError('caseRef') && 'ring-2 ring-danger-400')} placeholder="CASE-…" autoCapitalize="characters" />
        </Field>

        <Field label="Notes for the receiving hospital (optional)">
          <textarea value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} rows={3} className={cx(inputCls, 'h-auto w-full py-2')} placeholder="e.g. Conscious, oriented; tourniquet applied 10:42" />
        </Field>

        {submit.state === 'error' && <ErrorBox>{submit.message}</ErrorBox>}
        {touched && !ready && (
          <ul role="alert" className="space-y-0.5 text-[13px] text-danger-700">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <JivaButton type="submit" variant="primary" size="lg" iconRight="arrowRight">Review</JivaButton>
          <JivaButton variant="ghost" size="lg" onClick={onCancel}>Cancel</JivaButton>
        </div>
      </form>
    </JivaCard>
  );
}

const inputCls = 'h-9 rounded-lg bg-white px-2.5 text-sm text-ink-900 ring-1 ring-inset ring-ink-300 transition-shadow duration-150 placeholder:text-ink-400 hover:ring-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-600';

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-semibold text-ink-900">{label}</span>
      {hint && <span className="block text-xs text-ink-500">{hint}</span>}
      {children}
    </label>
  );
}

function Chip({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      onClick={onClick}
      className={cx(
        'inline-flex h-8 items-center gap-1 rounded-full px-3 text-[13px] font-semibold transition-colors',
        on ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
      )}
    >
      {on && <Icon name="check" size={13} strokeWidth={2.4} />}
      {children}
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="shrink-0 text-ink-500">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink-900">{children}</dd>
    </div>
  );
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger-700 ring-1 ring-inset ring-danger-200">
      <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

