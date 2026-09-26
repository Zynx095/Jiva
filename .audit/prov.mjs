import fs from 'fs';
const dir='D:/College/SOMESHIT DOWNLOADS/Jiva/data/';
for (const f of ['canonical/hospitals.json','synthetic/bengaluru/hospitals.json']) {
  const j = JSON.parse(fs.readFileSync(dir+f,'utf8')); console.log('\n=====',f,'count',j.length);
  const chk = h => ({
    id: !!h.hospitalId, name: !!h.displayName, addr: !!h.address?.fullAddress, coords: !!h.location?.latitude, coordSrc: h.location?.coordinateSource,
    contact: !!(h.contact?.phone||h.contact?.emergencyPhone||h.contact?.website), prov: Array.isArray(h.provenance)?h.provenance.length:typeof h.provenance,
    provSrc: Array.isArray(h.provenance)?h.provenance.map(p=>p.sourceName||p.sourceId).join(';').slice(0,60):null,
    ver: h.verificationStatus, dataStatus: h.dataStatus, opSource: h.operationalState?.source, acc: h.operationalState?.acceptance, emerg: h.operationalState?.emergency, icu: h.operationalState?.icu, lastConf: h.operationalState?.lastConfirmedAt, expires: h.operationalState?.expiresAt,
    hist: JSON.stringify(h.historicalCapacity), capKeys: Object.keys(h.capabilities||{}).filter(k=>h.capabilities[k]).join(','), util: h.utilizationIndicators?.length,
  });
  for (const h of j) console.log(JSON.stringify(chk(h)));
}
