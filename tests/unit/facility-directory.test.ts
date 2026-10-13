/**
 * Phase 3 — public facility directory: normalization, classification, merge and OpenStreetMap match
 * rules, plus invariants of the committed directory file (nothing invented, unknowns stay unknown).
 */
import fs from 'fs';
import path from 'path';
import type { FacilityDirectory } from '../../packages/domain-models/src';
import {
  buildEntry, buildOsmIndex, classify, cleanAddress, cleanName, extractPincode, matchFacility, mergeListings,
  type ListedRecord, type OsmFacility,
} from '../../scripts/lib/directory';
import { csvRecords, parseCsv, readXlsxFirstSheet } from '../../scripts/lib/tabular';
import { check, eq, ok, run } from './helpers/assert';

const ROOT = path.resolve(__dirname, '../..');
const AREA = { minLat: 12.7, minLng: 77.3, maxLat: 13.3, maxLng: 77.95 };
const osm = (id: number, name: string, o: Partial<OsmFacility> = {}): OsmFacility =>
  ({ type: 'node', id, lat: 12.97 + id / 1000, lon: 77.59 + id / 1000, name, altNames: [], addressText: '', ...o });
const listed = (name: string, sourceId: string, row: number, address = '', pincode?: string): ListedRecord =>
  ({ name, address, pincode, source: { sourceId, file: 'x', row, originalName: name } });

run('Phase 3 — facility directory rules', async () => {
  await check('names: abbreviations expanded, embedded addresses and insurer notes removed, real commas kept', () => {
    eq(cleanName('A. D. Halli H.C.'), 'A. D. Halli Health Centre', 'H.C.');
    eq(cleanName('Azadnagar UFWC'), 'Azadnagar Urban Family Welfare Centre', 'UFWC');
    eq(cleanName('Brains Superspeciality Hospital, # 192, T Mariappa Road, Lalbagh Siddapura,, bengaluru'), 'Brains Superspeciality Hospital', 'embedded address');
    eq(cleanName('Rainbow Childrens Medicare Limited,'), 'Rainbow Childrens Medicare Limited', 'trailing comma');
    eq(cleanName('Suguna Hospital (No Cashless for Ophthalmology P'), 'Suguna Hospital', 'insurer note');
    eq(cleanName('Referral Hospital, Srirampura'), 'Referral Hospital, Srirampura', 'name comma kept');
  });

  await check('pincodes: explicit, written, and the "Bangalore - 79" postal shorthand; never a non-Bengaluru code', () => {
    eq(extractPincode(cleanAddress('#4, 17th Cross, Basaveshwaranagar, Bangalore ? 79')), '560079', 'shorthand (mis-encoded dash)');
    eq(extractPincode('80, P & T Colony, Rt Nagar, Bangalore-32'), '560032', 'shorthand');
    eq(extractPincode('44-45/2 2nd Cross, Bengaluru, Karnataka, 560027'), '560027', 'written');
    eq(extractPincode('anything', '560040'), '560040', 'explicit');
    eq(extractPincode('Erode', '638001'), undefined, 'not a Bengaluru code');
    eq(extractPincode('Near Balemandi, Binnypet, Bangalore'), undefined, 'none');
  });

  await check('classification: source type first, documented name keywords next, otherwise UNKNOWN (never guessed)', () => {
    eq(classify('A D Halli Health Centre', 'BBMP Health Centre', 'bbmp-health-facilities').category, 'HEALTH_CENTRE', 'BBMP type');
    eq(classify('Austin Town Maternity Home', 'BBMP Maternity Home', 'bbmp-maternity-homes').ownership, 'MUNICIPAL', 'BBMP is municipal');
    const eye = classify('Abhaya Eye Hospital', undefined, 'rohini-network-list');
    eq([eye.category, eye.specialtyHint, eye.basis], ['SPECIALTY_HOSPITAL', 'EYE', 'NAME_KEYWORD:eye'], 'eye by name');
    eq(classify('Ashwini Nursing Home', undefined, 'hospitals-in-india').category, 'NURSING_HOME', 'nursing home');
    eq(classify('Motherhood', undefined, 'rohini-network-list').category, 'MATERNITY_HOME', 'maternity keyword');
    eq(classify('Sakra World', undefined, 'rohini-network-list'), { category: 'UNKNOWN', basis: 'NO_RULE', ownership: 'UNKNOWN' }, 'no rule → unknown');
  });

  await check('merge: branches of one source stay apart; cross-source listings merge only on shared pincode or locality', () => {
    const recs = [
      listed('Manipal Hospital', 'rohini-network-list', 1, '#98 Rustom Bagh, Hal Airport Road'),
      listed('Manipal Hospital', 'rohini-network-list', 2, 'Sarjapur Road, Bellandur'),
      listed('Manipal Hospital', 'manual-extract', 1, '98, HAL Airport road, Bengaluru'),
      listed('Abhaya Hospital', 'rohini-network-list', 3, 'Wilson Garden', '560027'),
      listed('Abhaya Hospital (Neuropsychiatry Pvt Ltd)', 'hospitals-in-india', 9, 'Dr MH Marigowda Road', '560027'),
      listed('Citi Hospital', 'rohini-network-list', 4, 'Rajajinagar', '560010'),
      listed('Citi Hospital', 'hospitals-in-india', 10, 'Rajajinagar', '560086'),
    ];
    const { groups, merged } = mergeListings(recs);
    eq(merged, 2, 'two merges');
    const sizes = groups.map(g => `${g[0].name}:${g.map(r => `${r.source.sourceId}#${r.source.row}`).join('+')}`).sort();
    ok(sizes.some(s => s.includes('manual-extract#1+rohini-network-list#1')), 'manual extract joins the HAL Airport Road branch');
    ok(sizes.some(s => s === 'Manipal Hospital:rohini-network-list#2'), 'the Bellandur branch stays separate');
    ok(sizes.some(s => s.includes('hospitals-in-india#9+rohini-network-list#3')), 'same pincode merged');
    eq(sizes.filter(s => s.startsWith('Citi Hospital')).length, 2, 'conflicting pincodes never merge');
  });

  const index = buildOsmIndex([
    osm(1, 'Abhaya Hospital', { postcode: '560027' }),
    osm(2, 'Abhaya Eye Hospital', { postcode: '560085' }),
    osm(3, 'Nelivigi Eye Hospital', { addressText: 'koramangala' }),
    osm(4, 'Manipal Hospital', { lat: 12.95, lon: 77.64 }),
    osm(5, 'Manipal Hospital', { lat: 13.05, lon: 77.55 }),
    osm(6, 'Goverment Hospital, Hosahalli', { postcode: '560040' }),
    osm(7, 'Premier Hospital'),
    osm(8, 'Sri Manjunatha Clinic'),
    osm(9, 'Jayanagar General Hospital'),
  ]);

  await check('matching: exact names match; the eye hospital never stands in for the general hospital of the same name', () => {
    const r = matchFacility({ name: 'Abhaya Hospital', pincode: '560027', address: 'Wilson Garden' }, index);
    ok(r.status === 'MATCHED' && r.osm.id === 1 && r.corroboration.includes('POSTCODE'), JSON.stringify(r));
    const e = matchFacility({ name: 'Abhaya Eye Hospital', address: 'Banashankari' }, index);
    ok(e.status === 'MATCHED' && e.osm.id === 2, 'eye matched to eye');
  });

  await check('matching: specialty mismatch, extra identity and locality-only overlap are rejected', () => {
    eq(matchFacility({ name: 'Manjunatha Nethralaya', address: 'Vijayanagar' }, index).status, 'UNRESOLVED', 'eye vs clinic');
    eq(matchFacility({ name: 'Cloudnine Jayanagar', address: '4th Block, Jayanagar' }, index).status, 'UNRESOLVED', 'locality-only overlap');
  });

  await check('matching: a facility named after its locality still matches when the names agree', () => {
    const r = matchFacility({ name: 'Hosahalli Referral Hospital', pincode: '560040', address: 'Vijayanagar, Hosahalli' }, index);
    ok(r.status === 'MATCHED' && r.osm.id === 6, JSON.stringify(r));
  });

  await check('matching: chains are ambiguous without corroboration; a postcode conflict rejects; a thin identity needs corroboration', () => {
    const chain = matchFacility({ name: 'Manipal Hospital', address: 'Somewhere' }, index);
    ok(chain.status === 'UNRESOLVED' && chain.reason === 'AMBIGUOUS', JSON.stringify(chain));
    const conflict = matchFacility({ name: 'Abhaya Hospital', pincode: '560099', address: 'Elsewhere' }, index);
    ok(conflict.status === 'UNRESOLVED' && conflict.reason === 'POSTCODE_CONFLICT', JSON.stringify(conflict));
    const thin = matchFacility({ name: 'Premier Health Care', address: 'Unknown' }, index);
    ok(thin.status === 'UNRESOLVED' && thin.reason === 'NEEDS_CORROBORATION', JSON.stringify(thin));
  });

  await check('placement: only matches inside the service area are placed; an entry is identical across builds', () => {
    const group = [listed('Nelivigi Eye Hospital And Surgical Centre', 'rohini-network-list', 7, 'Koramangala 1st Block')];
    const a = buildEntry(group, index, AREA).entry;
    const b = buildEntry(group, index, AREA).entry;
    eq(a, b, 'deterministic');
    eq(a.coordinateStatus, 'OSM_FACILITY_MATCH', 'placed');
    const outside = buildEntry(group, index, { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 }).entry;
    eq([outside.coordinateStatus, outside.location], ['UNRESOLVED', undefined], 'not placed outside the area');
  });

  await check('tabular readers: quoted CSV and the committed workbook', () => {
    eq(parseCsv('a,b\r\n"x, y","he said ""hi"""\n'), [['a', 'b'], ['x, y', 'he said "hi"']], 'csv quoting');
    eq(csvRecords('Name,Type\r\nX,Y\r\n'), [{ Name: 'X', Type: 'Y' }], 'records');
    const rows = readXlsxFirstSheet(fs.readFileSync(path.join(ROOT, 'Bengaluru.xlsx')));
    eq(rows[0].C, 'HOSPITAL NAME', 'header');
    eq(rows.length - 1, 306, 'ROHINI rows');
  });

  // ---------------------------------------------------------------- committed directory invariants
  const dir = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/directory/bengaluru-facilities.json'), 'utf8')) as FacilityDirectory;

  await check('committed directory: nothing operational is claimed; unknowns stay unknown', () => {
    ok(dir.facilities.length > 400, `materially expanded (${dir.facilities.length} facilities)`);
    for (const f of dir.facilities) {
      ok(f.dataStatus === 'PUBLIC_LISTED', `${f.facilityId} data status`);
      ok(f.operational.connectedToJiva === false && f.operational.capacity === 'UNKNOWN' && f.operational.acceptanceChannel === 'NONE', `${f.facilityId} not connected`);
      ok(!('capabilities' in f) && !('beds' in f) && !('operationalState' in f), `${f.facilityId} invents no services or capacity`);
      ok((f.coordinateStatus === 'UNRESOLVED') === !f.location, `${f.facilityId} coordinates only when resolved`);
      if (f.location) ok(f.location.latitude >= AREA.minLat && f.location.latitude <= AREA.maxLat && f.location.longitude >= AREA.minLng && f.location.longitude <= AREA.maxLng, `${f.facilityId} inside the service area`);
      if (f.coordinateStatus === 'OSM_FACILITY_MATCH') ok(!!f.location?.osm && typeof f.location.matchScore === 'number', `${f.facilityId} OSM provenance`);
      ok(f.sources.length > 0 && f.sources.every(s => dir.sources.some(d => d.sourceId === s.sourceId)), `${f.facilityId} traceable sources`);
    }
  });

  await check('committed directory: unique ids, counts consistent, OSM attribution and licence recorded', () => {
    eq(new Set(dir.facilities.map(f => f.facilityId)).size, dir.facilities.length, 'unique ids');
    eq(Object.values(dir.counts.byCoordinateStatus).reduce((a, b) => a + b, 0), dir.facilities.length, 'coordinate counts');
    ok(/OpenStreetMap/.test(dir.osmSnapshot?.attribution ?? '') && /ODbL/.test(dir.osmSnapshot?.license ?? ''), 'attribution + licence');
  });
});
