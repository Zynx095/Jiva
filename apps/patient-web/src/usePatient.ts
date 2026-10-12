import { useCallback, useEffect, useRef, useState } from 'react';
import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import type { ConnectionState, JivaEvent } from '@jiva/ui/src';
import { apiGet, socket } from './api';

type LoadState = 'loading' | 'ready' | 'error';

const mergeNewest = (a: JivaEvent[], b: JivaEvent[]) => {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
    .sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp))
    .slice(0, 150);
};

/** The patient's own case only — the server scopes every response and event to it. */
export function usePatient(onLiveEvent?: (e: JivaEvent) => void) {
  const [patient, setPatient] = useState<PatientState | null>(null);
  const [ambulance, setAmbulance] = useState<AmbulanceState | null>(null);
  const [hospital, setHospital] = useState<HospitalState | null>(null);
  const [hospitals, setHospitals] = useState<HospitalState[]>([]);
  const [events, setEvents] = useState<JivaEvent[]>([]);
  const [load, setLoad] = useState<LoadState>('loading');
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'live' : 'connecting');
  const [syncedAt, setSyncedAt] = useState<number | null>(null);
  const everConnected = useRef(socket.connected);
  const caseRef = useRef<string | undefined>(undefined);
  const pending = useRef<number | undefined>(undefined);
  const liveRef = useRef(onLiveEvent);
  useEffect(() => {
    liveRef.current = onLiveEvent;
  }, [onLiveEvent]);

  const fetchState = useCallback(async () => {
    try {
      const [pats, ambs, hosps] = await Promise.all([
        apiGet<PatientState[]>('/api/patients'),
        apiGet<AmbulanceState[]>('/api/ambulances'),
        apiGet<HospitalState[]>('/api/hospitals'),
      ]);
      const me = pats[0] || null;
      const myAmb = ambs[0] || null;
      setPatient(me);
      setAmbulance(myAmb);
      setHospitals(hosps);
      setHospital(myAmb?.destinationHospital ? hosps.find((h) => h.hospitalId === myAmb.destinationHospital) || null : null);
      setLoad('ready');
      setSyncedAt(Date.now());
      if (me && me.patientId !== caseRef.current) {
        caseRef.current = me.patientId;
        apiGet<JivaEvent[]>(`/api/cases/${encodeURIComponent(me.patientId)}/timeline`)
          .then((list) => setEvents((prev) => mergeNewest(prev, list)))
          .catch(() => undefined);
      }
    } catch {
      setLoad('error');
    }
  }, []);

  useEffect(() => {
    void fetchState();
    const safety = window.setInterval(() => void fetchState(), 15000);
    const onConnect = () => {
      everConnected.current = true;
      setConnection('live');
      caseRef.current = undefined;
      void fetchState();
    };
    const onDisconnect = () => setConnection('reconnecting');
    const onConnectError = () => setConnection(everConnected.current ? 'reconnecting' : 'offline');
    const onEvent = (event: JivaEvent) => {
      if (event.eventType === 'demo.reset') {
        caseRef.current = undefined;
        setEvents([]);
      } else {
        setEvents((prev) => mergeNewest([event], prev));
      }
      liveRef.current?.(event);
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => void fetchState(), 120);
    };
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('event', onEvent);
    if (socket.connected) {
      everConnected.current = true;
      setConnection('live');
    }
    return () => {
      window.clearInterval(safety);
      window.clearTimeout(pending.current);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('event', onEvent);
    };
  }, [fetchState]);

  return { patient, ambulance, hospital, hospitals, events, load, connection, syncedAt, refresh: fetchState };
}
