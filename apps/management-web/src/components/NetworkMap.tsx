import { useMemo, useState, type ReactNode } from 'react';
import {
  AmbulanceMarker,
  Icon,
  EmergencyMarker,
  HospitalMarker,
  JivaButton,
  JivaFilter,
  JivaMap,
  JivaStatus,
  MapLegend,
  MapPopup,
  ToggleChip,
  acceptanceStatus,
  ambulanceStatus,
  capabilityStatus,
  formatClock,
  hospitalShortName,
  minutesFromSeconds,
  severityStatus,
  timeAgo,
  type MapFit,
  type MapFocus,
} from '@jiva/ui/src';
import { gpsFreshness, hospitalFreshness, isOpenCase } from '../derive';
import { useModel } from '../model';
import type { AmbulanceState } from '../types';

export interface MapFilters {
  hospitals: boolean;
  ambulances: boolean;
  emergencies: boolean;
  routes: boolean;
  staleOnly: boolean;
  statuses: string[];
}

export const STATUS_FILTERS = ['ACCEPTED', 'PENDING', 'LIMITED', 'UNAVAILABLE', 'UNKNOWN'] as const;

/** Statuses grouped for filtering: "Unavailable" also covers declines, "Unknown" covers expired. */
export const statusBucket = (s: string) => (s === 'REJECTED' ? 'UNAVAILABLE' : s === 'EXPIRED' ? 'UNKNOWN' : s);

const routeOf = (a?: AmbulanceState) => (a?.activeRoute && a.activeRoute.hospitalId === a.destinationHospital ? a.activeRoute : undefined);

export function NetworkMap({
  filters,
  onFilters,
  focus,
  fit,
  popupOpen,
  onClosePopup,
  onShowDetails,
}: {
  filters: MapFilters;
  onFilters: (f: MapFilters) => void;
  focus: MapFocus | null;
  fit: MapFit | null;
  popupOpen: boolean;
  onClosePopup: () => void;
  onShowDetails: () => void;
}) {
  const m = useModel();
  const sel = m.selection;
  const [statusOpen, setStatusOpen] = useState(false);

  const statusCounts: Record<string, number> = {};
  for (const h of m.hospitals) {
    const b = statusBucket(m.hospitalStatus(h));
    statusCounts[b] = (statusCounts[b] ?? 0) + 1;
  }

  // The route on screen follows the selection; otherwise the first live route.
  const routeAmbulance = (() => {
    if (sel?.kind === 'ambulance') return m.ambulanceById.get(sel.id);
    if (sel?.kind === 'case') return m.ambulanceForCase(sel.id);
    if (sel?.kind === 'hospital') return m.ambulances.find((a) => a.destinationHospital === sel.id && routeOf(a));
    return m.ambulances.find((a) => routeOf(a) && a.status !== 'ARRIVED') ?? m.ambulances.find((a) => routeOf(a));
  })();
  const route = routeOf(routeAmbulance);
  // Stable reference per computed route: GPS refreshes must not redraw the line.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routeCoords = useMemo(() => route?.coordinates, [route?.calculatedAt, routeAmbulance?.ambulanceId]);

  const visibleHospitals = m.hospitals.filter((h) => {
    if (!h.location) return false;
    if (sel?.kind === 'hospital' && sel.id === h.hospitalId) return true;
    if (!filters.hospitals) return false;
    if (filters.statuses.length && !filters.statuses.includes(statusBucket(m.hospitalStatus(h)))) return false;
    if (filters.staleOnly && !hospitalFreshness(h, m.now).stale) return false;
    return true;
  });
  const visibleAmbulances = m.ambulances.filter((a) => {
    if (!a.currentLocation) return false;
    if (sel?.kind === 'ambulance' && sel.id === a.ambulanceId) return true;
    if (!filters.ambulances) return false;
    if (filters.staleOnly && !gpsFreshness(a, m.now).stale) return false;
    return true;
  });
  const emergencies = filters.emergencies && !filters.staleOnly ? m.patients.filter((p) => p.currentLocation && p.currentStatus !== 'DISCHARGED') : [];

  const set = (patch: Partial<MapFilters>) => onFilters({ ...filters, ...patch });
  const activeFilterCount = filters.statuses.length + (filters.staleOnly ? 1 : 0) + [filters.hospitals, filters.ambulances, filters.emergencies, filters.routes].filter((x) => !x).length;

  return (
    <JivaMap
      label="Bengaluru network map: hospitals, ambulances and emergencies"
      routeCoordinates={filters.routes ? routeCoords : undefined}
      routeMetadata={route}
      focus={focus}
      fit={fit}
      onBackgroundClick={onClosePopup}
      topLeft={
        <div className="max-w-full rounded-xl bg-white/95 p-1.5 shadow-sm ring-1 ring-ink-200">
          <div className="jiva-scroll flex items-center gap-1.5 overflow-x-auto" role="group" aria-label="Map layers and filters">
            <ToggleChip icon="hospital" pressed={filters.hospitals} onChange={(v) => set({ hospitals: v })}>Hospitals</ToggleChip>
            <ToggleChip icon="ambulance" pressed={filters.ambulances} onChange={(v) => set({ ambulances: v })}>Ambulances</ToggleChip>
            <ToggleChip icon="siren" pressed={filters.emergencies} onChange={(v) => set({ emergencies: v })}>Emergencies</ToggleChip>
            <ToggleChip icon="route" pressed={filters.routes} onChange={(v) => set({ routes: v })}>Routes</ToggleChip>
            <span className="mx-0.5 h-5 w-px shrink-0 bg-ink-200" aria-hidden="true" />
            <ToggleChip icon="filter" pressed={statusOpen || filters.statuses.length > 0} onChange={(v) => setStatusOpen(v)}>
              Status{filters.statuses.length ? ` · ${filters.statuses.length}` : ''}
            </ToggleChip>
            <ToggleChip icon="clock" pressed={filters.staleOnly} onChange={(v) => set({ staleOnly: v })}>Stale data</ToggleChip>
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => {
                  onFilters({ hospitals: true, ambulances: true, emergencies: true, routes: true, staleOnly: false, statuses: [] });
                  setStatusOpen(false);
                }}
                className="shrink-0 px-1.5 text-xs font-semibold text-brand-700 hover:underline"
              >
                Reset ({activeFilterCount})
              </button>
            )}
          </div>
          {(statusOpen || filters.statuses.length > 0) && (
            <JivaFilter
              className="jiva-scroll mt-1.5 animate-fade overflow-x-auto"
              label="Hospital status"
              value={filters.statuses}
              onChange={(statuses) => set({ statuses, hospitals: true })}
              allLabel="All statuses"
              options={STATUS_FILTERS.map((s) => ({ value: s, label: acceptanceStatus(s).label.replace('No current response', 'Unknown'), tone: acceptanceStatus(s).tone, count: statusCounts[s] ?? 0 }))}
            />
          )}
        </div>
      }
      bottomLeft={<MapLegend />}
    >
      {visibleHospitals.map((h) => {
        const status = m.hospitalStatus(h);
        const dimmed = !!sel && sel.kind !== 'hospital' && routeAmbulance?.destinationHospital !== h.hospitalId;
        return (
          <HospitalMarker
            key={h.hospitalId}
            hospitalId={h.hospitalId}
            name={h.displayName}
            lat={h.location!.latitude}
            lng={h.location!.longitude}
            emergencyStatus={status}
            dataStatus={h.dataStatus}
            label={hospitalShortName(h.displayName, h.address?.locality)}
            selected={sel?.kind === 'hospital' && sel.id === h.hospitalId}
            dimmed={dimmed}
            onClick={() => m.select({ kind: 'hospital', id: h.hospitalId })}
          />
        );
      })}
      {emergencies.map((p) => (
        <EmergencyMarker
          key={p.patientId}
          patientId={p.patientId}
          lat={p.currentLocation!.latitude}
          lng={p.currentLocation!.longitude}
          condition={p.activeConditions[0] ?? 'Emergency'}
          active={isOpenCase(p)}
          selected={sel?.kind === 'case' && sel.id === p.patientId}
          onClick={() => m.select({ kind: 'case', id: p.patientId })}
        />
      ))}
      {visibleAmbulances.map((a) => {
        const r = routeOf(a);
        const dest = a.destinationHospital ? m.name(a.destinationHospital) : undefined;
        return (
          <AmbulanceMarker
            key={a.ambulanceId}
            ambulanceId={a.ambulanceId}
            lat={a.currentLocation!.latitude}
            lng={a.currentLocation!.longitude}
            status={a.status}
            selected={sel?.kind === 'ambulance' && sel.id === a.ambulanceId}
            detail={dest ? `→ ${dest}${r && a.status !== 'ARRIVED' ? ` · ${minutesFromSeconds(r.durationSeconds)} min` : ''}` : a.assignedPatient}
            onClick={() => m.select({ kind: 'ambulance', id: a.ambulanceId })}
          />
        );
      })}
      {popupOpen && <SelectionPopup onClose={onClosePopup} onShowDetails={onShowDetails} />}
    </JivaMap>
  );
}

/** Compact marker card: what it is, its state, one line of context, two actions. */
function SelectionPopup({ onClose, onShowDetails }: { onClose: () => void; onShowDetails: () => void }) {
  const m = useModel();
  const sel = m.selection;
  if (!sel) return null;

  let pos: { lat: number; lng: number } | undefined;
  let body: ReactNode = null;
  let routeFor: string | undefined;

  if (sel.kind === 'hospital') {
    const h = m.hospitalById.get(sel.id);
    if (!h?.location) return null;
    pos = { lat: h.location.latitude, lng: h.location.longitude };
    const status = m.hospitalStatus(h);
    const op = h.operationalState;
    const incoming = m.ambulances.find((a) => a.destinationHospital === h.hospitalId && routeOf(a));
    routeFor = incoming?.ambulanceId;
    body = (
      <>
        <PopupTitle title={h.displayName} />
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <JivaStatus meta={acceptanceStatus(status)} />
          {op.acceptanceCaseId && (status === 'ACCEPTED' || status === 'LIMITED') && <span className="text-xs text-ink-500">for {op.acceptanceCaseId}</span>}
        </div>
        <p className="mt-1.5 text-xs text-ink-600">
          ED {capabilityStatus(op.emergency).label.toLowerCase()} · ICU {capabilityStatus(op.icu).label.toLowerCase()} · Trauma {capabilityStatus(op.trauma).label.toLowerCase()}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">
          {op.lastConfirmedAt ? `Answered ${timeAgo(op.lastConfirmedAt, m.now)}` : hospitalFreshness(h, m.now).text || 'No answer yet'}
          {incoming ? ` · ${incoming.ambulanceId} heading here` : ''}
        </p>
      </>
    );
  } else if (sel.kind === 'ambulance') {
    const a = m.ambulanceById.get(sel.id);
    if (!a?.currentLocation) return null;
    pos = { lat: a.currentLocation.latitude, lng: a.currentLocation.longitude };
    const r = routeOf(a);
    routeFor = r ? a.ambulanceId : undefined;
    body = (
      <>
        <PopupTitle title={`Ambulance ${a.ambulanceId}`} />
        <div className="mt-1.5">
          <JivaStatus meta={ambulanceStatus(a.status)} />
        </div>
        <p className="mt-1.5 text-xs text-ink-600">
          {a.assignedPatient ? `${a.assignedPatient}` : 'No case assigned'}
          {a.destinationHospital ? ` → ${m.name(a.destinationHospital) ?? a.destinationHospital}` : a.assignedPatient ? ' · awaiting destination' : ''}
          {r && a.status !== 'ARRIVED' ? ` · ${minutesFromSeconds(r.durationSeconds)} min` : ''}
        </p>
        <p className="mt-0.5 text-xs text-ink-500">{a.locationAsOf ? `GPS ${timeAgo(a.locationAsOf, m.now)}` : gpsFreshness(a, m.now).text}</p>
      </>
    );
  } else {
    const p = m.patientById.get(sel.id);
    if (!p?.currentLocation) return null;
    pos = { lat: p.currentLocation.latitude, lng: p.currentLocation.longitude };
    const facts = m.facts.get(p.patientId);
    const amb = m.ambulanceForCase(p.patientId);
    routeFor = routeOf(amb) ? amb?.ambulanceId : undefined;
    body = (
      <>
        <PopupTitle title={p.patientId} />
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <JivaStatus meta={severityStatus(facts?.severity)} />
        </div>
        <p className="mt-1.5 text-xs text-ink-700">{p.activeConditions.join(', ') || 'Condition not reported'}</p>
        <p className="mt-0.5 text-xs text-ink-500">
          {facts?.reportedAt ? `Reported ${formatClock(facts.reportedAt)}` : ''}
          {amb ? ` · ${amb.ambulanceId}` : ' · no ambulance yet'}
          {amb?.destinationHospital ? ` → ${m.name(amb.destinationHospital)}` : ''}
        </p>
      </>
    );
  }

  return (
    <MapPopup lat={pos.lat} lng={pos.lng} onClose={onClose}>
      <div className="w-64 p-3">
        {body}
        <div className="mt-3 flex gap-2">
          <JivaButton size="sm" variant="primary" iconRight="chevronRight" onClick={onShowDetails}>
            Details
          </JivaButton>
          {routeFor && (
            <JivaButton size="sm" icon="route" onClick={() => m.fitRoute(routeFor!)}>
              View route
            </JivaButton>
          )}
          <button type="button" onClick={onClose} aria-label="Close map card" className="ml-auto rounded-md p-1.5 text-ink-500 hover:bg-ink-100 hover:text-ink-800">
            <Icon name="x" size={15} />
          </button>
        </div>
      </div>
    </MapPopup>
  );
}

function PopupTitle({ title }: { title: string }) {
  return <p className="pr-2 text-sm font-semibold leading-5 text-ink-900">{title}</p>;
}
