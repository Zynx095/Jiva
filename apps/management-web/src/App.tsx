import { useEffect, useMemo, useRef, useState } from 'react';
import type { PatientState, HospitalState, AmbulanceState } from '@jiva/domain-models';
import { JivaMap } from '@jiva/ui/src/Map/JivaMap';
import { HospitalMarker } from '@jiva/ui/src/Map/HospitalMarker';
import { AmbulanceMarker } from '@jiva/ui/src/Map/AmbulanceMarker';
import { DemoSimulator } from './lib/simulator';
import { apiGet, socket, API_URL } from './api';

function App() {
  const [patients, setPatients] = useState<PatientState[]>([]);
  const [hospitals, setHospitals] = useState<HospitalState[]>([]);
  const [ambulances, setAmbulances] = useState<AmbulanceState[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [aiInsights, setAiInsights] = useState<any[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const pending = useRef<number | undefined>(undefined);
  const [isConnected, setIsConnected] = useState(false);
  const [selectedHospital, setSelectedHospital] = useState<HospitalState | null>(null);
  const [systemHealth, setSystemHealth] = useState<any>(null);

  const fetchState = () => {
    apiGet<PatientState[]>('/api/patients').then(setPatients).catch(() => {});
    apiGet<HospitalState[]>('/api/hospitals').then(setHospitals).catch(() => {});
    apiGet<AmbulanceState[]>('/api/ambulances').then(setAmbulances).catch(() => {});
  };
  const scheduleFetch = () => {
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(fetchState, 120);
  };
  // Rebuild the event stream from the server ledger (on load / reconnect) so nothing is missed.
  const fetchLedger = () => {
    apiGet<any[]>('/api/events/history?limit=200').then(list => {
      setEvents(list.filter(e => !e.eventType.startsWith('ai.')).slice(0, 100));
      setAiInsights(list.filter(e => e.eventType.startsWith('ai.')).slice(0, 50));
    }).catch(() => {});
  };

  const fetchHealth = () => {
    fetch(`${API_URL}/api/health`)
      .then(res => res.json())
      .then(setSystemHealth)
      .catch(() => setSystemHealth(null));
  };

  const control = async (action: () => Promise<string | null>) => {
    setControlError(await action().catch(e => String(e)));
  };

  useEffect(() => {
    fetchState();
    fetchLedger();
    fetchHealth();
    const healthInterval = setInterval(fetchHealth, 5000);

    setIsConnected(socket.connected);
    socket.on('connect', () => { setIsConnected(true); fetchState(); fetchLedger(); });
    socket.on('disconnect', () => setIsConnected(false));

    socket.on('event', (event: any) => {
      if (event.eventType === 'demo.reset') {
        setEvents([]);
        setAiInsights([]);
        fetchState();
        return;
      }
      if (event.eventType.startsWith('ai.')) {
        setAiInsights(prev => [event, ...prev].slice(0, 50));
      } else {
        setEvents(prev => (prev.some(e => e.eventId === event.eventId) ? prev : [event, ...prev].slice(0, 100)));
        scheduleFetch();
      }
    });

    return () => {
      clearInterval(healthInterval);
      socket.off('connect');
      socket.off('disconnect');
      socket.off('event');
    };
  }, []);

  const activeEmergencies = patients.filter(p => p.currentStatus !== 'DISCHARGED');
  const activeAmbulances = ambulances.filter(a => a.status !== 'AVAILABLE' && a.status !== 'UNAVAILABLE');
  const requests = events.filter(e => e.eventType === 'hospital.acceptance.requested');
  const accepted = hospitals.filter(h => h.operationalState?.acceptance === 'ACCEPTED');
  const answered = new Set(events.filter(e => e.eventType === 'hospital.acceptance.received').map(e => `${e.payload.caseId}|${e.payload.hospitalId}`));
  const awaiting = requests.filter(r => !answered.has(`${r.payload.caseId}|${r.payload.hospitalId}`));
  const routedAmbulance = ambulances.find(a => a.activeRoute && a.activeRoute.hospitalId === a.destinationHospital);
  const activeRoute = routedAmbulance?.activeRoute;
  const routeCoords = useMemo(() => activeRoute?.coordinates, [activeRoute?.calculatedAt]);
  const mapping = systemHealth?.components?.mapping;

  const advanceAmbulance = async () => {
    const amb = ambulances.find(a => a.ambulanceId === 'AMB-BLR-001');
    const pts = amb?.activeRoute?.coordinates;
    if (!amb?.currentLocation || !pts?.length) return 'Ambulance has no active route yet';
    const here = amb.currentLocation;
    const dist = (p: [number, number]) => Math.hypot(p[0] - here.longitude, p[1] - here.latitude);
    let idx = 0;
    pts.forEach((p, i) => { if (dist(p) < dist(pts[idx])) idx = i; });
    const next = pts[Math.min(idx + 1, pts.length - 1)];
    return DemoSimulator.moveAmbulance(amb.ambulanceId, next[1], next[0]);
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 font-sans flex flex-col h-screen overflow-hidden">
      <header className="px-6 py-3 border-b border-gray-800 flex justify-between items-center bg-gray-950">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-3">
            <span className="text-blue-500">●</span> JIVA COMMAND CENTER
          </h1>
          <p className="text-gray-400 text-xs mt-1 uppercase tracking-wider">Bengaluru Healthcare Coordination Network</p>
        </div>
        
        {/* System Health Area */}
        {/* System Health Area */}
        <div className="flex items-center gap-5 text-xs">
          <div className="flex flex-col items-end">
            <div className="text-gray-500 text-[10px]">EVENT BUS</div>
            <div className={systemHealth?.components?.eventBus?.status === 'HEALTHY' ? 'text-emerald-400 flex items-center gap-1' : 'text-yellow-500 flex items-center gap-1'}>
              <span className={`w-1.5 h-1.5 rounded-full ${systemHealth?.components?.eventBus?.status === 'HEALTHY' ? 'bg-emerald-500' : 'bg-yellow-500'}`}></span>
              {systemHealth?.components?.eventBus?.provider === 'AwsEventBridgeBus' ? 'EVENTBRIDGE' : 'LOCAL BUS'}
            </div>
          </div>

          <div className="flex flex-col items-end">
            <div className="text-gray-500 text-[10px]">DATABASE</div>
            <div className={systemHealth?.components?.database?.status === 'HEALTHY' ? 'text-emerald-400 flex items-center gap-1' : 'text-red-400 flex items-center gap-1'}>
              <span className={`w-1.5 h-1.5 rounded-full ${systemHealth?.components?.database?.status === 'HEALTHY' ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
              {systemHealth?.components?.database?.provider === 'DynamoStateStore' ? 'DYNAMODB' : 'LOCAL STORE'}
            </div>
          </div>

          <div className="flex flex-col items-end">
            <div className="text-gray-500 text-[10px]">REALTIME</div>
            <div className={isConnected ? "text-emerald-400 flex items-center gap-1" : "text-red-400 flex items-center gap-1"}>
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-red-500'}`}></span>
              {isConnected ? 'LIVE MESH' : 'OFFLINE'}
            </div>
          </div>

          <div className="flex flex-col items-end">
            <div className="text-gray-500 text-[10px]">MAPPING</div>
            <div className={`${mapping?.synthetic || !mapping ? 'text-amber-400' : 'text-emerald-400'} flex items-center gap-1`} title={mapping?.lastFallbackReason || ''}>
              <span className={`w-1.5 h-1.5 rounded-full ${mapping?.synthetic || !mapping ? 'bg-amber-500' : 'bg-emerald-500'}`}></span>
              {mapping ? `${String(mapping.provider).toUpperCase()}${mapping.synthetic ? ' (SYNTHETIC)' : ''}` : 'UNKNOWN'}
            </div>
          </div>

          <div className="flex flex-col items-end">
            <div className="text-gray-500 text-[10px]">AI SIDECAR</div>
            <div className="text-indigo-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-500"></span>
              {systemHealth?.components?.ai?.provider === 'BedrockAIProvider' ? 'BEDROCK' : 'MOCK AI'}
            </div>
          </div>

          <div className="flex flex-col items-end">
            <div className="text-gray-500 text-[10px]">INFRA MODE</div>
            <div className={systemHealth?.environment === 'aws-demo' ? 'text-blue-400 border border-blue-900 bg-blue-950/60 px-2 py-0.5 rounded font-mono text-[10px]' : 'text-orange-400 border border-orange-900 bg-orange-950/60 px-2 py-0.5 rounded font-mono text-[10px]'}>
              {systemHealth?.environment === 'aws-demo' ? 'AWS MESH' : 'LOCAL DEMO'}
            </div>
          </div>
        </div>
      </header>

      {/* TOP METRICS */}
      <div className="grid grid-cols-5 gap-4 px-6 py-3 bg-gray-900 border-b border-gray-800">
        <div className="flex flex-col">
          <span className="text-gray-500 text-[10px] uppercase">Active Emergencies</span>
          <span className="text-2xl font-bold text-white">{activeEmergencies.length.toString().padStart(2, '0')}</span>
        </div>
        <div className="flex flex-col border-l border-gray-800 pl-4">
          <span className="text-gray-500 text-[10px] uppercase">Ambulances Active</span>
          <span className="text-2xl font-bold text-white">{activeAmbulances.length.toString().padStart(2, '0')}</span>
        </div>
        <div className="flex flex-col border-l border-gray-800 pl-4">
          <span className="text-gray-500 text-[10px] uppercase">Hospital Requests</span>
          <span className="text-2xl font-bold text-white">{requests.length.toString().padStart(2, '0')}</span>
        </div>
        <div className="flex flex-col border-l border-gray-800 pl-4">
          <span className="text-gray-500 text-[10px] uppercase">Accepted</span>
          <span className="text-2xl font-bold text-emerald-400">{accepted.length.toString().padStart(2, '0')}</span>
        </div>
        <div className="flex flex-col border-l border-gray-800 pl-4">
          <span className="text-gray-500 text-[10px] uppercase">Awaiting response</span>
          <span className="text-2xl font-bold text-yellow-400">{awaiting.length.toString().padStart(2, '0')}</span>
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT PANEL - Map */}
        <div className="w-2/3 flex flex-col relative border-r border-gray-800">
          <div className="absolute top-4 left-4 z-10 flex gap-2">
            <div className="bg-black/80 p-2 rounded border border-gray-700 flex gap-2">
              <button className="px-3 py-1 bg-gray-800 text-xs rounded hover:bg-gray-700">Hospitals</button>
              <button className="px-3 py-1 bg-gray-800 text-xs rounded hover:bg-gray-700">Ambulances</button>
              <button className="px-3 py-1 bg-gray-800 text-xs rounded hover:bg-gray-700">Emergencies</button>
              <button className="px-3 py-1 bg-gray-800 text-xs rounded hover:bg-gray-700">Routes</button>
            </div>
          </div>
          
          <div className="flex-1 bg-gray-900 relative">
            <JivaMap
              routeCoordinates={routeCoords}
              routeMetadata={activeRoute}
            >
              {hospitals.map(h => (
                h.location && (
                  <HospitalMarker 
                    key={h.hospitalId} 
                    hospitalId={h.hospitalId} 
                    name={h.displayName} 
                    lat={h.location.latitude} 
                    lng={h.location.longitude} 
                    emergencyStatus={h.operationalState?.emergency === 'UNAVAILABLE' ? 'UNAVAILABLE' : h.operationalState?.acceptance || 'UNKNOWN'}
                    dataStatus={h.dataStatus}
                  />
                )
              ))}
              {ambulances.map(a => (
                a.currentLocation && (
                  <AmbulanceMarker 
                    key={a.ambulanceId} 
                    ambulanceId={a.ambulanceId} 
                    lat={a.currentLocation.latitude} 
                    lng={a.currentLocation.longitude} 
                    status={a.status}
                  />
                )
              ))}
            </JivaMap>
          </div>
          
          {/* DEMO CONTROLS (Only visible in dev) */}
          <div className="absolute bottom-4 left-4 right-4 bg-gray-950/95 border border-gray-800 p-3 rounded-lg shadow-2xl z-10 backdrop-blur">
            <div className="flex justify-between items-center text-xs text-orange-400 mb-2 border-b border-gray-800 pb-1.5 font-mono">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></span>
                DEMO CONTROLS: each acts as the real actor through the event API
              </span>
              <span className="text-[10px] text-gray-500">Synthetic demo data</span>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              <button onClick={() => control(DemoSimulator.resetScenario)} className="bg-gray-800 hover:bg-gray-700 text-gray-300 border-gray-700 text-[11px] font-medium px-2 py-1.5 rounded border transition">Reset demo</button>
              <button onClick={() => control(DemoSimulator.startEmergency)} className="bg-blue-900/80 hover:bg-blue-800 border-blue-700/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Report emergency + dispatch</button>
              <button onClick={() => control(() => DemoSimulator.accept('HOSP-BLR-001'))} className="bg-emerald-900/80 hover:bg-emerald-800 border-emerald-700/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Hebbal (001) accepts</button>
              <button onClick={() => control(() => DemoSimulator.accept('HOSP-BLR-004'))} className="bg-emerald-900/80 hover:bg-emerald-800 border-emerald-700/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Indiranagar (004) accepts</button>
              <button onClick={() => control(() => DemoSimulator.limited('HOSP-BLR-002'))} className="bg-amber-900/80 hover:bg-amber-800 border-amber-700/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Whitefield (002) limited</button>
              <button onClick={() => control(() => DemoSimulator.reject('HOSP-BLR-002'))} className="bg-rose-950/80 hover:bg-rose-900 border-rose-800/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Whitefield (002) rejects</button>
              <button onClick={() => control(() => DemoSimulator.hospitalUnavailable('HOSP-BLR-001'))} className="bg-red-900/80 hover:bg-red-800 border-red-700/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Hebbal (001) ED unavailable</button>
              <button onClick={() => control(advanceAmbulance)} className="bg-teal-900/80 hover:bg-teal-800 border-teal-700/50 text-[11px] font-medium px-2 py-1.5 rounded border transition">Advance ambulance (GPS)</button>
            </div>
            {controlError && <div role="alert" className="mt-2 text-[11px] text-red-400">Control rejected by API: {controlError}</div>}
          </div>
        </div>

        {/* RIGHT PANEL - Sidebars */}
        <div className="w-1/3 flex flex-col bg-gray-950 overflow-hidden">
          {/* ACTIVE INCIDENTS */}
          <div className="h-1/3 overflow-y-auto border-b border-gray-800 p-4 custom-scrollbar">
            <h2 className="text-sm font-semibold mb-4 text-gray-300 uppercase tracking-wider">Active Incidents</h2>
            <div className="space-y-3">
              {activeEmergencies.map(p => {
                const assignedAmb = ambulances.find(a => a.assignedPatient === p.patientId);
                const destHosp = hospitals.find(h => h.hospitalId === assignedAmb?.destinationHospital);
                
                return (
                  <div key={p.patientId} className="p-3 bg-gray-900 border border-gray-800 rounded cursor-pointer hover:border-gray-600 transition-colors">
                    <div className="flex justify-between items-start mb-2">
                      <h3 className="font-bold text-white text-sm">{p.patientId}</h3>
                      <span className="text-[10px] px-2 py-0.5 rounded bg-blue-900/50 text-blue-400">{p.currentStatus}</span>
                    </div>
                    <div className="text-xs text-gray-400 mb-1">{p.activeConditions.join(', ')}</div>
                    <div className="text-[10px] text-gray-500 mb-2">Requires: {p.careRequirements.join(', ')}</div>
                    
                    {assignedAmb && (
                      <div className="mt-2 text-xs border-t border-gray-800 pt-2 flex items-center justify-between">
                        <div className="flex items-center gap-1 text-emerald-400">
                          🚑 {assignedAmb.ambulanceId}
                        </div>
                        {assignedAmb.status === 'ARRIVED' && destHosp ? (
                          <div className="text-emerald-300 text-right">Arrived · {destHosp.displayName}</div>
                        ) : destHosp ? (
                          <div className="text-gray-300 text-right">
                            → {destHosp.displayName} <span className={destHosp.operationalState?.acceptance === 'ACCEPTED' ? 'text-emerald-400' : 'text-amber-400'}>({destHosp.operationalState?.acceptance})</span>
                          </div>
                        ) : (
                          <div className="text-orange-400 text-right">
                            AWAITING DESTINATION
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
              {activeEmergencies.length === 0 && <p className="text-sm text-gray-600 text-center py-4">No active incidents.</p>}
            </div>
          </div>

          {/* AI INTELLIGENCE */}
          <div className="h-1/3 overflow-y-auto border-b border-gray-800 p-4 custom-scrollbar bg-indigo-950/20">
            <h2 className="text-sm font-semibold mb-4 text-indigo-300 uppercase tracking-wider flex items-center gap-2">
              <span>✨</span> AI sidecar, advisory only ({systemHealth?.components?.ai?.provider === 'BedrockAIProvider' ? 'Bedrock' : 'mock templates'})
            </h2>
            <div className="space-y-3">
              {aiInsights.map((insight, i) => (
                <div key={i} className="p-3 bg-indigo-950/40 border border-indigo-900 rounded">
                  <div className="flex justify-between text-indigo-400/50 mb-1 text-[10px]">
                    <span>{new Date(insight.timestamp).toLocaleTimeString()}</span>
                    <span>{insight.eventType}</span>
                  </div>
                  
                  {insight.eventType === 'ai.anomaly.explained' && (
                    <div>
                      <div className="text-xs font-bold text-red-400 mb-1">Anomaly Detected</div>
                      <div className="text-xs text-indigo-200 mb-2">{insight.payload.explanation}</div>
                      <div className="flex flex-wrap gap-1">
                        {insight.payload.suggestedActions.map((act: string, idx: number) => (
                          <span key={idx} className="px-2 py-0.5 bg-indigo-900/50 text-indigo-300 text-[10px] rounded">{act}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {insight.eventType === 'ai.handoff.generated' && (
                    <div>
                      <div className="text-xs font-bold text-emerald-400 mb-1">Clinical Handoff Ready</div>
                      <div className="text-xs text-indigo-200 mb-2">{insight.payload.summary}</div>
                      {insight.payload.criticalAlerts.length > 0 && (
                        <div className="text-[10px] text-red-300 mt-1">Alerts: {insight.payload.criticalAlerts.join(', ')}</div>
                      )}
                    </div>
                  )}

                  {insight.eventType === 'ai.summary.generated' && (
                    <div>
                      <div className="text-xs font-bold text-blue-400 mb-1">Emergency Summary</div>
                      <div className="text-xs text-indigo-200 mb-2">{insight.payload.briefSummary}</div>
                      <ul className="list-disc pl-4 text-[10px] text-indigo-300">
                        {insight.payload.timelineHighlights.map((hl: string, idx: number) => (
                           <li key={idx}>{hl}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
              {aiInsights.length === 0 && <p className="text-sm text-indigo-900 text-center py-4">Waiting for asynchronous insights...</p>}
            </div>
          </div>

          {/* EVENT STREAM / DECISION TRACE */}
          <div className="h-1/3 flex flex-col p-4 custom-scrollbar overflow-y-auto">
            <h2 className="text-sm font-semibold mb-4 text-gray-300 uppercase tracking-wider">Event Stream & Decision Trace</h2>
            <div className="space-y-3">
              {events.map((e, i) => (
                <div key={i} className={`p-3 rounded border text-xs font-mono ${e.eventType.includes('acceptance') || e.eventType.includes('candidate') ? 'bg-blue-950/20 border-blue-900' : 'bg-gray-900 border-gray-800'}`}>
                  <div className="flex justify-between text-gray-500 mb-1 text-[10px]">
                    <span>{new Date(e.timestamp).toLocaleTimeString()}</span>
                    <span>{e.source.type}:{e.source.id}</span>
                  </div>
                  <div className="text-blue-400 font-semibold mb-1">{e.eventType}</div>
                  
                  {e.eventType === 'hospital.candidate.generated' && (
                    <div className="mt-2 bg-black/40 p-2 rounded">
                      <div className="text-gray-400 mb-1">Decision Trace for {e.payload.caseId}:</div>
                      {e.payload.candidates.map((c: any) => (
                         <div key={c.hospitalId} className="border-l-2 border-gray-700 pl-2 mb-2 last:mb-0">
                           <div className="text-white">{c.hospitalName} <span className="text-gray-500">({c.distanceKm}km, ETA {c.etaMinutes}m)</span></div>
                           <div className={c.operationalEligibility === 'ELIGIBLE' ? 'text-green-400' : c.operationalEligibility === 'PENDING_ACCEPTANCE' ? 'text-yellow-400' : 'text-red-400'}>
                             {c.operationalEligibility}
                           </div>
                           <div className="text-gray-500 text-[10px] mt-0.5">{c.reason}</div>
                         </div>
                      ))}
                    </div>
                  )}

                  {e.eventType === 'route.recalculated' && (
                    <div className="mt-2 bg-black/40 p-2 rounded text-emerald-400">
                      {e.payload.oldHospitalId ? `Reroute ${e.payload.oldHospitalId} → ${e.payload.newHospitalId}` : `→ Destination: ${e.payload.newHospitalId}`}<br/>
                      Distance: {(e.payload.distanceMeters/1000).toFixed(1)}km<br/>
                      ETA: {Math.ceil(e.payload.durationSeconds/60)} minutes · provider {e.payload.provider}{e.payload.synthetic ? ' (synthetic)' : ''}<br/>
                      <span className="text-gray-500 text-[10px]">Reason: {e.payload.reason}</span>
                    </div>
                  )}

                  {e.eventType === 'hospital.capacity.updated' && e.payload.emergencyStatus === 'UNAVAILABLE' && (
                    <div className="mt-2 text-red-400">
                      Hospital became UNAVAILABLE
                    </div>
                  )}
                  
                  {e.eventType === 'destination.changed' && (
                    <div className="mt-2 text-yellow-400">
                      Ambulance {e.payload.ambulanceId} → {e.payload.hospitalId}<br />
                      <span className="text-gray-500 text-[10px]">Reason: {e.payload.reason}</span>
                    </div>
                  )}

                  {e.eventType === 'hospital.acceptance.received' && (
                    <div className={`mt-2 ${e.payload.status === 'ACCEPTED' ? 'text-emerald-400' : e.payload.status === 'LIMITED' ? 'text-amber-400' : 'text-red-400'}`}>
                      {e.payload.hospitalId}: {e.payload.status}{e.payload.limitations?.length ? ` (${e.payload.limitations.join(', ')})` : ''}
                    </div>
                  )}

                  {e.eventType === 'hospital.acceptance.expired' && (
                    <div className="mt-2 text-orange-400">Acceptance from {e.payload.hospitalId} expired → UNKNOWN</div>
                  )}

                  {e.eventType === 'ambulance.arrived' && (
                    <div className="mt-2 text-emerald-300">{e.payload.ambulanceId} arrived at {e.payload.hospitalId}</div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      
      {/* HOSPITAL DETAILS PANEL MODAL (Simplified logic) */}
      {selectedHospital && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-8">
           {/* Detailed hospital panel here */}
           <button onClick={() => setSelectedHospital(null)}>Close</button>
        </div>
      )}
    </div>
  );
}

export default App;
