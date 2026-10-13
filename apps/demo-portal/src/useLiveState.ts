import { useCallback, useEffect, useRef, useState } from 'react';
import type { AmbulanceState, PatientState } from '@jiva/domain-models';
import type { ConnectionState, EncounterRecord, ReferralOverview } from '@jiva/ui/src';
import { API_URL, call, socket } from './api';
import { DEMO } from './workflows';

/** The routing provider in plain words. Before the first route the API has not chosen one yet. */
export function routingText(m: { provider?: string; synthetic?: boolean; chain?: string[] } | undefined): string {
  if (!m?.provider) return 'unknown';
  if (m.synthetic || m.provider === 'mock') return 'mock (synthetic routes, labelled; no live traffic)';
  if (m.provider === 'none-yet') return `no route computed yet — tries ${(m.chain ?? []).join(' → ') || 'the configured providers'}; without a routing server it uses synthetic routes`;
  return m.provider;
}

export interface Health {
  status?: string;
  mode?: 'DEMO' | 'OPERATIONAL';
  provenance?: {
    statement?: string;
    liveIntegrations?: Record<string, boolean>;
    providers?: { telemetry?: { simulator?: boolean; medicalDevices?: boolean }; positions?: { manual?: boolean; simulator?: boolean; deviceGps?: boolean } };
  };
  components?: { mapping?: { provider?: string; synthetic?: boolean; chain?: string[] }; realtime?: { activeConnections?: number }; ai?: { provider?: string; generator?: string } };
}

export interface LiveState {
  health: Health | null;
  apiReachable: boolean | null;
  connection: ConnectionState;
  caseState: PatientState | null;
  ambulance: AmbulanceState | null;
  encounter: EncounterRecord | null;
  referrals: ReferralOverview | null;
  /** Increments on every refresh: views that read more state reload with it. */
  version: number;
  refresh: () => void;
}

/**
 * What the portal shows about the demo case, read from the API as the personas allowed to read it
 * (management for network state, the receiving hospital's coordinator for the encounter). Refreshed on
 * every realtime event and every few seconds; nothing is derived on the client.
 */
export function useLiveState(): LiveState {
  const [health, setHealth] = useState<Health | null>(null);
  const [apiReachable, setApiReachable] = useState<boolean | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(socket.connected ? 'live' : 'connecting');
  const [caseState, setCaseState] = useState<PatientState | null>(null);
  const [ambulance, setAmbulance] = useState<AmbulanceState | null>(null);
  const [encounter, setEncounter] = useState<EncounterRecord | null>(null);
  const [referrals, setReferrals] = useState<ReferralOverview | null>(null);
  const [version, setVersion] = useState(0);
  const everConnected = useRef(socket.connected);
  const pending = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const h = (await (await fetch(`${API_URL}/api/health`)).json()) as Health;
      setHealth(h);
      setApiReachable(true);
      if (h.mode !== 'DEMO') return; // nothing else is read outside demo mode
      const [pats, ambs, encs] = await Promise.all([
        call<PatientState[]>(DEMO.management, 'GET', '/api/patients'),
        call<AmbulanceState[]>(DEMO.management, 'GET', '/api/ambulances'),
        call<EncounterRecord[]>(DEMO.management, 'GET', `/api/encounters?caseId=${DEMO.caseId}`),
      ]);
      setCaseState((Array.isArray(pats.body) ? pats.body : []).find((p) => p.patientId === DEMO.caseId) ?? null);
      const units = Array.isArray(ambs.body) ? ambs.body : [];
      setAmbulance(units.find((a) => a.assignedPatient === DEMO.caseId) ?? units.find((a) => a.ambulanceId === DEMO.crew.ambulanceId) ?? null);
      const summary = Array.isArray(encs.body) ? encs.body[0] : undefined;
      if (summary) {
        // The full encounter (doctor, history) is read as the coordinator of the receiving hospital.
        const persona = DEMO.hospitals[summary.hospitalId]?.persona ?? (summary.hospitalId === 'HOSP-BLR-003' ? 'demo-hosp-3' : undefined);
        const full = persona ? await call<EncounterRecord>(persona, 'GET', `/api/encounters/${summary.encounterId}`) : undefined;
        setEncounter(full?.ok ? full.body : summary);
      } else setEncounter(null);
      const ref = await call<ReferralOverview>(DEMO.management, 'GET', `/api/cases/${DEMO.caseId}/referrals`);
      setReferrals(ref.ok ? ref.body : null);
      setVersion((v) => v + 1);
    } catch {
      setApiReachable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = window.setInterval(() => void refresh(), 4000);
    const onConnect = () => {
      everConnected.current = true;
      setConnection('live');
      void refresh();
    };
    const onDisconnect = () => setConnection('reconnecting');
    const onConnectError = () => setConnection(everConnected.current ? 'reconnecting' : 'offline');
    const onEvent = () => {
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => void refresh(), 200);
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
      window.clearInterval(t);
      window.clearTimeout(pending.current);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.off('event', onEvent);
    };
  }, [refresh]);

  return { health, apiReachable, connection, caseState, ambulance, encounter, referrals, version, refresh: () => void refresh() };
}
