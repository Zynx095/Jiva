# JIVA — Implementation Progress

Tracker for the phased emergency-to-care implementation (Master Implementation Directive, phases 0–14).
Every status below was recorded from an actual command run in this repository. "Done" means the
phase's acceptance criteria were met **and** verified; frontend-only progress is never marked done.

| Item | Value |
|---|---|
| Branch | `feat/emergency-to-care-journey` (created from `main` @ `b0be67c`; `main` is untouched) |
| Preserved prior work | `6dbeb8a feat(ui): JIVA design system and four-app UI/UX upgrade` — the previously uncommitted UI/UX work, committed verbatim before any new change |
| Not committed (not ours) | `start-jiva.bat` (Windows launcher created 2026-10-12, unrelated to this roadmap) — left untracked |
| Decision authority | `DECISION_AUTHORITY_MODE` unset → `SHADOW`; legacy rule engines decide all routing; no change planned |
| Cloud | Nothing deployed; no AWS command that provisions or deploys anything is run |

---

## Phase overview

| # | Phase | Status | Commits |
|---|---|---|---|
| 0 | Baseline, repository safety, tracking | ✅ Done | (this file) |
| 1 | Domain models, event contracts, authorization | ✅ Done | see Phase 1 section |
| 2 | Ambulance emergency intake | ⏳ | |
| 3 | Real hospital directory and map coverage | ⏳ | |
| 4 | Hospital referrals and explicit acceptance | ⏳ | |
| 5 | Arrival, handover, encounter creation | ⏳ | |
| 6 | Doctor assignment | ⏳ | |
| 7 | Clinical records and prescriptions | ⏳ | |
| 8 | Diagnostic documents and secure file storage | ⏳ | |
| 9 | Patient dashboard and in-hospital experience | ⏳ | |
| 10 | Medical telemetry foundation | ⏳ | |
| 11 | Operational mode, demo mode, provenance | ⏳ | |
| 12 | Security, privacy and audit hardening | ⏳ | |
| 13 | End-to-end integration and regression testing | ⏳ | |
| 14 | Final quality gate and documentation | ⏳ | |

---

## Phase 0 — Baseline (2026-10-12)

### Repository state found

- Branch `main`, up to date with `origin/main`, HEAD `b0be67c readme was added`. Tags `jiva-demo-ready-2026-09-26`, `jiva-demo-ready-2026-09-27`.
- 31 modified + 16 untracked paths: the UI/UX upgrade described in `docs/handoffs/PHASE-UI-UX-UPGRADE-HANDOFF.md` (last touched 2026-10-03), plus `start-jiva.bat` (2026-10-12). No sign of concurrent edits.
- **Handling:** branched to `feat/emergency-to-care-journey` (working tree carried over intact), committed the UI/UX work alone as `6dbeb8a` after verifying it builds and passes every suite. New work goes in separate commits on top, so the UI commit can be reviewed or reverted on its own.

### Discrepancies with the directive and earlier documents

| Claim | Reality (verified) |
|---|---|
| `JIVA_TECHNICAL_AUDIT_AND_HANDOFF.md` exists at the repository root | **Not present** anywhere in the repository or its parent folder. Its reported findings were re-derived from the code instead (all of them are confirmed below). |
| Phase 6.7 handoff: branch `jiva-intelligence-expansion` | The work is on `main`; that branch does not exist locally or on `origin`. |
| Phase 6.7 handoff lists frozen files `canaryRouter.ts`, `telemetryCollector.ts`, `auditLogger.ts`, `replayValidator.ts` | **None of these files exist.** The authority directory holds `circuitBreaker, config, decisionAuthority, disagreement, killSwitch, metrics, promotionGates, types`. The handoff overstates what was built; the frozen set that exists is respected. |
| README: canonical dataset "7 public-listed records; capabilities unknown" | `scripts/data-normalize.ts` **hard-codes** capabilities (`emergency/trauma/icu/...: true`) and coordinates (labelled `geocoder-nominatim`) that are not in the raw extracts. Only used when `USE_CANONICAL` is set. Addressed in Phase 3. |
| Audit: ambulance role cannot submit `patient.emergency.created` | Confirmed (`services/api/src/authorizationPolicy.ts`: only MANAGEMENT/ADMIN or the patient themself). |
| Audit: JSON body limit ~100 kB | Confirmed (`express.json({ limit: '100kb' })` in `services/api/src/index.ts`). |
| Audit: 15-minute acceptance TTL | Confirmed (`REQUEST_TTL_MS = 15 * 60000` in `services/api/src/stateTransitions.ts`). |
| Audit: GPS telemetry exists, medical telemetry does not | Confirmed. |
| Audit: `doctors.csv`, `Bengaluru.xlsx`, `bbmphospital.csv`, `bbmp_referral.csv` | All present at the repository root (profiled below). |

### Architecture map (as found)

- **Event pipeline:** client → `POST /api/events` → Zod `AnyEventSchema` → future-timestamp guard → `authorizeEventSubmission` (pure policy shared with the AWS ingestion lambda) → acceptance correlation check (409) → `stampTrustedEvidence` (provenance from the principal, never the payload) → `recordEvent` (eventId idempotency) → in-process `LocalEventBus`.
- **State engines** (`services/api/src/stateEngines.ts`): emergency → rule-based requirement (`assessRequiredCapabilities`) → `evaluateHospitals` (capability + case-scoped acceptance via the ledger + ED-unavailable; mapping only orders) → `hospital.acceptance.requested` (TTL 15 min) → responses → destination selection through `decisionAuthority` (SHADOW: legacy pick) → `destination.changed` / `route.recalculated`; reroute on REJECTED/UNAVAILABLE/capacity loss/expiry; GPS geofence (150 m) → `ambulance.arrived`.
- **Stores:** in-memory `LocalStateStore` (patients, hospitals, ambulances, event ledger, materialized acceptance indexes); DynamoDB store for AWS (code only).
- **Feasibility engine:** shadow-only observer (`services/api/src/feasibility/*`), traces as privileged-only `feasibility.trace.recorded`.
- **Realtime:** Socket.IO, every bus event filtered per principal by `canReceiveEvent`.
- **Auth:** demo personas (`x-jiva-demo-user`), Cognito RS256 path (`jwtVerifier` → `CognitoAuthProvider.parseClaims`); demo auth refused when `JIVA_ENVIRONMENT=production`.
- **Apps:** management (5173), ambulance (5174), hospital (5175), patient (5176); React 19 + Vite 8 + Tailwind 4; `@jiva/ui` consumed as source.
- **AWS:** CDK stack + 7 bundled lambdas mirroring the local engines (parity tested in-process), not deployed.

### Datasets profiled

| File | Rows | Content | Coordinates | Notes |
|---|---|---|---|---|
| `Bengaluru.xlsx` | 306 | S No, ROHINI ID, hospital name, address, city | none | ROHINI IDs suggest the insurance network registry (IIB ROHINI). Publisher/licence not documented in the repo. |
| `bbmphospital.csv` | 54 | BBMP facilities: name, type, address, ward | none | Mostly "BBMP Health Centre" (not hospitals). Addresses use `Bangalore ? 79` (mis-encoded dash + postal shorthand). |
| `bbmp_referral.csv` | 6 | BBMP referral hospitals | none | Several rows lack contact/ward. |
| `bbmp_maternity.csv` | 23 | BBMP maternity homes | none | Not ingested anywhere today. |
| `HospitalsInIndia.csv` | 1,348 (≈95 Bengaluru) | name, state, city, address, pincode | none | Origin undocumented. |
| `doctors.csv` | 10 | synthetic names, specialization (Dermatology/Pediatrics/Oncology), phone, email, branch | — | Branches ("Westside Clinic", "Eastside Clinic", "Central Hospital") **do not match any JIVA hospital**; synthetic Kaggle-style data. |
| `patients/appointments/treatments/billing.csv` | ~50 each | synthetic hospital-management dataset | — | Not used by JIVA; contains PII-shaped fields. Not imported. |
| `data/synthetic/bengaluru/*.json` | 4 hospitals, 3 ambulances | demo network | synthetic | Labelled `SYNTHETIC_DEMO`. |
| `data/canonical/hospitals.json` | 7 | manual extracts | hard-coded | See discrepancy above. |

### Baseline verification (before any change)

| Command | Result |
|---|---|
| `npm run typecheck` (all workspaces incl. 4 Vite builds + tests typecheck) | ✅ exit 0 (≈30 s) |
| `npm run test:unit` (25 suites) | ✅ exit 0 (≈1 m 45 s) |
| `npm run test:integration` (parity, mapping parity, runtime) | ✅ exit 0 — runtime **124 passed, 0 failed** |
| `npm run build:lambdas` | ✅ exit 0 — 7 bundles |
| `npm run data:validate` | ✅ exit 0 — 7 canonical facilities pass |

### Pre-existing issues recorded (not introduced by this work)

1. `tests/unit/security-prompt-injection.test.ts` is excluded from the tests typecheck (obsolete fixtures; documented in `tests/tsconfig.json`).
2. Canonical dataset contains capabilities/coordinates not present in its sources (see above).
3. Hospital responses are checked for an open request for (case, hospital) but **not** for the `requestId` they claim to answer; the management demo controls send `requestId: 'AR-demo-control'`.
4. AWS WebSocket broadcast (`services/api/src/lambdas/websocketHandler.ts`) sends every event except feasibility traces to **every** connection, with no per-role filtering (local Socket.IO filters per role). Not deployed; recorded for Phase 12.
5. `npm run build --workspaces` builds apps before packages (workspace order), so a fresh change to a package's types is only picked up by the apps on a second build.
6. No clinical domain exists: no encounter, doctor, prescription, report, document or medical telemetry model, event or API.

---

## Cross-cutting design decisions

Recorded here so later phases stay consistent. Each is the least invasive option that meets the directive.

1. **Routing stays where it is.** No change to `evaluateHospitals`, `pickLegacyDestination`, `decisionAuthority`, the acceptance ledger or any frozen Phase-6 component. New behaviour is added around them (inputs, read models, new events).
2. **Directory ≠ network.** Public directory facilities are a separate read model shown on maps with provenance. They never enter `hospitalsStore`, never receive referrals and never become routing candidates; capacity and capabilities stay unknown unless a source states them.
3. **Clinical content stays out of the operational bus.** Encounter lifecycle facts (arrival, handover, doctor assignment) are canonical events projected into an encounter store. Clinical records (prescriptions, reports, documents, measurements) are stored in an access-controlled clinical store; their canonical events carry identifiers, versions, hashes and actors only — no medication names, findings, values or file contents. Realtime delivery and the ledger APIs never expose clinical content.
4. **Commands for clinical workflows.** New workflows use REST command endpoints that validate, authorize (backend), check state preconditions, then record + publish the canonical event. The new event types are not submittable through `POST /api/events` (system/command-produced only), so preconditions cannot be bypassed.
5. **Arrival and handover are explicit.** The GPS geofence keeps producing the legacy `ambulance.arrived` signal, but in-hospital care starts only after a hospital user records the handover; the patient app switches on that backend state, never on GPS, timers or UI assumptions.
6. **Demo vs operational.** Synthetic hospitals, clinicians and simulated telemetry exist only in demo mode and are labelled; operational mode loads none of them and leaves unknowns unknown.

---

## Phase 1 — Domain models, event contracts, authorization (✅ 2026-10-12)

### What changed

| Area | Files | Summary |
|---|---|---|
| Domain models | `packages/domain-models/src/clinical.ts`, `patient.ts` | `ActorRef`, `Practitioner`, `HospitalEncounter` (+`DoctorAssignment`), `Prescription` (+versions), `DiagnosticReport` (+versions), `DiagnosticDocument`, `TelemetryMeasurement` (+`TelemetrySource`), `AuditRecord`. `PatientState` gains optional `reportedSymptoms`, `suspectedCause`, `requestedCapabilities`, `intake`, `encounterId` and status `HANDED_OVER`. Existing fields untouched. |
| Event contracts | `packages/event-schema/src/{primitives,clinical,commands,events}.ts` | Additive, optional fields: `patient.emergency.created` (`reportedSymptoms`, `suspectedCause`, `requestedCapabilities`, `notes`, `intake`), `ambulance.dispatched.assignmentBasis`, `ambulance.arrived.basis`, `care.requirement.created.capabilitySources`. New events: `encounter.arrival.recorded` (only `HOSPITAL_CONFIRMED`), `encounter.handover.recorded`, `encounter.doctor.assigned`, `clinical.prescription.recorded`, `clinical.report.recorded`, `clinical.document.stored`, `clinical.telemetry.recorded`. Clinical payloads are `.strict()` and carry ids/versions/hashes/actors only. Command bodies (intake, arrival, handover, assignment, prescriptions, reports, upload intents, telemetry) are strict; identity, provenance and telemetry source are never accepted from a body. |
| Roles | `packages/auth/src/{types,demoAuth,cognitoAuth}.ts`, CDK | New role `CLINICIAN` scoped by `hospitalId` + `practitionerId`; demo personas `demo-doc-1…5` (two at HOSP-BLR-004); Cognito group `CLINICIAN` + `custom:practitionerId` (CDK model only, `cdk synth` exit 0). |
| Submission policy | `services/api/src/authorizationPolicy.ts` (shared with the AWS ingestion lambda) | **Ambulance emergency creation:** the product journey starts with the crew, so `AMBULANCE` may submit `patient.emergency.created` only as its own unit (`source = {ambulance, ownId}`); a claimed `intake.channel` must match the reporter. No other permission is added (no self-dispatch, no hospital answers, no clinical access). Externally submitted `ambulance.dispatched` may not claim `REPORTED_BY_CREW`. The 7 new event types are not externally submittable by anyone. |
| Clinical policy | `services/api/src/clinical/policy.ts` (pure) | Explicit matrix: coordinator (`HOSPITAL`) = arrival/handover/doctor assignment/metadata at own hospital, no clinical content; `CLINICIAN` = clinical records only for encounters assigned to them; patient = own case, released records, read-only; ambulance = own case summary; management/admin = summaries, no clinical content; admin = audit log. Unrelated principals get 404 (no existence leak). Realtime/ledger delivery for the new events is default-deny; management/admin never receive clinical-record events. |
| Wiring | `services/api/src/authorization.ts`, `services/api/src/index.ts`, `services/api/src/clinical/{store,index}.ts` | `canReceiveEvent` routes encounter/clinical events through the clinical policy before the privileged shortcut; `CLINICIAN` sees only the clinical context of assigned patients; hospitals keep seeing patients whose arrival they recorded; `/api/events/history` is now filtered with the same delivery rules; demo reset clears the clinical store. |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/clinical-contracts.test.ts` (new) | ✅ 18 checks |
| `tsx tests/unit/clinical-authorization.test.ts` (new) | ✅ 23 checks (allow and deny paths for every role) |
| `npm run test:unit` (now 27 suites) | ✅ exit 0 |
| `npm run test:integration` | ✅ exit 0 — runtime 124 passed, 0 failed |
| `tsc` for all packages + `services/api` + `tsc -p tests/tsconfig.json` | ✅ |
| `npx cdk synth --quiet` (no deploy) | ✅ exit 0; pre-existing warning: Lambda runtime `nodejs20.x` deprecated (not changed here) |

### Decisions

- Separation of duties between coordination staff and clinicians follows "do not expose every hospital's encounters to every doctor": a clinician sees an encounter only once assigned. There is no break-glass access (documented limitation).
- Clinical-record events are deliberately content-free and strict, so even a coding mistake cannot put a medication or a measurement value on the operational bus.
- Encounter/clinical events are produced by command endpoints only (state preconditions cannot be bypassed through `POST /api/events`).

### Next

Phase 2 — ambulance emergency intake (command endpoint, engine handling of structured intake and crew assignment, AWS parity, ambulance UI).
