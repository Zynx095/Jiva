import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AmbulanceState, HospitalState } from '@jiva/domain-models';
import {
  AmbulanceMarker,
  AppHeader,
  CardHeader,
  ConnectionPill,
  ModeBadge,
  DirectoryFacilityDetails,
  DirectoryLayer,
  EmergencyMarker,
  EmptyState,
  Flash,
  HospitalMarker,
  Icon,
  JivaButton,
  JivaCard,
  JivaMap,
  JivaStatus,
  JivaTimeline,
  MapLegend,
  MapPopup,
  PersonaSelect,
  SkeletonRows,
  TechnicalDetails,
  ToggleChip,
  acceptanceStatus,
  ambulanceStatus,
  capabilityLabel,
  caseResponses,
  cx,
  describeEvent,
  eventTechnicalFields,
  formatClock,
  formatKm,
  hospitalShortName,
  humanizeReason,
  minutesFromSeconds,
  severityStatus,
  timeAgo,
  timeUntil,
  capacityLine,
  referralDetail,
  referralStatus,
  useDirectory,
  useNow,
  useToast,
  type CaseResponse,
  type ReferralRow,
  type DirectoryFacility,
  type DirectoryResponse,
  type JivaEvent,
  type MapFocus,
  type Tone,
  type TimelineItem,
} from '@jiva/ui/src';
import { API_URL, PERSONA, apiGet } from './api';
import { useCrew } from './useCrew';
import { EmergencyIntake, type DraftLocation } from './EmergencyIntake';
import { PrehospitalCard } from './Vitals';

const PERSONAS = [
  { value: 'demo-amb-1', label: 'AMB-BLR-001 (demo-amb-1)' },
  { value: 'demo-amb-2', label: 'AMB-BLR-002 (demo-amb-2)' },
  { value: 'demo-amb-3', label: 'AMB-BLR-003 (demo-amb-3)' },
];

interface Reroute {
  at: string;
  oldId: string;
  newId: string;
  reason?: string;
  distanceMeters?: number;
  durationSeconds?: number;
  oldCoords?: [number, number][];
}

/** Public facility directory: listed, not connected. Module-level so the fetcher is stable. */
const fetchDirectory = () => apiGet<DirectoryResponse>('/api/directory/facilities?located=true');

interface NearbyFacility { facility: DirectoryFacility; straightLineKm: number }

const routeOf = (a?: AmbulanceState | null) => (a?.activeRoute && a.activeRoute.hospitalId === a.destinationHospital ? a.activeRoute : undefined);

export default function App() {
  const toast = useToast();
  const [reroute, setReroute] = useState<Reroute | null>(null);
  const [lost, setLost] = useState<{ at: string; reason?: string } | null>(null);
  // The last job this unit handed over (from the hospital's handover record), shown while the unit is free.
  const [handedOver, setHandedOver] = useState<{ caseId: string; hospitalId: string; at: string } | null>(null);
  // Bumped when the crew's pre-hospital record changes (the observations card reloads).
  const [observationsVersion, setObservationsVersion] = useState(0);
  const latest = useRef<{ ambulance: AmbulanceState | null; name: (id: string) => string | undefined }>({ ambulance: null, name: () => undefined });

  const onLive = useCallback(
    (e: JivaEvent) => {
      const p = e.payload;
      const name = latest.current.name;
      const me = latest.current.ambulance;
      if (e.eventType === 'demo.reset') {
        setReroute(null);
        setLost(null);
        setHandedOver(null);
        toast.show({ title: 'Demo reset', description: 'All demo state was cleared.', icon: 'refresh', groupKey: 'reset' });
        return;
      }
      if (me && p.ambulanceId !== me.ambulanceId) return;
      if (e.eventType === 'route.recalculated') {
        const oldId = typeof p.oldHospitalId === 'string' ? p.oldHospitalId : '';
        const newId = String(p.newHospitalId);
        if (oldId && oldId !== newId) {
          setReroute({
            at: e.timestamp,
            oldId,
            newId,
            reason: humanizeReason(typeof p.reason === 'string' ? p.reason : undefined, name),
            distanceMeters: typeof p.distanceMeters === 'number' ? p.distanceMeters : undefined,
            durationSeconds: typeof p.durationSeconds === 'number' ? p.durationSeconds : undefined,
            oldCoords: routeOf(me)?.coordinates,
          });
          toast.show({ title: `Rerouted to ${name(newId) ?? newId}`, description: humanizeReason(String(p.reason ?? ''), name), tone: 'warn', icon: 'route', groupKey: 'route', durationMs: 8000 });
        } else {
          toast.show({ title: `Destination: ${name(newId) ?? newId}`, description: 'The hospital accepted. Route ready.', tone: 'ok', icon: 'navigation', groupKey: 'route' });
        }
        setLost(null);
      } else if (e.eventType === 'destination.changed' && p.hospitalId === 'UNASSIGNED') {
        setLost({ at: e.timestamp, reason: humanizeReason(typeof p.reason === 'string' ? p.reason : undefined, name) });
        toast.show({ title: 'Destination withdrawn', description: 'Waiting for another hospital to accept.', tone: 'danger', icon: 'alertTriangle', groupKey: 'route', durationMs: 8000 });
      } else if (e.eventType === 'ambulance.arrived' && p.basis !== 'HOSPITAL_CONFIRMED') {
        toast.show({ title: `At ${name(String(p.hospitalId)) ?? p.hospitalId}`, description: 'Waiting for the hospital to record your arrival.', tone: 'ok', icon: 'pin', groupKey: 'arrived' });
      } else if (e.eventType === 'encounter.arrival.recorded') {
        toast.show({ title: `${name(String(p.hospitalId)) ?? p.hospitalId} confirmed your arrival`, description: 'Hand the patient over to the emergency team.', tone: 'ok', icon: 'hospital', groupKey: 'arrived' });
      } else if (e.eventType === 'encounter.handover.recorded') {
        setReroute(null);
        setLost(null);
        setHandedOver({ caseId: String(p.caseId), hospitalId: String(p.hospitalId), at: typeof p.handedOverAt === 'string' ? p.handedOverAt : e.timestamp });
        toast.show({ title: 'Handover recorded', description: `${String(p.caseId)} is in the care of ${name(String(p.hospitalId)) ?? p.hospitalId}. Your unit is available.`, tone: 'ok', icon: 'checkCircle', groupKey: 'arrived', durationMs: 8000 });
      } else if (e.eventType === 'clinical.prehospital.recorded') {
        setObservationsVersion((v) => v + 1);
      } else if (e.eventType === 'ambulance.dispatched' && p.assignmentBasis !== 'REPORTED_BY_CREW') {
        // A crew-reported case is confirmed by the intake itself; only dispatch assignments need a toast.
        toast.show({ title: `Dispatched to ${String(p.caseId ?? 'a case')}`, tone: 'ok', icon: 'ambulance', groupKey: 'dispatch' });
      }
    },
    [toast],
  );

  const crew = useCrew(onLive);
  const now = useNow(5000);
  const { ambulance, patient, hospitals } = crew;

  // Emergency intake: open while the unit is free; the draft location can be picked on the map.
  const [intakeOpen, setIntakeOpen] = useState(false);
  const [draftLocation, setDraftLocation] = useState<DraftLocation | null>(null);
  const [pendingCase, setPendingCase] = useState<{ caseId: string; at: number; assignedHere: boolean; timedOut: boolean } | null>(null);
  // Facility directory layer (off by default to keep the crew map clean).
  const [showDirectory, setShowDirectory] = useState(false);
  const [dirSelected, setDirSelected] = useState<DirectoryFacility | null>(null);
  const directory = useDirectory(fetchDirectory, showDirectory);
  useEffect(() => {
    if (!pendingCase) return;
    // Success is read back from authoritative state: the case is now this ambulance's job.
    if (ambulance?.assignedPatient === pendingCase.caseId && patient?.patientId === pendingCase.caseId) {
      toast.show({ title: `Emergency ${pendingCase.caseId} created`, description: 'JIVA is asking hospitals that list the needed care.', tone: 'ok', icon: 'checkCircle', groupKey: 'intake', durationMs: 7000 });
      setPendingCase(null);
      setIntakeOpen(false);
      setDraftLocation(null);
      return;
    }
    const t = window.setTimeout(() => setPendingCase((p) => (p && p.caseId === pendingCase.caseId ? { ...p, timedOut: true } : p)), Math.max(0, pendingCase.at + 12_000 - Date.now()));
    return () => window.clearTimeout(t);
  }, [pendingCase, ambulance?.assignedPatient, patient?.patientId, toast]);

  const hospitalById = useMemo(() => new Map(hospitals.map((h) => [h.hospitalId, h])), [hospitals]);
  const name = useCallback((id: string) => {
    const h = hospitalById.get(id);
    return h ? hospitalShortName(h.displayName, h.address?.locality) : undefined;
  }, [hospitalById]);
  useEffect(() => {
    latest.current = { ambulance, name };
  }, [ambulance, name]);

  const caseId = ambulance?.assignedPatient;
  const destination = ambulance?.destinationHospital ? hospitalById.get(ambulance.destinationHospital) ?? null : null;
  const route = routeOf(ambulance);
  const arrived = ambulance?.status === 'ARRIVED';
  // Stable reference per computed route: GPS refreshes must not redraw or re-fit the route.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routeCoords = useMemo(() => route?.coordinates, [route?.calculatedAt]);
  const responses = useMemo(() => (caseId ? caseResponses(crew.events).get(caseId) : undefined), [crew.events, caseId]);
  const severity = useMemo(() => {
    const e = crew.events.find((x) => x.eventType === 'patient.emergency.created' && (x.patientId === caseId || x.payload.caseId === caseId));
    return typeof e?.payload.severity === 'string' ? e.payload.severity : undefined;
  }, [crew.events, caseId]);

  const overview = crew.referrals?.caseId === caseId ? crew.referrals : null;
  const rowById = useMemo(() => new Map((overview?.rows ?? []).map((r) => [r.hospitalId, r])), [overview]);
  const statusFor = (h: HospitalState): string => {
    if (h.operationalState.emergency === 'UNAVAILABLE') return 'UNAVAILABLE';
    const row = rowById.get(h.hospitalId);
    if (row) {
      const st = referralStatus(row, now);
      return st === 'NOT_ASKED' || st === 'CANCELLED' || st === 'UNANSWERED' ? 'UNKNOWN' : st;
    }
    const r = responses?.get(h.hospitalId);
    if (r) return r.status === 'CANCELLED' ? 'UNKNOWN' : r.status;
    return h.operationalState.acceptanceCaseId === caseId ? h.operationalState.acceptance : 'UNKNOWN';
  };

  const destStatus = destination ? acceptanceStatus(statusFor(destination)) : null;
  const next = nextAction({ ambulance, destinationName: destination?.displayName, lost: !!lost && !destination, arrived, confirmed: !!patient?.encounterId, destStatus: destination ? statusFor(destination) : undefined });

  // The unit may report a new emergency only while free (mirrors the server's check).
  const free = !!ambulance && ambulance.status !== 'UNAVAILABLE' && (!ambulance.assignedPatient || ambulance.status === 'AVAILABLE');
  const showIntake = intakeOpen && (free || !!pendingCase);
  useEffect(() => {
    // Dispatch assigned a case while the form was open: the job takes over the panel.
    if (intakeOpen && !free && !pendingCase) {
      setIntakeOpen(false);
      setDraftLocation(null);
    }
  }, [intakeOpen, free, pendingCase]);

  /** Did JIVA find any connected hospital it could ask? (from the candidate evaluation for this case) */
  const referralGap = useMemo(() => {
    const ev = crew.events.find((e) => e.eventType === 'hospital.candidate.generated' && e.payload.caseId === caseId);
    const cands = Array.isArray(ev?.payload.candidates) ? (ev.payload.candidates as Array<{ missingCapabilities?: string[]; operationalEligibility?: string }>) : [];
    if (!ev || cands.length === 0) return null;
    const askable = cands.filter((c) => (c.missingCapabilities ?? []).length === 0 && c.operationalEligibility !== 'INELIGIBLE');
    if (askable.length > 0) return null;
    // Care that NO connected hospital lists (a gap in one hospital alone is not a network gap).
    const missing = [...new Set(cands.flatMap((c) => c.missingCapabilities ?? []))].filter((cap) => cands.every((c) => (c.missingCapabilities ?? []).includes(cap)));
    const partial = cands.some((c) => (c.missingCapabilities ?? []).length > 0);
    return { missing, partial };
  }, [crew.events, caseId]);

  // When nobody connected can be asked, show the nearest LISTED facilities (straight line, not connected).
  const [nearby, setNearby] = useState<{ caseId: string; list: NearbyFacility[] } | null>(null);
  const scene = patient?.currentLocation;
  useEffect(() => {
    if (!referralGap || !scene || !caseId || nearby?.caseId === caseId) return;
    apiGet<{ results: NearbyFacility[] }>(`/api/directory/facilities/near?lat=${scene.latitude}&lng=${scene.longitude}&limit=3&category=HOSPITAL,SPECIALTY_HOSPITAL,MATERNITY_HOME`)
      .then((r) => setNearby({ caseId, list: r.results }))
      .catch(() => setNearby({ caseId, list: [] }));
  }, [referralGap, scene, caseId, nearby?.caseId]);

  const timeline = useMemo<TimelineItem[]>(
    () =>
      crew.events
        .filter((e) => e.eventType !== 'ambulance.location.updated' && e.eventType !== 'feasibility.trace.recorded')
        .filter((e) => !(e.eventType === 'destination.changed' && e.payload.hospitalId !== 'UNASSIGNED'))
        .slice(0, 30)
        .map((e) => {
          const d = describeEvent(e, name, 'crew');
          return { id: e.eventId, time: e.timestamp, title: d.title, description: d.detail, tone: d.tone, icon: d.icon, details: <TechnicalDetails fields={eventTechnicalFields(e)} data={e.payload} /> };
        }),
    [crew.events, name],
  );

  const others = hospitals.filter((h) => h.hospitalId !== destination?.hospitalId && h.location);

  // Without a route to frame, keep the crew's own unit in view: centre on it on load and on each new job.
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const loc = ambulance?.currentLocation;
  const focusKey = `${ambulance?.ambulanceId ?? ''}:${caseId ?? 'idle'}`;
  useEffect(() => {
    if (!loc || route) return;
    setFocus({ lat: loc.latitude, lng: loc.longitude, zoom: 12.5, key: focusKey });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, !!loc, !!route]);

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh">
      <AppHeader
        app={`Ambulance ${ambulance?.ambulanceId ?? ''}`.trim()}
        context={ambulance ? `${ambulanceStatus(ambulance.status).label}${ambulance.dataStatus === 'SYNTHETIC_DEMO' ? ' · synthetic demo telemetry' : ''}` : 'Loading…'}
        actions={
          <>
            <PersonaSelect value={PERSONA} options={PERSONAS} />
            <ConnectionPill state={crew.connection} lastSync={crew.lastSync} />
            <ModeBadge apiUrl={API_URL} detail="Synthetic GPS, simulated hospital responses and mock routes. Not real capacity." />
          </>
        }
      />

      {crew.error && (
        <div role="alert" className="flex items-center gap-2 border-b border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger-700">
          <Icon name="wifiOff" size={16} />
          <span className="flex-1">Cannot reach the JIVA API. Showing the last known state; retrying automatically.</span>
          <JivaButton size="sm" variant="danger-soft" icon="refresh" onClick={() => void crew.refresh()}>
            Try again
          </JivaButton>
        </div>
      )}

      {/* Decision bar: the four facts a crew needs at a glance, always visible. */}
      <section aria-label="Current job" className="border-b border-ink-200 bg-white">
        <div className="grid grid-cols-2 gap-px bg-ink-200 sm:grid-cols-4">
          <Fact label="Patient">
            {caseId ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span>{caseId}</span>
                {severity && <JivaStatus meta={severityStatus(severity)} />}
              </span>
            ) : (
              <span className="text-ink-500">No case</span>
            )}
          </Fact>
          <Fact label={patient?.reportedSymptoms?.length ? 'Reported symptoms' : 'Condition'} title={patient?.activeConditions.join(', ')}>
            {patient?.reportedSymptoms?.join(', ') || patient?.activeConditions.join(', ') || <span className="text-ink-500">—</span>}
          </Fact>
          <Fact label="Destination">
            {destination ? (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="truncate">{hospitalShortName(destination.displayName, destination.address?.locality)}</span>
                {destStatus && <JivaStatus meta={destStatus} />}
              </span>
            ) : (
              <span className={caseId ? 'text-warn-700' : 'text-ink-500'}>{caseId ? 'Awaiting acceptance' : '—'}</span>
            )}
          </Fact>
          <Fact label={arrived ? 'Status' : 'ETA'}>
            <Flash value={route?.calculatedAt}>
              {arrived ? 'Arrived' : route ? (
                <span>
                  <span className="tabular-nums">{minutesFromSeconds(route.durationSeconds)} min</span>
                  <span className="ml-1.5 text-sm font-medium text-ink-500">{formatKm(route.distanceMeters)}</span>
                </span>
              ) : (
                <span className="text-ink-500">—</span>
              )}
            </Flash>
          </Fact>
        </div>
      </section>

      <main id="main" className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
        <section aria-label="Route map" className="relative h-[46vh] min-h-[320px] lg:h-auto lg:flex-1">
          <JivaMap
            label="Route map: this ambulance, its destination and other hospitals"
            routeCoordinates={routeCoords}
            routeMetadata={route}
            alternativeRouteCoordinates={reroute?.oldCoords ? [reroute.oldCoords] : undefined}
            fitBoundsOnUpdate
            focus={focus}
            bottomLeft={<MapLegend showEmergency showDirectory={showDirectory} />}
            onBackgroundClick={() => setDirSelected(null)}
            onPick={showIntake && !pendingCase ? (p) => setDraftLocation({ latitude: p.lat, longitude: p.lng, method: 'MAP_PIN', source: 'Map pin' }) : undefined}
            topLeft={
              <>
                {showIntake && !pendingCase && (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-white/95 px-2.5 py-1.5 text-xs font-semibold text-ink-800 shadow-sm ring-1 ring-ink-200">
                    <Icon name="crosshair" size={13} />
                    Tap the map where the patient is
                  </span>
                )}
                <span className="rounded-lg bg-white/95 p-1 shadow-sm ring-1 ring-ink-200">
                  <ToggleChip
                    icon="building"
                    pressed={showDirectory}
                    onChange={(v) => {
                      setShowDirectory(v);
                      if (!v) setDirSelected(null);
                    }}
                  >
                    {showDirectory && directory.state === 'loading' ? 'Loading facilities…' : showDirectory && directory.state === 'error' ? 'Facilities unavailable' : 'Listed facilities'}
                  </ToggleChip>
                </span>
              </>
            }
          >
            <DirectoryLayer facilities={directory.data?.facilities ?? []} visible={showDirectory} selectedId={dirSelected?.facilityId} onSelect={setDirSelected} />
            {dirSelected?.location && (
              <MapPopup lat={dirSelected.location.latitude} lng={dirSelected.location.longitude} offset={12} onClose={() => setDirSelected(null)}>
                <div className="w-72 p-3">
                  <DirectoryFacilityDetails facility={dirSelected} />
                </div>
              </MapPopup>
            )}
            {showIntake && draftLocation && (
              <EmergencyMarker patientId="New report" lat={draftLocation.latitude} lng={draftLocation.longitude} condition={draftLocation.source} selected />
            )}
            {others.map((h) => (
              <HospitalMarker
                key={h.hospitalId}
                hospitalId={h.hospitalId}
                name={h.displayName}
                lat={h.location!.latitude}
                lng={h.location!.longitude}
                emergencyStatus={statusFor(h)}
                dataStatus={h.dataStatus}
                label={hospitalShortName(h.displayName, h.address?.locality)}
                dimmed={!!destination}
              />
            ))}
            {destination?.location && (
              <HospitalMarker
                hospitalId={destination.hospitalId}
                name={destination.displayName}
                lat={destination.location.latitude}
                lng={destination.location.longitude}
                emergencyStatus={statusFor(destination)}
                dataStatus={destination.dataStatus}
                label={hospitalShortName(destination.displayName, destination.address?.locality)}
                statusLabel={`Destination · ${destStatus?.label ?? ''}`}
                selected
              />
            )}
            {patient?.currentLocation && !arrived && (
              <EmergencyMarker patientId={patient.patientId} lat={patient.currentLocation.latitude} lng={patient.currentLocation.longitude} condition="Pickup location" active={!route} />
            )}
            {ambulance?.currentLocation && (
              <AmbulanceMarker
                ambulanceId={ambulance.ambulanceId}
                lat={ambulance.currentLocation.latitude}
                lng={ambulance.currentLocation.longitude}
                status={ambulance.status}
                detail={destination ? `→ ${hospitalShortName(destination.displayName, destination.address?.locality)}` : undefined}
                selected
              />
            )}
          </JivaMap>
        </section>

        <aside aria-label="Job details" className="jiva-scroll space-y-4 border-t border-ink-200 bg-ink-25 p-4 lg:min-h-0 lg:w-[420px] lg:overflow-y-auto lg:border-l lg:border-t-0">
          {!crew.loaded ? (
            <JivaCard>
              <SkeletonRows rows={3} />
            </JivaCard>
          ) : (
            <>
              <JivaCard accent={next.tone} className="animate-enter">
                <p className="text-xs font-semibold text-ink-500">Next action</p>
                <p className="mt-1 text-xl font-semibold leading-7 tracking-[-0.01em] text-ink-900">{next.title}</p>
                {next.detail && <p className="mt-1 text-sm text-ink-600">{next.detail}</p>}
                {destination && !arrived && destination.operationalState.lastConfirmedAt && (
                  <p className="mt-2 text-xs text-ink-500">
                    Answered {formatClock(destination.operationalState.lastConfirmedAt)}
                    {destination.operationalState.expiresAt ? ` · valid ${timeUntil(destination.operationalState.expiresAt, now)}` : ''}
                  </p>
                )}
              </JivaCard>

              {reroute && <RerouteCard r={reroute} name={name} onDismiss={() => setReroute(null)} />}

              {lost && !destination && (
                <JivaCard accent="danger" role="alert">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-danger-700">
                    <Icon name="alertTriangle" size={16} />
                    Destination withdrawn at {formatClock(lost.at)}
                  </p>
                  {lost.reason && <p className="mt-1 text-[13px] text-ink-700">{lost.reason}</p>}
                  <p className="mt-1 text-xs text-ink-500">A new destination appears here as soon as another hospital accepts.</p>
                </JivaCard>
              )}

              {referralGap && (
                <JivaCard accent="danger" role="alert">
                  <p className="flex items-center gap-1.5 text-sm font-semibold text-danger-700">
                    <Icon name="alertTriangle" size={16} />
                    No connected hospital could be asked
                  </p>
                  <p className="mt-1 text-[13px] text-ink-700">
                    {referralGap.missing.length
                      ? <>No connected hospital lists {referralGap.missing.map((c) => capabilityLabel(c)).join(', ')}, so JIVA could not send a referral.</>
                      : referralGap.partial
                        ? 'No single connected hospital lists all the care this patient needs, so JIVA could not send a referral.'
                        : 'Every connected hospital is currently unable to take this case.'}
                  </p>
                  <p className="mt-1 text-xs text-ink-500">Contact dispatch or call the nearest suitable hospital directly. JIVA never sends a patient to a hospital that has not accepted.</p>
                  {nearby && nearby.caseId === caseId && nearby.list.length > 0 && (
                    <div className="mt-3 border-t border-ink-100 pt-3">
                      <p className="text-xs font-semibold text-ink-700">Nearest listed facilities (straight line · not connected to JIVA)</p>
                      <ul className="mt-2 space-y-2.5">
                        {nearby.list.map((n) => (
                          <li key={n.facility.facilityId} className="rounded-lg bg-ink-25 p-2.5 ring-1 ring-inset ring-ink-200">
                            <DirectoryFacilityDetails facility={n.facility} distanceKm={n.straightLineKm} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </JivaCard>
              )}

              {patient && (
                <JivaCard>
                  <CardHeader title="Patient" icon="user" subtitle={caseId} level={2} />
                  <dl className="mt-3 space-y-2 text-sm">
                    {patient.reportedSymptoms?.length ? (
                      <>
                        <div>
                          <dt className="text-xs font-semibold text-ink-500">Reported symptoms</dt>
                          <dd className="font-medium text-ink-900">{patient.reportedSymptoms.join(', ')}</dd>
                        </div>
                        <div>
                          <dt className="text-xs font-semibold text-ink-500">Suspected cause (unconfirmed)</dt>
                          <dd className="font-medium text-ink-900">{patient.suspectedCause || <span className="text-ink-500">Not given</span>}</dd>
                        </div>
                        {patient.intake?.notes && (
                          <div>
                            <dt className="text-xs font-semibold text-ink-500">Crew notes</dt>
                            <dd className="text-ink-800">{patient.intake.notes}</dd>
                          </div>
                        )}
                      </>
                    ) : (
                      <div>
                        <dt className="text-xs font-semibold text-ink-500">Reported condition</dt>
                        <dd className="font-medium text-ink-900">{patient.activeConditions.join(', ') || 'Not reported'}</dd>
                      </div>
                    )}
                    <div>
                      <dt className="text-xs font-semibold text-ink-500">Care needed (assessed)</dt>
                      <dd className="mt-1 flex flex-wrap gap-1">
                        {patient.careRequirements.map((c) => (
                          <span key={c} className="rounded-md bg-ink-50 px-1.5 py-0.5 text-xs font-semibold text-ink-700 ring-1 ring-inset ring-ink-200">
                            {capabilityLabel(c)}
                          </span>
                        ))}
                      </dd>
                    </div>
                  </dl>
                </JivaCard>
              )}

              {patient && caseId && <PrehospitalCard key={caseId} caseId={caseId} version={observationsVersion} />}

              {caseId && (
                <JivaCard>
                  <CardHeader title="Hospital answers" icon="hospital" subtitle="Only hospitals that confirm can become your destination" />
                  {overview ? (
                    <ReferralAnswers rows={overview.rows} destinationId={destination?.hospitalId} now={now} />
                  ) : (
                    <HospitalAnswers hospitals={hospitals} responses={responses} destinationId={destination?.hospitalId} statusFor={statusFor} now={now} />
                  )}
                </JivaCard>
              )}

              {route && (
                <JivaCard>
                  <CardHeader title="Route" icon="route" />
                  <dl className="mt-2 divide-y divide-ink-100 text-sm">
                    <Row label="Distance">{formatKm(route.distanceMeters)}</Row>
                    <Row label="Drive time">{minutesFromSeconds(route.durationSeconds)} min</Row>
                    <Row label="Provider">
                      <span className={route.synthetic ? 'text-warn-700' : undefined}>
                        {route.synthetic ? 'Synthetic (mock provider)' : route.provider}
                        {route.trafficAware ? '' : ' · no live traffic'}
                      </span>
                    </Row>
                    <Row label="Calculated">{formatClock(route.calculatedAt)}</Row>
                    <Row label="GPS">{ambulance?.locationAsOf ? timeAgo(ambulance.locationAsOf, now) : 'No fix yet'}</Row>
                  </dl>
                </JivaCard>
              )}

              {showIntake ? (
                <EmergencyIntake
                  ambulance={ambulance}
                  hospitals={hospitals}
                  location={draftLocation}
                  onLocation={setDraftLocation}
                  onCancel={() => {
                    setIntakeOpen(false);
                    setDraftLocation(null);
                  }}
                  onSubmitted={(id, assignedHere) => {
                    if (!assignedHere) {
                      toast.show({ title: `Recorded as ${id}`, description: 'This ambulance could not be assigned to it. Dispatch will assign a unit.', tone: 'warn', icon: 'alertTriangle', groupKey: 'intake', durationMs: 9000 });
                      setIntakeOpen(false);
                      setDraftLocation(null);
                      return;
                    }
                    setPendingCase({ caseId: id, at: Date.now(), assignedHere, timedOut: false });
                    void crew.refresh();
                  }}
                  pending={pendingCase ? { caseId: pendingCase.caseId, timedOut: pendingCase.timedOut } : null}
                />
              ) : free ? (
                <>
                  {handedOver && (
                    <JivaCard accent="ok" className="animate-enter">
                      <p className="flex items-center gap-1.5 text-sm font-semibold text-brand-800">
                        <Icon name="checkCircle" size={16} />
                        Handover recorded at {formatClock(handedOver.at)}
                      </p>
                      <p className="mt-1 text-[13px] text-ink-700">
                        {handedOver.caseId} is in the care of {name(handedOver.hospitalId) ?? handedOver.hospitalId}. The hospital's record released this unit; the case is no longer shown here.
                      </p>
                    </JivaCard>
                  )}
                  <JivaCard>
                    <EmptyState
                      icon="ambulance"
                      title="Available"
                      description="Dispatch assignments appear here automatically. If your crew is already with a patient, report the emergency yourself."
                      action={
                        <JivaButton variant="danger" icon="siren" onClick={() => setIntakeOpen(true)}>
                          Report an emergency
                        </JivaButton>
                      }
                    />
                  </JivaCard>
                </>
              ) : (
                !caseId && (
                  <JivaCard>
                    <EmptyState icon="ban" title="Out of service" description="This unit is marked unavailable and cannot take a case." />
                  </JivaCard>
                )
              )}

              {timeline.length > 0 && (
                <JivaCard>
                  <CardHeader title="Case activity" icon="activity" />
                  <div className="mt-3">
                    <JivaTimeline items={timeline} dense detailsLabel="Evidence" />
                  </div>
                </JivaCard>
              )}
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="min-w-0 bg-white px-4 py-2.5">
      <p className="text-xs font-semibold text-ink-500">{label}</p>
      <div className="mt-0.5 truncate text-[17px] font-semibold leading-7 text-ink-900" title={title}>
        {children}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="text-ink-500">{label}</dt>
      <dd className="text-right font-medium text-ink-900">{children}</dd>
    </div>
  );
}

function nextAction({ ambulance, destinationName, lost, arrived, confirmed, destStatus }: { ambulance: AmbulanceState | null; destinationName?: string; lost: boolean; arrived: boolean; confirmed: boolean; destStatus?: string }): { title: string; detail?: string; tone: Tone } {
  if (!ambulance) return { title: 'Connecting to JIVA…', tone: 'neutral' };
  if (arrived && confirmed) return { title: `Hand over at ${destinationName ?? 'the hospital'}`, detail: 'The hospital recorded your arrival. Your unit is released when the hospital records the handover.', tone: 'ok' };
  if (arrived) return { title: `At ${destinationName ?? 'the hospital'}`, detail: 'GPS places you at the hospital. Hand over to the emergency team; the hospital records the arrival and the handover.', tone: 'ok' };
  if (!ambulance.assignedPatient) return { title: 'Available', detail: 'Waiting for dispatch.', tone: 'neutral' };
  // A unit transporting its patient whose destination was withdrawn: the live event sets `lost`, and after a
  // reload the state alone says it (en route to a hospital without one) — never "proceed to the patient".
  if (lost || (!destinationName && ambulance.status === 'EN_ROUTE_TO_HOSPITAL')) return { title: 'Hold — finding a new destination', detail: 'The previous hospital can no longer take this patient. JIVA is waiting for another hospital to accept.', tone: 'danger' };
  if (!destinationName && ambulance.status === 'ON_SCENE') return { title: 'Stay with the patient', detail: 'You reported this emergency. JIVA is asking hospitals that offer the required care; a destination appears as soon as one accepts.', tone: 'warn' };
  if (!destinationName) return { title: 'Proceed to the patient', detail: 'JIVA is asking hospitals that offer the required care. A destination appears as soon as one accepts.', tone: 'warn' };
  if (destStatus === 'UNAVAILABLE' || destStatus === 'REJECTED') return { title: 'Destination no longer available', detail: 'JIVA is re-evaluating eligible hospitals.', tone: 'danger' };
  if (destStatus === 'ACCEPTED') return { title: `Drive to ${destinationName}`, detail: 'The hospital confirmed it can receive this patient.', tone: 'ok' };
  if (destStatus === 'LIMITED') return { title: `Drive to ${destinationName}`, detail: 'The hospital accepted with limits.', tone: 'ok' };
  return { title: `Drive to ${destinationName}`, detail: "The hospital's answer is no longer current. JIVA is re-checking and reroutes if needed.", tone: 'warn' };
}

/** OLD destination → why → re-evaluated → NEW destination, kept until the crew acknowledges it. */
function RerouteCard({ r, name, onDismiss }: { r: Reroute; name: (id: string) => string | undefined; onDismiss: () => void }) {
  const min = minutesFromSeconds(r.durationSeconds);
  return (
    <JivaCard accent="warn" role="alert" className="animate-enter">
      <div className="flex items-start justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-warn-800">
          <Icon name="route" size={16} />
          Rerouted at {formatClock(r.at)}
        </p>
        <JivaButton size="sm" variant="ghost" onClick={onDismiss}>
          Got it
        </JivaButton>
      </div>
      <ol className="mt-3 space-y-0">
        <Step icon="ban" tone="danger" title={name(r.oldId) ?? r.oldId} subtitle="Previous destination — no longer suitable" strike />
        <Step icon="info" tone="neutral" title="Why" subtitle={r.reason ?? 'Hospital status changed'} />
        <Step icon="refresh" tone="neutral" title="JIVA re-evaluated eligible hospitals" subtitle="Only hospitals with a current acceptance qualify" />
        <Step icon="checkCircle" tone="ok" title={name(r.newId) ?? r.newId} subtitle={`New destination${min !== undefined ? ` · ${min} min` : ''}${r.distanceMeters !== undefined ? ` · ${formatKm(r.distanceMeters)}` : ''}`} last />
      </ol>
      {r.oldCoords && <p className="mt-2 text-xs text-ink-500">The previous route is shown dashed on the map.</p>}
    </JivaCard>
  );
}

function Step({ icon, tone, title, subtitle, strike, last }: { icon: 'ban' | 'info' | 'refresh' | 'checkCircle'; tone: Tone; title: string; subtitle: string; strike?: boolean; last?: boolean }) {
  const color = tone === 'ok' ? 'bg-brand-50 text-brand-700' : tone === 'danger' ? 'bg-danger-50 text-danger-700' : 'bg-ink-50 text-ink-600';
  return (
    <li className="relative flex gap-3 pb-3 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute bottom-0 left-[13px] top-7 w-px bg-ink-200" />}
      <span className={cx('relative z-[1] flex h-7 w-7 shrink-0 items-center justify-center rounded-full ring-4 ring-white', color)}>
        <Icon name={icon} size={14} strokeWidth={2} />
      </span>
      <div className="min-w-0 pt-0.5">
        <p className={cx('text-sm font-semibold text-ink-900', strike && 'text-ink-500 line-through decoration-ink-300')}>{title}</p>
        <p className="text-[13px] text-ink-600">{subtitle}</p>
      </div>
    </li>
  );
}

/**
 * Server-side referral overview: per connected hospital, the explicit answer for THIS case (or why there
 * is none), what the hospital lists, and its last capacity report with who reported it.
 */
function ReferralAnswers({ rows, destinationId, now }: { rows: ReferralRow[]; destinationId?: string; now: number }) {
  const rank: Record<string, number> = { ACCEPTED: 0, LIMITED: 1, PENDING: 2, EXPIRED: 3, UNANSWERED: 3, CANCELLED: 4, REJECTED: 5, UNAVAILABLE: 5, NOT_ASKED: 6 };
  const list = [...rows].sort((a, b) => (a.hospitalId === destinationId ? -1 : b.hospitalId === destinationId ? 1 : (rank[referralStatus(a, now)] ?? 9) - (rank[referralStatus(b, now)] ?? 9)));
  return (
    <ul className="mt-3 divide-y divide-ink-100">
      {list.map((r) => {
        const isDest = r.hospitalId === destinationId;
        return (
          <li key={r.hospitalId} className={cx('py-2.5', isDest && 'rounded-lg bg-brand-50/60 px-2 -mx-2')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-semibold text-ink-900">
                  {hospitalShortName(r.name)}
                  {isDest && <span className="ml-1.5 text-xs font-semibold text-brand-700">Your destination</span>}
                </p>
                <p className="text-xs text-ink-600">{referralDetail(r, now)}</p>
              </div>
              <JivaStatus meta={acceptanceStatus(referralStatus(r, now))} />
            </div>
            <details className="mt-1 text-xs text-ink-500">
              <summary className="cursor-pointer select-none font-semibold text-ink-500 hover:text-ink-700">Evidence</summary>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                <dt>Lists</dt>
                <dd>{r.listed.missingRequired.length ? `not ${r.listed.missingRequired.map((c) => capabilityLabel(c)).join(', ')}` : 'all the care needed'}</dd>
                {r.assessment && (
                  <>
                    <dt>Assessed</dt>
                    <dd>at referral: {r.assessment.eligibility === 'INELIGIBLE' ? 'not suitable' : r.assessment.eligibility === 'ELIGIBLE' ? 'eligible' : 'capable, answer needed'}{r.assessment.etaMinutes ? ` · ≈ ${r.assessment.etaMinutes} min (estimate)` : ''}</dd>
                  </>
                )}
                {r.answer && (
                  <>
                    <dt>Answer</dt>
                    <dd>{r.answer.provenance === 'SYNTHETIC_DEMO' ? 'demo response' : r.answer.provenance === 'HOSPITAL_CONFIRMED' ? 'confirmed by hospital staff' : r.answer.provenance.toLowerCase()} · ref {r.answer.requestId}</dd>
                  </>
                )}
                <dt>Capacity</dt>
                <dd>{capacityLine(r, now)}</dd>
              </dl>
            </details>
          </li>
        );
      })}
    </ul>
  );
}

function HospitalAnswers({ hospitals, responses, destinationId, statusFor, now }: {
  hospitals: HospitalState[];
  responses?: Map<string, CaseResponse>;
  destinationId?: string;
  statusFor: (h: HospitalState) => string;
  now: number;
}) {
  const rank: Record<string, number> = { ACCEPTED: 0, LIMITED: 1, PENDING: 2, UNKNOWN: 3, EXPIRED: 3, REJECTED: 4, UNAVAILABLE: 4 };
  const list = [...hospitals].sort((a, b) => (a.hospitalId === destinationId ? -1 : b.hospitalId === destinationId ? 1 : (rank[statusFor(a)] ?? 9) - (rank[statusFor(b)] ?? 9)));
  return (
    <ul className="mt-3 divide-y divide-ink-100">
      {list.map((h) => {
        const status = statusFor(h);
        const r = responses?.get(h.hospitalId);
        const isDest = h.hospitalId === destinationId;
        const detail = r?.respondedAt
          ? `Answered ${formatClock(r.respondedAt)}${r.limitations.length ? ` · ${r.limitations.join('; ')}` : ''}`
          : r?.status === 'PENDING'
            ? r.answerBy && Date.parse(r.answerBy) > now
              ? `Asked · answer due ${timeUntil(r.answerBy, now)}`
              : 'Asked · no answer in time'
            : h.operationalState.emergency === 'UNAVAILABLE'
              ? 'Emergency department reported unavailable'
              : 'Not asked for this case';
        return (
          <li key={h.hospitalId} className={cx('flex items-start justify-between gap-3 py-2.5', isDest && 'rounded-lg bg-brand-50/60 px-2 -mx-2')}>
            <div className="min-w-0">
              <p className="truncate text-[13px] font-semibold text-ink-900">
                {hospitalShortName(h.displayName, h.address?.locality)}
                {isDest && <span className="ml-1.5 text-xs font-semibold text-brand-700">Your destination</span>}
              </p>
              <p className="text-xs text-ink-500">{detail}</p>
            </div>
            <JivaStatus meta={acceptanceStatus(status)} />
          </li>
        );
      })}
    </ul>
  );
}
