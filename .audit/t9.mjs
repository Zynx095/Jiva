import * as L from './lib.mjs';
import { execSync } from 'child_process';
const rss = () => { const pid = execSync('powershell -NoProfile -Command "(Get-NetTCPConnection -LocalPort 4000 -State Listen).OwningProcess"').toString().trim(); return Math.round(Number(execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid}).WorkingSet64"`).toString())/1048576)+'MB pid '+pid; };
console.log('RSS before', rss());
const c='CASE-LOAD'; await L.post(L.ev('patient.emergency.created',{condition:'TRAUMA',location:{latitude:13.03,longitude:77.59},severity:'HIGH'},{type:'patient',id:'p'},{patientId:c}));
await L.post(L.ev('ambulance.dispatched',{ambulanceId:'AMB-BLR-003',caseId:c,destination:{latitude:1,longitude:1},estimatedEtaMinutes:1},{type:'ambulance',id:'x'},{patientId:c})); await L.sleep(1500);
const N=6000; const t=Date.now(); let ok=0;
for (let i=0;i<N;i+=50) { await Promise.all(Array.from({length:50},(_,j)=>L.post(L.ev('ambulance.location.updated',{ambulanceId:'AMB-BLR-003',coordinates:{latitude:12.9+(i+j)/1e5,longitude:77.6},speedKmh:40},{type:'ambulance',id:'AMB-BLR-003'})).then(r=>{if(r.status===202)ok++;}))); }
console.log(`posted ${ok}/${N} in ${Date.now()-t}ms`); await L.sleep(1500); console.log('RSS after', rss());
const h=(await L.get('/api/events/history?limit=20000')).json; console.log('history len (bounded 10000?)', h.length);
const t2=Date.now(); await L.get('/api/health'); console.log('health latency ms', Date.now()-t2);
// acceptance after 6000 events -> AI filter cost
const t3=Date.now(); const {events,ready}=L.listen(); await ready; await L.post(L.acc(c,'HOSP-BLR-004','ACCEPTED')); while(!events.find(e=>e.eventType==='ai.handoff.generated')&&Date.now()-t3<20000) await L.sleep(50); console.log('acceptance→ai.handoff latency ms', Date.now()-t3);
process.exit(0);
