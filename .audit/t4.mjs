import * as L from './lib.mjs';
const c = 'CASE-ORD-1';
const T = m => new Date(Date.now() + m*60000).toISOString();
// Acceptance ordering: A (t-20m ACCEPTED, old), C (t=now REJECTED newest), B(t-10m ACCEPTED middle). Deliver A, C, B
const A = L.acc(c,'HOSP-BLR-001','ACCEPTED',{respondedAt:T(-20)});
const C = L.acc(c,'HOSP-BLR-001','REJECTED',{respondedAt:T(0)});
const B = L.acc(c,'HOSP-BLR-001','LIMITED',{respondedAt:T(-10)});
A.timestamp=T(-20); B.timestamp=T(-10); C.timestamp=T(0);
for (const [n,e] of [['A',A],['C',C],['B (late, older)',B]]) { await L.post(e); await L.sleep(400); const s=(await L.hosp())['HOSP-BLR-001'].operationalState; console.log(n,'→ acceptance',s.acceptance,'lastConfirmedAt',s.lastConfirmedAt); }
console.log('dup B', (await L.post(B)).body.slice(0,40));
const R = L.acc(c,'HOSP-BLR-001','ACCEPTED',{respondedAt:T(-30)}); R.timestamp=T(-30); await L.post(R); await L.sleep(400);
console.log('replay stale ACCEPTED(-30m) → ', (await L.hosp())['HOSP-BLR-001'].operationalState.acceptance);
// Ambulance location ordering
const loc=(lat,tOff)=>{const e=L.ev('ambulance.location.updated',{ambulanceId:'AMB-BLR-003',coordinates:{latitude:lat,longitude:77.62}},{type:'ambulance',id:'AMB-BLR-003'}); e.timestamp=T(tOff); return e;};
const a=loc(12.90,-2), b=loc(12.91,-1), cc=loc(12.92,0);
for (const [n,e] of [['A lat12.90 t-2',a],['C lat12.92 t0',cc],['B lat12.91 t-1 (late)',b]]) { await L.post(e); await L.sleep(200); console.log(n,'→ amb lat',(await L.amb())['AMB-BLR-003'].currentLocation.latitude); }
// capacity ordering
const cap=(st,off)=>{const e=L.ev('hospital.capacity.updated',{hospitalId:'HOSP-BLR-003',emergencyStatus:st,traumaStatus:'UNKNOWN',icuStatus:'UNKNOWN',ventilatorStatus:'UNKNOWN'},{type:'hospital',id:'HOSP-BLR-003'}); e.timestamp=T(off); return e;};
await L.post(cap('AVAILABLE',0)); await L.sleep(200); await L.post(cap('UNAVAILABLE',-30)); await L.sleep(200);
console.log('capacity: newer AVAILABLE then stale UNAVAILABLE(-30m) → emergency =', (await L.hosp())['HOSP-BLR-003'].operationalState.emergency);
// UNKNOWN->AVAILABLE without confirmation: does capacity.updated from ANY source (even patient) set AVAILABLE?
const e=cap('AVAILABLE',0); e.source={type:'patient',id:'random-patient'}; e.payload.hospitalId='HOSP-BLR-001'; await L.post(e); await L.sleep(200);
const s=(await L.hosp())['HOSP-BLR-001']; console.log('patient-sourced capacity event accepted → H1 emergency',s.operationalState.emergency,'provenance last',JSON.stringify(s.provenance.at(-1)));
process.exit(0);
