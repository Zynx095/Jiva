# JIVA — Emergency-to-care journey: implementation reference

Branch `feat/emergency-to-care-journey`. The phase-by-phase record (audits, decisions, tests, commits) is
[`IMPLEMENTATION_PROGRESS.md`](../IMPLEMENTATION_PROGRESS.md); the security review is
[`security-review.md`](security-review.md). This document describes the result as it stands.

> JIVA is a research and demonstration platform. It is not a medical device. Everything in demo mode is
> synthetic; no live hospital, device or staff-directory integration exists (see §9).

## 1. The journey

**Journey A — emergency coordination.** An ambulance crew reports the emergency from the scene (location,
severity, reported symptoms, suspected cause, care it believes is needed). JIVA derives the care requirement
(frozen rule-based assessment ∪ crew request), refers the case to capable **network** hospitals, and routes
the crew only to a hospital that explicitly accepted **this** case. Expiry, rejection and unavailability
re-evaluate the destination through the existing routing engine (shadow decision authority unchanged).

**Journey B — hospital care.** The receiving hospital records the **arrival** (opens the encounter) and the
**handover** from the crew (the patient is now in hospital care; the crew is released). The coordinator
assigns the responsible doctor. The assigned clinician writes prescriptions and diagnostic reports, uploads
scans and documents, and records vital signs. The patient sees what the hospital released.

A GPS geofence, a timer or a screen never establishes arrival, handover or care: only the hospital's
records do.

## 2. Architecture changes

| Area | Change |
|---|---|
| Commands | New REST command endpoints (crew intake, arrival, handover, doctor, prescriptions, reports, documents, vital signs). Each: backend authorization → strict body (`.strict()`, identity/provenance never from the body) → idempotency (`clientRequestId`, 422 on reuse with another body) → per-case lock → state preconditions → canonical event validated against the contract → ledger + bus → projection. Async failures answer 500. |
| Encounter projection | `services/api/src/clinical/encounters.ts`: pure transitions + a projector for `encounter.*` events into the clinical store and the operational case/ambulance state. |
| Clinical store | `services/api/src/clinical/store.ts`: encounters, roster, prescriptions, reports, documents, measurements, audit, command results — separate from the operational store and never on the bus. In memory locally. |
| Content-free clinical events | `clinical.*` events carry identifiers, versions, hashes, counts and actors — never a medication, finding, value or file. |
| Per-recipient copies | `eventForRecipient`: staff identities in encounter/clinical events only for staff of the same hospital; everyone else gets the role. Applied to Socket.IO, ledger and timeline reads, the AWS WebSocket fan-out and the AI sidecar's context. |
| Arrival effects | `markAmbulanceArrived` (shared by the geofence and the hospital record) runs under the per-ambulance routing lock and re-validates; a hospital record wins over the routed destination (diversion). Selection, eligibility and the decision authority are untouched. |
| Directory | Public facility directory (466 facilities, OSM-matched coordinates where verifiable) as a separate read model; never routing candidates. |
| Documents | Storage interface + local provider; ticket-bound streamed uploads with integrity checks; authorized downloads. |
| Mode | `services/api/src/mode.ts`: one OPERATIONAL/DEMO switch (`JIVA_ENVIRONMENT`), shared with evidence trust. |
| Apps | Crew intake; hospital console (arrivals, handover, doctor); clinician workspace (same hospital app, chosen by the server role); patient state A/B; command-center provenance; server-driven demo badge. |

## 3. Event contracts (additions)

All in `packages/event-schema`. Additive and backwards compatible; the 7 clinical/encounter types are
**not externally submittable** (produced by commands only).

| Event | Payload (summary) |
|---|---|
| `patient.emergency.created` (extended) | optional `reportedSymptoms`, `suspectedCause`, `requestedCapabilities`, `notes`, `intake { channel, reportedByAmbulanceId, locationMethod, locationAccuracyMeters }` |
| `ambulance.dispatched` (extended) | optional `assignmentBasis: DISPATCH \| REPORTED_BY_CREW` |
| `ambulance.arrived` (extended) | optional `basis: GPS_GEOFENCE \| HOSPITAL_CONFIRMED` |
| `care.requirement.created` (extended) | optional `capabilitySources { ruleDerived, reporterRequested }` |
| `hospital.acceptance.expired` (extended) | optional `caseId`, `kind: RESPONSE_VALIDITY \| REQUEST_UNANSWERED` |
| `encounter.arrival.recorded` | encounterId, caseId, hospitalId, ambulanceId?, referralRequestId?, arrivedAt, recordedBy, dataStatus?, `basis: HOSPITAL_CONFIRMED` |
| `encounter.handover.recorded` | encounterId, caseId, hospitalId, ambulanceId?, handedOverAt, recordedBy, dataStatus? |
| `encounter.doctor.assigned` | encounterId, caseId, hospitalId, practitionerId, previousPractitionerId?, reason, assignedAt, recordedBy, dataStatus? |
| `clinical.prescription.recorded` | prescriptionId, encounter refs, version, action, status, contentHash, patientVisible |
| `clinical.report.recorded` | reportId, encounter refs, version, action, category, status, documentCount, contentHash, patientVisible |
| `clinical.document.stored` | documentId, encounter refs, category, contentType, sizeBytes, sha256, patientVisible |
| `clinical.telemetry.recorded` | batchId, encounter refs, source, measurementCount, measurementTypes, observedFrom/To, deviceId?, patientVisible |

Command bodies (`commands.ts`): intake, arrival, handover, doctor assignment, prescription create/amend/
discontinue, report create/amend, document upload intent, vital signs, simulation request, and the (unused,
for review) `DeviceObservationBatchSchema`.

## 4. API

| Method and path | Who | Notes |
|---|---|---|
| `POST /api/emergencies` | AMBULANCE | Crew intake; service area; unit free; 202 with the case reference |
| `GET /api/directory/facilities[/near]` | any authenticated | Public listings; straight-line distance only |
| `GET /api/cases/:id/referrals` | crew of the case, management, referred hospital (own row) | Listed / assessed / answer / capacity, kept apart |
| `POST /api/hospitals/:hospitalId/arrivals` | HOSPITAL of that hospital | Case routed there or with a standing answer of that hospital; otherwise 404 |
| `POST /api/encounters/:id/handover` | HOSPITAL of that hospital | ARRIVED → IN_CARE; crew released |
| `POST /api/encounters/:id/doctor` | HOSPITAL of that hospital | Active clinician of the same hospital; reasons; history |
| `GET /api/encounters[/:id]` | by view | Full (hospital staff, assigned clinician), patient view, summary (crew of the case, management) |
| `GET /api/hospitals/:id/clinicians` | HOSPITAL/CLINICIAN of that hospital | Roster with workload (demo: synthetic) |
| `GET/POST /api/encounters/:id/prescriptions`, `POST …/:rxId/amend`, `POST …/:rxId/discontinue` | assigned CLINICIAN writes; patient reads own | Versioned; `expectedVersion`; reasons |
| `GET/POST /api/encounters/:id/reports`, `GET …/:reportId`, `POST …/:reportId/amend` | assigned CLINICIAN writes; patient reads shared | Preliminary → final → amended |
| `POST /api/encounters/:id/documents` | assigned CLINICIAN | Upload intent → one-time PUT URL |
| `PUT /api/uploads/:token` | the declaring clinician | Streamed; size, sha256, signature checked |
| `GET /api/encounters/:id/documents[/:documentId/content]` | assigned CLINICIAN; patient released | Attachment download, audited |
| `GET/POST /api/encounters/:id/vitals`, `POST …/vitals/simulate` | assigned CLINICIAN writes; patient reads | Simulator only in DEMO mode |
| `GET /api/audit` | ADMIN | Content-free audit trail |
| `GET /api/health` | public | Adds `mode`, accurate `demoAuth`, `provenance` |

## 5. Authorization rules

| Principal | Can | Cannot |
|---|---|---|
| AMBULANCE | Report an emergency as its own unit; read its case, referral overview and encounter summary while assigned | Dispatch itself, answer for hospitals, record arrival/handover, read clinical content; after the handover it loses the case |
| HOSPITAL (coordinator) | Answer its referrals, report capacity, record arrival/handover and assign doctors at its own hospital, read its roster and full encounters | Read or write clinical content; act for another hospital |
| CLINICIAN | Everything clinical for encounters **assigned to them** at their hospital; read the roster | See other encounters (404), record arrival/handover, assign doctors, answer referrals |
| PATIENT | Read their own case, encounter (doctor's name, no staff ids), prescriptions, shared reports/documents, vital signs | Write anything clinical (403); see another case (404) |
| MANAGEMENT | Network coordination, encounter summaries, ledger (without clinical events) | Clinical content, audit log |
| ADMIN | Demo reset (demo mode only), audit log, network views | Clinical content |

Unrelated principals get **404** (existence is not revealed); related principals without the permission get **403**.
Every write and every denial is audited; clinical reads are access-audited.

## 6. Hospital-data provenance

| Source | Label | Meaning |
|---|---|---|
| Synthetic network (4 hospitals, 3 ambulances) | `SYNTHETIC_DEMO` | Demo only; never loaded in operational mode |
| Public directory (466 facilities) | `PUBLIC_LISTED` | What a facility lists; never capacity, never a destination |
| Referral answers | trusted stamp from the principal (`SYNTHETIC_DEMO` for demo personas, `HOSPITAL_CONFIRMED` for real staff) | The only thing that makes a hospital a destination; case-specific, time-limited |
| Capacity reports | as reported; `verified` only for hospital-confirmed or authorised-feed reports | Seed values are shown as seed, never as live |
| Unknowns | `UNKNOWN` | No answer, no report, no listing = unknown, never available |

## 7. Operational and demo behavior

`JIVA_ENVIRONMENT=production` (or AWS Lambda) → **OPERATIONAL**: demo personas refused; no synthetic network,
roster or simulator; no demo reset; `/api/health` says so. Anything else → **DEMO**: synthetic data labelled
`SYNTHETIC_DEMO` (cases, units, hospitals, roster, simulated vital signs); screens show the demo badge until
the server confirms operational mode. A process configured as production via `ENVIRONMENT`/`NODE_ENV` but
not switched to operational mode refuses to start.

## 8. Clinical records, documents and telemetry

- **Records** are append-only versions with author, time, reason and a sha256 of each version's content;
  stale edits are refused (`expectedVersion`). Stored in memory (local); lost on restart and demo reset.
- **Documents**: local provider under `JIVA_DOCUMENT_DIR` (default `data/local/documents/`, git-ignored),
  server-generated names, verified on upload, never served publicly. Not encrypted at rest locally.
- **Telemetry sources**: `MANUAL_CLINICIAN` (entered by the assigned clinician — the only real source in use),
  `DEVICE_SIMULATED` (demo-only simulator, always labelled, `SYNTHETIC_DEMO`), `MEDICAL_DEVICE` (contract only;
  no endpoint; nothing integrated). The source is decided by the server. Each value carries its observation time
  and freshness (current ≤ 15 min, recent ≤ 2 h, older).

## 9. Not implemented (external integrations and production prerequisites)

**Integrations that do not exist:** hospital capacity/acceptance feeds (answers come from the hospital app);
hospital staff directory (demo roster only); EHR/FHIR exchange; medical devices; production document object
storage (S3 provider designed, not built); e-prescription transmission; live traffic routing (Valhalla/OSRM
fixture-tested only; the mock fallback is labelled); Bedrock (failure path only).

**Before any production use** (none of this is done; nothing is deployed):

1. Identity: Cognito user pools, role provisioning (incl. `CLINICIAN` + `custom:practitionerId`), MFA, a verified patient-linking flow.
2. Durable, encrypted, access-logged storage for encounters, clinical records, documents (S3 + KMS), measurements and the audit trail; backups and retention.
3. The clinical domain on AWS: API routes, functions and tables for encounters, records, documents and vital signs (only the local API has them).
4. A Cognito-token authorizer on the WebSocket `$connect` (the fan-out already filters per principal).
5. Rate limiting/WAF, break-glass access, tamper-evident audit, consent and data-subject workflows.
6. Clinical validation and governance; the Care Feasibility Engine stays in shadow mode.
7. Lambda runtime upgrade (`nodejs20.x` is deprecated — pre-existing CDK warning).

## 10. Tests

| Suite | What it covers |
|---|---|
| `tests/unit/*` (36 suites) | Incl. clinical contracts and authorization matrix, intake rules, directory rules, referral lifecycle (simulated clock), encounter transitions, record versioning, documents (signatures, storage, tickets), telemetry (ranges, freshness, simulator, device contract), runtime mode, AWS realtime isolation |
| `tests/integration/api-runtime.test.ts` | The pre-existing runtime suite (124 checks), unchanged in substance |
| `tests/integration/clinical-journey.test.ts` | Real API: phases 2–12 per endpoint and role (302 checks) |
| `tests/integration/operational-mode.test.ts` | Real API in production mode; insecure configuration refuses to start (14) |
| `tests/integration/e2e-journey.test.ts` | The 20-step journey and the failure scenarios, with the mapping stack unreachable (39) |

Run: `npm run typecheck && npm run test:unit && npm run test:integration` (and `npm run build:lambdas`, `npx cdk synth --quiet` in `infrastructure/aws` — synthesis only, never deploy).
