import * as L from './lib.mjs';
const { events, ready } = L.listen(); await ready;
const c = 'CASE-AUDIT-1';
const mark = () => events.length; let m;
const show = (label, from) => console.log(`--- ${label}\n` + L.summarize(events.slice(from)).join('\n'));
m = mark(); console.log('dispatch', (await L.post(L.ev('ambulance.dispatched', { ambulanceId: 'AMB-BLR-001', caseId: c, destination: { latitude: 13.0358, longitude: 77.597 }, estimatedEtaMinutes: 10 }, { type: 'ambulance', id: 'AMB-BLR-001' }, { patientId: c }))).status);
await L.sleep(500); show('dispatch', m);
// Hospital A=H4 LIMITED, B=H2 ACCEPTED, C=H1 REJECTED
m = mark(); const eL = L.acc(c, 'HOSP-BLR-004', 'LIMITED'); await L.post(eL); await L.sleep(1500); show('H4 LIMITED', m);
console.log('amb dest', (await L.amb())['AMB-BLR-001'].destinationHospital);
m = mark(); const eA = L.acc(c, 'HOSP-BLR-002', 'ACCEPTED'); await L.post(eA); await L.sleep(1500); show('H2 ACCEPTED', m);
console.log('amb dest', (await L.amb())['AMB-BLR-001'].destinationHospital);
m = mark(); const eR = L.acc(c, 'HOSP-BLR-001', 'REJECTED'); await L.post(eR); await L.sleep(1500); show('H1 REJECTED', m);
let h = await L.hosp(); console.log('states', Object.entries(h).map(([k,v])=>k+':'+v.operationalState.acceptance).join(' '));
// duplicate same event
m = mark(); console.log('dup same eventId', await L.post(eA)); await L.sleep(1000); show('dup same event', m);
// same responseId new eventId (redelivery w/ different envelope)
m = mark(); const eA2 = {...eA, eventId: crypto.randomUUID()}; console.log('same responseId new eventId', (await L.post(eA2)).status); await L.sleep(1500); show('same response, new eventId', m);
h = await L.hosp(); console.log('H2 provenance entries', h['HOSP-BLR-002'].provenance.length, 'H2 state', JSON.stringify(h['HOSP-BLR-002'].operationalState));
// UNAVAILABLE / UNKNOWN / EXPIRED statuses via API
for (const st of ['UNAVAILABLE','UNKNOWN','EXPIRED']) { const r = await L.post(L.acc(c,'HOSP-BLR-004',st)); await L.sleep(800); console.log(st, r.status, (await L.hosp())['HOSP-BLR-004'].operationalState.acceptance); }
console.log('amb', JSON.stringify((await L.amb())['AMB-BLR-001']).slice(0,400));
process.exit(0);
