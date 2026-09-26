import * as L from './lib.mjs';
// seed two patients
for (const [c,lat] of [['CASE-PRIV-A',12.97],['CASE-PRIV-B',12.98]]) await L.post(L.ev('patient.emergency.created',{condition:'CARDIAC arrest, name John Doe, phone 9999999999',location:{latitude:lat,longitude:77.6},severity:'HIGH'},{type:'patient',id:c},{patientId:c}));
await L.sleep(1500);
const roles = {
 none: {}, PATIENT_A: {'x-jiva-role':'PATIENT','x-jiva-case-id':'CASE-PRIV-A'},
 PATIENT_nocase: {'x-jiva-role':'PATIENT'},
 HOSPITAL1: {'x-jiva-role':'HOSPITAL','x-jiva-hospital-id':'HOSP-BLR-001'},
 AMBULANCE1: {'x-jiva-role':'AMBULANCE','x-jiva-ambulance-id':'AMB-BLR-001'},
 MANAGEMENT: {'x-jiva-role':'MANAGEMENT'}, FORGED_ADMIN: {'x-jiva-role':'ADMIN'}, garbage: {'x-jiva-role':'zzz'}, 'demo-user hdr': {'x-jiva-demo-user':'demo-patient-1'},
};
for (const [n,h] of Object.entries(roles)) {
  const p=await L.get('/api/patients',h), hs=await L.get('/api/hospitals',h), a=await L.get('/api/ambulances',h), ev=await L.get('/api/events/history?limit=500',h), tl=await L.get('/api/cases/CASE-PRIV-B/timeline',h);
  console.log(n.padEnd(15),'patients',p.status,p.json?.length,'| hospitals',hs.status,hs.json?.length,'| amb',a.status,a.json?.length,'| history',ev.status,ev.json?.length,'| timeline(B)',tl.status,tl.json?.length);
}
const pa=(await L.get('/api/patients',roles.PATIENT_A)).json; console.log('PATIENT_A sees', pa.map(p=>p.patientId));
const pn=(await L.get('/api/patients',roles.PATIENT_nocase)).json; console.log('PATIENT w/o caseId sees', pn.length,'patients incl free text:', pn[0]&&pn[0].careRequirements);
const hospSees=(await L.get('/api/patients',roles.HOSPITAL1)).json; console.log('HOSPITAL1 sees patients', hospSees.map(p=>p.patientId));
// PATIENT posting operational events
const r=await L.post(L.ev('hospital.capacity.updated',{hospitalId:'HOSP-BLR-002',emergencyStatus:'UNAVAILABLE',traumaStatus:'UNAVAILABLE',icuStatus:'UNAVAILABLE',ventilatorStatus:'UNAVAILABLE'},{type:'patient',id:'x'}),roles.PATIENT_A); console.log('PATIENT_A POST capacity for H2:',r.status);
console.log('H2 emerg now', (await L.hosp())['HOSP-BLR-002'].operationalState.emergency);
const r2=await L.post(L.ev('ambulance.dispatched',{ambulanceId:'AMB-BLR-003',caseId:'CASE-PRIV-B',destination:{latitude:1,longitude:1},estimatedEtaMinutes:1},{type:'ambulance',id:'x'}),roles.none); console.log('anonymous dispatch',r2.status);
// CORS
const cr = await fetch(L.H+'/api/patients',{headers:{Origin:'http://evil.example'}}); console.log('CORS ACAO:', cr.headers.get('access-control-allow-origin'));
// Socket: does unauthenticated socket get all patients' events?
const {events,ready}=L.listen(); await ready; await L.post(L.ev('patient.emergency.created',{condition:'X',location:{latitude:12.9,longitude:77.6},severity:'LOW'},{type:'patient',id:'z'},{patientId:'CASE-PRIV-C'})); await L.sleep(800);
console.log('anonymous socket received', events.map(e=>e.eventType+(e.patientId?':'+e.patientId:'')).slice(0,5));
process.exit(0);
