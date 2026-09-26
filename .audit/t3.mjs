import * as L from './lib.mjs';
const { events, ready } = L.listen(); await ready;
const c = 'CASE-EXP-1';
await L.post(L.ev('patient.emergency.created', { condition: 'TRAUMA', location: { latitude: 12.9784, longitude: 77.6408 }, severity: 'HIGH' }, { type: 'patient', id: 'p' }, { patientId: c }));
await L.post(L.ev('ambulance.dispatched', { ambulanceId: 'AMB-BLR-002', caseId: c, destination: { latitude: 12.97, longitude: 77.64 }, estimatedEtaMinutes: 10 }, { type: 'ambulance', id: 'AMB-BLR-002' }, { patientId: c }));
await L.sleep(1500);
const m = events.length;
// H4 ACCEPTED expiring in 4s
await L.post(L.acc(c, 'HOSP-BLR-004', 'ACCEPTED', { validUntil: new Date(Date.now() + 4000).toISOString() }));
// H2 ACCEPTED long-lived (second candidate)
await L.post(L.acc(c, 'HOSP-BLR-002', 'ACCEPTED'));
await L.sleep(1000);
console.log('dest before expiry', (await L.amb())['AMB-BLR-002'].destinationHospital);
for (let i = 0; i < 4; i++) { await L.sleep(4000); const h = await L.hosp(); console.log(new Date().toISOString().slice(17,23), 'H4 acc=', h['HOSP-BLR-004'].operationalState.acceptance, 'emerg=', h['HOSP-BLR-004'].operationalState.emergency, 'dest=', (await L.amb())['AMB-BLR-002'].destinationHospital); }
console.log(L.summarize(events.slice(m)).join('\n'));
const h = (await L.hosp())['HOSP-BLR-004']; console.log(JSON.stringify(h.operationalState));
process.exit(0);
