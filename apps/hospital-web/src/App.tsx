import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import {
  AppHeader,
  AsyncButton,
  CardHeader,
  ConnectionPill,
  DemoBadge,
  EmptyState,
  Icon,
  JivaBadge,
  JivaBreadcrumbs,
  JivaButton,
  JivaCard,
  JivaModal,
  JivaStatus,
  JivaTimeline,
  PersonaSelect,
  SkeletonRows,
  TechnicalDetails,
  acceptanceStatus,
  ambulanceStatus,
  capabilityLabel,
  capabilityStatus,
  cx,
  dataStatus,
  describeEvent,
  eventTechnicalFields,
  formatClock,
  formatCountdown,
  formatKm,
  hospitalShortName,
  minutesFromSeconds,
  msUntil,
  timeAgo,
  timeUntil,
  useNow,
  useToast,
  type JivaEvent,
  type TimelineItem,
} from '@jiva/ui/src';
import { PERSONA, sendEvent } from './api';
import { useHospital, type AcceptanceRequest } from './useHospital';
import { ArrivalByReference, DepartmentSection, RecordArrivalButton } from './Department';

type Decision = 'ACCEPTED' | 'LIMITED' | 'REJECTED' | 'UNAVAILABLE';

interface Confirmation {
  requestId: string;
  caseId: string;
  status: Decision;
  at: string;
  validUntil: string;
  limitations: string[];
}

const LIMIT_REASONS = ['ICU capacity limited', 'Surgical stabilisation only', 'Specialist on call, arriving later', 'Imaging (CT) unavailable'];
const DECLINE_REASONS = ['Trauma service unavailable', 'No ICU bed', 'Emergency department at capacity'];
const UNAVAILABLE_REASONS = ['Emergency department full', 'Critical equipment out of service', 'Mass-casualty incident in progress'];
const VALIDITY_MIN = 30;

const PERSONAS = [
  { value: 'demo-hosp-1', label: 'Hebbal (demo-hosp-1)' },
  { value: 'demo-hosp-2', label: 'Whitefield (demo-hosp-2)' },
  { value: 'demo-hosp-3', label: 'Koramangala (demo-hosp-3)' },
  { value: 'demo-hosp-4', label: 'Indiranagar (demo-hosp-4)' },
];

const routeOf = (a?: AmbulanceState) => (a?.activeRoute && a.activeRoute.hospitalId === a.destinationHospital ? a.activeRoute : undefined);

export default function App() {
  const toast = useToast();
  const requestsRef = useRef<HTMLElement | null>(null);
  const [confirmations, setConfirmations] = useState<Confirmation[]>([]);
  const [confirmUnavailable, setConfirmUnavailable] = useState(false);
  const hospitalIdRef = useRef('');

  const onLive = useCallback(
    (e: JivaEvent) => {
      const me = hospitalIdRef.current;
      const p = e.payload;
      if (e.eventType === 'demo.reset') {
        setConfirmations([]);
        toast.show({ title: 'Demo reset', description: 'All demo state was cleared.', icon: 'refresh', groupKey: 'reset' });
      } else if (e.eventType === 'hospital.acceptance.requested') {
        toast.show({
          title: 'New emergency request',
          description: `${String(p.caseId)} · answer by ${formatClock(String(p.expiresAt))}`,
          tone: 'warn',
          icon: 'siren',
          groupKey: 'request',
          durationMs: 9000,
          action: { label: 'Review request', onClick: () => requestsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }) },
        });
      } else if (e.eventType === 'destination.changed' && p.hospitalId === me) {
        toast.show({ title: `${String(p.ambulanceId)} is heading here`, description: 'An ambulance was routed to your hospital.', tone: 'ok', icon: 'ambulance', groupKey: `dest:${String(p.ambulanceId)}` });
      } else if (e.eventType === 'route.recalculated' && p.oldHospitalId === me && p.newHospitalId !== me) {
        toast.show({ title: `${String(p.ambulanceId)} rerouted elsewhere`, description: 'It is no longer heading to your hospital.', tone: 'warn', icon: 'route', groupKey: `dest:${String(p.ambulanceId)}` });
      } else if (e.eventType === 'ambulance.arrived' && p.hospitalId === me && p.basis !== 'HOSPITAL_CONFIRMED') {
        toast.show({ title: `${String(p.ambulanceId)} is at your hospital`, description: `GPS places ${String(p.caseId ?? 'the patient')} at your hospital. Record the arrival when the patient is with your team.`, tone: 'ok', icon: 'pin', groupKey: `arr:${String(p.caseId ?? p.ambulanceId)}` });
      } else if (e.eventType === 'encounter.arrival.recorded' && p.hospitalId === me) {
        toast.show({ title: `Arrival recorded · ${String(p.caseId)}`, description: 'Record the handover when the crew hands the patient over.', tone: 'ok', icon: 'hospital', groupKey: `arr:${String(p.caseId)}` });
      } else if (e.eventType === 'encounter.handover.recorded' && p.hospitalId === me) {
        toast.show({ title: `${String(p.caseId)} is in your care`, description: 'Handover recorded; the crew is released.', tone: 'ok', icon: 'stethoscope', groupKey: `arr:${String(p.caseId)}` });
      } else if (e.eventType === 'encounter.doctor.assigned' && p.hospitalId === me) {
        toast.show({ title: `Doctor ${p.previousPractitionerId ? 'changed' : 'assigned'} · ${String(p.caseId)}`, tone: 'ok', icon: 'user', groupKey: `doc:${String(p.caseId)}` });
      }
    },
    [toast],
  );

  const hs = useHospital(onLive);
  useEffect(() => {
    hospitalIdRef.current = hs.hospitalId;
  }, [hs.hospitalId]);
  const now = useNow(1000);

  const open = hs.requests.filter((r) => !confirmations.some((c) => c.requestId === r.requestId));
  useEffect(() => {
    document.title = open.length ? `(${open.length}) New request · JIVA Hospital` : 'JIVA · Hospital';
  }, [open.length]);

  const patientById = useMemo(() => new Map(hs.patients.map((p) => [p.patientId, p])), [hs.patients]);
  // Once the arrival is recorded, the patient moves from "on the way" to "in your department".
  const encounterCases = useMemo(() => new Set(hs.encounters.map((e) => e.caseId)), [hs.encounters]);
  const incoming = hs.ambulances.filter((a) => a.destinationHospital === hs.hospitalId && !(a.assignedPatient && encounterCases.has(a.assignedPatient)));
  const handoffs = hs.events.filter((e) => e.eventType === 'ai.handoff.generated');
  const recentAnswers = hs.events.filter((e) => e.eventType === 'hospital.acceptance.received');
  const names = useMemo(() => new Map(hs.hospitals.map((h) => [h.hospitalId, hospitalShortName(h.displayName, h.address?.locality)])), [hs.hospitals]);
  const name = useCallback((id: string) => names.get(id), [names]);

  const respond = async (req: AcceptanceRequest, status: Decision, limitations: string[]) => {
    const respondedAt = new Date().toISOString();
    const validUntil = new Date(Date.now() + VALIDITY_MIN * 60000).toISOString();
    const error = await sendEvent({
      eventId: crypto.randomUUID(),
      eventType: 'hospital.acceptance.received',
      timestamp: respondedAt,
      source: { type: 'hospital', id: hs.hospitalId },
      version: '1.0',
      payload: {
        responseId: `RESP-${crypto.randomUUID().substring(0, 8)}`,
        requestId: req.requestId,
        caseId: req.caseId,
        hospitalId: hs.hospitalId,
        status,
        acceptedCapabilities: status === 'REJECTED' || status === 'UNAVAILABLE' ? [] : req.requiredCapabilities,
        limitations,
        respondedAt,
        validUntil,
        responderRole: 'CLINICAL_COORDINATOR',
        source: 'SYNTHETIC_DEMO',
      },
    });
    if (!error) {
      setConfirmations((prev) => [{ requestId: req.requestId, caseId: req.caseId, status, at: respondedAt, validUntil, limitations }, ...prev].slice(0, 6));
      void hs.refresh();
    }
    return error;
  };

  const reportCapacity = async (status: 'AVAILABLE' | 'UNAVAILABLE') => {
    const error = await sendEvent({
      eventId: crypto.randomUUID(),
      eventType: 'hospital.capacity.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: hs.hospitalId },
      version: '1.0',
      payload: { hospitalId: hs.hospitalId, emergencyStatus: status, traumaStatus: status, icuStatus: status, ventilatorStatus: 'UNKNOWN' },
      metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO' },
    });
    if (!error) void hs.refresh();
    return error;
  };

  const short = hs.hospital ? hospitalShortName(hs.hospital.displayName, hs.hospital.address?.locality) : '';
  const visibleConfirmations = confirmations.filter((c) => now - Date.parse(c.at) < 45_000);

  return (
    <div className="min-h-dvh">
      <AppHeader
        app="Emergency department"
        context={hs.hospital?.displayName ?? (hs.loaded ? 'Unknown hospital' : 'Loading…')}
        actions={
          <>
            <PersonaSelect value={PERSONA} options={PERSONAS} />
            <ConnectionPill state={hs.connection} lastSync={hs.lastSync} />
            <DemoBadge detail="Simulated hospital: responses you send here are demo data, not real capacity." />
          </>
        }
      />

      {hs.error && (
        <div role="alert" className="flex items-center gap-2 border-b border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger-700 lg:px-6">
          <Icon name="alertCircle" size={16} />
          <span className="flex-1">{hs.error}</span>
          <JivaButton size="sm" variant="danger-soft" icon="refresh" onClick={() => void hs.refresh()}>
            Try again
          </JivaButton>
        </div>
      )}

      <StatusStrip hospital={hs.hospital} now={now} onUnavailable={() => setConfirmUnavailable(true)} onAvailable={() => reportCapacity('AVAILABLE')} />

      <main id="main" className="mx-auto grid max-w-[1400px] gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:px-6">
        <div className="min-w-0 space-y-8">
          <section ref={requestsRef} aria-labelledby="requests-title" className="scroll-mt-20 space-y-3">
            <div className="flex items-center gap-2">
              <h2 id="requests-title" className="text-lg font-semibold tracking-[-0.01em] text-ink-900">
                Incoming emergency requests
              </h2>
              {open.length > 0 && (
                <JivaBadge tone="warn" icon="clock">
                  {open.length} awaiting your answer
                </JivaBadge>
              )}
            </div>
            {visibleConfirmations.map((c) => (
              <ConfirmationCard key={c.requestId} c={c} hospitalId={hs.hospitalId} hospital={hs.hospital} ambulances={hs.ambulances} now={now} />
            ))}
            {!hs.loaded ? (
              <JivaCard>
                <SkeletonRows rows={2} />
              </JivaCard>
            ) : open.length === 0 ? (
              visibleConfirmations.length === 0 && (
                <JivaCard className="border-dashed">
                  <EmptyState
                    icon="checkCircle"
                    title="No open requests"
                    description={`When JIVA needs a hospital for a patient whose care ${short || 'your hospital'} lists, the request appears here with a response deadline. Each answer is valid for ${VALIDITY_MIN} minutes.`}
                  />
                </JivaCard>
              )
            ) : (
              open.map((r) => <RequestCard key={r.requestId} req={r} patient={patientById.get(r.caseId)} now={now} onRespond={respond} />)
            )}
          </section>

          <section aria-labelledby="incoming-title" className="space-y-3">
            <h2 id="incoming-title" className="text-lg font-semibold tracking-[-0.01em] text-ink-900">
              Patients on the way
            </h2>
            {incoming.length === 0 ? (
              <p className="text-sm text-ink-500">No ambulance is routed to your hospital right now. Patients appear here once JIVA assigns your hospital as their destination.</p>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {incoming.map((a) => (
                  <li key={a.ambulanceId}>
                    <IncomingCard
                      a={a}
                      patient={a.assignedPatient ? patientById.get(a.assignedPatient) : undefined}
                      now={now}
                      hasBrief={handoffs.some((h) => h.payload.patientId === a.assignedPatient)}
                      action={a.assignedPatient ? <RecordArrivalButton hospitalId={hs.hospitalId} caseId={a.assignedPatient} ambulanceId={a.ambulanceId} gpsArrived={a.status === 'ARRIVED'} onDone={() => void hs.refresh()} /> : undefined}
                    />
                  </li>
                ))}
              </ul>
            )}
            {hs.hospitalId && <ArrivalByReference hospitalId={hs.hospitalId} onDone={() => void hs.refresh()} />}
          </section>

          <DepartmentSection encounters={hs.encounters} patients={patientById} roster={hs.roster} now={now} onChanged={() => void hs.refresh()} />

          <section aria-labelledby="answers-title" className="space-y-3">
            <h2 id="answers-title" className="text-lg font-semibold tracking-[-0.01em] text-ink-900">
              Your recent answers
            </h2>
            {recentAnswers.length === 0 ? (
              <p className="text-sm text-ink-500">Answers sent for your hospital — from this screen or from the demo controls — are listed here.</p>
            ) : (
              <ul className="divide-y divide-ink-100 rounded-xl bg-white ring-1 ring-ink-200">
                {recentAnswers.slice(0, 8).map((e) => {
                  const p = e.payload;
                  const status = String(p.status);
                  const valid = typeof p.validUntil === 'string' ? p.validUntil : undefined;
                  const lim = Array.isArray(p.limitations) ? (p.limitations as string[]) : [];
                  return (
                    <li key={e.eventId} className="flex items-start justify-between gap-3 px-4 py-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink-900">{String(p.caseId)}</p>
                        <p className="text-xs text-ink-500">
                          {formatClock(e.timestamp)} · {timeAgo(e.timestamp, now)}
                          {lim.length ? ` · ${lim.join('; ')}` : ''}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-1">
                        <JivaStatus meta={acceptanceStatus(status)} />
                        {valid && (status === 'ACCEPTED' || status === 'LIMITED') && (
                          <span className="text-xs text-ink-500">{msUntil(valid, now) > 0 ? `valid ${timeUntil(valid, now)}` : 'expired'}</span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className="min-w-0 space-y-6" aria-label="Hospital status and briefs">
          <FacilityPanel hospital={hs.hospital} />
          <HandoffPanel handoffs={handoffs} />
          <ActivityPanel events={hs.events} name={name} />
        </aside>
      </main>

      <JivaModal
        open={confirmUnavailable}
        onClose={() => setConfirmUnavailable(false)}
        title="Report the emergency department unavailable?"
        icon="ban"
        tone="danger"
        description={
          <>
            Ambulances heading to {short || 'your hospital'} that need emergency, trauma or intensive care will be <strong>rerouted to another accepting hospital</strong>, and JIVA stops asking you about new cases until you report available again.
          </>
        }
        actions={
          <>
            <JivaButton onClick={() => setConfirmUnavailable(false)}>Cancel</JivaButton>
            <AsyncButton
              variant="danger"
              icon="ban"
              pendingText="Reporting…"
              onAction={async () => {
                const err = await reportCapacity('UNAVAILABLE');
                if (!err) setConfirmUnavailable(false);
                return err;
              }}
            >
              Report ED unavailable
            </AsyncButton>
          </>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------------ status strip */

function StatusStrip({ hospital, now, onUnavailable, onAvailable }: { hospital: HospitalState | null; now: number; onUnavailable: () => void; onAvailable: () => Promise<string | null> }) {
  const op = hospital?.operationalState;
  const acc = acceptanceStatus(op?.acceptance);
  const live = op?.acceptance === 'ACCEPTED' || op?.acceptance === 'LIMITED';
  return (
    <section aria-label="Current status" className="border-b border-ink-200 bg-white">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 lg:px-6">
        {(['emergency', 'icu', 'trauma'] as const).map((k) => (
          <div key={k} className="flex items-center gap-2">
            <span className="text-[13px] text-ink-500">{k === 'emergency' ? 'Emergency dept' : k === 'icu' ? 'ICU' : 'Trauma'}</span>
            <JivaStatus meta={capabilityStatus(op?.[k])} />
          </div>
        ))}
        <span className="hidden h-6 w-px bg-ink-200 md:block" aria-hidden="true" />
        <div className="flex items-center gap-2">
          <span className="text-[13px] text-ink-500">Your current answer</span>
          <JivaStatus meta={acc} suffix={op?.acceptanceCaseId && op.acceptance !== 'UNKNOWN' ? ` · ${op.acceptanceCaseId}` : undefined} />
          {live && op?.expiresAt && <span className="text-xs text-ink-500">valid {timeUntil(op.expiresAt, now)}</span>}
        </div>
        <p className="text-xs text-ink-500">{op?.capacityAsOf ? `Status reported ${timeAgo(op.capacityAsOf, now)}` : 'Seed status — not a live report'}</p>
        <div className="ml-auto flex gap-2">
          {op?.emergency === 'UNAVAILABLE' ? (
            <AsyncButton size="sm" variant="ok-soft" icon="checkCircle" pendingText="Reporting…" onAction={onAvailable}>
              Report ED available
            </AsyncButton>
          ) : (
            <>
              <JivaButton size="sm" variant="danger-soft" icon="ban" onClick={onUnavailable}>
                Report ED unavailable
              </JivaButton>
              <AsyncButton size="sm" variant="secondary" icon="checkCircle" pendingText="Reporting…" onAction={onAvailable}>
                Report ED available
              </AsyncButton>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ request card */

function RequestCard({ req, patient, now, onRespond }: { req: AcceptanceRequest; patient?: PatientState; now: number; onRespond: (r: AcceptanceRequest, s: Decision, l: string[]) => Promise<string | null> }) {
  const [mode, setMode] = useState<'choose' | 'limited' | 'rejected' | 'unavailable'>('choose');
  const [reasons, setReasons] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const left = msUntil(req.expiresAt, now);
  const total = Math.max(1, Date.parse(req.expiresAt) - Date.parse(req.requestedAt));
  const expired = left <= 0;
  const urgent = left > 0 && left < 2 * 60_000;

  const REASONS = { limited: LIMIT_REASONS, rejected: DECLINE_REASONS, unavailable: UNAVAILABLE_REASONS } as const;
  const pick = (m: 'limited' | 'rejected' | 'unavailable') => {
    setMode(m);
    setReasons([REASONS[m][0]]);
    setError(null);
  };
  const send = (status: Decision, limitations: string[]) => async () => {
    const err = await onRespond(req, status, limitations);
    setError(err);
    return err;
  };

  return (
    <JivaCard as="article" padded={false} accent={expired ? 'neutral' : 'warn'} className="animate-enter overflow-hidden" aria-labelledby={`req-${req.requestId}`}>
      <div className="h-1 bg-ink-100" aria-hidden="true">
        <div className={cx('h-full transition-[width] duration-1000 ease-linear', expired ? 'bg-ink-300' : urgent ? 'bg-danger-500' : 'bg-warn-500')} style={{ width: `${Math.max(0, Math.min(100, (left / total) * 100))}%` }} />
      </div>
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-warn-700">
              <Icon name="siren" size={15} />
              New emergency request
            </p>
            <h3 id={`req-${req.requestId}`} className="mt-0.5 text-xl font-semibold tracking-[-0.01em] text-ink-900">
              {req.caseId}
            </h3>
            <p className="text-xs text-ink-500">Referral {req.requestId} · your answer is tied to this case only</p>
          </div>
          <div className={cx('rounded-xl px-3 py-2 text-right ring-1 ring-inset', expired ? 'bg-ink-50 ring-ink-200' : urgent ? 'bg-danger-50 ring-danger-200' : 'bg-warn-50 ring-warn-200')} role="timer" aria-live="off">
            <p className={cx('text-xs font-semibold', expired ? 'text-ink-600' : urgent ? 'text-danger-700' : 'text-warn-800')}>{expired ? 'Response window closed' : 'Answer within'}</p>
            <p className={cx('text-2xl font-semibold tabular-nums leading-7', expired ? 'text-ink-500' : urgent ? 'text-danger-700' : 'text-warn-800')}>{expired ? formatClock(req.expiresAt) : formatCountdown(left)}</p>
          </div>
        </div>

        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold text-ink-500">Reported condition</dt>
            <dd className="mt-0.5 text-[15px] font-medium text-ink-900">{patient?.activeConditions.join(', ') || 'Not shared with this hospital'}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold text-ink-500">Ambulance ETA</dt>
            <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-ink-900">{req.ambulanceEtaMinutes !== undefined ? `≈ ${req.ambulanceEtaMinutes} min` : 'Not known yet'}</dd>
            <dd className="text-xs text-ink-500">estimate, demo routing</dd>
          </div>
          <div className="sm:col-span-3">
            <dt className="text-xs font-semibold text-ink-500">Required care</dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              {req.requiredCapabilities.map((c) => (
                <span key={c} className="rounded-lg bg-ink-50 px-2 py-1 text-[13px] font-semibold text-ink-800 ring-1 ring-inset ring-ink-200">
                  {capabilityLabel(c)}
                </span>
              ))}
            </dd>
          </div>
        </dl>

        <div className="mt-5 border-t border-ink-100 pt-4">
          {mode === 'choose' ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <AsyncButton size="lg" variant="primary" icon="checkCircle" disabled={expired} pendingText="Sending…" onAction={send('ACCEPTED', [])}>
                  Accept
                </AsyncButton>
                <JivaButton size="lg" variant="warn-soft" icon="half" disabled={expired} onClick={() => pick('limited')}>
                  Accept with limits
                </JivaButton>
                <JivaButton size="lg" variant="danger-soft" icon="xCircle" disabled={expired} onClick={() => pick('rejected')}>
                  Decline
                </JivaButton>
              </div>
              <p className="mt-2.5 text-xs text-ink-500">
                {expired
                  ? 'This request expired without an answer. JIVA treats your hospital as unknown for this case.'
                  : `Accepting lets JIVA route the ambulance to you. Answers are valid for ${VALIDITY_MIN} minutes.`}
              </p>
              {!expired && (
                <button type="button" onClick={() => pick('unavailable')} className="mt-1.5 text-xs font-semibold text-danger-700 hover:underline">
                  Can't take any patient right now?
                </button>
              )}
            </>
          ) : (
            <div className="animate-fade space-y-3">
              <p className="text-sm font-semibold text-ink-900">{mode === 'limited' ? 'Which limits apply?' : mode === 'unavailable' ? 'Why can\'t you take any patient?' : 'Why are you declining?'}</p>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={mode === 'limited' ? 'Limits' : 'Reasons'}>
                {REASONS[mode].map((r) => {
                  const on = reasons.includes(r);
                  return (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setReasons((prev) => (on ? prev.filter((x) => x !== r) : [...prev, r]))}
                      className={cx(
                        'inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold transition-colors',
                        on ? 'bg-ink-900 text-white' : 'bg-white text-ink-700 ring-1 ring-inset ring-ink-200 hover:bg-ink-50',
                      )}
                    >
                      {on && <Icon name="check" size={13} strokeWidth={2.4} />}
                      {r}
                    </button>
                  );
                })}
              </div>
              <p className={cx('text-xs', mode === 'unavailable' ? 'font-semibold text-danger-700' : 'text-ink-500')}>
                {mode === 'limited'
                  ? 'Hospitals that accept fully are preferred; your limits are shown to the coordinating team.'
                  : mode === 'unavailable'
                    ? `This tells JIVA your hospital cannot take ANY new patient for the next ${VALIDITY_MIN} minutes: every ambulance heading here is rerouted and JIVA stops asking you until then.`
                    : 'JIVA will ask other hospitals. If an ambulance is heading here for this case, it is rerouted.'}
              </p>
              <div className="flex flex-wrap gap-2">
                <AsyncButton
                  variant={mode === 'limited' ? 'primary' : 'danger'}
                  icon={mode === 'limited' ? 'half' : mode === 'unavailable' ? 'ban' : 'xCircle'}
                  disabled={reasons.length === 0 || expired}
                  pendingText="Sending…"
                  onAction={send(mode === 'limited' ? 'LIMITED' : mode === 'unavailable' ? 'UNAVAILABLE' : 'REJECTED', reasons)}
                >
                  {mode === 'limited' ? 'Send limited acceptance' : mode === 'unavailable' ? 'Report unable to take patients' : 'Send decline'}
                </AsyncButton>
                <JivaButton variant="ghost" onClick={() => setMode('choose')}>
                  Back
                </JivaButton>
              </div>
            </div>
          )}
          {error && (
            <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg bg-danger-50 px-3 py-2 text-[13px] text-danger-700 ring-1 ring-inset ring-danger-200">
              <Icon name="alertCircle" size={15} className="mt-0.5 shrink-0" />
              <span>
                <strong className="font-semibold">Hospital response could not be submitted.</strong> {error} Use the buttons above to try again.
              </span>
            </div>
          )}
        </div>
      </div>
    </JivaCard>
  );
}

/** Cause → effect: what happened after this hospital answered. */
const VERB: Record<Decision, string> = { ACCEPTED: 'accepted', LIMITED: 'accepted with limits', REJECTED: 'declined', UNAVAILABLE: 'reported unable to take patients' };

function ConfirmationCard({ c, hospitalId, hospital, ambulances, now }: { c: Confirmation; hospitalId: string; hospital: HospitalState | null; ambulances: AmbulanceState[]; now: number }) {
  const meta = acceptanceStatus(c.status);
  const routed = ambulances.find((a) => a.assignedPatient === c.caseId && a.destinationHospital === hospitalId);
  const route = routeOf(routed);
  const effect =
    c.status === 'UNAVAILABLE'
      ? `JIVA reroutes ambulances heading here and stops asking you for ${VALIDITY_MIN} minutes.`
      : c.status === 'REJECTED'
      ? 'JIVA is offering this case to other hospitals.'
      : hospital?.operationalState.emergency === 'UNAVAILABLE'
        ? 'Your emergency department is reported unavailable, so JIVA routes this patient elsewhere.'
        : routed
        ? `${routed.ambulanceId} is now heading here${route ? ` · ${minutesFromSeconds(route.durationSeconds)} min` : ''}.`
        : c.status === 'LIMITED'
          ? 'Recorded. Hospitals that accept fully are preferred for routing.'
          : 'Recorded. JIVA routes the ambulance here if you are the best eligible option.';
  return (
    <JivaCard as="article" accent={meta.tone} className="animate-enter">
      <div className="flex flex-wrap items-center gap-2">
        <JivaStatus meta={meta} size="md" />
        <p className="text-sm font-semibold text-ink-900">
          {c.caseId} · {VERB[c.status]} at {formatClock(c.at)}
        </p>
        <span className="ml-auto text-xs text-ink-500">{timeAgo(c.at, now)}</span>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-sm text-ink-700">
        <Icon name={routed ? 'ambulance' : c.status === 'REJECTED' || c.status === 'UNAVAILABLE' ? 'route' : 'info'} size={15} className="shrink-0 text-ink-500" />
        {effect}
      </p>
      {c.status !== 'REJECTED' && <p className="mt-1 text-xs text-ink-500">Valid until {formatClock(c.validUntil)}{c.limitations.length ? ` · ${c.status === 'UNAVAILABLE' ? 'reason' : 'limits'}: ${c.limitations.join('; ')}` : ''}</p>}
    </JivaCard>
  );
}

function IncomingCard({ a, patient, now, hasBrief, action }: { a: AmbulanceState; patient?: PatientState; now: number; hasBrief: boolean; action?: ReactNode }) {
  const route = routeOf(a);
  const arrived = a.status === 'ARRIVED';
  return (
    <JivaCard as="article" accent={arrived ? 'ok' : 'neutral'} className="h-full">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink-900">{a.assignedPatient ?? 'Unassigned'}</p>
          <p className="text-[13px] text-ink-700">{patient?.activeConditions.join(', ') || 'Condition not shared'}</p>
        </div>
        <JivaStatus meta={ambulanceStatus(a.status)} />
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs text-ink-500">{arrived ? 'At your hospital (GPS)' : 'Arrives in'}</p>
          <p className="text-2xl font-semibold tabular-nums tracking-[-0.02em] text-ink-900">{arrived ? 'Now' : route ? `${minutesFromSeconds(route.durationSeconds)} min` : '—'}</p>
        </div>
        <div className="text-right text-xs text-ink-500">
          <p className="font-semibold text-ink-700">{a.ambulanceId}</p>
          <p>{route ? `${formatKm(route.distanceMeters)}${route.synthetic ? ' · synthetic route' : ''}` : 'Route pending'}</p>
          <p>{a.locationAsOf ? `GPS ${timeAgo(a.locationAsOf, now)}` : 'No GPS fix yet'}</p>
        </div>
      </div>
      {patient && patient.careRequirements.length > 0 && <p className="mt-2 text-xs text-ink-600">Needs: {patient.careRequirements.map((c) => capabilityLabel(c)).join(', ')}</p>}
      {hasBrief && (
        <p className="mt-2 flex items-center gap-1 text-xs font-semibold text-ink-600">
          <Icon name="brief" size={13} /> Handoff brief available below
        </p>
      )}
      {action ? (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-ink-100 pt-3">
          <span className="text-xs text-ink-500">{arrived ? 'GPS is evidence only — confirm the arrival.' : 'When the patient reaches your department:'}</span>
          {action}
        </div>
      ) : null}
    </JivaCard>
  );
}

/* ------------------------------------------------------------------ side panels */

const SERVICES = [
  { key: 'emergency', label: 'Emergency department' },
  { key: 'icu', label: 'Intensive care (ICU)' },
  { key: 'trauma', label: 'Trauma' },
  { key: 'nicu', label: 'Newborn ICU' },
  { key: 'picu', label: "Children's ICU" },
  { key: 'ventilator', label: 'Ventilators' },
] as const;

function FacilityPanel({ hospital }: { hospital: HospitalState | null }) {
  const [service, setService] = useState<(typeof SERVICES)[number] | null>(null);
  if (!hospital) {
    return (
      <JivaCard>
        <SkeletonRows rows={3} />
      </JivaCard>
    );
  }
  const op = hospital.operationalState;
  const short = hospitalShortName(hospital.displayName, hospital.address?.locality);
  return (
    <JivaCard>
      <CardHeader
        title="Facility"
        icon="building"
        subtitle={<JivaBreadcrumbs items={service ? [{ label: short, onClick: () => setService(null) }, { label: service.label }] : [{ label: short }]} />}
        actions={<JivaStatus meta={dataStatus(hospital.dataStatus)} />}
      />
      {service ? (
        <div className="mt-3 animate-fade space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink-900">{service.label}</p>
            <JivaStatus meta={capabilityStatus(op[service.key])} size="md" />
          </div>
          <dl className="space-y-1 text-[13px]">
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">Listed in directory</dt>
              <dd className="font-medium text-ink-900">{hospital.capabilities?.[service.key] ? 'Yes' : hospital.capabilities?.[service.key] === false ? 'No' : 'Not listed'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">Last reported</dt>
              <dd className="font-medium text-ink-900">{op.capacityAsOf ? formatClock(op.capacityAsOf) : 'Seed value'}</dd>
            </div>
          </dl>
          <p className="rounded-lg bg-ink-50 p-3 text-xs text-ink-600 ring-1 ring-inset ring-ink-200">
            Wards, rooms and beds stay inside your hospital systems. JIVA only receives service-level flags and your answers to requests — by design.
          </p>
          <JivaButton size="sm" variant="ghost" icon="chevronLeft" onClick={() => setService(null)}>
            All services
          </JivaButton>
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-ink-100">
          {SERVICES.map((s) => (
            <li key={s.key}>
              <button type="button" onClick={() => setService(s)} className="flex w-full items-center justify-between gap-3 py-2.5 text-left hover:bg-ink-25">
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold text-ink-900">{s.label}</span>
                  <span className="block text-xs text-ink-500">{hospital.capabilities?.[s.key] ? 'Listed' : 'Not listed'}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <JivaStatus meta={capabilityStatus(op[s.key])} />
                  <Icon name="chevronRight" size={14} className="text-ink-400" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </JivaCard>
  );
}

function HandoffPanel({ handoffs }: { handoffs: JivaEvent[] }) {
  return (
    <JivaCard>
      <CardHeader title="Handoff briefs" icon="brief" subtitle="AI-generated · advisory only" />
      {handoffs.length === 0 ? (
        <p className="mt-3 text-[13px] text-ink-500">A brief appears here when a patient is routed to your hospital.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {handoffs.slice(0, 4).map((h) => {
            const p = h.payload;
            const alerts = Array.isArray(p.criticalAlerts) ? (p.criticalAlerts as string[]) : [];
            const preps = Array.isArray(p.recommendedPreparations) ? (p.recommendedPreparations as string[]) : [];
            return (
              <li key={h.eventId} className="rounded-xl bg-ink-25 p-3 ring-1 ring-inset ring-ink-200">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[13px] font-semibold text-ink-900">{String(p.patientId)}</p>
                  <span className="text-xs text-ink-500">{formatClock(h.timestamp)}</span>
                </div>
                <p className="mt-1 text-[13px] text-ink-700">{String(p.summary ?? '')}</p>
                {alerts.length > 0 && (
                  <ul className="mt-2 space-y-0.5 text-xs text-danger-700">
                    {alerts.map((a) => (
                      <li key={a} className="flex items-center gap-1">
                        <Icon name="alertTriangle" size={12} />
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
                {preps.length > 0 && (
                  <ul className="mt-1.5 space-y-0.5 text-xs text-ink-700">
                    {preps.map((a) => (
                      <li key={a} className="flex items-center gap-1">
                        <Icon name="check" size={12} />
                        {a}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </JivaCard>
  );
}

function ActivityPanel({ events, name }: { events: JivaEvent[]; name: (id: string) => string | undefined }) {
  const items = useMemo<TimelineItem[]>(
    () =>
      events
        .filter((e) => e.eventType !== 'ai.handoff.generated')
        .slice(0, 25)
        .map((e) => {
          const d = describeEvent(e, name, 'hospital');
          return {
            id: e.eventId,
            time: e.timestamp,
            title: d.title,
            description: d.detail,
            tone: d.tone,
            icon: d.icon,
            details: <TechnicalDetails fields={eventTechnicalFields(e)} data={e.payload} />,
          };
        }),
    [events, name],
  );
  return (
    <JivaCard>
      <CardHeader title="Activity" icon="activity" subtitle="Everything JIVA shared with your hospital" />
      <div className="mt-3">
        <JivaTimeline items={items} dense detailsLabel="Evidence" empty={<p className="text-[13px] text-ink-500">No activity for your hospital yet.</p>} />
      </div>
    </JivaCard>
  );
}
