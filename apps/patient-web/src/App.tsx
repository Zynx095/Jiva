import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AppHeader,
  ConnectionPill,
  ModeBadge,
  EmptyState,
  Flash,
  Icon,
  JivaButton,
  JivaCard,
  JivaTimeline,
  PersonaSelect,
  JivaSkeleton,
  capabilityLabel,
  cx,
  describeEvent,
  formatClock,
  hospitalShortName,
  joinList,
  plainCapabilities,
  aiOutputLabel,
  minutesFromSeconds,
  timeAgo,
  useNow,
  useRuntimeMode,
  useToast,
  type IconName,
  type JivaEvent,
  type TimelineItem,
} from '@jiva/ui/src';
import { API_URL, PERSONA } from './api';
import { CareTeamCard, DocumentsCard, MedicationsCard, RecordsNotYet, ReportsCard, VitalsCard } from './InHospital';
import { usePatient } from './usePatient';

const PERSONAS = [
  { value: 'demo-patient-1', label: 'CASE-BLR-876 (demo-patient-1)' },
  { value: 'demo-patient-2', label: 'CASE-BLR-877 (demo-patient-2)' },
];

const SOURCE_TEXT: Record<string, string> = {
  system: 'JIVA coordination system',
  ambulance: 'Ambulance crew device',
  hospital: 'Hospital',
  patient: 'You',
  clinician: 'Clinician',
  laboratory: 'Laboratory',
};

export default function App() {
  const toast = useToast();
  const [notice, setNotice] = useState<string | null>(null);
  const [allActivity, setAllActivity] = useState(false);
  const nameRef = useRef<(id: string) => string | undefined>(() => undefined);

  const onLive = useCallback(
    (e: JivaEvent) => {
      if (e.eventType === 'demo.reset') {
        setNotice(null);
        return;
      }
      const p = e.payload;
      if (e.eventType === 'route.recalculated' && typeof p.oldHospitalId === 'string' && p.oldHospitalId) {
        const to = nameRef.current(String(p.newHospitalId)) ?? 'another hospital';
        setNotice(`Your destination changed to ${to} so you reach a hospital that can treat you now.`);
        toast.show({ title: 'Your destination changed', description: `Now going to ${to}.`, tone: 'warn', icon: 'route', groupKey: 'dest' });
      } else if (e.eventType === 'route.recalculated') {
        toast.show({ title: 'A hospital confirmed it can receive you', description: nameRef.current(String(p.newHospitalId)), tone: 'ok', icon: 'checkCircle', groupKey: 'dest' });
      } else if (e.eventType === 'ambulance.dispatched') {
        toast.show({ title: 'An ambulance is on the way', tone: 'ok', icon: 'ambulance', groupKey: 'amb' });
      } else if (e.eventType === 'ambulance.arrived' && p.basis !== 'HOSPITAL_CONFIRMED') {
        toast.show({ title: 'You have reached the hospital', description: 'The hospital will confirm your arrival and take over your care.', tone: 'ok', icon: 'pin', groupKey: 'arrived' });
      } else if (e.eventType === 'encounter.arrival.recorded') {
        toast.show({ title: 'The hospital recorded your arrival', description: 'The ambulance crew is handing you over to the emergency team.', tone: 'ok', icon: 'hospital', groupKey: 'arrived' });
      } else if (e.eventType === 'encounter.handover.recorded') {
        toast.show({ title: 'You are in hospital care', description: 'The ambulance crew handed you over to the hospital team.', tone: 'ok', icon: 'stethoscope', groupKey: 'arrived' });
      } else if (e.eventType === 'encounter.doctor.assigned') {
        toast.show({ title: p.previousPractitionerId ? 'Your doctor changed' : 'A doctor was assigned to you', description: 'See "Your care team".', tone: 'ok', icon: 'user', groupKey: 'doctor' });
      } else if (e.eventType.startsWith('clinical.')) {
        // Content-free notification; the details are read from your records.
        toast.show({ title: 'New in your health records', description: 'Your care team shared an update with you.', tone: 'ok', icon: 'file', groupKey: 'records' });
      }
    },
    [toast],
  );

  const pt = usePatient(onLive);
  const mode = useRuntimeMode(API_URL);
  const now = useNow(5000);
  const { patient, ambulance, hospital, encounter, records } = pt;

  const names = useMemo(() => new Map(pt.hospitals.map((h) => [h.hospitalId, h.displayName])), [pt.hospitals]);
  const name = useCallback((id: string) => names.get(id), [names]);
  useEffect(() => {
    nameRef.current = name;
  }, [name]);

  const route = ambulance?.activeRoute && ambulance.activeRoute.hospitalId === ambulance.destinationHospital ? ambulance.activeRoute : undefined;
  // The hospital's operational state holds its latest answer to ANY case: count it only when it names this
  // patient's case. JIVA routes an ambulance only to a hospital that accepted the case, so the ambulance's
  // destination is this patient's confirmation too.
  const op = hospital?.operationalState;
  const confirmed =
    (!!hospital && !!ambulance?.destinationHospital && ambulance.destinationHospital === hospital.hospitalId) ||
    (!!patient && op?.acceptanceCaseId === patient.patientId && (op.acceptance === 'ACCEPTED' || op.acceptance === 'LIMITED'));
  const acceptance = patient && op?.acceptanceCaseId === patient.patientId ? op.acceptance : confirmed ? 'ACCEPTED' : undefined;
  // Only the hospital's own records move the patient into hospital care: the arrival record opens the
  // encounter and the handover record puts the patient in the hospital's care. GPS alone never does.
  const arrivalConfirmed = !!encounter;
  const inCare = encounter?.status === 'IN_CARE';
  const arrived = arrivalConfirmed || ambulance?.status === 'ARRIVED' || patient?.currentStatus === 'ARRIVED' || patient?.currentStatus === 'HANDED_OVER';
  const hospitalShort = hospital ? hospitalShortName(hospital.displayName, hospital.address?.locality) : encounter?.hospitalName ?? 'the hospital';
  const eta = arrived ? 0 : minutesFromSeconds(route?.durationSeconds);
  const summary = pt.events.find((e) => e.eventType === 'ai.summary.generated');

  const journey = [
    { label: 'Emergency reported', done: !!patient },
    { label: 'Ambulance on the way', done: !!ambulance || arrived },
    { label: 'Hospital confirmed', done: confirmed || arrived },
    { label: 'Travelling to hospital', done: ambulance?.status === 'EN_ROUTE_TO_HOSPITAL' || arrived },
    { label: 'Arrival recorded by the hospital', done: arrivalConfirmed },
    { label: 'In hospital care', done: inCare },
  ];
  const currentStep = journey.findIndex((s) => !s.done);

  const headline = !patient
    ? { title: 'No active emergency', body: 'If you need urgent help, call 108.', icon: 'checkCircle' as IconName }
    : inCare
      ? { title: `In the care of ${hospitalShort}`, body: 'The ambulance crew handed you over to the hospital team. Your care team will add updates here.', icon: 'stethoscope' as IconName }
      : arrivalConfirmed
        ? { title: `${hospitalShort} recorded your arrival`, body: 'The ambulance crew is handing you over to the emergency team.', icon: 'hospital' as IconName }
        : arrived
          ? { title: 'You have reached the hospital', body: `At ${hospital?.displayName ?? 'the hospital'}. The hospital will confirm your arrival and take over your care.`, icon: 'pin' as IconName }
          : hospital && confirmed
        ? { title: `On the way to ${hospitalShortName(hospital.displayName, hospital.address?.locality)}`, body: `Ambulance ${ambulance?.ambulanceId ?? ''} is taking you to a hospital that confirmed it can receive you.`, icon: 'ambulance' as IconName }
        : ambulance?.status === 'ON_SCENE' || ambulance?.status === 'EN_ROUTE_TO_HOSPITAL'
          ? // The crew is already with the patient (it reported the emergency, or is transporting them).
            { title: 'An ambulance crew is with you', body: `Ambulance ${ambulance.ambulanceId} is looking after you. We are confirming which hospital can treat you now.`, icon: 'ambulance' as IconName }
        : ambulance
          ? { title: 'Help is on the way', body: `Ambulance ${ambulance.ambulanceId} is coming. We are confirming which hospital can treat you now.`, icon: 'ambulance' as IconName }
          : { title: 'Your emergency was reported', body: 'An ambulance is being assigned to you.', icon: 'siren' as IconName };

  const timeline = useMemo<TimelineItem[]>(
    () =>
      pt.events
        .filter((e) => e.eventType !== 'ambulance.location.updated')
        // The route event already says where the patient is going; its paired destination event would repeat it.
        .filter((e) => !(e.eventType === 'destination.changed' && e.payload.hospitalId !== 'UNASSIGNED'))
        .map((e) => {
          const d = describeEvent(e, name, 'patient');
          return {
            id: e.eventId,
            time: e.timestamp,
            title: d.title,
            description: d.detail,
            tone: d.tone,
            icon: d.icon,
            details: (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                <dt className="text-ink-500">Time</dt>
                <dd className="text-ink-800">{new Date(e.timestamp).toLocaleString()}</dd>
                <dt className="text-ink-500">Source</dt>
                <dd className="text-ink-800">{SOURCE_TEXT[e.source.type] ?? e.source.type}</dd>
                <dt className="text-ink-500">Data</dt>
                <dd className="text-ink-800">{mode === 'OPERATIONAL' ? 'Recorded by JIVA' : 'Demo data — simulated for this demonstration'}</dd>
                <dt className="text-ink-500">Reference</dt>
                <dd className="break-all font-mono text-ink-600">{e.eventId}</dd>
              </dl>
            ),
          };
        }),
    [pt.events, name, mode],
  );

  return (
    <div className="min-h-dvh">
      <AppHeader
        app="Your care"
        context={patient ? `Case ${patient.patientId}` : 'JIVA patient view'}
        actions={
          <>
            <span className="hidden sm:inline-flex">
              <PersonaSelect value={PERSONA} options={PERSONAS} />
            </span>
            <ConnectionPill state={pt.connection} lastSync={pt.syncedAt} />
            <ModeBadge apiUrl={API_URL} detail="This is a demonstration with simulated data. In an emergency, call 108." />
          </>
        }
      />

      <main id="main" className="mx-auto grid max-w-5xl gap-5 px-4 py-6 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:px-6">
        {pt.load === 'error' && (
          <div role="alert" className="flex items-start gap-2 rounded-xl bg-danger-50 p-4 text-sm text-danger-700 ring-1 ring-inset ring-danger-200 lg:col-span-2">
            <Icon name="wifiOff" size={18} className="mt-0.5 shrink-0" />
            <span className="flex-1">We can't reach JIVA right now and are trying again. Your ambulance crew is still with you — call 108 if you need help.</span>
            <JivaButton size="sm" variant="danger-soft" icon="refresh" onClick={() => void pt.refresh()}>
              Try again
            </JivaButton>
          </div>
        )}

        <div className="min-w-0 space-y-5">
          {/* CURRENT CARE */}
          <section aria-labelledby="current-care" className="overflow-hidden rounded-2xl bg-white ring-1 ring-ink-200">
            <div className="bg-brand-700 px-5 pb-5 pt-5 text-white">
              <p id="current-care" className="text-[13px] font-semibold text-brand-100">
                Current care
              </p>
              {pt.load === 'loading' ? (
                <div className="mt-2 space-y-2">
                  <JivaSkeleton className="h-7 w-3/4 opacity-40" />
                  <JivaSkeleton className="h-4 w-1/2 opacity-40" />
                </div>
              ) : (
                <div className="mt-1 flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <h1 className="text-2xl font-semibold leading-8 tracking-[-0.02em]">{headline.title}</h1>
                    <p className="mt-1 text-[15px] leading-6 text-brand-50">{headline.body}</p>
                  </div>
                  <span className="hidden h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/12 sm:flex">
                    <Icon name={headline.icon} size={26} strokeWidth={1.75} />
                  </span>
                </div>
              )}
              {patient && !arrived && (
                <div className="mt-4 flex items-end justify-between gap-3 rounded-xl bg-white/10 px-4 py-3">
                  <div>
                    <p className="text-[13px] font-semibold text-brand-100">Estimated arrival at hospital</p>
                    <p className="text-xs text-brand-100/90">{route?.synthetic ? 'Estimate from synthetic demo routing, without live traffic' : !route?.trafficAware ? 'Estimate, without live traffic' : 'Estimate'}</p>
                  </div>
                  <Flash value={eta}>
                    <span className="text-4xl font-semibold tabular-nums tracking-[-0.02em]">{eta ?? '--'}</span>
                    <span className="ml-1 text-base font-medium text-brand-100">min</span>
                  </Flash>
                </div>
              )}
            </div>

            {patient && (
              <ol className="grid grid-cols-3 gap-x-1 gap-y-3 px-4 py-4 sm:grid-cols-6" aria-label="Your journey">
                {journey.map((s, i) => {
                  const current = i === currentStep;
                  return (
                    <li key={s.label} className="flex flex-col items-center gap-1.5 text-center" aria-current={current ? 'step' : undefined}>
                      <span
                        className={cx(
                          'flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold transition-colors duration-300',
                          s.done ? 'bg-brand-600 text-white' : current ? 'bg-white text-brand-700 ring-2 ring-brand-500' : 'bg-ink-100 text-ink-500',
                        )}
                      >
                        {s.done ? <Icon name="check" size={14} strokeWidth={2.6} /> : i + 1}
                      </span>
                      <span className={cx('text-[11px] leading-4 sm:text-xs', s.done ? 'font-semibold text-ink-800' : current ? 'font-semibold text-brand-800' : 'text-ink-500')}>{s.label}</span>
                      <span className="sr-only">{s.done ? '(done)' : current ? '(in progress)' : '(next)'}</span>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>

          {notice && (
            <div role="status" className="flex animate-enter items-start gap-2.5 rounded-xl bg-warn-50 p-4 text-sm text-warn-900 ring-1 ring-inset ring-warn-200">
              <Icon name="route" size={18} className="mt-0.5 shrink-0" />
              <span className="flex-1">{notice}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="rounded-md p-1 text-warn-800 hover:bg-warn-100">
                <Icon name="x" size={15} />
              </button>
            </div>
          )}

          {patient && inCare && encounter && <CareTeamCard encounter={encounter} hospitalName={hospital?.displayName ?? encounter.hospitalName ?? 'Your hospital'} now={now} />}

          {patient && !inCare && (
            <JivaCard as="section" aria-labelledby="dest-title">
              <p id="dest-title" className="text-[13px] font-semibold text-ink-500">
                Your hospital
              </p>
              {hospital ? (
                <>
                  <p className="mt-1 text-lg font-semibold leading-6 text-ink-900">{hospital.displayName}</p>
                  <p className={cx('mt-1.5 flex items-center gap-1.5 text-sm font-semibold', acceptance === 'ACCEPTED' ? 'text-brand-700' : acceptance === 'LIMITED' ? 'text-warn-700' : 'text-ink-600')}>
                    <Icon name={acceptance === 'ACCEPTED' ? 'checkCircle' : acceptance === 'LIMITED' ? 'half' : 'clock'} size={16} />
                    {acceptance === 'ACCEPTED' ? 'Confirmed it can receive you' : acceptance === 'LIMITED' ? 'Can receive you, with some limits' : 'Waiting for the hospital to confirm'}
                  </p>
                  {hospital.operationalState?.lastConfirmedAt && op?.acceptanceCaseId === patient.patientId && (
                    <p className="mt-2 border-t border-ink-100 pt-2 text-xs text-ink-500">
                      Confirmed at {formatClock(hospital.operationalState.lastConfirmedAt)} · {timeAgo(hospital.operationalState.lastConfirmedAt, now)}
                    </p>
                  )}
                </>
              ) : (
                <p className="mt-1 text-sm text-ink-600">{ambulance ? 'Checking which hospital can receive you now…' : 'A hospital will be chosen once one confirms it can treat you.'}</p>
              )}
            </JivaCard>
          )}

          {patient && <WhatNext patientCare={patient.careRequirements} hospitalName={hospital?.displayName} confirmed={confirmed} arrived={arrived} inCare={inCare} hasAmbulance={!!ambulance} eta={eta} />}

          <SosCard inHospital={arrivalConfirmed} />
        </div>

        <div className="min-w-0 space-y-5">
          {inCare && encounter ? (
            <>
              <VitalsCard vitals={records?.encounterId === encounter.encounterId ? records.vitals : undefined} now={now} />
              <MedicationsCard list={records?.encounterId === encounter.encounterId ? records.prescriptions : undefined} />
              <ReportsCard encounterId={encounter.encounterId} list={records?.encounterId === encounter.encounterId ? records.reports : undefined} documents={records?.encounterId === encounter.encounterId ? records.documents : undefined} />
              <DocumentsCard encounterId={encounter.encounterId} list={records?.encounterId === encounter.encounterId ? records.documents : undefined} />
            </>
          ) : (
            patient && <RecordsNotYet />
          )}

          {summary && (
            <JivaCard as="section" aria-labelledby="summary-title">
              <p id="summary-title" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-500" title={aiOutputLabel(summary.payload.generator, 'patient').hint}>
                <Icon name="brief" size={14} />
                {aiOutputLabel(summary.payload.generator, 'patient').label}
              </p>
              <p className="mt-1.5 text-sm text-ink-800">{plainCapabilities(String(summary.payload.briefSummary ?? ''))}</p>
            </JivaCard>
          )}

          <JivaCard as="section" aria-labelledby="activity-title">
            <h2 id="activity-title" className="text-[15px] font-semibold text-ink-900">
              Recent activity
            </h2>
            <p className="text-[13px] text-ink-500">What happened so far, newest first. Tap an entry to see where it came from.</p>
            <div className="mt-4">
              {pt.load === 'loading' ? (
                <div className="space-y-3">
                  <JivaSkeleton className="h-10" />
                  <JivaSkeleton className="h-10" />
                </div>
              ) : (
                <>
                  <JivaTimeline
                    items={allActivity ? timeline : timeline.slice(0, 5)}
                    detailsLabel="Details"
                    empty={<EmptyState compact icon="activity" title="Nothing yet" description="Updates about your care appear here as they happen." />}
                  />
                  {timeline.length > 5 && (
                    <JivaButton size="sm" variant="tertiary" icon={allActivity ? 'chevronUp' : 'chevronDown'} onClick={() => setAllActivity((v) => !v)}>
                      {allActivity ? 'Show the latest only' : `Show all ${timeline.length} updates`}
                    </JivaButton>
                  )}
                </>
              )}
            </div>
          </JivaCard>

          <p className="px-1 text-center text-xs text-ink-500">
            {pt.syncedAt ? `Updated ${timeAgo(pt.syncedAt, now)}` : ''} · signed in as demo persona {PERSONA}
          </p>
        </div>
      </main>
    </div>
  );
}

/** Upcoming: what will happen next, in plain words. Never a clinical judgement. */
function WhatNext({ patientCare, hospitalName, confirmed, arrived, inCare, hasAmbulance, eta }: { patientCare: string[]; hospitalName?: string; confirmed: boolean; arrived: boolean; inCare: boolean; hasAmbulance: boolean; eta?: number }) {
  const steps: Array<{ icon: IconName; text: ReactNode }> = inCare
    ? [
        { icon: 'stethoscope', text: <>Your care team at <strong className="font-semibold">{hospitalName ?? 'the hospital'}</strong> is looking after you.</> },
        { icon: 'file', text: 'Medications, results and scans your care team shares with you appear on this page.' },
        { icon: 'user', text: 'Questions about your treatment are best answered by your doctor or nurse.' },
      ]
    : arrived
    ? [
        { icon: 'stethoscope', text: <>The team at <strong className="font-semibold">{hospitalName ?? 'the hospital'}</strong> records your arrival and takes over your care from the ambulance crew.</> },
        { icon: 'brief', text: 'A short summary of your journey appears on this page when it is ready.' },
      ]
    : confirmed && hospitalName
      ? [
          { icon: 'navigation', text: <>The ambulance takes you to <strong className="font-semibold">{hospitalName}</strong>{eta ? <>, in about <strong className="font-semibold">{eta} min</strong></> : null}.</> },
          { icon: 'checkCircle', text: 'The hospital has confirmed it can receive you and knows you are coming.' },
          { icon: 'route', text: 'If that changes, JIVA finds another hospital and this page updates straight away.' },
        ]
      : hasAmbulance
        ? [
            { icon: 'hospital', text: patientCare.length ? <>JIVA is asking hospitals that offer {joinList(patientCare.map((c) => capabilityLabel(c, 'plain').toLowerCase()))} to confirm they can receive you.</> : 'JIVA is asking nearby hospitals to confirm they can receive you.' },
            { icon: 'clock', text: 'Your hospital appears here as soon as one confirms.' },
          ]
        : [{ icon: 'ambulance', text: 'An ambulance is being assigned to you.' }];
  return (
    <JivaCard as="section" aria-labelledby="next-title">
      <h2 id="next-title" className="text-[15px] font-semibold text-ink-900">
        What happens next
      </h2>
      <ul className="mt-3 space-y-2.5">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-3 text-sm text-ink-700">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700">
              <Icon name={s.icon} size={15} />
            </span>
            <span className="pt-1">{s.text}</span>
          </li>
        ))}
      </ul>
    </JivaCard>
  );
}

function SosCard({ inHospital }: { inHospital: boolean }) {
  if (inHospital) {
    return (
      <section aria-labelledby="sos-title" className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 ring-1 ring-danger-200">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-50 text-danger-700">
          <Icon name="alertCircle" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="sos-title" className="text-[15px] font-semibold text-ink-900">
            Feeling worse?
          </h2>
          <p className="text-[13px] text-ink-600">Tell the nurse or doctor near you straight away, or use the call button by your bed. Do not wait for this page.</p>
        </div>
      </section>
    );
  }
  return (
    <section aria-labelledby="sos-title" className="flex flex-wrap items-center gap-3 rounded-2xl bg-white p-4 ring-1 ring-danger-200">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-danger-50 text-danger-700">
        <Icon name="phone" size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <h2 id="sos-title" className="text-[15px] font-semibold text-ink-900">
          Need urgent help?
        </h2>
        <p className="text-[13px] text-ink-600">Call the emergency number, or tell your ambulance crew if you feel worse.</p>
      </div>
      <a href="tel:108" className="inline-flex h-11 items-center gap-2 rounded-xl bg-danger-600 px-4 text-sm font-semibold text-white shadow-xs transition-colors hover:bg-danger-700 active:scale-[0.98]">
        <Icon name="phone" size={16} />
        Call 108
      </a>
    </section>
  );
}
