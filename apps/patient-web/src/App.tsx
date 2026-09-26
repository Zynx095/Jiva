import { useCallback, useEffect, useState } from 'react';
import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import { apiGet, socket, PERSONA } from './api';

type LoadState = 'loading' | 'ready' | 'error';

export default function App() {
  const [patient, setPatient] = useState<PatientState | null>(null);
  const [ambulance, setAmbulance] = useState<AmbulanceState | null>(null);
  const [hospital, setHospital] = useState<HospitalState | null>(null);
  const [connected, setConnected] = useState(socket.connected);
  const [load, setLoad] = useState<LoadState>('loading');
  const [syncedAt, setSyncedAt] = useState<Date | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [, tick] = useState(0);

  // The server scopes every response to this patient's own case.
  const fetchState = useCallback(async () => {
    try {
      const [pats, ambs] = await Promise.all([
        apiGet<PatientState[]>('/api/patients'),
        apiGet<AmbulanceState[]>('/api/ambulances'),
      ]);
      const me = pats[0] || null;
      const myAmb = ambs[0] || null;
      setPatient(me);
      setAmbulance(myAmb);
      if (myAmb?.destinationHospital) {
        const hosps = await apiGet<HospitalState[]>('/api/hospitals');
        setHospital(hosps.find(h => h.hospitalId === myAmb.destinationHospital) || null);
      } else {
        setHospital(null);
      }
      setLoad('ready');
      setSyncedAt(new Date());
    } catch {
      setLoad('error');
    }
  }, []);

  useEffect(() => {
    fetchState();
    const onConnect = () => { setConnected(true); fetchState(); };
    const onDisconnect = () => setConnected(false);
    const onEvent = (event: any) => {
      if (event.eventType === 'demo.reset') { setNotice(null); setSummary(null); }
      if (event.eventType === 'destination.changed' && event.payload.hospitalId !== 'UNASSIGNED' && event.payload.reason?.match(/UNAVAILABLE|REJECTED|expired/i)) {
        setNotice('Your destination hospital changed so you reach a hospital that can treat you now.');
      }
      if (event.eventType === 'ai.summary.generated') setSummary(event.payload.briefSummary);
      fetchState();
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('event', onEvent);
    setConnected(socket.connected); // the socket may have connected before these listeners existed
    const t = setInterval(() => tick(x => x + 1), 5000);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('event', onEvent);
      clearInterval(t);
    };
  }, [fetchState]);

  const route = ambulance?.activeRoute && ambulance.activeRoute.hospitalId === ambulance.destinationHospital ? ambulance.activeRoute : undefined;
  const acceptance = hospital?.operationalState?.acceptance;
  const arrived = ambulance?.status === 'ARRIVED' || patient?.currentStatus === 'ARRIVED';
  const secondsAgo = syncedAt ? Math.round((Date.now() - syncedAt.getTime()) / 1000) : null;

  const journey = [
    { label: 'Emergency reported', done: !!patient },
    { label: 'Ambulance dispatched', done: !!ambulance },
    { label: 'Hospital confirmed it can receive you', done: acceptance === 'ACCEPTED' || acceptance === 'LIMITED' },
    { label: 'On the way to hospital', done: ambulance?.status === 'EN_ROUTE_TO_HOSPITAL' || arrived },
    { label: 'Arrived at hospital', done: arrived },
  ];

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 font-sans p-4 md:p-8 flex items-center justify-center">
      <div className="max-w-md w-full bg-white rounded-3xl shadow-xl overflow-hidden border border-gray-100">
        <div className="bg-blue-600 text-white p-6 pb-8 text-center rounded-b-[40px] shadow-sm relative">
          <h1 className="text-2xl font-bold tracking-tight mb-1">JIVA</h1>
          <p className="text-blue-100 text-sm font-medium">Your care journey</p>
          <div className="mt-5 inline-block bg-blue-700/50 px-4 py-1.5 rounded-full text-sm font-semibold border border-blue-500/30">
            {patient?.patientId || 'No active case'}
          </div>
          <div className="mt-3 flex justify-center gap-2 text-[11px]">
            <span className={`px-2 py-0.5 rounded-full ${connected ? 'bg-emerald-500/30 text-emerald-50' : 'bg-red-500/40 text-white'}`}>
              {connected ? 'Live updates on' : 'Reconnecting… information may be out of date'}
            </span>
            <span className="px-2 py-0.5 rounded-full bg-amber-400/30 text-amber-50">Demo data</span>
          </div>
        </div>

        <div className="px-6 py-8 space-y-6 -mt-4">
          {load === 'error' && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl p-4">
              Can't reach JIVA right now. We'll keep trying — call 108 if you need help.
            </div>
          )}

          {notice && (
            <div role="status" className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded-xl p-4">{notice}</div>
          )}

          {ambulance ? (
            <div className="bg-blue-50 rounded-2xl p-5 border border-blue-100 shadow-sm">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-10 h-10 bg-blue-100 rounded-full flex items-center justify-center text-xl" aria-hidden="true">🚑</div>
                <div>
                  <h2 className="font-bold text-blue-900">{arrived ? 'You have arrived' : 'Help is on the way'}</h2>
                  <p className="text-sm text-blue-700">Ambulance {ambulance.ambulanceId}</p>
                </div>
              </div>
              <div className="mt-4 pt-4 border-t border-blue-200/50 flex justify-between items-end">
                <div className="text-xs text-blue-600 font-semibold">Estimated arrival at hospital</div>
                <div className="text-3xl font-black text-blue-700">
                  {arrived ? '0' : route ? Math.ceil(route.durationSeconds / 60) : '--'}
                  <span className="text-lg font-medium text-blue-600 ml-1">min</span>
                </div>
              </div>
              {route?.synthetic && !arrived && (
                <p className="text-[11px] text-blue-500 mt-2">Estimate from demo routing, without live traffic.</p>
              )}
            </div>
          ) : (
            <div className="bg-gray-100 rounded-2xl p-5 border border-gray-200 text-center text-gray-500">
              {load === 'loading' ? 'Loading…' : patient ? 'Finding the nearest ambulance…' : 'No active emergency.'}
            </div>
          )}

          <div>
            <h3 className="text-xs font-bold text-gray-500 mb-3 px-2">Destination</h3>
            {hospital ? (
              <div className={`bg-white border-2 rounded-2xl p-5 shadow-sm ${acceptance === 'ACCEPTED' ? 'border-emerald-100' : 'border-amber-100'}`}>
                <h4 className="font-bold text-gray-800 text-lg mb-1">{hospital.displayName}</h4>
                {acceptance === 'ACCEPTED' ? (
                  <div className="flex items-center gap-2 text-emerald-700 font-medium text-sm">
                    <span className="w-2 h-2 rounded-full bg-emerald-500" aria-hidden="true" />Confirmed it can receive you
                  </div>
                ) : acceptance === 'LIMITED' ? (
                  <div className="flex items-center gap-2 text-amber-700 font-medium text-sm">
                    <span className="w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />Can receive you with some limits
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-gray-600 font-medium text-sm">
                    <span className="w-2 h-2 rounded-full bg-gray-400" aria-hidden="true" />Waiting for the hospital to confirm
                  </div>
                )}
                {hospital.operationalState?.lastConfirmedAt && (
                  <div className="text-xs text-gray-500 border-t border-gray-100 pt-3 mt-4">
                    Confirmed at {new Date(hospital.operationalState.lastConfirmedAt).toLocaleTimeString()}
                  </div>
                )}
              </div>
            ) : (
              <div className="bg-gray-50 border border-dashed border-gray-300 rounded-2xl p-5 text-sm text-gray-500">
                {ambulance ? 'Checking which hospital can receive you now…' : 'A hospital will be chosen once one confirms it can treat you.'}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-xs font-bold text-gray-500 mb-4 px-2">Your journey</h3>
            <ol className="px-2 relative">
              <div className="absolute left-[13px] top-2 bottom-2 w-0.5 bg-gray-100" aria-hidden="true" />
              {journey.map((step, i) => {
                const isCurrent = step.done && !journey[i + 1]?.done;
                return (
                  <li key={step.label} className={`flex items-start gap-4 py-3 relative ${step.done ? '' : 'opacity-40'}`}>
                    <div className={`w-3 h-3 rounded-full mt-1.5 flex-shrink-0 border-2 ${step.done ? (isCurrent ? 'bg-blue-500 border-blue-200 ring-4 ring-blue-50' : 'bg-blue-500 border-blue-500') : 'bg-white border-gray-300'}`} />
                    <div className={`text-sm ${isCurrent ? 'text-blue-700 font-bold' : step.done ? 'text-gray-800 font-medium' : 'text-gray-500'}`}>{step.label}</div>
                  </li>
                );
              })}
            </ol>
          </div>

          {summary && (
            <div className="bg-indigo-50 border border-indigo-100 rounded-xl p-4 text-sm text-indigo-900">
              <div className="text-xs font-bold text-indigo-600 mb-1">Summary (AI-generated, for information only)</div>
              {summary}
            </div>
          )}

          <p className="text-[11px] text-gray-400 text-center">
            {secondsAgo !== null ? `Updated ${secondsAgo < 5 ? 'just now' : `${secondsAgo}s ago`}` : ''} · signed in as demo persona {PERSONA}
          </p>
        </div>
      </div>
    </div>
  );
}
