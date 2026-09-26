import { randomUUID as uuid } from 'crypto';
import { io } from 'socket.io-client';
export const H = process.env.H || 'http://localhost:4000';
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function post(ev, headers = {}) {
  const r = await fetch(H + '/api/events', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(ev) });
  return { status: r.status, body: await r.text() };
}
export const get = async (p, headers = {}) => { const r = await fetch(H + p, { headers }); const t = await r.text(); let j; try { j = JSON.parse(t) } catch {} return { status: r.status, json: j, text: t }; };
export function ev(eventType, payload, source = { type: 'system', id: 'audit' }, extra = {}) {
  return { eventId: uuid(), eventType, timestamp: new Date().toISOString(), source, version: '1.0', payload, ...extra };
}
export function listen() {
  const events = [];
  const s = io(H); s.on('event', e => events.push(e));
  return { events, s, ready: new Promise(r => s.on('connect', r)) };
}
export const acc = (caseId, hospitalId, status, extra = {}) => ev('hospital.acceptance.received', {
  responseId: 'RESP-' + uuid().slice(0, 6), requestId: 'AR-x', caseId, hospitalId, status,
  acceptedCapabilities: ['EMERGENCY'], limitations: status === 'LIMITED' ? ['ICU 1 bed'] : [], respondedAt: new Date().toISOString(),
  validUntil: new Date(Date.now() + 900000).toISOString(), responderRole: 'HOSPITAL', source: 'HOSPITAL_CONFIRMED', ...extra
}, { type: 'hospital', id: hospitalId });
export const hosp = async () => Object.fromEntries((await get('/api/hospitals')).json.map(h => [h.hospitalId, h]));
export const amb = async () => Object.fromEntries((await get('/api/ambulances')).json.map(h => [h.ambulanceId, h]));
export const summarize = evs => evs.map(e => `${e.eventType}${e.payload?.hospitalId ? ' H=' + e.payload.hospitalId : ''}${e.payload?.status ? ' ' + e.payload.status : ''}${e.payload?.newHospitalId ? ' →' + e.payload.newHospitalId : ''}${e.payload?.provider ? ' prov=' + e.payload.provider : ''}`);
