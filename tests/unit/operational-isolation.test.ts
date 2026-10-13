/**
 * Demo/operational isolation of the doctor-workspace features, with the real route handlers mounted
 * in-process and REAL (non-demo) principals — operational mode refuses demo personas, so this is how the
 * operational behaviour of these routes is exercised without a live identity provider.
 *
 * OPERATIONAL mode must offer nothing synthetic: no sample-document catalogue (its routes are 404), no
 * sample attachment, no simulated monitors, no demo fault injection, and no bundled medication list (an
 * administrator imports an authoritative one). Switching the same handlers to DEMO mode turns exactly
 * those features on, which shows the mode — not the caller — decides.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import type { AuthContext } from '../../packages/auth/src';
import { check, eq, ok, run } from './helpers/assert';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jiva-isolation-'));
process.env.JIVA_DOCUMENT_DIR = tmp;
process.env.JIVA_ENVIRONMENT = 'production';

const principals: Record<string, AuthContext> = {
  admin: { userId: 'ops-admin-1', role: 'ADMIN', isDemo: false } as AuthContext,
  clinician: { userId: 'clin-1', role: 'CLINICIAN', hospitalId: 'HOSP-REAL-1', practitionerId: 'PRAC-REAL-1', isDemo: false } as AuthContext,
  crew: { userId: 'crew-1', role: 'AMBULANCE', ambulanceId: 'AMB-REAL-1', isDemo: false } as AuthContext,
};

run('Operational / demo isolation of the clinical workspace features', async () => {
  const express = (await import('express')).default;
  const { catalogueRouter } = await import('../../services/api/src/routes/catalogue');
  const { documentRouter } = await import('../../services/api/src/routes/documents');
  const { prehospitalRouter } = await import('../../services/api/src/routes/prehospital');
  const { demoRouter, resetDemoFaults } = await import('../../services/api/src/routes/demo');
  const { initialiseCatalogues } = await import('../../services/api/src/catalogue');
  const { runtimeMode } = await import('../../services/api/src/mode');

  const app = express();
  app.use(express.json({ limit: '100kb' }));
  app.use((req, _res, next) => {
    (req as typeof req & { auth?: AuthContext }).auth = principals[String(req.headers['x-test-principal'])];
    next();
  });
  app.use('/api', catalogueRouter(), documentRouter(), prehospitalRouter(), demoRouter());
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (who: string, method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', 'x-test-principal': who }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text };
  };

  try {
    await check('OPERATIONAL: no sample-document catalogue, no bundled medication list', async () => {
      eq(runtimeMode(), 'OPERATIONAL', 'mode');
      initialiseCatalogues();
      const summary = (await call('clinician', 'GET', '/api/catalogue')).json;
      eq(summary?.kinds?.['scan-assets'], { available: false }, 'samples unavailable');
      eq([summary?.kinds?.medications?.available, summary?.kinds?.medications?.entries, summary?.kinds?.medications?.catalogueVersion], [true, 0, 0], 'medications empty until imported');
      const r = await Promise.all([
        call('clinician', 'GET', '/api/catalogue/scan-assets'),
        call('clinician', 'GET', '/api/catalogue/scan-assets/SCAN-XRAY-CHEST-PA/content'),
        call('admin', 'POST', '/api/catalogue/scan-assets/import/preview', { format: 'json', content: '[]' }),
        call('admin', 'GET', '/api/catalogue/scan-assets/export'),
      ]);
      eq(r.map(x => x.status), [404, 404, 404, 404], 'every sample route is absent');
    });

    await check('OPERATIONAL: a sample can never be attached, and no monitor or fault injection exists', async () => {
      const r = await Promise.all([
        call('clinician', 'POST', '/api/encounters/ENC-REAL-1/documents/samples', { clientRequestId: randomUUID(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: true }),
        call('crew', 'POST', '/api/cases/CASE-REAL-1/prehospital/simulate', { clientRequestId: randomUUID() }),
        call('admin', 'POST', '/api/demo/realtime-interruption', { seconds: 10 }),
        call('admin', 'GET', '/api/demo/realtime-interruption'),
      ]);
      eq(r.map(x => x.status), [404, 404, 404, 404], 'sample attach, simulated ambulance monitor, fault injection');
    });

    await check('OPERATIONAL: an administrator imports an authoritative medication catalogue (preview → apply); others cannot', async () => {
      const entry = { schemaVersion: 1, medicationId: 'MED-HOSP-PARA-500', status: 'ACTIVE', name: 'Paracetamol', strength: '500 mg', formulation: 'TABLET', routes: ['ORAL'], provenance: { source: 'Hospital formulary export', licence: 'Internal' } };
      const denied = await call('clinician', 'POST', '/api/catalogue/medications/import/preview', { format: 'json', content: JSON.stringify([entry]) });
      const prev = await call('admin', 'POST', '/api/catalogue/medications/import/preview', { format: 'json', content: JSON.stringify([entry]) });
      const applied = await call('admin', 'POST', '/api/catalogue/medications/import/apply', { clientRequestId: randomUUID(), previewId: prev.json?.previewId });
      eq([denied.status, prev.status, applied.status, applied.json?.catalogueVersion], [403, 200, 200, 1], 'import');
      eq(((await call('clinician', 'GET', '/api/catalogue/medications')).json?.entries ?? []).map((e: { medicationId: string }) => e.medicationId), ['MED-HOSP-PARA-500'], 'only the imported entry');
    });

    await check('DEMO: the same handlers offer the synthetic samples, the simulator and fault injection', async () => {
      process.env.JIVA_ENVIRONMENT = 'demo';
      initialiseCatalogues();
      const summary = (await call('clinician', 'GET', '/api/catalogue')).json;
      ok(summary?.kinds?.['scan-assets']?.available === true && summary.kinds['scan-assets'].entries >= 8, 'samples available');
      ok((summary?.kinds?.medications?.entries ?? 0) >= 20, 'bundled illustrative medication list loaded');
      const sample = await call('clinician', 'POST', '/api/encounters/ENC-UNKNOWN/documents/samples', { clientRequestId: randomUUID(), assetId: 'SCAN-XRAY-CHEST-PA', patientVisible: true });
      eq([sample.status, sample.json?.error], [404, 'not_found'], 'route exists; an unknown encounter is simply not found');
      const cut = await call('admin', 'POST', '/api/demo/realtime-interruption', { seconds: 5 });
      eq([cut.status, cut.json?.status], [200, 'interrupted'], 'fault injection available in demo mode');
      resetDemoFaults();
    });
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
