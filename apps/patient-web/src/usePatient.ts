import { useCallback, useEffect, useRef, useState } from 'react';
import type { AmbulanceState, HospitalState, PatientState } from '@jiva/domain-models';
import type { ConnectionState, DocumentRecord, EncounterRecord, JivaEvent, PatientPrescription, PatientReport } from '@jiva/ui/src';
import { apiGet, socket } from './api';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * The patient's own records for one encounter, as the API releases them. `null` = could not be loaded
 * (shown as "unavailable", never as "none"). Held in memory only and keyed by the encounter: they are
 * dropped as soon as the encounter changes or disappears, so nothing outlives the session or its case.
 */
export interface PatientRecords {
  encounterId: string;
  prescriptions: PatientPrescription[] | null;
  reports: PatientReport[] | null;
  documents: DocumentRecord[] | null;
}

const enc = encodeURIComponent;

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
  // The hospital's own record of this patient's stay (arrival, handover, doctor). Only the hospital creates it.
  const [encounter, setEncounter] = useState<EncounterRecord | null>(null);
  const [records, setRecords] = useState<PatientRecords | null>(null);
  const encounterRef = useRef<string | undefined>(undefined);
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

  /** What the hospital has released to the patient: prescriptions, shared reports, shared documents. */
  const loadRecords = useCallback(async (encounterId: string) => {
    const [prescriptions, reports, documents] = await Promise.all([
      apiGet<PatientPrescription[]>(`/api/encounters/${enc(encounterId)}/prescriptions`).catch(() => null),
      apiGet<PatientReport[]>(`/api/encounters/${enc(encounterId)}/reports`).catch(() => null),
      apiGet<DocumentRecord[]>(`/api/encounters/${enc(encounterId)}/documents`).catch(() => null),
    ]);
    if (encounterRef.current !== encounterId) return;
    setRecords({ encounterId, prescriptions, reports, documents });
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const [pats, ambs, hosps, encs] = await Promise.all([
        apiGet<PatientState[]>('/api/patients'),
        apiGet<AmbulanceState[]>('/api/ambulances'),
        apiGet<HospitalState[]>('/api/hospitals'),
        apiGet<EncounterRecord[]>('/api/encounters'),
      ]);
      const me = pats[0] || null;
      const myAmb = ambs[0] || null;
      const stay = encs[0] || null;
      setPatient(me);
      setAmbulance(myAmb);
      setEncounter(stay);
      setHospitals(hosps);
      // The hospital that recorded the arrival, else the ambulance's destination.
      const hospitalId = stay?.hospitalId ?? myAmb?.destinationHospital;
      setHospital(hospitalId ? hosps.find((h) => h.hospitalId === hospitalId) || null : null);
      setLoad('ready');
      setSyncedAt(Date.now());
      if (stay?.encounterId !== encounterRef.current) {
        encounterRef.current = stay?.encounterId;
        setRecords(null); // never show one encounter's records under another
      }
      if (stay) void loadRecords(stay.encounterId);
      if (me && me.patientId !== caseRef.current) {
        caseRef.current = me.patientId;
        apiGet<JivaEvent[]>(`/api/cases/${encodeURIComponent(me.patientId)}/timeline`)
          .then((list) => setEvents((prev) => mergeNewest(prev, list)))
          .catch(() => undefined);
      }
    } catch {
      setLoad('error');
    }
  }, [loadRecords]);

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
        encounterRef.current = undefined;
        setEvents([]);
        setEncounter(null);
        setRecords(null);
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

  return { patient, ambulance, hospital, encounter, records, hospitals, events, load, connection, syncedAt, refresh: fetchState };
}
