import { useCallback, useEffect, useState } from 'react';
import type { HospitalState } from '@jiva/domain-models';
import { apiGet, apiPost, socket, PERSONA } from './api';

interface AcceptanceRequest {
  requestId: string;
  caseId: string;
  hospitalId: string;
  requiredCapabilities: string[];
  optionalCapabilities: string[];
  ambulanceEtaMinutes?: number;
  requestedAt: string;
  expiresAt: string;
}

const statusColor = (s?: string) =>
  s === 'AVAILABLE' || s === 'ACCEPTED' ? 'text-green-400'
  : s === 'LIMITED' ? 'text-yellow-400'
  : s === 'UNAVAILABLE' || s === 'REJECTED' ? 'text-red-400'
  : 'text-gray-400';

export default function App() {
  const [hospitalId, setHospitalId] = useState<string>('');
  const [requests, setRequests] = useState<AcceptanceRequest[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [hospital, setHospital] = useState<HospitalState | null>(null);
  const [aiHandoffs, setAiHandoffs] = useState<any[]>([]);
  const [connected, setConnected] = useState(socket.connected);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await apiGet<{ hospitalId?: string }>('/api/whoami');
      if (!me.hospitalId) return setMessage('This persona is not a hospital user.');
      setHospitalId(me.hospitalId);
      const [hosps, reqs] = await Promise.all([
        apiGet<HospitalState[]>('/api/hospitals'),
        apiGet<AcceptanceRequest[]>(`/api/hospitals/${me.hospitalId}/requests`),
      ]);
      setHospital(hosps.find(h => h.hospitalId === me.hospitalId) || null);
      setRequests(reqs);
    } catch {
      setMessage('Cannot reach JIVA API. Showing last known state.');
    }
  }, []);

  useEffect(() => {
    refresh();
    const onConnect = () => { setConnected(true); setMessage(null); refresh(); };
    const onDisconnect = () => setConnected(false);
    const onEvent = (event: any) => {
      if (event.eventType === 'demo.reset') { setHistory([]); setAiHandoffs([]); }
      if (event.eventType === 'ai.handoff.generated') setAiHandoffs(prev => [event.payload, ...prev].slice(0, 5));
      refresh(); // server only sends this hospital's events
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
  }, [refresh]);

  const respond = async (req: AcceptanceRequest, status: 'ACCEPTED' | 'LIMITED' | 'REJECTED', limitations: string[] = []) => {
    const respondedAt = new Date().toISOString();
    const payload = {
      responseId: `RESP-${crypto.randomUUID().substring(0, 8)}`,
      requestId: req.requestId,
      caseId: req.caseId,
      hospitalId,
      status,
      acceptedCapabilities: status === 'REJECTED' ? [] : req.requiredCapabilities,
      limitations,
      respondedAt,
      validUntil: new Date(Date.now() + 30 * 60000).toISOString(),
      responderRole: 'CLINICAL_COORDINATOR',
      source: 'SYNTHETIC_DEMO',
    };
    const res = await apiPost('/api/events', {
      eventId: crypto.randomUUID(),
      eventType: 'hospital.acceptance.received',
      timestamp: respondedAt,
      source: { type: 'hospital', id: hospitalId },
      version: '1.0',
      payload,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setMessage(`Response not recorded: ${body.message || body.error || res.status}`);
      return;
    }
    setMessage(null);
    setHistory(prev => [{ ...payload, time: respondedAt }, ...prev].slice(0, 10));
    refresh();
  };

  const reportCapacity = async (status: 'AVAILABLE' | 'UNAVAILABLE') => {
    const res = await apiPost('/api/events', {
      eventId: crypto.randomUUID(),
      eventType: 'hospital.capacity.updated',
      timestamp: new Date().toISOString(),
      source: { type: 'hospital', id: hospitalId },
      version: '1.0',
      payload: { hospitalId, emergencyStatus: status, traumaStatus: status, icuStatus: status, ventilatorStatus: 'UNKNOWN' },
      metadata: { confidence: 1, sourceType: 'SYNTHETIC_DEMO' },
    });
    if (!res.ok) setMessage(`Capacity update rejected (${res.status}).`);
    refresh();
  };

  const op = hospital?.operationalState;

  return (
    <div className="min-h-screen bg-black text-white p-8">
      <div className="max-w-6xl mx-auto flex gap-8">
        <div className="flex-1">
          <div className="border-b border-gray-800 pb-4 mb-8 flex justify-between items-end">
            <div>
              <h1 className="text-2xl font-bold tracking-wider">JIVA HOSPITAL COMMAND</h1>
              <p className="text-gray-400">{hospital?.displayName || 'Loading…'} <span className="text-gray-600">({hospitalId || PERSONA})</span></p>
            </div>
            <div className="text-right">
              <div className={`flex items-center justify-end gap-2 ${connected ? 'text-emerald-500' : 'text-red-400'}`}>
                <div className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`} aria-hidden="true" />
                {connected ? 'CONNECTED' : 'DISCONNECTED — data may be stale'}
              </div>
              <div className="text-xs bg-orange-900/30 text-orange-500 border border-orange-500/50 px-2 py-1 rounded mt-2">
                SYNTHETIC DEMO / SIMULATED HOSPITAL RESPONSE
              </div>
            </div>
          </div>

          {message && <div role="alert" className="mb-4 p-3 rounded border border-red-800 bg-red-950/40 text-red-300 text-sm">{message}</div>}

          <h2 className="text-xl mb-4 font-semibold text-gray-300">Active emergency requests</h2>

          {requests.length === 0 ? (
            <div className="p-8 border border-dashed border-gray-800 text-center text-gray-500 rounded">
              No open acceptance requests for this hospital.
            </div>
          ) : (
            <div className="space-y-4">
              {requests.map(req => {
                const isExpired = new Date() > new Date(req.expiresAt);
                return (
                  <div key={req.requestId} className="border border-blue-900/50 bg-blue-950/20 p-6 rounded relative overflow-hidden">
                    <div className="absolute top-0 left-0 w-1 h-full bg-blue-500" />
                    <div className="flex justify-between items-start mb-6">
                      <div>
                        <h3 className="text-lg font-bold">Emergency request</h3>
                        <p className="text-sm text-gray-400">Case: {req.caseId}</p>
                        <p className="text-xs text-gray-500">Respond by {new Date(req.expiresAt).toLocaleTimeString()}</p>
                      </div>
                      <div className="text-xl font-bold text-yellow-500">ETA: {req.ambulanceEtaMinutes ?? '--'} min</div>
                    </div>
                    <div className="mb-6">
                      <h4 className="text-sm text-gray-500 mb-2">Required care</h4>
                      <div className="flex gap-2 flex-wrap">
                        {req.requiredCapabilities.map(c => (
                          <span key={c} className="bg-gray-900 border border-gray-700 px-3 py-1 rounded text-sm text-gray-300">{c}</span>
                        ))}
                      </div>
                    </div>
                    <div className="flex gap-3 pt-4 border-t border-gray-800">
                      <button onClick={() => respond(req, 'ACCEPTED')} disabled={isExpired} className="flex-1 bg-green-900 hover:bg-green-800 text-green-100 py-3 rounded font-bold disabled:opacity-50">Accept</button>
                      <button onClick={() => respond(req, 'LIMITED', ['ICU capacity limited'])} disabled={isExpired} className="flex-1 bg-yellow-900 hover:bg-yellow-800 text-yellow-100 py-3 rounded font-bold disabled:opacity-50">Accept with limits</button>
                      <button onClick={() => respond(req, 'REJECTED', ['Trauma service unavailable'])} disabled={isExpired} className="flex-1 bg-red-900 hover:bg-red-800 text-red-100 py-3 rounded font-bold disabled:opacity-50">Reject</button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="w-96 flex flex-col gap-6">
          <div className="border border-indigo-900 bg-indigo-950/20 p-4 rounded">
            <h2 className="text-sm font-semibold mb-1 text-indigo-300">✨ AI clinical handoffs</h2>
            <p className="text-[10px] text-indigo-400/70 mb-3">Advisory only — generated for patients routed to this hospital.</p>
            {aiHandoffs.length === 0 ? <p className="text-xs text-indigo-400/60">No incoming patient handoffs.</p> : (
              <div className="space-y-4">
                {aiHandoffs.map((h, i) => (
                  <div key={i} className="bg-indigo-950/50 p-3 rounded border border-indigo-900">
                    <div className="text-xs text-indigo-200 font-bold mb-2">Case: {h.patientId}</div>
                    <div className="text-xs text-indigo-300 mb-2">{h.summary}</div>
                    {h.criticalAlerts?.length > 0 && (
                      <ul className="text-[10px] text-red-300 list-disc pl-4 mb-2">{h.criticalAlerts.map((a: string) => <li key={a}>{a}</li>)}</ul>
                    )}
                    {h.recommendedPreparations?.length > 0 && (
                      <ul className="text-[10px] text-emerald-300 list-disc pl-4">{h.recommendedPreparations.map((p: string) => <li key={p}>{p}</li>)}</ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border border-gray-800 bg-gray-900 p-4 rounded">
            <h2 className="text-sm font-semibold mb-1 text-gray-400">Current operational status</h2>
            <p className="text-[10px] text-gray-500 mb-3">
              Source: {op?.source || 'UNKNOWN'}{op?.capacityAsOf ? ` · reported ${new Date(op.capacityAsOf).toLocaleTimeString()}` : ' · synthetic seed, not a live report'}
            </p>
            <div className="space-y-2 text-sm">
              {(['emergency', 'icu', 'trauma'] as const).map(k => (
                <div key={k} className="flex justify-between">
                  <span className="text-gray-500 capitalize">{k === 'icu' ? 'ICU' : k}:</span>
                  <span className={statusColor(op?.[k])}>{op?.[k] || 'UNKNOWN'}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-gray-800 pt-2 mt-2">
                <span className="text-gray-500 font-bold">Last response:</span>
                <span className={`${statusColor(op?.acceptance)} font-bold`}>{op?.acceptance || 'UNKNOWN'}</span>
              </div>
              {op?.expiresAt && (op.acceptance === 'ACCEPTED' || op.acceptance === 'LIMITED') && (
                <div className="text-[11px] text-gray-500 text-right">valid until {new Date(op.expiresAt).toLocaleTimeString()}</div>
              )}
            </div>
            <div className="flex gap-2 mt-4">
              <button onClick={() => reportCapacity('UNAVAILABLE')} className="flex-1 text-xs bg-red-950 border border-red-800 text-red-300 py-2 rounded hover:bg-red-900">Report ED unavailable</button>
              <button onClick={() => reportCapacity('AVAILABLE')} className="flex-1 text-xs bg-gray-800 border border-gray-700 text-gray-300 py-2 rounded hover:bg-gray-700">Report ED available</button>
            </div>
          </div>

          <div className="border border-gray-800 bg-gray-900 p-4 rounded flex-1 overflow-y-auto">
            <h2 className="text-sm font-semibold mb-4 text-gray-400">Response history</h2>
            {history.length === 0 ? <p className="text-xs text-gray-500">No responses sent from this screen.</p> : (
              <div className="space-y-3">
                {history.map((h, i) => (
                  <div key={i} className="text-xs border-b border-gray-800 pb-2 last:border-0">
                    <div className="flex justify-between text-gray-500 mb-1">
                      <span>{new Date(h.time).toLocaleTimeString()}</span>
                      <span className={statusColor(h.status)}>{h.status}</span>
                    </div>
                    <div className="text-gray-300">Case: {h.caseId}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
