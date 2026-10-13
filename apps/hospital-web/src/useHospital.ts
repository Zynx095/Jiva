import { useCallback, useEffect, useRef, useState } from 'react';
import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import type { ConnectionState, EncounterRecord, JivaEvent, RosterEntry } from '@jiva/ui/src';
import { apiGet, socket } from './api';

export interface AcceptanceRequest {
  requestId: string;
  caseId: string;
  hospitalId: string;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  ambulanceEtaMinutes?: number;
  requestedAt: string;
  expiresAt: string;
}

const MAX_EVENTS = 200;

const sortNewest = (list: JivaEvent[]) => [...list].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
const dedupe = (list: JivaEvent[]) => {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.eventId) ? false : (seen.add(e.eventId), true)));
};

/** Everything this hospital may see. The API scopes every read and every socket event to this hospital. */
export function useHospital(onLiveEvent?: (e: JivaEvent) => void) {
  const [hospitalId, setHospitalId] = useState('');
  const [hospital, setHospital] = useState<HospitalState | null>(null);
  const [hospitals, setHospitals] = useState<HospitalState[]>([]);
  const [requests, setRequests] = useState<AcceptanceRequest[]>([]);
  const [patients, setPatients] = useState<PatientState[]>([]);
  const [ambulances, setAmbulances] = useState<AmbulanceState[]>([]);
  const [encounters, setEncounters] = useState<EncounterRecord[]>([]);
  const [roster, setRoster] = useState<RosterEntry[]>([]);
  const [events, setEvents] = useState<JivaEvent[]>([]);
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'live' : 'connecting');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const everConnected = useRef(socket.connected);
  const pending = useRef<number | undefined>(undefined);
  const liveRef = useRef(onLiveEvent);
  useEffect(() => {
    liveRef.current = onLiveEvent;
  }, [onLiveEvent]);

  const refresh = useCallback(async () => {
    try {
      const me = await apiGet<{ hospitalId?: string }>('/api/whoami');
      if (!me.hospitalId) {
        setError('This demo persona is not a hospital user. Open the console with ?as=demo-hosp-1 … demo-hosp-4.');
        setLoaded(true);
        return;
      }
      setHospitalId(me.hospitalId);
      const [hosps, reqs, pats, ambs, encs, staff] = await Promise.all([
        apiGet<HospitalState[]>('/api/hospitals'),
        apiGet<AcceptanceRequest[]>(`/api/hospitals/${me.hospitalId}/requests`),
        apiGet<PatientState[]>('/api/patients'),
        apiGet<AmbulanceState[]>('/api/ambulances'),
        apiGet<EncounterRecord[]>('/api/encounters'),
        apiGet<RosterEntry[]>(`/api/hospitals/${me.hospitalId}/clinicians`).catch(() => [] as RosterEntry[]),
      ]);
      setHospital(hosps.find((h) => h.hospitalId === me.hospitalId) || null);
      setHospitals(hosps);
      setRequests(reqs);
      setPatients(pats);
      setAmbulances(ambs);
      setEncounters(encs);
      setRoster(staff);
      setError(null);
      setLoaded(true);
      setLastSync(Date.now());
      return pats;
    } catch {
      setError('Cannot reach the JIVA API. Showing the last known state; retrying automatically.');
      return undefined;
    }
  }, []);

  /** Rebuild this hospital's history from the case timelines it is allowed to read. */
  const loadHistory = useCallback(async (pats: PatientState[] | undefined) => {
    if (!pats?.length) return;
    const lists = await Promise.all(pats.map((p) => apiGet<JivaEvent[]>(`/api/cases/${encodeURIComponent(p.patientId)}/timeline`).catch(() => [] as JivaEvent[])));
    setEvents((prev) => sortNewest(dedupe([...prev, ...lists.flat()])).slice(0, MAX_EVENTS));
  }, []);

  const scheduleRefresh = useCallback(() => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => void refresh(), 120);
  }, [refresh]);

  useEffect(() => {
    void refresh().then(loadHistory);
    const safety = window.setInterval(() => void refresh(), 15000);
    const onConnect = () => {
      everConnected.current = true;
      setConnection('live');
      void refresh().then(loadHistory);
    };
    const onDisconnect = () => setConnection('reconnecting');
    const onConnectError = () => setConnection(everConnected.current ? 'reconnecting' : 'offline');
    const onEvent = (event: JivaEvent) => {
      if (event.eventType === 'demo.reset') setEvents([event]);
      else setEvents((prev) => (prev.some((e) => e.eventId === event.eventId) ? prev : [event, ...prev].slice(0, MAX_EVENTS)));
      setLastSync(Date.now());
      liveRef.current?.(event);
      scheduleRefresh(); // server only sends this hospital's events
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
  }, [refresh, loadHistory, scheduleRefresh]);

  return { hospitalId, hospital, hospitals, requests, patients, ambulances, encounters, roster, events, connection, lastSync, loaded, error, refresh };
}
