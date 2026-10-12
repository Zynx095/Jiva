import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionState } from '@jiva/ui/src';
import { API_URL, apiGet, socket } from './api';
import type { AmbulanceState, Health, HospitalState, JivaEvent, PatientState } from './types';

const MAX_EVENTS = 400;

const mergeEvent = (list: JivaEvent[], e: JivaEvent) => (list.some((x) => x.eventId === e.eventId) ? list : [e, ...list].slice(0, MAX_EVENTS));

/** Ledger entries can repeat (an external event is recorded on ingest and again on the bus). */
const dedupe = (list: JivaEvent[]) => {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)));
};

/**
 * Network state for the command center: REST snapshots, the event ledger and the live Socket.IO
 * stream. Every live event triggers a short debounced resync, so the screen never drifts from the API.
 */
export function useNetwork(onLiveEvent?: (e: JivaEvent) => void) {
  const [patients, setPatients] = useState<PatientState[]>([]);
  const [hospitals, setHospitals] = useState<HospitalState[]>([]);
  const [ambulances, setAmbulances] = useState<AmbulanceState[]>([]);
  const [events, setEvents] = useState<JivaEvent[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'live' : 'connecting');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const pending = useRef<number | undefined>(undefined);
  const everConnected = useRef(socket.connected);
  const liveRef = useRef(onLiveEvent);
  useEffect(() => {
    liveRef.current = onLiveEvent;
  }, [onLiveEvent]);

  const fetchState = useCallback(async () => {
    try {
      const [p, h, a] = await Promise.all([
        apiGet<PatientState[]>('/api/patients'),
        apiGet<HospitalState[]>('/api/hospitals'),
        apiGet<AmbulanceState[]>('/api/ambulances'),
      ]);
      setPatients(p);
      setHospitals(h);
      setAmbulances(a);
      setLoaded(true);
      setLoadError(null);
      setLastSync(Date.now());
    } catch {
      setLoadError('Cannot reach the JIVA API. Showing the last known state; retrying automatically.');
    }
  }, []);

  const scheduleFetch = useCallback(() => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(fetchState, 120);
  }, [fetchState]);

  // Rebuild the stream from the server ledger (on load / reconnect) so nothing is missed.
  const fetchLedger = useCallback(() => {
    apiGet<JivaEvent[]>('/api/events/history?limit=400')
      .then((list) => setEvents(dedupe(list)))
      .catch(() => undefined);
  }, []);

  const fetchHealth = useCallback(() => {
    fetch(`${API_URL}/api/health`)
      .then((res) => res.json() as Promise<Health>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    fetchState();
    fetchLedger();
    fetchHealth();
    const healthInterval = window.setInterval(fetchHealth, 5000);
    // Safety net: resync periodically even if an event is missed.
    const stateInterval = window.setInterval(fetchState, 15000);

    const onConnect = () => {
      everConnected.current = true;
      setConnection('live');
      fetchState();
      fetchLedger();
    };
    const onDisconnect = () => setConnection('reconnecting');
    const onConnectError = () => setConnection(everConnected.current ? 'reconnecting' : 'offline');
    const onEvent = (event: JivaEvent) => {
      if (event.eventType === 'demo.reset') {
        setEvents([event]);
        fetchState();
      } else {
        setEvents((prev) => mergeEvent(prev, event));
        scheduleFetch();
      }
      setLastSync(Date.now());
      liveRef.current?.(event);
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.on('event', onEvent);
    // The socket may have connected before these listeners existed.
    if (socket.connected) {
      everConnected.current = true;
      setConnection('live');
    }

    return () => {
      window.clearInterval(healthInterval);
      window.clearInterval(stateInterval);
      window.clearTimeout(pending.current);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('event', onEvent);
    };
  }, [fetchState, fetchLedger, fetchHealth, scheduleFetch]);

  return { patients, hospitals, ambulances, events, health, connection, lastSync, loaded, loadError, refresh: fetchState };
}
