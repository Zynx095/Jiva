import * as L from './lib.mjs';
const { events, ready } = L.listen(); await ready;
const c = 'CASE-BLR-876', A = 'AMB-BLR-001';
for (let run = 1; run <= 3; run++) {
  const a0 = (await L.amb())[A]; console.log(`\n===== RUN ${run} start: amb status=${a0.status} assigned=${a0.assignedPatient} dest=${a0.destinationHospital} loc=${a0.currentLocation.latitude.toFixed(4)},${a0.currentLocation.longitude.toFixed(4)} provLen=${a0.provenance.length}`);
  const m = events.length; const t0 = Date.now();
  for (const h of ['HOSP-BLR-001','HOSP-BLR-002','HOSP-BLR-003','HOSP-BLR-004']) await L.post(L.ev('hospital.capacity.updated',{hospitalId:h,emergencyStatus:'UNKNOWN',traumaStatus:'UNKNOWN',icuStatus:'UNKNOWN',ventilatorStatus:'UNKNOWN'},{type:'hospital',id:h}));
  await L.post(L.ev('patient.emergency.created',{condition:'TRAUMA',location:{latitude:13.0358,longitude:77.597},severity:'CRITICAL'},{type:'patient',id:'p'},{patientId:c})); await L.sleep(1500);
  await L.post(L.ev('ambulance.dispatched',{ambulanceId:A,caseId:c,destination:{latitude:13.0358,longitude:77.597},estimatedEtaMinutes:8},{type:'ambulance',id:A},{patientId:c})); await L.sleep(800);
  const hosp1 = (await L.hosp())['HOSP-BLR-001'].operationalState;
  console.log(`  after reset events H1 acceptance=${hosp1.acceptance} emergency=${hosp1.emergency}`);
  await L.post(L.acc(c,'HOSP-BLR-001','ACCEPTED')); await L.sleep(1500);
  await L.post(L.acc(c,'HOSP-BLR-004','ACCEPTED')); await L.sleep(1500);
  console.log('  dest after A,B accepted:', (await L.amb())[A].destinationHospital);
  for (const lat of [13.08,13.06]) { await L.post(L.ev('ambulance.location.updated',{ambulanceId:A,coordinates:{latitude:lat,longitude:77.6},speedKmh:40,heading:180},{type:'ambulance',id:A})); await L.sleep(500); }
  const m2 = events.length; const tr = Date.now();
  await L.post(L.ev('hospital.capacity.updated',{hospitalId:'HOSP-BLR-001',emergencyStatus:'UNAVAILABLE',traumaStatus:'UNAVAILABLE',icuStatus:'UNAVAILABLE',ventilatorStatus:'UNAVAILABLE'},{type:'hospital',id:'HOSP-BLR-001'})); await L.sleep(2500);
  console.log('  REROUTE SEQUENCE:', L.summarize(events.slice(m2)).join(' ➜ '));
  const a1 = (await L.amb())[A]; console.log('  final dest', a1.destinationHospital, ' total events this run', events.length - m, ' counts:', JSON.stringify(events.slice(m).reduce((o,e)=>(o[e.eventType]=(o[e.eventType]||0)+1,o),{})));
  const rr = events.slice(m2).find(e=>e.eventType==='route.recalculated'); console.log('  route:', rr && `${(rr.payload.distanceMeters/1000).toFixed(1)}km ${Math.round(rr.payload.durationSeconds/60)}min prov=${rr.payload.provider} synthetic=${rr.payload.synthetic}`);
  console.log('  H1 state', JSON.stringify((await L.hosp())['HOSP-BLR-001'].operationalState.acceptance), 'prov entries', (await L.hosp())['HOSP-BLR-001'].provenance.length);
}
const h = await L.get('/api/health'); console.log('\nmem check via health ok', h.status);
process.exit(0);
