import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppHeader,
  ConnectionPill,
  DemoBadge,
  Icon,
  JivaBreadcrumbs,
  JivaButton,
  JivaSearch,
  JivaStatus,
  JivaTabs,
  TabPanel,
  acceptanceStatus,
  ambulanceStatus,
  describeEvent,
  hospitalShortName,
  useNow,
  useToast,
  type ActionResult,
  type JivaEvent,
  type MapFit,
  type MapFocus,
  type SearchItem,
} from '@jiva/ui/src';
import { DemoSimulator } from './lib/simulator';
import { useNetwork } from './useNetwork';
import { NetworkContext, type NetworkModel } from './model';
import {
  caseCandidates,
  caseFacts,
  caseResponses,
  hospitalDisplayStatus,
  isAwaiting,
  isOnJob,
  isOpenCase,
  makeNameResolver,
  pendingHospitals,
} from './derive';
import type { PanelTab, Selection, SelectionKind } from './types';
import { Kpis } from './components/Kpis';
import { NetworkMap, type MapFilters } from './components/NetworkMap';
import { DemoControls } from './components/DemoControls';
import { ActivityFeed, AmbulancesList, HospitalsList, IncidentsList } from './components/Lists';
import { AmbulanceDetail, CaseDetail, HospitalDetail } from './components/Details';
import { SystemStatus } from './components/SystemStatus';

const TAB_FOR: Record<SelectionKind, PanelTab> = { case: 'incidents', hospital: 'hospitals', ambulance: 'ambulances' };
const TAB_LABEL: Record<PanelTab, string> = { incidents: 'Incidents', hospitals: 'Hospitals', ambulances: 'Ambulances', activity: 'Activity' };

/** Selection lives in the URL hash so the browser Back button walks back through drill-downs. */
function readHash(): Selection | null {
  const m = window.location.hash.match(/^#(case|hospital|ambulance)\/(.+)$/);
  return m ? { kind: m[1] as SelectionKind, id: decodeURIComponent(m[2]) } : null;
}

const DEFAULT_FILTERS: MapFilters = { hospitals: true, ambulances: true, emergencies: true, routes: true, staleOnly: false, statuses: [] };

export default function App() {
  const toast = useToast();
  const [selection, setSelection] = useState<Selection | null>(readHash);
  const [tab, setTab] = useState<PanelTab>(() => (readHash() ? TAB_FOR[readHash()!.kind] : 'incidents'));
  const [filters, setFilters] = useState<MapFilters>(DEFAULT_FILTERS);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [fit, setFit] = useState<MapFit | null>(null);
  const [popupOpen, setPopupOpen] = useState(false);
  const detailRef = useRef<HTMLDivElement | null>(null);

  // Latest data for callbacks created once (live-event handler, selection focus).
  const latest = useRef<{ model: NetworkModel | null }>({ model: null });
  const framed = useRef(false);

  const positionOf = useCallback((s: Selection) => {
    const m = latest.current.model;
    if (!m) return undefined;
    const loc =
      s.kind === 'case' ? m.patientById.get(s.id)?.currentLocation : s.kind === 'ambulance' ? m.ambulanceById.get(s.id)?.currentLocation : m.hospitalById.get(s.id)?.location;
    return loc ? { lat: loc.latitude, lng: loc.longitude } : undefined;
  }, []);

  const select = useCallback(
    (s: Selection | null) => {
      setSelection(s);
      setPopupOpen(!!s);
      if (s) {
        setTab(TAB_FOR[s.kind]);
        const hash = `#${s.kind}/${encodeURIComponent(s.id)}`;
        if (window.location.hash !== hash) window.history.pushState(null, '', hash);
        const pos = positionOf(s);
        if (pos) setFocus({ ...pos, zoom: 13, key: `${s.kind}:${s.id}:${Date.now()}`, offset: [0, 90] });
      } else if (window.location.hash) {
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    },
    [positionOf],
  );

  const openTab = useCallback(
    (t: PanelTab) => {
      select(null);
      setTab(t);
    },
    [select],
  );

  useEffect(() => {
    const onPop = () => {
      const s = readHash();
      if (!s && window.location.hash && window.location.hash !== '#') return; // e.g. #main from the skip link
      setSelection(s);
      setPopupOpen(!!s);
      if (s) {
        setTab(TAB_FOR[s.kind]);
        const pos = positionOf(s);
        if (pos) setFocus({ ...pos, zoom: 13, key: `${s.kind}:${s.id}:${Date.now()}`, offset: [0, 90] });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [positionOf]);

  // Realtime feedback: notable events become short grouped notifications with a "View" shortcut.
  const onLiveEvent = useCallback(
    (e: JivaEvent) => {
      const m = latest.current.model;
      if (e.eventType === 'demo.reset') {
        select(null);
        framed.current = false;
        toast.show({ title: 'Demo reset', description: 'All demo state was cleared and re-seeded.', tone: 'neutral', icon: 'refresh', groupKey: 'reset' });
        return;
      }
      if (!m) return;
      const d = describeEvent(e, m.name, 'ops');
      if (!d.notable) return;
      const target: Selection | null = d.caseId && e.eventType === 'patient.emergency.created' ? { kind: 'case', id: d.caseId } : d.hospitalId && e.eventType.startsWith('hospital.') ? { kind: 'hospital', id: d.hospitalId } : d.ambulanceId ? { kind: 'ambulance', id: d.ambulanceId } : d.caseId ? { kind: 'case', id: d.caseId } : null;
      toast.show({
        title: d.title,
        description: d.detail,
        tone: d.tone,
        icon: d.icon,
        groupKey: `${e.eventType}:${d.hospitalId ?? d.ambulanceId ?? d.caseId ?? ''}`,
        action: target ? { label: 'View', onClick: () => select(target) } : undefined,
      });
    },
    [select, toast],
  );

  const net = useNetwork(onLiveEvent);
  const hasPending = useMemo(() => net.events.some((e) => e.eventType === 'hospital.acceptance.requested'), [net.events]);
  const now = useNow(hasPending ? 1000 : 5000);

  const derived = useMemo(() => {
    const responses = caseResponses(net.events);
    const openCases = new Set(net.patients.filter(isOpenCase).map((p) => p.patientId));
    return {
      responses,
      openCases,
      facts: caseFacts(net.events),
      candidates: caseCandidates(net.events),
      name: makeNameResolver(net.hospitals),
      hospitalById: new Map(net.hospitals.map((h) => [h.hospitalId, h])),
      ambulanceById: new Map(net.ambulances.map((a) => [a.ambulanceId, a])),
      patientById: new Map(net.patients.map((p) => [p.patientId, p])),
    };
  }, [net.events, net.patients, net.hospitals, net.ambulances]);

  const pending = useMemo(() => pendingHospitals(derived.responses, derived.openCases, now), [derived, now]);

  const model: NetworkModel = useMemo(
    () => ({
      now,
      patients: net.patients,
      hospitals: net.hospitals,
      ambulances: net.ambulances,
      events: net.events,
      ...derived,
      pending,
      hospitalStatus: (h) => hospitalDisplayStatus(h, pending),
      ambulanceForCase: (caseId) => net.ambulances.find((a) => a.assignedPatient === caseId),
      selection,
      select,
      openTab,
      fitRoute: (ambulanceId) => {
        const a = derived.ambulanceById.get(ambulanceId);
        const coords = a?.activeRoute?.coordinates;
        if (!coords?.length) return;
        setFilters((f) => (f.routes ? f : { ...f, routes: true }));
        setFit({ coordinates: coords, key: `${ambulanceId}:${Date.now()}` });
      },
    }),
    [now, net.patients, net.hospitals, net.ambulances, net.events, derived, pending, selection, select, openTab],
  );
  useEffect(() => {
    latest.current.model = model;
  }, [model]);

  // First load (and after a demo reset): frame every hospital, ambulance and emergency (or the deep-linked selection).
  useEffect(() => {
    if (framed.current || !net.loaded || net.hospitals.length === 0) return;
    framed.current = true;
    if (selection) {
      const pos = positionOf(selection);
      if (pos) setFocus({ ...pos, zoom: 13, key: 'initial-selection', offset: [0, 90] });
      return;
    }
    const coords: [number, number][] = [
      ...net.hospitals.flatMap((h) => (h.location ? [[h.location.longitude, h.location.latitude] as [number, number]] : [])),
      ...net.ambulances.flatMap((a) => (a.currentLocation ? [[a.currentLocation.longitude, a.currentLocation.latitude] as [number, number]] : [])),
      ...net.patients.flatMap((p) => (p.currentLocation ? [[p.currentLocation.longitude, p.currentLocation.latitude] as [number, number]] : [])),
    ];
    if (coords.length) setFit({ coordinates: coords, key: 'initial', padding: { top: 80, bottom: 60, left: 50, right: 70 }, maxZoom: 12.5, instant: true });
  }, [net.loaded, net.hospitals, net.ambulances, net.patients, selection, positionOf]);

  const kpis = useMemo(() => {
    let awaiting = 0;
    for (const [caseId, m] of derived.responses) {
      if (!derived.openCases.has(caseId)) continue;
      for (const r of m.values()) if (isAwaiting(r, now)) awaiting++;
    }
    return {
      open: derived.openCases.size,
      arrived: net.patients.filter((p) => p.currentStatus === 'ARRIVED').length,
      onJob: net.ambulances.filter(isOnJob).length,
      idle: net.ambulances.filter((a) => a.status === 'AVAILABLE').length,
      awaiting,
      accepted: net.hospitals.filter((h) => hospitalDisplayStatus(h, pending) === 'ACCEPTED').length,
      limited: net.hospitals.filter((h) => hospitalDisplayStatus(h, pending) === 'LIMITED').length,
      requests: net.events.filter((e) => e.eventType === 'hospital.acceptance.requested').length,
    };
  }, [derived, net.patients, net.ambulances, net.hospitals, net.events, now, pending]);

  const searchItems = useMemo<SearchItem[]>(
    () => [
      ...net.patients.map((p) => ({
        id: `case:${p.patientId}`,
        group: 'Cases',
        label: p.patientId,
        sublabel: p.activeConditions.join(', '),
        icon: 'siren' as const,
        keywords: p.careRequirements.join(' '),
      })),
      ...net.hospitals.map((h) => ({
        id: `hospital:${h.hospitalId}`,
        group: 'Hospitals',
        label: h.displayName,
        sublabel: `${h.address?.locality ?? ''} · ${acceptanceStatus(model.hospitalStatus(h)).label}`,
        icon: 'hospital' as const,
        keywords: `${h.hospitalId} ${hospitalShortName(h.displayName)}`,
        meta: <JivaStatus meta={acceptanceStatus(model.hospitalStatus(h))} />,
      })),
      ...net.ambulances.map((a) => ({
        id: `ambulance:${a.ambulanceId}`,
        group: 'Ambulances',
        label: a.ambulanceId,
        sublabel: `${ambulanceStatus(a.status).label}${a.assignedPatient ? ` · ${a.assignedPatient}` : ''}`,
        icon: 'ambulance' as const,
      })),
    ],
    [net.patients, net.hospitals, net.ambulances, model],
  );

  const advanceAmbulance = useCallback(async (): Promise<ActionResult> => {
    const amb = latest.current.model?.ambulanceById.get('AMB-BLR-001');
    const pts = amb?.activeRoute?.coordinates;
    if (!amb?.currentLocation || !pts?.length) return 'Ambulance has no active route yet';
    const here = amb.currentLocation;
    const dist = (p: [number, number]) => Math.hypot(p[0] - here.longitude, p[1] - here.latitude);
    let idx = 0;
    pts.forEach((p, i) => {
      if (dist(p) < dist(pts[idx])) idx = i;
    });
    const next = pts[Math.min(idx + 1, pts.length - 1)];
    return DemoSimulator.moveAmbulance(amb.ambulanceId, next[1], next[0]);
  }, []);

  const showDetails = () => {
    detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    detailRef.current?.focus({ preventScroll: true });
  };

  const selectionLabel = (() => {
    if (!selection) return '';
    if (selection.kind === 'hospital') return model.name(selection.id) ?? selection.id;
    return selection.id;
  })();

  return (
    <NetworkContext.Provider value={model}>
      <div className="flex min-h-dvh flex-col lg:h-dvh">
        <AppHeader
          app="Command Center"
          context="Bengaluru healthcare network"
          center={
            <JivaSearch
              label="Search cases, hospitals and ambulances"
              placeholder="Search cases, hospitals, ambulances"
              items={searchItems}
              onSelect={(it) => {
                const [kind, ...rest] = it.id.split(':');
                select({ kind: kind as SelectionKind, id: rest.join(':') });
              }}
            />
          }
          actions={
            <>
              <SystemStatus health={net.health} />
              <ConnectionPill state={net.connection} lastSync={net.lastSync} />
              <DemoBadge />
            </>
          }
        />

        {net.loadError && (
          <div role="alert" className="flex items-center gap-2 border-b border-danger-200 bg-danger-50 px-4 py-2 text-sm text-danger-700 lg:px-6">
            <Icon name="wifiOff" size={16} />
            <span className="flex-1">{net.loadError}</span>
            <JivaButton size="sm" variant="danger-soft" icon="refresh" onClick={() => void net.refresh()}>
              Try again
            </JivaButton>
          </div>
        )}

        <Kpis
          v={kpis}
          tab={selection ? null : tab}
          statusFilter={filters.statuses}
          onOpen={(t, status) => {
            openTab(t);
            if (t === 'hospitals') setFilters((f) => ({ ...f, statuses: status ? [status] : [] }));
          }}
        />

        <main id="main" className="flex flex-1 flex-col lg:min-h-0 lg:flex-row">
          <div className="flex flex-col lg:min-h-0 lg:flex-1">
            <section aria-label="Network map" className="relative h-[58vh] min-h-[340px] lg:h-auto lg:flex-1">
              <NetworkMap
                filters={filters}
                onFilters={setFilters}
                focus={focus}
                fit={fit}
                popupOpen={popupOpen && !!selection}
                onClosePopup={() => setPopupOpen(false)}
                onShowDetails={showDetails}
              />
            </section>
            <DemoControls advanceAmbulance={advanceAmbulance} />
          </div>

          <aside aria-label="Network details" className="flex flex-col border-t border-ink-200 bg-ink-25 lg:min-h-0 lg:w-[420px] lg:border-l lg:border-t-0 xl:w-[460px]">
            {selection ? (
              <div className="flex flex-col lg:min-h-0 lg:flex-1">
                <div className="flex items-center gap-2 border-b border-ink-200 bg-white px-3 py-2">
                  <JivaButton size="sm" variant="ghost" icon="chevronLeft" onClick={() => openTab(TAB_FOR[selection.kind])} aria-label={`Back to ${TAB_LABEL[TAB_FOR[selection.kind]]}`}>
                    Back
                  </JivaButton>
                  <JivaBreadcrumbs
                    items={[
                      { label: 'Network', onClick: () => openTab('incidents') },
                      { label: TAB_LABEL[TAB_FOR[selection.kind]], onClick: () => openTab(TAB_FOR[selection.kind]) },
                      { label: selectionLabel },
                    ]}
                  />
                </div>
                <div ref={detailRef} tabIndex={-1} className="jiva-scroll p-4 outline-none lg:min-h-0 lg:flex-1 lg:overflow-y-auto" key={`${selection.kind}:${selection.id}`}>
                  <div className="animate-enter">
                    {selection.kind === 'case' && <CaseDetail id={selection.id} />}
                    {selection.kind === 'hospital' && <HospitalDetail id={selection.id} />}
                    {selection.kind === 'ambulance' && <AmbulanceDetail id={selection.id} />}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col lg:min-h-0 lg:flex-1">
                <JivaTabs
                  className="bg-white px-2"
                  idPrefix="panel"
                  label="Network lists"
                  value={tab}
                  onChange={setTab}
                  items={[
                    { id: 'incidents', label: 'Incidents', count: kpis.open + kpis.arrived, attention: kpis.open > 0 },
                    { id: 'hospitals', label: 'Hospitals', count: net.hospitals.length, attention: kpis.awaiting > 0 },
                    { id: 'ambulances', label: 'Ambulances', count: net.ambulances.length },
                    { id: 'activity', label: 'Activity' },
                  ]}
                />
                <TabPanel idPrefix="panel" id={tab} className="jiva-scroll p-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
                  {tab === 'incidents' && <IncidentsList loaded={net.loaded} />}
                  {tab === 'hospitals' && (
                    <HospitalsList statuses={filters.statuses} onStatuses={(statuses) => setFilters((f) => ({ ...f, statuses }))} staleOnly={filters.staleOnly} loaded={net.loaded} />
                  )}
                  {tab === 'ambulances' && <AmbulancesList loaded={net.loaded} />}
                  {tab === 'activity' && <ActivityFeed loaded={net.loaded} />}
                </TabPanel>
              </div>
            )}
          </aside>
        </main>
      </div>
    </NetworkContext.Provider>
  );
}
