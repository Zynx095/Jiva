import { useCallback, useEffect, useRef, useState } from 'react';
import type { HospitalState, PatientState } from '@jiva/domain-models';
import type {
  ClinicalNoteRecord, ConnectionState, DocumentRecord, EncounterRecord, JivaEvent, PrehospitalResponse, PrescriptionRecord, ReportRecord, RosterEntry, VitalsResponse,
} from '@jiva/ui/src';
import { apiGet, socket } from './api';

interface Me {
  userId: string;
  role: string;
  hospitalId?: string;
  practitionerId?: string;
}

/** Records of the selected encounter. `null` = could not be loaded (shown as such, never as "none"). */
export interface EncounterRecords {
  encounterId: string;
  prescriptions: PrescriptionRecord[] | null;
  reports: ReportRecord[] | null;
  notes: ClinicalNoteRecord[] | null;
  documents: DocumentRecord[] | null;
  vitals: VitalsResponse | null;
  prehospital: PrehospitalResponse | null;
  /** The case's recorded history as this clinician may see it (content-free events). */
  timeline: JivaEvent[] | null;
}

const enc = encodeURIComponent;

/**
 * The clinician's view: the encounters assigned to them (the API returns nothing else), those patients'
 * case summaries, and every record of the selected encounter — including what the ambulance crew recorded
 * before the handover. A patient reassigned to another doctor disappears from the list and their records
 * are dropped from memory on the next refresh.
 */
export function useClinician(onLiveEvent?: (e: JivaEvent) => void) {
  const [me, setMe] = useState<Me | null>(null);
  const [hospital, setHospital] = useState<HospitalState | null>(null);
  const [self, setSelf] = useState<RosterEntry | null>(null);
  const [encounters, setEncounters] = useState<EncounterRecord[]>([]);
  const [patients, setPatients] = useState<PatientState[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [records, setRecords] = useState<EncounterRecords | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'live' : 'connecting');
  const [lastSync, setLastSync] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const encountersRef = useRef<EncounterRecord[]>([]);
  const loadSeq = useRef(0);
  const appliedSeq = useRef(0);
  const everConnected = useRef(socket.connected);
  const pending = useRef<number | undefined>(undefined);
  const liveRef = useRef(onLiveEvent);
  useEffect(() => {
    liveRef.current = onLiveEvent;
  }, [onLiveEvent]);

  const loadRecords = useCallback(async (encounterId: string) => {
    const seq = ++loadSeq.current;
    const caseId = encountersRef.current.find((e) => e.encounterId === encounterId)?.caseId;
    const base = `/api/encounters/${enc(encounterId)}`;
    const [prescriptions, reports, notes, documents, vitals, prehospital, timeline] = await Promise.all([
      apiGet<PrescriptionRecord[]>(`${base}/prescriptions`).catch(() => null),
      apiGet<ReportRecord[]>(`${base}/reports`).catch(() => null),
      apiGet<ClinicalNoteRecord[]>(`${base}/notes`).catch(() => null),
      apiGet<DocumentRecord[]>(`${base}/documents`).catch(() => null),
      apiGet<VitalsResponse>(`${base}/vitals`).catch(() => null),
      apiGet<PrehospitalResponse>(`${base}/prehospital`).catch(() => null),
      caseId ? apiGet<JivaEvent[]>(`/api/cases/${enc(caseId)}/timeline`).catch(() => null) : Promise.resolve(null),
    ]);
    if (selectedRef.current !== encounterId) return; // the selection changed meanwhile
    // A slower, older load (e.g. the periodic refresh started before a save) must not replace newer records.
    if (seq < appliedSeq.current) return;
    appliedSeq.current = seq;
    setRecords({ encounterId, prescriptions, reports, notes, documents, vitals, prehospital, timeline });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const who = await apiGet<Me>('/api/whoami');
      setMe(who);
      const [hosps, encs, pats, staff] = await Promise.all([
        apiGet<HospitalState[]>('/api/hospitals'),
        apiGet<EncounterRecord[]>('/api/encounters'),
        apiGet<PatientState[]>('/api/patients'),
        who.hospitalId ? apiGet<RosterEntry[]>(`/api/hospitals/${enc(who.hospitalId)}/clinicians`).catch(() => [] as RosterEntry[]) : Promise.resolve([] as RosterEntry[]),
      ]);
      setHospital(hosps.find((h) => h.hospitalId === who.hospitalId) ?? null);
      encountersRef.current = encs;
      setEncounters(encs);
      setPatients(pats);
      setSelf(staff.find((s) => s.practitionerId === who.practitionerId) ?? null);
      const current = selectedRef.current;
      const next = current && encs.some((e) => e.encounterId === current) ? current : (encs[0]?.encounterId ?? null);
      if (next !== current) {
        selectedRef.current = next;
        setSelectedId(next);
        setRecords(null);
      }
      if (next) void loadRecords(next);
      setError(null);
      setLoaded(true);
      setLastSync(Date.now());
    } catch {
      setError('Cannot reach the JIVA API. Showing the last known state; retrying automatically.');
    }
  }, [loadRecords]);

  const select = useCallback(
    (id: string) => {
      if (selectedRef.current === id) return;
      selectedRef.current = id;
      setSelectedId(id);
      setRecords(null);
      void loadRecords(id);
    },
    [loadRecords],
  );

  const reloadRecords = useCallback(() => {
    if (selectedRef.current) void loadRecords(selectedRef.current);
  }, [loadRecords]);

  useEffect(() => {
    void refresh();
    const safety = window.setInterval(() => void refresh(), 15000);
    const onConnect = () => {
      everConnected.current = true;
      setConnection('live');
      void refresh();
    };
    const onDisconnect = () => setConnection('reconnecting');
    const onConnectError = () => setConnection(everConnected.current ? 'reconnecting' : 'offline');
    const onEvent = (event: JivaEvent) => {
      setLastSync(Date.now());
      liveRef.current?.(event);
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => void refresh(), 150); // the server only sends this clinician's events
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
  }, [refresh]);

  return { me, hospital, self, encounters, patients, selectedId, select, records, reloadRecords, connection, lastSync, loaded, error, refresh };
}
