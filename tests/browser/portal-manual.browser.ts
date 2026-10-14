/**
 * Browser suite: the demo portal as the starting point, theme isolation, navigation back to the portal, and
 * the manual (hardware-independent) workflows, driven in an installed Microsoft Edge or Google Chrome
 * (playwright-core) against a REAL API and the six apps' dev servers:
 *  1. Portal Home: OLED theme, JIVA hero, honest facts (no hardware, no GPS), one card per role with working
 *     persona links, guided demos, breadcrumbs and browser history
 *  2. Reset needs an explicit confirmation; "Keep the data" changes nothing
 *  3. Theme isolation: the operational apps stay light; each has a working "Demo portal" link
 *  4. Crew sets the unit's position by hand → arrived, labelled "Set by the crew"
 *  5. Hospital records the handover with notes → visible to the hospital and the assigned doctor
 *  6. Doctor types vital signs, corrects one, withdraws another → the patient sees only current values
 *  7. A slow (stale) answer for one patient never overwrites the patient the doctor has since selected
 * Uses its own ports (API :4110, apps :5203–5208) and synthetic data only.
 *
 * Run: npx tsx tests/browser/portal-manual.browser.ts
 */
import { spawn, execSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { Browser, Page } from 'playwright-core';
import { ROOT, check, envelope, results, startApi, uuid, type Api } from '../integration/helpers/api';

const API_PORT = 4110;
const APPS = { management: 5203, ambulance: 5204, hospital: 5205, patient: 5206, doctor: 5207, portal: 5208 } as const;
type AppName = keyof typeof APPS;
const url = (app: AppName, persona?: string) => `http://localhost:${APPS[app]}/${persona ? `?as=${persona}` : ''}`;
const CASE = 'CASE-BLR-876';
const H1 = 'HOSP-BLR-001';
const NOTE = 'Phone and wallet handed to the ward; daughter informed.';

const children: ChildProcess[] = [];
const isWin = process.platform === 'win32';
function killChild(c: ChildProcess) {
  try {
    if (isWin && c.pid) execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' });
    else c.kill();
  } catch {
    /* already gone */
  }
}

function startApp(app: AppName): Promise<void> {
  const dir = path.join(ROOT, 'apps', app === 'portal' ? 'demo-portal' : `${app}-web`);
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
      if (/ready in/i.test(out)) {
        clearTimeout(t);
        resolve();
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
  });
}

async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const channels = process.env.JIVA_BROWSER ? [process.env.JIVA_BROWSER] : ['msedge', 'chrome'];
  for (const channel of channels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      /* try next */
    }
  }
  throw new Error(`No installed browser found (tried ${channels.join(', ')}). Install Edge or Chrome.`);
}

const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
const rgb = (page: Page, selector: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    const m = el ? getComputedStyle(el).backgroundColor.match(/\d+/g) : null;
    return m ? m.slice(0, 3).map(Number) : [];
  }, selector);
const ambulance = async (api: Api, id: string) => ((await api.get('demo-mgmt-1', '/api/ambulances')).json as any[]).find((a) => a.ambulanceId === id);
const patients = async (api: Api) => ((await api.get('demo-mgmt-1', '/api/patients')).json as any[]).length;

async function reportAndAccept(api: Api, caseId = CASE, crew = 'demo-amb-2', ambulanceId = 'AMB-BLR-002') {
  const created = await api.post(crew, '/api/emergencies', {
    clientRequestId: uuid(), caseRef: caseId, location: { latitude: 13.0431, longitude: 77.5891, method: 'MAP_PIN' }, severity: 'HIGH',
    reportedSymptoms: ['Chest pain'], suspectedCause: 'Synthetic test', requiredCapabilities: [],
  });
  if (created.status !== 202) throw new Error(`fixture: report ${created.status} ${created.text.slice(0, 200)}`);
  let requestId: string | undefined;
  await api.waitFor(async () => {
    const reqs = (await api.get('demo-hosp-1', `/api/hospitals/${H1}/requests`)).json as any[];
    requestId = Array.isArray(reqs) ? reqs.find((r) => r.caseId === caseId)?.requestId : undefined;
    return !!requestId;
  });
  await api.event('demo-hosp-1', envelope('hospital.acceptance.received', {
    responseId: `R-${uuid().slice(0, 8)}`, requestId: requestId ?? 'AR-none', caseId, hospitalId: H1, status: 'ACCEPTED',
    acceptedCapabilities: ['EMERGENCY'], limitations: [], respondedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 30 * 60_000).toISOString(),
    responderRole: 'CLINICAL_COORDINATOR', source: 'SYNTHETIC_DEMO',
  }, { type: 'hospital', id: H1 }));
  await api.waitFor(async () => (await ambulance(api, ambulanceId))?.destinationHospital === H1);
}

/** A second patient all the way into Dr. Ravi Kumar's care, by API (crew position set by hand). */
async function intoCare(api: Api, caseId: string, crew: string, ambulanceId: string): Promise<string> {
  await reportAndAccept(api, caseId, crew, ambulanceId);
  const h1 = ((await api.get('demo-mgmt-1', '/api/hospitals')).json as any[]).find((h) => h.hospitalId === H1);
  await api.event(crew, envelope('ambulance.location.updated', { ambulanceId, coordinates: { latitude: h1.location.latitude, longitude: h1.location.longitude }, source: 'MANUAL' }, { type: 'ambulance', id: ambulanceId }));
  await api.waitFor(async () => (await ambulance(api, ambulanceId))?.status === 'ARRIVED');
  const arr = await api.post('demo-hosp-1', `/api/hospitals/${H1}/arrivals`, { clientRequestId: uuid(), caseId });
  const encounterId: string = arr.json?.encounter?.encounterId;
  await api.post('demo-hosp-1', `/api/encounters/${encounterId}/handover`, { clientRequestId: uuid() });
  const assign = await api.post('demo-hosp-1', `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-001-01' });
  if (!encounterId || assign.status >= 300) throw new Error(`fixture: ${caseId} into care failed (${arr.status}, ${assign.status})`);
  return encounterId;
}

async function main() {
  console.log('[Test] Browser: demo portal, theme isolation and manual workflows\n');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-browser-portal-'));
  const api = await startApi(API_PORT, {
    JIVA_DOCUMENT_DIR: documentDir,
    CORS_ORIGINS: Object.values(APPS).map((p) => `http://localhost:${p}`).join(','),
  });
  let browser: Browser | undefined;
  const pageErrors: string[] = [];
  try {
    await Promise.all((Object.keys(APPS) as AppName[]).map(startApp));
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(12_000);
    page.on('pageerror', (e) => pageErrors.push(e.message));
    check('fixture: demo reset', (await api.post('demo-admin', '/api/demo/reset')).status === 200);

    // ------------------------------------------------------------ 1. portal home
    console.log('[1] Portal Home');
    await page.goto(url('portal'));
    check('the portal opens on Home: "JIVA — Real-time healthcare coordination"', await ok(page.getByRole('heading', { name: 'JIVA', exact: true }).waitFor()) && (await page.getByText('Real-time healthcare coordination').count()) === 1);
    check('the portal is in the OLED theme (true black canvas)', (await page.evaluate(() => document.documentElement.classList.contains('theme-oled'))) && JSON.stringify(await rgb(page, '#root > div')) === '[0,0,0]', JSON.stringify(await rgb(page, '#root > div')));
    const facts = await page.getByRole('list', { name: 'What is real and what is simulated in this demo' }).innerText();
    check('it says plainly that no hardware and no GPS are connected', /No hardware connected/.test(facts) && /No GPS/.test(facts), facts);
    const roles: Array<[string, AppName, string]> = [['Patient', 'patient', 'demo-patient-1'], ['Doctor', 'doctor', 'demo-doc-3'], ['Hospital', 'hospital', 'demo-hosp-1'], ['Ambulance', 'ambulance', 'demo-amb-1'], ['Management', 'management', 'demo-mgmt-1']];
    const hrefs = await Promise.all(roles.map(([title]) => page.getByRole('link', { name: `Open ${title.toLowerCase()} interface` }).getAttribute('href')));
    check('one card per role, each opening its interface as a demo persona', roles.every(([, app, persona], i) => hrefs[i] === url(app, persona)), hrefs.join(' '));
    const doctorCard = page.getByRole('article', { name: 'Doctor' });
    await doctorCard.getByRole('combobox', { name: 'Demo persona' }).selectOption('demo-doc-1');
    check('choosing another persona changes the link', (await doctorCard.getByRole('link', { name: 'Open doctor interface' }).getAttribute('href')) === url('doctor', 'demo-doc-1'));
    check('every role card says what the role can see', (await page.getByRole('article').filter({ hasText: /Only|Requests and patients|Your own unit|Operational state/ }).count()) >= 5);

    await page.getByRole('button', { name: 'Start a guided demo' }).click();
    check('"Start a guided demo" opens the scenarios (?view=scenarios) with a breadcrumb', page.url().endsWith('?view=scenarios') && (await page.getByRole('navigation', { name: 'Breadcrumb' }).innerText()).includes('Scenarios'));
    const briefing = await Promise.all(['What it shows', 'Roles involved', 'What you do', 'Expected outcome', 'Data used'].map((t) => page.getByText(t, { exact: true }).isVisible()));
    check('the selected scenario explains itself (what it shows, roles, what you do, outcome, data)', briefing.every(Boolean), JSON.stringify(briefing));
    await page.goBack();
    check('the browser Back button returns Home', await ok(page.getByRole('heading', { name: 'JIVA', exact: true }).waitFor()));
    await page.getByRole('navigation', { name: 'Demo portal' }).getByRole('button', { name: 'System' }).click();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Demo portal' }).click();
    check('the breadcrumb returns Home', page.url().endsWith('?view=home') && (await ok(page.getByRole('heading', { name: 'JIVA', exact: true }).waitFor())));

    // ------------------------------------------------------------ 2. reset needs confirmation
    console.log('[2] Reset needs an explicit confirmation');
    await reportAndAccept(api);
    await page.getByRole('button', { name: 'Reset demo data…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset all demo data?' });
    check('the reset button only opens a confirmation dialog', (await ok(dialog.waitFor())) && (await patients(api)) === 1);
    await dialog.getByRole('button', { name: 'Keep the data' }).click();
    check('"Keep the data" closes it and changes nothing', !(await dialog.isVisible()) && (await patients(api)) === 1);
    await page.getByRole('button', { name: 'Reset demo data…' }).click();
    await dialog.getByRole('button', { name: 'Reset demo data' }).click();
    check('confirming resets the demo', await api.waitFor(async () => (await patients(api)) === 0));

    // ------------------------------------------------------------ 3. theme isolation and back links
    console.log('[3] Operational apps: light theme and a way back to the portal');
    for (const [, app, persona] of roles) {
      await page.goto(url(app, persona));
      const link = page.getByRole('link', { name: 'Demo portal' });
      const linked = (await ok(link.waitFor())) && (await link.getAttribute('href')) === url('portal');
      const light = !(await page.evaluate(() => document.documentElement.classList.contains('theme-oled'))) && (await rgb(page, 'body')).every((c) => c > 200);
      check(`${app}: light theme, "Demo portal" link to the portal`, linked && light, JSON.stringify(await rgb(page, 'body')));
    }
    await page.getByRole('link', { name: 'Demo portal' }).click();
    check('the link opens the portal Home', await ok(page.getByRole('heading', { name: 'JIVA', exact: true }).waitFor()));

    // ------------------------------------------------------------ 4. crew sets the position by hand
    console.log('[4] Crew sets the position by hand');
    await reportAndAccept(api);
    await page.goto(url('ambulance', 'demo-amb-2'));
    await page.getByRole('button', { name: /I'm at Hebbal/ }).click();
    const arrived = await api.waitFor(async () => (await ambulance(api, 'AMB-BLR-002'))?.status === 'ARRIVED', 10_000);
    check('"I\'m at Hebbal" marks the unit arrived, with a MANUAL position', arrived && (await ambulance(api, 'AMB-BLR-002'))?.locationSource === 'MANUAL');
    check('the crew screen labels it "Set by the crew"', await ok(page.getByText(/Set by the crew/).first().waitFor()));

    // ------------------------------------------------------------ 5. handover with notes
    console.log('[5] Handover with notes');
    const arr = await api.post('demo-hosp-1', `/api/hospitals/${H1}/arrivals`, { clientRequestId: uuid(), caseId: CASE });
    const encounterId: string = arr.json?.encounter?.encounterId;
    await page.goto(url('hospital', 'demo-hosp-1'));
    await page.getByRole('button', { name: 'Record handover', exact: true }).click();
    const ho = page.getByRole('dialog');
    await ho.getByLabel('Handover notes (optional)').fill(NOTE);
    await ho.getByRole('button', { name: 'Record handover now' }).click();
    check('the coordinator records the handover with notes; the department card shows them', await ok(page.getByText(NOTE).first().waitFor()));
    const assign = await api.post('demo-hosp-1', `/api/encounters/${encounterId}/doctor`, { clientRequestId: uuid(), practitionerId: 'PRAC-BLR-001-01' });
    check('fixture: Dr. Ravi Kumar assigned', assign.status === 200 || assign.status === 201, assign.text.slice(0, 160));

    // ------------------------------------------------------------ 6. doctor: typed vitals, correction, withdrawal
    console.log('[6] Doctor: typed vital signs, correction, withdrawal');
    await page.goto(url('doctor', 'demo-doc-3'));
    await page.locator('[role=option]', { hasText: CASE }).click();
    check('the assigned doctor sees the handover notes', await ok(page.getByText(NOTE).first().waitFor()));
    const panel = () => page.locator('[role=tabpanel]:visible');
    await page.getByRole('tab', { name: /Vital signs/ }).click();
    await panel().getByRole('button', { name: 'Record vital signs' }).click();
    check('the form says no monitoring device is connected', await ok(panel().getByText(/no monitoring device is connected/i).first().waitFor()));
    await panel().getByRole('textbox', { name: /Heart rate/ }).fill('140');
    await panel().getByRole('textbox', { name: /Blood glucose/ }).fill('142');
    await panel().getByRole('button', { name: 'Save vital signs' }).click();
    check('typed vital signs are saved and labelled as entered manually', await ok(panel().getByText(/Entered manually/).first().waitFor()));
    await panel().getByText(/Observation history/).click();
    await panel().getByRole('button', { name: /Correct Heart rate 140/ }).click();
    await panel().getByLabel(/Corrected value/).fill('104');
    await panel().getByLabel(/^Reason/).fill('Typed 140 instead of 104');
    await panel().getByRole('button', { name: 'Save correction' }).click();
    check('heart rate corrected to 104 (the history keeps the original)', await ok(panel().getByText(/Corrected to 104/).first().waitFor()));
    await panel().getByRole('button', { name: /Correct Blood glucose 142/ }).click();
    await panel().getByLabel(/^Reason/).fill('Entered on the wrong patient');
    await panel().getByRole('button', { name: 'Withdraw as entered in error' }).click();
    check('blood glucose withdrawn as entered in error', await ok(panel().getByText(/Withdrawn as entered in error/).first().waitFor()));
    const pv = (await api.get('demo-patient-1', `/api/encounters/${encounterId}/vitals`)).json;
    const seen = ((pv?.measurements ?? []) as any[]).filter((m) => m.source === 'MANUAL_CLINICIAN').map((m) => `${m.type}:${m.value}`);
    check('the patient sees only the current value (heart rate 104; no glucose, no 140)', JSON.stringify(seen) === JSON.stringify(['HEART_RATE:104']), JSON.stringify(seen));
    const notesForPatient = (await api.get('demo-patient-1', `/api/encounters/${encounterId}`)).text;
    check('the patient does not see the handover notes', !notesForPatient.includes('daughter informed'));

    // ------------------------------------------------------------ 7. a slow answer cannot overwrite the selected patient
    console.log('[7] Stale responses never overwrite the selected patient');
    const CASE2 = 'CASE-BLR-877';
    const encounter2 = await intoCare(api, CASE2, 'demo-amb-1', 'AMB-BLR-001');
    const own = await api.post('demo-doc-3', `/api/encounters/${encounter2}/vitals`, { clientRequestId: uuid(), measurements: [{ type: 'HEART_RATE', value: 77, unit: 'bpm', observedAt: new Date(Date.now() - 60_000).toISOString() }] });
    check('fixture: CASE-BLR-877 has its own typed heart rate (77)', own.status === 201, own.text.slice(0, 160));
    await page.goto(url('doctor', 'demo-doc-3'));
    await page.locator('[role=option]', { hasText: CASE2 }).click();
    await page.locator('main h2', { hasText: CASE2 }).first().waitFor();
    // Hold CASE-BLR-876's vital signs for 2.5 s, open it, then switch to CASE-BLR-877 before they arrive.
    await page.route(`**/api/encounters/${encounterId}/vitals`, async (route) => {
      await new Promise((r) => setTimeout(r, 2500));
      await route.continue();
    });
    await page.locator('[role=option]', { hasText: CASE }).click();
    await page.locator('[role=option]', { hasText: CASE2 }).click();
    await page.waitForTimeout(3500);
    await page.getByRole('tab', { name: /Vital signs/ }).click();
    const shown = (await page.locator('main h2').allInnerTexts()).join(' ');
    const vitalsText = await panel().innerText();
    check('after the slow answer for CASE-BLR-876 arrives, CASE-BLR-877 is still shown with its own vital signs (77, not 104)', shown.includes(CASE2) && !shown.includes(CASE) && /\b77\b/.test(vitalsText) && !/\b104\b/.test(vitalsText), `${shown} | ${vitalsText.slice(0, 900).replace(/\s+/g, ' ')}`);
    await page.unroute(`**/api/encounters/${encounterId}/vitals`);

    check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  } finally {
    await browser?.close().catch(() => undefined);
    for (const c of children) killChild(c);
    api.stop();
    try {
      fs.rmSync(documentDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  const { passes, failures } = results();
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
  console.log('✓ Portal and manual workflows browser suite PASSED.');
  process.exit(0);
}

main().catch((err) => {
  console.error('✗ Portal and manual workflows browser suite crashed:', err);
  for (const c of children) killChild(c);
  process.exit(1);
});
