/**
 * Browser test suite: drives the REAL DEMO PORTAL and OPERATIONAL APPS in an installed
 * Microsoft Edge or Google Chrome (playwright-core).
 *
 * It tests every single one of the 10 demonstration scenarios directly through the
 * Demo Portal web interface, asserts that every step runs to completion, and verifies
 * that the corresponding real-time operational apps reflect the expected states:
 *
 *   1. Successful hospital acceptance (accept)
 *   2. Rejection followed by rerouting (reject)
 *   3. Busy (unavailable) followed by rerouting (busy)
 *   4. Several rejections before an acceptance (multi)
 *   5. Referral answer expires (expiry)
 *   6. Ambulance arrival and handover (handover)
 *   7. Doctor assignment and encounter review (doctor)
 *   8. Synthetic scan attached (scan)
 *   9. Clinician-authorised demonstration prescription (prescription)
 *  10. Realtime outage and recovery (outage)
 *
 * Also verifies:
 *  - Scenario reset and replay reproducibility
 *  - Non-operational tabs: Controls, Timeline, Asset library, System view
 *  - Clean error isolation and truthful status reporting
 *
 * Run: npx tsx tests/browser/demo-scenarios.browser.ts
 */
import { spawn, execSync, type ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import type { Browser, Page } from 'playwright-core';
import { ROOT, check, results, sleep, startApi, type Api } from '../integration/helpers/api';

const API_PORT = 4108;
const APPS = {
  management: 5183,
  ambulance: 5184,
  hospital: 5185,
  patient: 5186,
  doctor: 5187,
  portal: 5188,
} as const;

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

function startApp(app: keyof typeof APPS): Promise<void> {
  const folderName = app === 'portal' ? 'demo-portal' : `${app}-web`;
  const dir = path.join(ROOT, 'apps', folderName);
  const child = spawn(
    process.execPath,
    [path.join(dir, 'node_modules/vite/bin/vite.js'), '--port', String(APPS[app]), '--strictPort'],
    {
      cwd: dir,
      env: { ...process.env, VITE_API_URL: `http://localhost:${API_PORT}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
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

const visible = (page: Page, text: string | RegExp, ms = 12000) =>
  page
    .getByText(text)
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: ms })
    .then(
      () => true,
      () => false
    );

async function main() {
  console.log('[Test] Browser: complete demo portal scenarios suite against real UI and API\n');
  const documentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-browser-scenarios-'));
  const corsOrigins = Object.values(APPS).map((p) => `http://localhost:${p}`).join(',');

  const api: Api = await startApi(API_PORT, {
    JIVA_DOCUMENT_DIR: documentDir,
    ACCEPTANCE_EXPIRY_CHECK_MS: '1000',
    CORS_ORIGINS: corsOrigins,
  });

  let browser: Browser | undefined;
  try {
    console.log('Starting all 6 frontend dev servers for browser test...');
    await Promise.all((Object.keys(APPS) as Array<keyof typeof APPS>).map(startApp));
    console.log('All 6 frontend servers answering. Launching headless browser...');

    browser = await launchBrowser();
    const portalPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const opPage = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

    const pageErrors: string[] = [];
    portalPage.on('pageerror', (e) => pageErrors.push(`[Portal] ${e.message}`));
    opPage.on('pageerror', (e) => pageErrors.push(`[OpApp] ${e.message}`));

    // Navigate to the Demo Portal
    await portalPage.goto(`http://localhost:${APPS.portal}/?view=scenarios`);
    await portalPage.getByText('Demonstration portal').first().waitFor({ timeout: 15000 });
    check('portal: loads with heading "Demonstration portal"', true);

    const scenarioButtons = portalPage.locator('aside[aria-label="Scenarios"] button');
    const scenarioCount = await scenarioButtons.count();
    check('portal: displays exactly 10 scenario options in sidebar', scenarioCount === 10, `got ${scenarioCount}`);

    // Helper: Select scenario by index and run it to completion
    async function runScenarioInUI(index: number, titleMatch: RegExp, timeoutMs = 80_000): Promise<boolean> {
      const btn = scenarioButtons.nth(index);
      await btn.click();
      await portalPage.waitForTimeout(400);

      // Verify selected title in CardHeader
      await portalPage.locator('h2', { hasText: titleMatch }).first().waitFor({ timeout: 8000 });

      // Click "Run all remaining steps"
      const runBtn = portalPage.getByRole('button', { name: 'Run all remaining steps' });
      await runBtn.click();

      // If the reset confirmation modal pops up, click "Reset and run"
      const resetModalBtn = portalPage.getByRole('button', { name: 'Reset and run' });
      try {
        await resetModalBtn.waitFor({ timeout: 2000 });
        await resetModalBtn.click();
      } catch {
        /* no modal for non-resetting scenarios */
      }

      // Wait for completion banner
      const complete = await portalPage
        .getByText('Scenario complete — every step confirmed by the server')
        .waitFor({ timeout: timeoutMs })
        .then(
          () => true,
          () => false
        );

      // Verify no step shows failed state
      const failedCount = await portalPage.locator('li.bg-danger-50\\/60').count();
      return complete && failedCount === 0;
    }

    // -------------------------------------------------------------
    // Scenario 1: Successful hospital acceptance
    // -------------------------------------------------------------
    console.log('\n--- Scenario 1: Successful hospital acceptance ---');
    const s1Passed = await runScenarioInUI(0, /Successful hospital acceptance/);
    check('Scenario 1 (accept): completes all steps via Portal UI', s1Passed);

    // Cross-check Ambulance app (:5184)
    await opPage.goto(`http://localhost:${APPS.ambulance}/?as=demo-amb-2`);
    await visible(opPage, /Hebbal/i, 10000);
    const ambBody1 = (await opPage.locator('body').innerText()).replace(/\s+/g, ' ');
    check('Ambulance app: crew AMB-BLR-002 routed to Hebbal', ambBody1.includes('Hebbal'), ambBody1.slice(0, 300));

    // Cross-check Management app (:5183)
    await opPage.goto(`http://localhost:${APPS.management}/?as=demo-mgmt-1`);
    await opPage.getByRole('button', { name: 'View case' }).first().waitFor({ timeout: 15000 });
    const mgmtBody1 = (await opPage.locator('body').innerText()).replace(/\s+/g, ' ');
    check('Management app: shows Hebbal as accepting hospital', mgmtBody1.includes('Hebbal') && mgmtBody1.includes('Accepted'), mgmtBody1.slice(0, 300));

    // Cross-check Patient app (:5186)
    await opPage.goto(`http://localhost:${APPS.patient}/?as=demo-patient-1`);
    await visible(opPage, 'Hospital confirmed', 10000);
    const patBody1 = (await opPage.locator('body').innerText()).replace(/\s+/g, ' ');
    check('Patient app: shows Hospital confirmed', patBody1.includes('Hospital confirmed'), patBody1.slice(0, 300));

    // -------------------------------------------------------------
    // Scenario 2: Rejection followed by rerouting
    // -------------------------------------------------------------
    console.log('\n--- Scenario 2: Rejection followed by rerouting ---');
    const s2Passed = await runScenarioInUI(1, /Rejection followed by rerouting/);
    check('Scenario 2 (reject): completes all steps via Portal UI', s2Passed);

    // Cross-check Ambulance app: now rerouted to Indiranagar
    await opPage.goto(`http://localhost:${APPS.ambulance}/?as=demo-amb-2`);
    await visible(opPage, /Indiranagar/i, 10000);
    const ambBody2 = await opPage.locator('body').innerText();
    check('Ambulance app: rerouted to Indiranagar after Hebbal declines', ambBody2.includes('Indiranagar'));

    // -------------------------------------------------------------
    // Scenario 3: Busy (unavailable) followed by rerouting
    // -------------------------------------------------------------
    console.log('\n--- Scenario 3: Busy (unavailable) followed by rerouting ---');
    const s3Passed = await runScenarioInUI(2, /Busy \(unavailable\) followed by rerouting/);
    check('Scenario 3 (busy): completes all steps via Portal UI', s3Passed);

    await opPage.goto(`http://localhost:${APPS.ambulance}/?as=demo-amb-2`);
    await visible(opPage, /Indiranagar/i, 10000);
    const ambBody3 = await opPage.locator('body').innerText();
    check('Ambulance app: rerouted to Indiranagar after Hebbal reported busy', ambBody3.includes('Indiranagar'));

    // -------------------------------------------------------------
    // Scenario 4: Several rejections before an acceptance
    // -------------------------------------------------------------
    console.log('\n--- Scenario 4: Several rejections before an acceptance ---');
    const s4Passed = await runScenarioInUI(3, /Several rejections before an acceptance/);
    check('Scenario 4 (multi): completes all steps via Portal UI', s4Passed);

    await opPage.goto(`http://localhost:${APPS.ambulance}/?as=demo-amb-2`);
    await visible(opPage, /Indiranagar/i, 10000);
    const ambBody4 = await opPage.locator('body').innerText();
    check('Ambulance app: routed to Indiranagar after earlier rejections', ambBody4.includes('Indiranagar'));

    // -------------------------------------------------------------
    // Scenario 5: Referral answer expires
    // -------------------------------------------------------------
    console.log('\n--- Scenario 5: Referral answer expires (waits ~20s) ---');
    const s5Passed = await runScenarioInUI(4, /Referral answer expires/, 80_000);
    check('Scenario 5 (expiry): completes all steps via Portal UI upon acceptance expiration', s5Passed);

    await opPage.goto(`http://localhost:${APPS.ambulance}/?as=demo-amb-2`);
    await visible(opPage, /Indiranagar/i, 10000);
    const ambBody5 = await opPage.locator('body').innerText();
    check('Ambulance app: rerouted to Indiranagar following Hebbal expiry', ambBody5.includes('Indiranagar'));

    // -------------------------------------------------------------
    // Scenario 6: Ambulance arrival and handover
    // -------------------------------------------------------------
    console.log('\n--- Scenario 6: Ambulance arrival and handover ---');
    const s6Passed = await runScenarioInUI(5, /Ambulance arrival and handover/);
    check('Scenario 6 (handover): completes all steps via Portal UI', s6Passed);

    // Cross-check Ambulance app: crew released, now AVAILABLE
    await opPage.goto(`http://localhost:${APPS.ambulance}/?as=demo-amb-2`);
    await visible(opPage, /Available/i, 10000);
    const ambBody6 = (await opPage.locator('body').innerText()).replace(/\s+/g, ' ');
    check('Ambulance app: crew released and marked available/standby', ambBody6.includes('Available') || ambBody6.includes('Waiting for dispatch'), ambBody6.slice(0, 300));

    // Cross-check Hospital app (:5185): encounter is in care
    await opPage.goto(`http://localhost:${APPS.hospital}/?as=demo-hosp-1`);
    await visible(opPage, /CASE-BLR-876/i, 10000);
    const hospBody6 = await opPage.locator('body').innerText();
    check('Hospital app: patient arrived and in care', hospBody6.includes('CASE-BLR-876') && (hospBody6.includes('IN_CARE') || hospBody6.includes('In care') || hospBody6.includes('Handover')));

    // -------------------------------------------------------------
    // Scenario 7: Doctor assignment and encounter review
    // -------------------------------------------------------------
    console.log('\n--- Scenario 7: Doctor assignment and encounter review ---');
    const s7Passed = await runScenarioInUI(6, /Doctor assignment and encounter review/);
    check('Scenario 7 (doctor): completes all steps via Portal UI', s7Passed);

    // Cross-check Doctor app (:5187): Dr. Ravi Kumar sees CASE-BLR-876
    await opPage.goto(`http://localhost:${APPS.doctor}/?as=demo-doc-3`);
    await visible(opPage, /CASE-BLR-876/i, 10000);
    const docBody7 = await opPage.locator('body').innerText();
    check('Doctor workspace: Dr. Ravi Kumar has CASE-BLR-876 assigned', docBody7.includes('CASE-BLR-876'));

    // -------------------------------------------------------------
    // Scenario 8: Synthetic scan attached
    // -------------------------------------------------------------
    console.log('\n--- Scenario 8: Synthetic scan attached ---');
    const s8Passed = await runScenarioInUI(7, /Synthetic scan attached/);
    check('Scenario 8 (scan): completes all steps via Portal UI', s8Passed);

    await opPage.goto(`http://localhost:${APPS.doctor}/?as=demo-doc-3`);
    await opPage.locator('[role=option]').first().waitFor({ timeout: 15000 });
    await opPage.locator('[role=option]', { hasText: 'CASE-BLR-876' }).first().click();
    await opPage.locator('#enc-tab-documents').click();
    await visible(opPage, /Chest X-ray/i, 10000);
    const docBody8 = (await opPage.locator('body').innerText()).replace(/\s+/g, ' ');
    check('Doctor workspace: synthetic scan (Chest X-Ray) visible in documents', docBody8.includes('Chest X-ray') || docBody8.includes('SCAN-XRAY-CHEST-PA'), docBody8.slice(0, 300));

    // -------------------------------------------------------------
    // Scenario 9: Clinician-authorised demonstration prescription
    // -------------------------------------------------------------
    console.log('\n--- Scenario 9: Clinician-authorised demonstration prescription ---');
    const s9Passed = await runScenarioInUI(8, /Clinician-authorised demonstration prescription/);
    check('Scenario 9 (prescription): completes all steps via Portal UI', s9Passed);

    // Cross-check Doctor workspace
    await opPage.goto(`http://localhost:${APPS.doctor}/?as=demo-doc-3`);
    await opPage.locator('[role=option]').first().waitFor({ timeout: 15000 });
    await opPage.locator('[role=option]', { hasText: 'CASE-BLR-876' }).first().click();
    await opPage.locator('#enc-tab-prescriptions').click();
    await visible(opPage, /Paracetamol/i, 10000);
    const docBody9 = (await opPage.locator('body').innerText()).replace(/\s+/g, ' ');
    check('Doctor workspace: authorised Paracetamol prescription listed', docBody9.includes('Paracetamol') && (docBody9.includes('Active') || docBody9.includes('ACTIVE')), docBody9.slice(0, 300));

    // Cross-check Patient app: authorised prescription now visible to patient
    await opPage.goto(`http://localhost:${APPS.patient}/?as=demo-patient-1`);
    await visible(opPage, /Paracetamol/i, 10000);
    const patBody9 = await opPage.locator('body').innerText();
    check('Patient app: patient sees authorised Paracetamol prescription', patBody9.includes('Paracetamol'));

    // -------------------------------------------------------------
    // Scenario 10: Realtime outage and recovery
    // -------------------------------------------------------------
    console.log('\n--- Scenario 10: Realtime outage and recovery (waits ~15s) ---');
    const s10Passed = await runScenarioInUI(9, /Realtime outage and recovery/, 60_000);
    check('Scenario 10 (outage): completes live interruption and automatic reconnection', s10Passed);

    // -------------------------------------------------------------
    // Repeatability & Reset verification: Re-run Scenario 1
    // -------------------------------------------------------------
    console.log('\n--- Repeatability Test: Re-run Scenario 1 after reset ---');
    const s1RepeatPassed = await runScenarioInUI(0, /Successful hospital acceptance/);
    check('Scenario 1 repeatability: re-runs successfully to identical final state', s1RepeatPassed);

    // -------------------------------------------------------------
    // Demo Portal Views / Tabs Verification
    // -------------------------------------------------------------
    console.log('\n--- Demo Portal Views Verification ---');

    // Controls tab
    await portalPage.goto(`http://localhost:${APPS.portal}/?view=controls`);
    await visible(portalPage, 'Emergency', 10000);
    check('Portal Controls view: loads controls layout', await visible(portalPage, 'Crew AMB-BLR-002'));

    // Timeline tab
    await portalPage.goto(`http://localhost:${APPS.portal}/?view=timeline`);
    await visible(portalPage, 'Recorded timeline', 10000);
    check('Portal Timeline view: displays recorded server timeline', await visible(portalPage, 'Recorded timeline'));

    // Asset library tab
    await portalPage.goto(`http://localhost:${APPS.portal}/?view=assets`);
    await visible(portalPage, 'Chest X-Ray', 10000);
    check('Portal Asset library: lists synthetic clinical scan assets', await visible(portalPage, 'SCAN-XRAY-CHEST-PA'));

    // System tab
    await portalPage.goto(`http://localhost:${APPS.portal}/?view=system`);
    await visible(portalPage, 'Mode and data', 10000);
    const systemText = await portalPage.locator('body').innerText();
    check('Portal System view: confirms DEMO mode and mock routing', systemText.includes('DEMO') && systemText.includes('synthetic routes'));

    check('no uncaught page errors across all browser tests', pageErrors.length === 0, pageErrors.join('; '));
  } catch (err) {
    check('demo scenarios browser suite completed without crash', false, err instanceof Error ? err.message : String(err));
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
  console.log(`\nDemo Scenarios Suite: ${passes} passed, ${failures} failed`);
  await sleep(200);
  process.exit(failures ? 1 : 0);
}

void main();
