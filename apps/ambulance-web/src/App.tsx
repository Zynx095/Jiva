import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PatientState, HospitalState, AmbulanceState } from '@jiva/domain-models';
import { JivaMap } from '@jiva/ui/src/Map/JivaMap';
import { HospitalMarker } from '@jiva/ui/src/Map/HospitalMarker';
import { AmbulanceMarker } from '@jiva/ui/src/Map/AmbulanceMarker';
import { apiGet, socket } from './api';

const acceptanceLabel = (a?: string) =>
  a === 'ACCEPTED' ? { text: '✓ ACCEPTED', cls: 'bg-green-900/50 text-green-400 border-green-900' }
  : a === 'LIMITED' ? { text: '⚠ LIMITED', cls: 'bg-yellow-900/50 text-yellow-400 border-yellow-900' }
  : a === 'REJECTED' ? { text: '✕ REJECTED', cls: 'bg-red-900/40 text-red-400 border-red-900' }
  : a === 'UNAVAILABLE' ? { text: '✕ UNAVAILABLE', cls: 'bg-red-900/40 text-red-400 border-red-900' }
  : { text: '? NO RESPONSE', cls: 'bg-gray-800 text-gray-400 border-gray-700' };

export default function App() {
  const [patient, setPatient] = useState<PatientState | null>(null);
  const [ambulance, setAmbulance] = useState<AmbulanceState | null>(null);
  const [hospitals, setHospitals] = useState<HospitalState[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [error, setError] = useState(false);
  const [reroute, setReroute] = useState<string | null>(null);
  const pending = useRef<number | undefined>(undefined);

  // Server scopes: this persona only sees its own ambulance and its assigned case.
  const fetchState = useCallback(async () => {
    try {
      const [ambs, hosps, pats] = await Promise.all([
        apiGet<AmbulanceState[]>('/api/ambulances'),
        apiGet<HospitalState[]>('/api/hospitals'),
        apiGet<PatientState[]>('/api/patients'),
      ]);
      const me = ambs[0] || null;
      setAmbulance(me);
      setHospitals(hosps);
      setPatient(pats.find(p => p.patientId === me?.assignedPatient) || null);
      setError(false);
    } catch {
      setError(true);
    }
  }, []);

  const scheduleFetch = useCallback(() => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(fetchState, 120);
  }, [fetchState]);

  useEffect(() => {
    fetchState();
    const onConnect = () => { setConnected(true); fetchState(); };
    const onDisconnect = () => setConnected(false);
    const onEvent = (event: any) => {
      if (event.eventType === 'demo.reset') setReroute(null);
      if (event.eventType === 'route.recalculated' && event.payload.oldHospitalId) {
        setReroute(`REROUTED: ${event.payload.oldHospitalId} → ${event.payload.newHospitalId}. ${event.payload.reason}`);
      }
      if (event.eventType === 'destination.changed' && event.payload.hospitalId === 'UNASSIGNED') {
        setReroute(`DESTINATION LOST: ${event.payload.reason}`);
      }
      scheduleFetch();
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('event', onEvent);
    setConnected(socket.connected); // the socket may have connected before these listeners existed
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('event', onEvent);
    };
  }, [fetchState, scheduleFetch]);

  const destination = hospitals.find(h => h.hospitalId === ambulance?.destinationHospital) || null;
  const route = ambulance?.activeRoute && ambulance.activeRoute.hospitalId === ambulance.destinationHospital ? ambulance.activeRoute : undefined;
  const destLabel = acceptanceLabel(destination?.operationalState?.acceptance);
  // Stable reference per computed route: GPS refreshes must not redraw or re-fit the route.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const routeCoords = useMemo(() => route?.coordinates, [route?.calculatedAt]);

  return (
    <div className="min-h-screen bg-black text-white p-4 flex flex-col md:flex-row gap-4 font-sans h-screen overflow-hidden">
      <div className="flex-1 rounded-xl overflow-hidden border border-gray-800 relative bg-gray-900 min-h-[320px]">
        <JivaMap routeCoordinates={routeCoords} routeMetadata={route} fitBoundsOnUpdate>
          {ambulance?.currentLocation && (
            <AmbulanceMarker
              ambulanceId={ambulance.ambulanceId}
              lat={ambulance.currentLocation.latitude}
              lng={ambulance.currentLocation.longitude}
              status={ambulance.status}
            />
          )}
          {destination?.location && (
            <HospitalMarker
              hospitalId={destination.hospitalId}
              name={destination.displayName}
              lat={destination.location.latitude}
              lng={destination.location.longitude}
              emergencyStatus={destination.operationalState?.acceptance || 'UNKNOWN'}
              dataStatus={destination.dataStatus}
            />
          )}
        </JivaMap>
      </div>

      <div className="w-full md:w-96 flex flex-col gap-4 overflow-y-auto">
        <div className="bg-gray-950 border border-gray-800 p-4 rounded-xl">
          <div className="flex justify-between items-center mb-3">
            <h1 className="text-lg font-bold text-emerald-500">{ambulance?.ambulanceId || 'AMBULANCE'}</h1>
            <div className={`text-xs px-2 py-1 rounded flex items-center gap-1.5 ${connected ? 'bg-emerald-950 text-emerald-400' : 'bg-red-950 text-red-400'}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-400'}`} aria-hidden="true" />
              {connected ? 'Live' : 'Offline — data may be stale'}
            </div>
          </div>
          <div className="text-2xl font-bold">{patient ? patient.patientId : 'Idle — awaiting dispatch'}</div>
          <div className="text-xs text-gray-500 mt-1">Status: {ambulance?.status || '—'} · synthetic demo telemetry</div>
          {error && <div className="text-xs text-red-400 mt-2">Cannot reach JIVA API. Showing last known state.</div>}
        </div>

        {reroute && (
          <div role="alert" className="bg-purple-950/60 border border-purple-700 text-purple-200 text-sm p-3 rounded-xl">{reroute}</div>
        )}

        {patient && (
          <div className="bg-gray-950 border border-gray-800 p-4 rounded-xl space-y-3">
            <h2 className="text-xs font-bold text-gray-500">Patient / case</h2>
            <div>
              <div className="text-xs text-gray-500">Reported condition</div>
              <div className="font-bold text-red-400">{patient.activeConditions.join(', ') || '—'}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500 mb-1">Required capabilities (assessed)</div>
              <div className="flex flex-wrap gap-2">
                {patient.careRequirements.map(c => (
                  <span key={c} className="bg-red-900/30 text-red-400 text-xs px-2 py-1 rounded border border-red-900">{c}</span>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="bg-gray-950 border border-gray-800 p-4 rounded-xl space-y-4">
          <h2 className="text-xs font-bold text-gray-500">Destination</h2>
          {destination ? (
            <div>
              <div className="flex justify-between items-start gap-2 mb-2">
                <div className="font-bold text-lg">{destination.displayName}</div>
                <div className={`text-xs font-bold px-2 py-1 rounded border whitespace-nowrap ${destLabel.cls}`}>{destLabel.text}</div>
              </div>
              <div className="grid grid-cols-2 gap-4 mt-4">
                <div className="bg-gray-900 p-3 rounded">
                  <div className="text-xs text-gray-500 mb-1">ETA</div>
                  <div className="text-2xl font-bold text-yellow-500">{ambulance?.status === 'ARRIVED' ? 'Arrived' : route ? `${Math.ceil(route.durationSeconds / 60)} min` : '--'}</div>
                </div>
                <div className="bg-gray-900 p-3 rounded">
                  <div className="text-xs text-gray-500 mb-1">Distance</div>
                  <div className="text-2xl font-bold text-blue-400">{route ? `${(route.distanceMeters / 1000).toFixed(1)} km` : '--'}</div>
                </div>
              </div>
              {route && (
                <div className="text-[11px] text-gray-500 mt-2">
                  Route provider: <span className={route.synthetic ? 'text-amber-400' : 'text-emerald-400'}>{route.provider}{route.synthetic ? ' (synthetic)' : ''}</span>
                  {!route.trafficAware && ' · no live traffic'}
                </div>
              )}
              <div className="text-xs text-gray-500 mt-3">
                Hospital response: {destination.operationalState?.lastConfirmedAt ? new Date(destination.operationalState.lastConfirmedAt).toLocaleTimeString() : 'none'}
                {destination.operationalState?.expiresAt && ` · valid until ${new Date(destination.operationalState.expiresAt).toLocaleTimeString()}`}
              </div>
            </div>
          ) : (
            <div className="text-center py-6 text-gray-500">
              {patient ? 'No hospital has accepted yet — awaiting responses' : 'Awaiting dispatch'}
            </div>
          )}
        </div>

        {patient && (
          <div className="bg-gray-950 border border-gray-800 p-4 rounded-xl space-y-3 flex-1 overflow-hidden flex flex-col">
            <h2 className="text-xs font-bold text-gray-500">Other hospitals (current responses)</h2>
            <div className="space-y-2 overflow-y-auto">
              {hospitals.filter(h => h.hospitalId !== destination?.hospitalId).map(h => {
                const forThisCase = h.operationalState?.acceptanceCaseId === patient.patientId;
                const l = acceptanceLabel(h.operationalState?.emergency === 'UNAVAILABLE' ? 'UNAVAILABLE' : forThisCase ? h.operationalState?.acceptance : undefined);
                return (
                  <div key={h.hospitalId} className="bg-gray-900 p-3 rounded border border-gray-800 flex justify-between items-center gap-2">
                    <div className="font-bold text-sm text-gray-300">{h.displayName}</div>
                    <span className={`text-[11px] px-2 py-0.5 rounded border whitespace-nowrap ${l.cls}`}>{l.text}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
