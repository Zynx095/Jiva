# JIVA — Security, privacy and audit review (Phase 12, 2026-10-13)

This document records what the code actually enforces after the emergency-to-care work (phases 1–11), how
it is tested, and what is **not** protected yet. It is an engineering review, not a compliance statement:
JIVA does not claim conformity with HIPAA, DISHA/DPDP, ISO 27001 or any other regulation or standard.

## 1. Review checklist

| Area | What is enforced | Where | Tests |
|---|---|---|---|
| Authentication | Every `/api` route except `GET /api/health` requires a principal (`requireAuth`); no default role. Bearer JWTs are verified cryptographically; unsigned `x-cognito-claims` are refused; demo personas only outside production. Socket.IO handshakes use the same rules. **New:** the API refuses to start if `ENVIRONMENT`/`NODE_ENV` says production while `JIVA_ENVIRONMENT` is not production (demo personas would be accepted). | `services/api/src/index.ts`, `authVerification.ts` | journey: every new endpoint → 401 unauthenticated; operational-mode suite: demo personas refused (HTTP + realtime), insecure configuration refuses to start |
| Role-based authorization | Pure policies decide every action: event submission allowlist (`authorizationPolicy.ts`), encounter/clinical matrix (`clinical/policy.ts`), roster and audit reads. Frontends only hide controls. | `authorizationPolicy.ts`, `clinical/policy.ts`, `authorization.ts` | `rbac.test.ts`, `clinical-authorization.test.ts` (allow/deny per role), journey suite per endpoint |
| Hospital isolation | Hospitals see their own referrals, answers, incoming units and encounters; another hospital gets 404 for an encounter and 403 for arrivals at someone else's facility. Coordinators never see clinical content. | `authorization.ts`, `clinical/policy.ts` | journey phases 4–8 |
| Patient isolation | A patient reads only their own case, encounter, prescriptions, shared reports/documents and vital signs; another patient gets 404/403. | `authorization.ts`, `clinical/policy.ts`, routes | journey phases 5–10, realtime checks |
| Encounter ownership | Clinical reads/writes need the **assigned** clinician; reassignment moves access immediately and is re-checked under the per-case lock; record ids are checked against the encounter in the path. | `routes/clinicalRecords.ts`, `routes/documents.ts`, `routes/vitals.ts` | journey: reassignment removes access; record ids of other encounters → 404 |
| Prescriptions and reports | Versioned, append-only; writes need the assigned clinician and an encounter in care; the patient view omits staff ids, change reasons and unreleased reports. | `clinical/records.ts`, `clinical/views.ts` | `clinical-records.test.ts`, journey phase 7 |
| Document download | Only through the API, after the encounter-level check; patients only released documents; streamed as attachments with `nosniff`, `no-store` and a sandbox CSP; every download audited. No public URL exists. | `routes/documents.ts` | journey phase 8 (identifier swapping, other patient, coordinator, management) |
| Unsafe uploads | Declared type/size/sha256; ticket bound to document and uploader; streamed with size cut-off; sha256 and file signature verified before storing; server-generated file names; temporary files in the store directory; JSON limit unchanged (100 kB). | `clinical/documents.ts`, `routes/documents.ts` | `diagnostic-documents.test.ts`, journey phase 8 |
| WebSocket isolation | Local: per-socket `canReceiveEvent` + per-recipient copies (`eventForRecipient`). **New (AWS):** the broadcast Lambda verifies a principal at `$connect` (JWT via `?token=`, never stored) and delivers each event only to connections allowed to receive it, in their copy; connections without a verified principal receive nothing. | `authorization.ts`, `lambdas/websocketHandler.ts` | journey realtime checks; `realtime-isolation.test.ts` |
| Event validation / authorization | Zod validation, future-timestamp guard, submission allowlist (system and clinical events cannot be submitted), referral correlation, trusted provenance stamping, idempotency. | `index.ts`, `authorizationPolicy.ts`, `acceptanceCorrelation.ts` | `security-prompt-injection`, `ingestion-rbac`, journey (forged encounter event → 403) |
| Identifier manipulation | Unknown and unrelated resources answer alike (404 `not_found` / `not_routed_here`); upload tokens are user-bound; case-scoped referral ids are enforced. | routes | journey phases 4–8 |
| Mass assignment | All command bodies are `.strict()` (unknown fields → 400): no client can set author, source, provenance, status or ids. Event payloads strip unknown keys. | `packages/event-schema/src/commands.ts` | `clinical-contracts.test.ts`, journey (author override, claimed device source → 400) |
| Sensitive data in logs | Logs carry identifiers only (event ids, case ids, document ids); bus handler failures log ids, never payloads; no document bytes or record content is logged. **New:** clinical-record events are excluded from the AI sidecar's context and encounter events reach it with the actor's role only (data minimisation for an external model). | `infrastructure/eventBus/LocalEventBus.ts`, `intelligenceEngine.ts` | code review (grep of all `console.*` calls) |
| Secrets in source control | None found (scan for AWS keys, private keys, tokens). `config.auth.demoAuthSecret` has a placeholder default and is **not used anywhere**. The local `.env` is git-ignored. | `packages/config` | `git grep` scan |
| Error messages | Structured errors; 500 answers `internal_error` without details; malformed JSON → `{"error":"malformed_json"}`; async command failures no longer hang (Express 4). Validation messages describe the field, not other users' data. | `index.ts`, `commands/support.ts` | journey: malformed JSON |
| Insecure defaults | Local default is DEMO (documented); CORS limited to the local app origins; `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` on every API response; the production misconfiguration guard above. | `index.ts`, `mode.ts` | journey + operational-mode suites |
| Frontend/backend consistency | Every write the screens offer is a command the API authorizes again; screens show the server's answer (never optimistic success). | apps | journey suite exercises the same endpoints |

## 2. Audit trail

- `AuditRecord`: `auditId`, `at`, `actor` (user id, role, hospital/practitioner/ambulance), `action`, `outcome` (`ALLOWED`/`DENIED`), `entityType`, `entityId`, `encounterId`, `caseId`, `hospitalId`, machine-readable `reasonCode`. **No record content** (no medication, finding, title, file name, value).
- Recorded: arrival, handover, doctor assignment, prescription create/amend/discontinue, report create/amend, upload intent, upload (incl. integrity rejections), every download, vital-sign entry and simulation, emergency intake, and every denial with its reason; reads of clinical records are access-audited (once a minute per reader, record type and encounter); reading the audit log is itself audited.
- `GET /api/audit?encounterId=&caseId=&limit=` — administrators only (management, hospital staff, clinicians, crews and patients → 403).
- Tested: journey phase 12 (expected actions present, every entry complete, a denial's reason, no clinical content, audit reads audited).

## 3. Remaining gaps (not built)

1. **Production identity:** the AWS stack defines Cognito, but no user/role provisioning, MFA policy or session management exists; the local Express API uses demo personas. Patient identity is a case reference bound to a persona — there is no verified patient-linking flow.
2. **Storage:** clinical records, documents, measurements and the audit log are in memory (local) and lost on restart; production needs encrypted, durable, access-logged storage (KMS-encrypted DynamoDB/S3), backups and retention rules. Local document files are not encrypted at rest.
3. **AWS clinical domain:** encounter, clinical record, document and telemetry routes exist only in the local API; the AWS stack has no routes, functions or tables for them. The WebSocket `$connect` is IAM-authorized; opening it to browsers needs a Cognito-token authorizer.
4. **Abuse controls:** no rate limiting, no lockout, no request quotas, no WAF.
5. **Break-glass / emergency access:** none. A clinician sees only assigned encounters; there is no audited override for emergencies.
6. **Audit integrity:** the audit log is append-only in code but not tamper-evident (no hash chain, no WORM storage) and is capped (20,000 entries locally).
7. **Consent and data-subject rights:** no consent capture, export or erasure workflow.
8. **Existence hints:** a crew reporting with a patient-shared case reference learns whether that reference is already open (409 `case_exists`) — accepted for the intake workflow, noted here.
9. **AI sidecar:** with `USE_BEDROCK=true`, case context (operational events, conditions, symptoms) is sent to Amazon Bedrock; clinical records are excluded, but no data-processing agreement or region pinning is configured here.

## 4. How to re-run the evidence

```
npm run typecheck
npm run test:unit          # incl. clinical-authorization, clinical-records, diagnostic-documents, medical-telemetry, runtime-mode, realtime-isolation
npm run test:integration   # incl. clinical-journey (real API, all roles) and operational-mode (real API in production mode)
```

## 5. Release-readiness review (2026-10-13, after phase 14)

An independent pass over the implementation (code reading plus targeted reproduction), not a re-reading of
the test results. Severity is for the **hackathon demo setting** unless marked otherwise.

| # | Severity | Component | Finding | Reproducible | Status |
|---|---|---|---|---|---|
| R1 | **High** | API + Socket.IO (demo mode) | Demo personas are not authentication, and the API listened on every network interface: any device on the same network could call it as `demo-admin`, read every synthetic clinical record, upload files or reset the demo. | Yes, from the code: `httpServer.listen(port)` binds all interfaces and demo personas need only a header. The regression test now sends that request to the LAN address and gets 403. | **Fixed** (`ac5a180`): in DEMO mode HTTP and realtime accept only loopback clients (`403 demo_local_only`) unless `JIVA_DEMO_ALLOW_REMOTE=true` is set on purpose (warned at start-up). Health stays reachable. Tests: unit (`runtime-mode`), journey (request from the LAN address). |
| R2 | **Medium** (data loss) | Local document storage | Every API process cleared the same `data/local/documents` directory at start, so running the runtime test suite during a demo deleted the demo's uploaded scans. | Yes: `api-runtime.test.ts` starts an API without `JIVA_DOCUMENT_DIR`. | **Fixed** (`b189e1d`): default directory is per port. Test: `diagnostic-documents`. |
| R3 | Medium (reliability) | Launcher | A port held by an earlier, abnormally terminated run made `npm run dev` start half the services; there was no readiness signal. Reproduced while testing (orphaned Vite servers after killing the launcher's process tree). | Yes | **Fixed** (`cc27f6b`): ports checked first (clear message, nothing started), then `READY` / `NOT READY <service>`. |
| R4 | Medium | All local state | Emergencies, referrals, encounters, clinical records, document metadata, measurements, audit and idempotency results are in memory: a restart loses them (documents on disk become unreachable and are cleared). Screens recover cleanly (verified in the browser: API stopped → "reconnecting / cannot reach", restarted → live again, no errors) but show the reset state. | Yes | **Open — architectural.** Plan: [`persistence-plan.md`](persistence-plan.md). |
| R5 | Medium (production) | Patient linking | A crew can attach an emergency to any case reference (`caseRef`); the demo patient persona is bound to that reference. There is no verified patient identity or linking flow. | By design in demo | Open; production prerequisite. |
| R6 | Low | In-memory indexes | `processedEventIds`, expiry bookkeeping and the acceptance ledger grow without bound over a very long run (the event history itself is capped at 10,000). Irrelevant for a demo session. | Code reading | Open; resolved by persistence with TTLs. |
| R7 | Low | Hospital status strip | The hospital's shared "current answer" slot can still read "Accepted · CASE-…" after that patient arrived (legacy slot semantics, kept deliberately in Phase 4). Case-specific views are correct. | Yes | Open (cosmetic; routing unaffected). |
| R8 | Low | Uploads | An authorized clinician can declare many 20 MB uploads; there is no per-user quota. | Code reading | Open. |
| R9 | Info | AWS | Clinical APIs/storage do not exist on AWS; the WebSocket `$connect` is IAM-authorized (fan-out filters per principal). | — | Open; see `production-readiness.md`. |

Confirmed adequate in this pass: idempotency keys are scoped per command **and user** (a key cannot replay
another user's response) and replays happen only after authorization; upload tickets are user-bound and
hash-stored; JWT failure logs contain header fields and verifier messages, never the token; clinical events
on the bus are content-free; per-recipient event copies apply on every delivery path; reassignment removes a
clinician's access immediately (REST and realtime).
