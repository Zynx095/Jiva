/**
 * Browser regression suite: drives the REAL apps (Vite dev servers) against a REAL API in an installed
 * Microsoft Edge or Google Chrome (playwright-core; no browser is downloaded). It covers defects that the
 * API-level suites cannot see because they live in the screens:
 *
 *  - doctor workspace: three patients are listed and open independently; a half-filled form is never
 *    carried to (and submitted for) the next patient; an update reaches only the intended patient and
 *    survives a reload;
 *  - management: the destination badge shows the hospital's answer FOR THAT CASE, not its latest answer
 *    to another case;
 *  - patient: "hospital confirmed" and the headline are about the patient's own case.
 *
 * Run: npm run test:browser   (JIVA_BROWSER=msedge|chrome, default: try Edge, then Chrome)
 * Uses its own ports (API :4107, apps :5193/:5196/:5197) and synthetic data only.
 */
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import type { Browser, Page } from 'playwright-core';
import { ROOT, check, results, sleep, startApi, uuid, type Api } from '../integration/helpers/api';

const API_PORT = 4107;
const APPS = { management: 5193, patient: 5196, doctor: 5197 } as const;
const H1 = 'HOSP-BLR-001';
const DOCTOR = { persona: 'demo-doc-3', practitionerId: 'PRAC-BLR-001-01' };
const CREWS = [
  { persona: 'demo-amb-1', ambulanceId: 'AMB-BLR-001' },
  { persona: 'demo-amb-2', ambulanceId: 'AMB-BLR-002' },
  { persona: 'demo-amb-3', ambulanceId: 'AMB-BLR-003' },
];

const children: ChildProcess[] = [];

function startApp(app: keyof typeof APPS): Promise<void> {
  const dir = path.join(ROOT, 'apps', `${app}-web`);
  const child = spawn(process.execPath, [path.join(dir, 'node_modules/vite/bin/vite.js'), '--port', String(APPS[app]), '--strictPort'], {
    cwd: dir,
    env: { ...process.env, VITE_API_URL: `http://localhost:${API_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const t = setTimeout(() => reject(new Error(`${app} did not start:\n${out.slice(-1500)}`)), 60_000);
    const onData = (d: Buffer) => {
      out += d;
      if (/ready in/i.test(out)) { clearTimeout(t); resolve(); }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const channels = process.env.JIVA_BROWSER ? [process.env.JIVA_BROWSER] : ['msedge', 'chrome'];
  for (const channel of channels) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try the next one */ }
  }
  throw new Error(`No installed browser found (tried ${channels.join(', ')}). Install Edge or Chrome, or set JIVA_BROWSER.`);
}

// ------------------------------------------------------------------ staging through the real API

async function must(r: Promise<{ status: number; text: string; json: any }>, codes: number[], what: string) {
  const res = await r;
  if (!codes.includes(res.status)) throw new Error(`${what}: ${res.status} ${res.text.slice(0, 300)}`);
  return res.json;
}

async function report(api: Api, crew: (typeof CREWS)[number], caseRef: string | undefined, latitude: number, symptom: string): Promise<string> {
  const body = await must(api.post(crew.persona, '/api/emergencies', {
    clientRequestId: uuid(), ...(caseRef ? { caseRef } : {}), location: { latitude, longitude: 77.59, method: 'MAP_PIN' },
    severity: 'CRITICAL', reportedSymptoms: [symptom], requiredCapabilities: [],
  }), [202], `report ${crew.ambulanceId}`);
  return body.caseId;
}

async function referral(api: Api, caseId: string): Promise<string> {
  let id: string | undefined;
  await api.waitFor(async () => !!(id = ((await api.get('demo-hosp-1', `/api/hospitals/${H1}/requests`)).json as any[]).find(q => q.caseId === caseId)?.requestId));
  if (!id) throw new Error(`no referral for ${caseId}`);
  return id;
}

async function answer(api: Api, caseId: string, status: 'ACCEPTED' | 'REJECTED') {
  const requestId = await referral(api, caseId);
  const now = new Date().toISOString();
  await must(api.event('demo-hosp-1', {
    eventId: uuid(), eventType: 'hospital.acceptance.received', timestamp: now, version: '1.0', source: { type: 'hospital', id: H1 },
    payload: { responseId: `R-${uuid().slice(0, 8)}`, requestId, caseId, hospitalId: H1, status, acceptedCapabilities: status === 'ACCEPTED' ? ['EMERGENCY', 'TRAUMA', 'ICU'] : [],
      limitations: status === 'REJECTED' ? ['synthetic'] : [], respondedAt: now, validUntil: new Date(Date.now() + 30 * 60_000).toISOString(), responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO' },
  }), [202], `answer ${caseId}`);
}

const ambulanceOf = async (api: Api, id: string) => ((await api.get('demo-mgmt-1', '/api/ambulances')).json as any[]).find(a => a.ambulanceId === id);

/** Crew report → Hebbal accepts → GPS arrival → arrival, handover and the doctor recorded by Hebbal. */
async function admit(api: Api, crew: (typeof CREWS)[number], caseRef: string | undefined, latitude: number, symptom: string) {
  const caseId = await report(api, crew, caseRef, latitude, symptom);
  await answer(api, caseId, 'ACCEPTED');
  await api.waitFor(async () => (await ambulanceOf(api, crew.ambulanceId))?.destinationHospital === H1);
  const h = ((await api.get('demo-mgmt-1', '/api/hospitals')).json as any[]).find(x => x.hospitalId === H1);
  await must(api.event(crew.persona, { eventId: uuid(), eventType: 'ambulance.location.updated', timestamp: new Date().toISOString(), version: '1.0', source: { type: 'ambulance', id: crew.ambulanceId }, payload: { ambulanceId: crew.ambulanceId, coordinates: { latitude: h.location.latitude, longitude: h.location.longitude }, speedKmh: 5, heading: 0 } }), [202], 'gps');
  await api.waitFor(async () => (await ambulanceOf(api, crew.ambulanceId))?.status === 'ARRIVED');
  const enc = (await must(api.post('demo-hosp-1', `/api/hospitals/${H1}/arrivals`, { clientRequestId: uuid(), caseId }), [201], 'arrival')).encounter.encounterId as string;
  await must(api.post('demo-hosp-1', `/api/encounters/${enc}/handover`, { clientRequestId: uuid() }), [200], 'handover');
  await must(api.post('demo-hosp-1', `/api/encounters/${enc}/doctor`, { clientRequestId: uuid(), practitionerId: DOCTOR.practitionerId }), [200], 'doctor');
  return { caseId, encounterId: enc, symptom };
}

// ------------------------------------------------------------------ helpers on pages

const visible = (page: Page, text: string | RegExp, ms = 8000) => page.getByText(text).filter({ visible: true }).first().waitFor({ timeout: ms }).then(() => true, () => false);
const panel = (page: Page) => page.locator('[role=tabpanel]:visible');

async function main() {
  console.log('[Test] Browser: multi-patient doctor workspace, per-case answers in management and patient screens\n');
  const api = await startApi(API_PORT, { CORS_ORIGINS: Object.values(APPS).map(p => `http://localhost:${p}`).join(',') });
  let browser: Browser | undefined;
  try {
    await Promise.all((Object.keys(APPS) as Array<keyof typeof APPS>).map(startApp));
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const pageErrors: string[] = [];
    page.on('pageerror', e => pageErrors.push(e.message));

    // ---------------------------------------------------------------- per-case answers (before arrival)
    await must(api.post('demo-admin', '/api/demo/reset'), [200], 'reset');
    const accepted = await report(api, CREWS[0], 'CASE-BLR-876', 13.0431, 'Synthetic alpha chest pain');
    const declined = await report(api, CREWS[1], 'CASE-BLR-877', 13.035, 'Synthetic bravo head injury');
    await answer(api, accepted, 'ACCEPTED');
    await api.waitFor(async () => (await ambulanceOf(api, CREWS[0].ambulanceId))?.destinationHospital === H1);
    await answer(api, declined, 'REJECTED'); // Hebbal's LATEST answer is now a decline — for another case

    await page.goto(`http://localhost:${APPS.management}/?as=demo-mgmt-1`);
    await page.getByRole('button', { name: 'View case' }).first().waitFor({ timeout: 15000 });
    const kpi = (await page.locator('body').innerText()).match(/Hospitals accepting\s+(\d+)/)?.[1];
    check('management: "Hospitals accepting" counts Hebbal, whose acceptance of one case is still current', kpi === '1', `got ${kpi}`);
    await page.locator('button', { hasText: accepted }).first().click();
    const detail = page.locator('dt', { hasText: /^Destination$/ }).first().locator('xpath=..');
    await visible(page, /To hospital/);
    const destText = (await detail.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check('management: the accepted case shows Hebbal "Accepted", not Hebbal\'s decline of another case', /Hebbal/.test(destText) && /Accepted/.test(destText) && !/Declined/.test(destText), destText);

    await page.goto(`http://localhost:${APPS.patient}/?as=demo-patient-1`);
    await visible(page, 'Hospital confirmed', 15000);
    const journey = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    check('patient 1: "Hospital confirmed" is done although Hebbal later declined another patient', /Hospital confirmed \(done\)/.test(journey), journey.slice(0, 300));
    await page.goto(`http://localhost:${APPS.patient}/?as=demo-patient-2`);
    await visible(page, 'An ambulance crew is with you', 15000);
    await page.waitForTimeout(1000);
    const p2Text = (await page.locator('main').innerText()).replace(/\s+/g, ' ');
    check('patient 2 (crew on scene, declined by Hebbal): told the crew is with them, not that one is coming', p2Text.includes('An ambulance crew is with you') && !p2Text.includes('is coming'), p2Text.slice(0, 200));

    // ---------------------------------------------------------------- three patients for one doctor
    await must(api.post('demo-admin', '/api/demo/reset'), [200], 'reset');
    const p1 = await admit(api, CREWS[0], 'CASE-BLR-876', 13.0431, 'Synthetic alpha chest pain');
    const p2 = await admit(api, CREWS[1], 'CASE-BLR-877', 13.035, 'Synthetic bravo head injury');
    const p3 = await admit(api, CREWS[2], undefined, 13.02, 'Synthetic charlie burns');
    const patients = [p1, p2, p3];

    await page.goto(`http://localhost:${APPS.doctor}/?as=${DOCTOR.persona}`);
    await page.locator('[role=option]').first().waitFor({ timeout: 15000 });
    const rows = await page.locator('[role=option]').allInnerTexts();
    check('doctor: all three assigned patients are listed', patients.every(p => rows.some(r => r.includes(p.caseId))), rows.join(' | '));
    const row = (caseId: string) => page.locator('[role=option]', { hasText: caseId });
    const header = () => page.locator('main h2').nth(1).innerText();

    for (const p of patients) {
      await row(p.caseId).click();
      await page.waitForTimeout(400);
      const h = await header();
      const scene = await panel(page).innerText();
      check(`doctor: ${p.caseId} opens with its own record`, h === p.caseId && scene.includes(p.symptom) && patients.filter(o => o !== p).every(o => !scene.includes(o.symptom)), `${h}`);
    }

    // A half-filled form for patient 1 must not survive the switch to patient 2.
    await row(p1.caseId).click();
    await page.getByRole('tab', { name: /Vital signs/ }).click();
    await panel(page).getByRole('button', { name: 'Enter values' }).click();
    await panel(page).getByLabel(/Heart rate/).fill('55');
    await row(p2.caseId).click();
    await page.waitForTimeout(500);
    check('doctor: a half-filled vital-signs form for patient 1 is gone after switching to patient 2', (await header()) === p2.caseId && (await panel(page).getByLabel(/Heart rate/).count()) === 0);

    // Update patient 2 only, through the screen.
    await panel(page).getByRole('button', { name: 'Enter values' }).click();
    await panel(page).getByLabel(/Heart rate/).fill('87');
    await panel(page).getByRole('button', { name: 'Record', exact: true }).click();
    check('doctor: the recorded value appears for patient 2', await visible(page, 'Entered by clinician'));
    const counts = async () => Promise.all(patients.map(async p => ((await api.get(DOCTOR.persona, `/api/encounters/${p.encounterId}/vitals`)).json?.measurements ?? []).filter((m: any) => m.source !== 'AMBULANCE_CREW').length));
    const [c1, c2, c3] = await counts();
    check('doctor: the update reached patient 2 only (server records)', c1 === 0 && c2 === 1 && c3 === 0, `${c1}/${c2}/${c3}`);

    // A prescription draft for patient 3 through the screen.
    await row(p3.caseId).click();
    await page.getByRole('tab', { name: /Prescriptions/ }).click();
    await panel(page).getByRole('button', { name: 'New prescription' }).click();
    await panel(page).getByLabel(/^Medication/).fill('Synthetic test medication');
    await panel(page).getByLabel(/^Dose/).fill('1 tablet');
    await panel(page).getByLabel(/^Frequency/).fill('once');
    await panel(page).getByRole('button', { name: 'Save as draft' }).click();
    check('doctor: the draft appears for patient 3', await visible(page, /draft saved/));
    const rx = await Promise.all(patients.map(async p => ((await api.get(DOCTOR.persona, `/api/encounters/${p.encounterId}/prescriptions`)).json ?? []).length));
    check('doctor: the prescription belongs to patient 3 only', rx[0] === 0 && rx[1] === 0 && rx[2] === 1, rx.join('/'));

    // Reload: every record is still with its own patient.
    await page.reload();
    await page.locator('[role=option]').first().waitFor({ timeout: 15000 });
    await row(p2.caseId).click();
    await page.getByRole('tab', { name: /Vital signs/ }).click();
    const v2 = await panel(page).innerText();
    await row(p1.caseId).click();
    const v1 = await panel(page).innerText();
    await row(p3.caseId).click();
    await page.getByRole('tab', { name: /Prescriptions/ }).click();
    const r3 = await panel(page).innerText();
    check('doctor (after reload): patient 2 keeps its value, patient 1 has none, patient 3 keeps its draft', v2.includes('Entered by clinician') && !v1.includes('Entered by clinician') && r3.includes('Synthetic test medication'));

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '));
  } catch (err) {
    check('browser suite ran to completion', false, err instanceof Error ? err.message : String(err));
  } finally {
    await browser?.close().catch(() => undefined);
    for (const c of children) c.kill();
    api.stop();
  }
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  await sleep(200);
  process.exit(failures ? 1 : 0);
}

void main();
