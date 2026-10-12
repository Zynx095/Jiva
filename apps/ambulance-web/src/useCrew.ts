import { useCallback, useEffect, useRef, useState } from 'react';
import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import type { ConnectionState, JivaEvent, ReferralOverview } from '@jiva/ui/src';
import { apiGet, socket } from './api';

const MAX_EVENTS = 200;

const mergeNewest = (a: JivaEvent[], b: JivaEvent[]) => {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)))
    .sort((x, y) => Date.parse(y.timestamp) - Date.parse(x.timestamp))
    .slice(0, MAX_EVENTS);
};

/** The crew's view: its own ambulance, its assigned case, hospital statuses and the case history. */
export function useCrew(onLiveEvent?: (e: JivaEvent) => void) {
  const [ambulance, setAmbulance] = useState<AmbulanceState | null>(null);
  const [patient, setPatient] = useState<PatientState | null>(null);
  const [hospitals, setHospitals] = useState<HospitalState[]>([]);
  const [events, setEvents] = useState<JivaEvent[]>([]);
  const [referrals, setReferrals] = useState<ReferralOverview | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'live' : 'connecting');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const pending = useRef<number | undefined>(undefined);
  const everConnected = useRef(socket.connected);
  const caseRef = useRef<string | undefined>(undefined);
  const liveRef = useRef(onLiveEvent);
  useEffect(() => {
    liveRef.current = onLiveEvent;
  }, [onLiveEvent]);

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
      setPatient(pats.find((p) => p.patientId === me?.assignedPatient) || null);
      setError(false);
      setLoaded(true);
      setLastSync(Date.now());
      const caseId = me?.assignedPatient;
      // Hospital answers for this case, from the server (survives reloads; replaces client-side replay).
      if (caseId) {
        apiGet<ReferralOverview>(`/api/cases/${encodeURIComponent(caseId)}/referrals`)
          .then(setReferrals)
          .catch(() => setReferrals((prev) => (prev?.caseId === caseId ? prev : null)));
      } else {
        setReferrals(null);
      }
      if (caseId && caseId !== caseRef.current) {
        caseRef.current = caseId;
        apiGet<JivaEvent[]>(`/api/cases/${encodeURIComponent(caseId)}/timeline`)
          .then((list) => setEvents((prev) => mergeNewest(prev, list)))
          .catch(() => undefined);
      }
    } catch {
      setError(true);
    }
  }, []);

  const scheduleFetch = useCallback(() => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(fetchState, 120);
  }, [fetchState]);

  useEffect(() => {
    void fetchState();
    const safety = window.setInterval(() => void fetchState(), 15000);
    const onConnect = () => {
      everConnected.current = true;
      setConnection('live');
      caseRef.current = undefined; // refetch the case history after a reconnect
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
      setLastSync(Date.now());
      liveRef.current?.(event);
      scheduleFetch();
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
  }, [fetchState, scheduleFetch]);

  return { ambulance, patient, hospitals, events, referrals, connection, lastSync, loaded, error, refresh: fetchState };
}
