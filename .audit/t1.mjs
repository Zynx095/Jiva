import * as L from './lib.mjs';
const { events, ready } = L.listen(); await ready;
const case1 = 'CASE-AUDIT-1';
// emergency
const em = L.ev('patient.emergency.created', { condition: 'TRAUMA', location: { latitude: 13.0358, longitude: 77.597 }, severity: 'CRITICAL' }, { type: 'patient', id: 'p' }, { patientId: case1 });
console.log('emergency', await L.post(em));
await L.sleep(2500);
console.log('--- realtime trace after emergency'); console.log(L.summarize(events).join('\n'));
const hist = (await L.get('/api/events/history')).json;
console.log('--- /api/events/history types:', hist.map(e=>e.eventType));
console.log('--- timeline for case:', (await L.get('/api/cases/'+case1+'/timeline')).json.map(e=>e.eventType));
const cr = events.find(e=>e.eventType==='care.requirement.created'); console.log('care req', JSON.stringify(cr?.payload));
const cand = events.find(e=>e.eventType==='hospital.candidate.generated'); console.log('candidates', JSON.stringify(cand?.payload.candidates.map(c=>[c.hospitalId,c.operationalEligibility,c.missingCapabilities,c.distanceKm,c.etaMinutes])));
const reqs = events.filter(e=>e.eventType==='hospital.acceptance.requested'); console.log('acc requests to', reqs.map(r=>r.payload.hospitalId));
console.log('patient state', JSON.stringify((await L.get('/api/patients')).json.find(p=>p.patientId===case1)));
process.exit(0);
