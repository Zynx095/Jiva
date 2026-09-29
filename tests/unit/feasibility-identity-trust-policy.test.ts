/**
 * Policy 2 (Production Identity / Trust) — Option B, approved.
 *
 * Invariant under test: CLIENT PAYLOAD never establishes hospital identity or evidence trust.
 * AUTHENTICATED PRINCIPAL (Cognito claims in production, fixed DemoAuthProvider personas in DEMO)
 * establishes identity; server-side authorization checks principal.hospitalId against the payload's
 * hospitalId; server-side stampTrustedEvidence() derives evidence status from the principal alone.
 *
 * Also verifies (in-process, no real AWS calls) that the CDK UserPoolClient no longer allows a
 * signed-in user to self-service-write their own hospitalId/ambulanceId/caseId — the Cognito side
 * of the "admin-managed, non-self-editable" hospital binding.
 */
import { randomUUID } from 'crypto';
import type { AnyEvent } from '../../packages/event-schema/src';
import { LocalStateStore } from '../../services/api/src/infrastructure/stateStore/LocalStateStore';
import { createIngestionHandler } from '../../services/api/src/lambdas/core/ingestionCore';
import { deriveTrustedStatus, stampTrustedEvidence, evidenceEnvironment } from '../../services/api/src/evidenceTrust';
import { CASE, check, eq, ok, passCount, requestedEvent, responseEvent, T0 } from './helpers/feasibilityHarness';

type Claims = Record<string, unknown> | undefined;
const claims = (group: string, extra: Record<string, string> = {}): Claims => ({ sub: `user-${group}`, 'cognito:groups': [group], ...extra });
const call = (h: ReturnType<typeof createIngestionHandler>, c: Claims, body: unknown) =>
  h({ requestContext: c ? { authorizer: { claims: c } } : {}, body: typeof body === 'string' ? body : JSON.stringify(body) });
const parse = (r: { body: string }) => JSON.parse(r.body);
const withZ = (e: AnyEvent) => JSON.parse(JSON.stringify(e));

async function withEnv<T>(name: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prior = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await fn(); } finally { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; }
}

async function main() {
  console.log('[Test] Policy 2 — production identity / trust (Option B)\n');

  const puts: { detailType: string; detail: string; resource: string }[] = [];
  const store = new LocalStateStore();
  const handler = createIngestionHandler({ store, now: () => T0, put: async e => { puts.push(e); } });

  await store.recordEvent(requestedEvent(CASE, 'HOSP-A', 0, 15));
  await store.recordEvent(requestedEvent('CASE-B', 'HOSP-B', 0, 15));

  const acc = (caseId: string, hospitalId: string, over: Record<string, unknown> = {}) => {
    const e: any = withZ(responseEvent(caseId, hospitalId, 'ACCEPTED', { respondedMin: 0 }));
    return { ...e, payload: { ...e.payload, ...over } };
  };

  await check('1. Valid HOSPITAL identity with hospitalId HOSP-A -> can submit HOSP-A acceptance', async () => {
    puts.length = 0;
    const r = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc(CASE, 'HOSP-A'));
    eq([r.statusCode, parse(r).status], [202, 'accepted'], 'accepted');
    eq(puts.length, 1, 'published once');
  });

  await check('2. Same identity attempting HOSP-B -> 403 rejected', async () => {
    puts.length = 0;
    const r = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc('CASE-B', 'HOSP-B'));
    eq(r.statusCode, 403, 'forbidden');
    eq(puts.length, 0, 'nothing published');
  });

  await check('3. Client payload claiming HOSPITAL_CONFIRMED is ignored (trust derives from principal, not payload)', async () => {
    puts.length = 0;
    // A real, non-demo HOSPITAL principal already derives HOSPITAL_CONFIRMED on its own; the point is
    // that the claim in payload.source has NO bearing -- flip it and the trusted grade is identical.
    const withClaim = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc(CASE, 'HOSP-A', { source: 'HOSPITAL_CONFIRMED' }));
    eq(withClaim.statusCode, 202, 'accepted');
    const detail = JSON.parse(puts[0].detail);
    eq(detail.metadata.trustedEvidence.status, 'HOSPITAL_CONFIRMED', 'derived from the principal, coincidentally matches the claim');
    eq(detail.metadata.trustedEvidence.environment, 'DEMO', 'default test environment');
  });

  await check('4. Client payload claiming AUTHORIZED_FEED is ignored (never reaches that grade without a server adapter)', async () => {
    puts.length = 0;
    await store.recordEvent(requestedEvent('CASE-AF', 'HOSP-A', 0, 15));
    const r = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc('CASE-AF', 'HOSP-A', { source: 'AUTHORIZED_FEED' }));
    eq(r.statusCode, 202, 'accepted');
    const detail = JSON.parse(puts[0].detail);
    eq(detail.metadata.trustedEvidence.status, 'HOSPITAL_CONFIRMED', 'a real hospital principal only ever derives HOSPITAL_CONFIRMED, never AUTHORIZED_FEED, from payload claims alone');
  });

  await check('5. Client payload claiming SYNTHETIC_DEMO in a PRODUCTION deployment cannot become trusted', async () => {
    puts.length = 0;
    await store.recordEvent(requestedEvent('CASE-SD', 'HOSP-A', 0, 15));
    await withEnv('JIVA_ENVIRONMENT', 'production', async () => {
      const r = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc('CASE-SD', 'HOSP-A', { source: 'SYNTHETIC_DEMO' }));
      eq(r.statusCode, 202, 'accepted (schema-valid enum value)');
    });
    const detail = JSON.parse(puts[0].detail);
    eq(detail.metadata.trustedEvidence.status, 'HOSPITAL_CONFIRMED', 'real hospital principal, not SYNTHETIC_DEMO, regardless of the payload claim');
    eq(detail.metadata.trustedEvidence.environment, 'PRODUCTION', 'environment recorded correctly');
  });

  await check('6. Demo hospital identity continues working in DEMO (derivation unchanged)', () => {
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: true }, 'DEMO'), 'SYNTHETIC_DEMO', 'demo persona in DEMO');
    const e = stampTrustedEvidence(withZ(responseEvent(CASE, 'HOSP-A', 'ACCEPTED')) as AnyEvent, { role: 'HOSPITAL', isDemo: true }, 'DEMO');
    eq((e as any).metadata.trustedEvidence, { status: 'SYNTHETIC_DEMO', environment: 'DEMO' }, 'unchanged demo behavior');
  });

  await check('7. Production hospital identity receives production trust only through the authenticated principal', () => {
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: false }, 'PRODUCTION'), 'HOSPITAL_CONFIRMED', 'real principal, no payload involved at all');
    eq(deriveTrustedStatus({ role: 'HOSPITAL', isDemo: true }, 'PRODUCTION'), 'UNVERIFIED', 'a demo persona can never derive production trust');
  });

  await check('8. hospitalId cannot be changed through the intended user self-service attribute path (Cognito app client)', () => {
    // infrastructure/aws is its own npm project (not a root workspace), so its CDK dependencies are
    // only resolvable from within that directory. Synthesize there (no network, no real AWS) and
    // read the produced CloudFormation template -- this both proves the synth still succeeds and
    // checks the actual WriteAttributes the deployed app client would carry.
    const path = require('path');
    const fs = require('fs');
    const { execFileSync } = require('child_process');
    const infraDir = path.resolve(__dirname, '../../infrastructure/aws');
    execFileSync('npx', ['cdk', 'synth', '--quiet'], { cwd: infraDir, stdio: 'pipe', shell: true });
    const templatePath = path.join(infraDir, 'cdk.out', 'JivaAwsStack.template.json');
    ok(fs.existsSync(templatePath), 'synthesized template exists');
    const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    const clientResource = Object.values(template.Resources).find((r: any) => r.Type === 'AWS::Cognito::UserPoolClient') as any;
    ok(!!clientResource, 'a UserPoolClient resource exists');
    const writeAttrs: string[] = clientResource.Properties.WriteAttributes || [];
    for (const identityAttr of ['custom:hospitalId', 'custom:ambulanceId', 'custom:caseId']) {
      ok(!writeAttrs.includes(identityAttr), `${identityAttr} must not be self-service writable`);
    }
    ok(writeAttrs.includes('email'), 'email remains self-service writable (unrelated to identity binding)');
  });

  await check('9. Acceptance request correlation remains intact (unrelated to the identity change)', async () => {
    puts.length = 0;
    const noRequest = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc('CASE-NEVER-ASKED', 'HOSP-A'));
    eq([noRequest.statusCode, parse(noRequest).error], [409, 'no_outstanding_request'], 'correlation guard unaffected by this change');
  });

  await check('10. Two simultaneous cases remain isolated', async () => {
    puts.length = 0;
    await store.recordEvent(requestedEvent('CASE-ISO-1', 'HOSP-A', 0, 15));
    await store.recordEvent(requestedEvent('CASE-ISO-2', 'HOSP-A', 0, 15));
    const r1 = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc('CASE-ISO-1', 'HOSP-A'));
    const r2 = await call(handler, claims('HOSPITAL', { 'custom:hospitalId': 'HOSP-A' }), acc('CASE-ISO-2', 'HOSP-A'));
    eq([r1.statusCode, r2.statusCode], [202, 202], 'both accepted independently');
    eq(puts.length, 2, 'two independent publishes, no cross-case interference');
  });

  await check('bonus: evidenceEnvironment() default resolution is unaffected by this change', () => {
    withEnv('JIVA_ENVIRONMENT', undefined, () => {
      withEnv('AWS_LAMBDA_FUNCTION_NAME', undefined, () => {
        eq(evidenceEnvironment(), 'DEMO', 'default (no env vars) resolves to DEMO, exactly as before');
      });
    });
  });

  console.log(`\n[Test] Policy 2 identity/trust: ${passCount()} checks passed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
