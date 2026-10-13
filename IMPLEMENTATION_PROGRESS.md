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
| Status (2026-10-13) | **All phases 0–14 done.** Final gate: typecheck, 36 unit suites, 6 integration suites (124 / 302 / 14 / 39 checks), lambdas, data validation, CDK synth (no deploy), lint, demo check, flagship scenario and a 27-check browser pass — all passing. Remaining limitations: Phase 14 section. |

---

## Phase overview

| # | Phase | Status | Commits |
|---|---|---|---|
| 0 | Baseline, repository safety, tracking | ✅ Done | (this file) |
| 1 | Domain models, event contracts, authorization | ✅ Done | see Phase 1 section |
| 2 | Ambulance emergency intake | ✅ Done | see Phase 2 section |
| 3 | Real hospital directory and map coverage | ✅ Done | see Phase 3 section |
| 4 | Hospital referrals and explicit acceptance | ✅ Done | see Phase 4 section |
| 5 | Arrival, handover, encounter creation | ✅ Done | see Phases 5–6 section |
| 6 | Doctor assignment | ✅ Done | see Phases 5–6 section |
| 7 | Clinical records and prescriptions | ✅ Done | see Phase 7 section |
| 8 | Diagnostic documents and secure file storage | ✅ Done | see Phase 8 section |
| 9 | Patient dashboard and in-hospital experience | ✅ Done | see Phase 9 section |
| 10 | Medical telemetry foundation | ✅ Done | see Phase 10 section |
| 11 | Operational mode, demo mode, provenance | ✅ Done | see Phase 11 section |
| 12 | Security, privacy and audit hardening | ✅ Done | see Phase 12 section |
| 13 | End-to-end integration and regression testing | ✅ Done | see Phase 13 section |
| 14 | Final quality gate and documentation | ✅ Done | see Phase 14 section |

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

---

## Phase 2 — Ambulance emergency intake (✅ 2026-10-12)

### What changed

| Area | Files | Summary |
|---|---|---|
| Shared intake rules | `services/api/src/intake.ts` | `deriveCareRequirement` = frozen `assessRequiredCapabilities` ∪ crew-requested care (rule-derived needs can never be removed); `composeCondition` keeps the legacy one-line condition with the cause prefixed `Suspected:`; `patientFromEmergency` projects symptoms, suspected cause, requested care and intake provenance as separate fields; `ambulanceCanAttend`. Used by BOTH the local engine and the AWS emergency lambda. |
| Engine | `services/api/src/stateEngines.ts`, `lambdas/core/emergencyCore.ts`, `lambdas/core/ambulanceCore.ts` | An emergency whose source is an ambulance assigns that crew through a system `ambulance.dispatched` (`assignmentBasis: REPORTED_BY_CREW`, `causationId` = the report) → status `ON_SCENE`. A busy or out-of-service unit is never reassigned. `care.requirement.created` carries `capabilitySources` when the crew added care. Legacy events produce exactly the legacy state (unit-tested). |
| Command | `services/api/src/routes/emergencies.ts`, `ingest.ts`, `serviceArea.ts`, `commands/support.ts` | `POST /api/emergencies` (AMBULANCE only): strict validation → idempotency (`clientRequestId`; 422 on key reuse) → per-ambulance lock → service-area check (422) → unit free (409 `ambulance_busy` / `ambulance_unavailable`) → case reference not already open (409 `case_exists`) → server-generated `CASE-XXXXXXXX` unless the patient shared one → canonical event validated against `AnyEventSchema` and the shared submission policy → trust stamp → ledger → bus. Content-free audit entries for allowed and denied reports. `POST /api/events` now shares the same `recordAndPublish` tail (behaviour unchanged). |
| Ambulance app | `apps/ambulance-web/src/EmergencyIntake.tsx`, `App.tsx`, `api.ts` | "Report an emergency" while the unit is free: location from this device (geolocation, accuracy shown), the ambulance's last GPS fix, a map pin (tap the map) or typed coordinates; severity; symptom chips + free text; suspected cause labelled unconfirmed; care chips showing how many connected hospitals list each (warning when none); optional patient reference (format-checked, no names or ID numbers); notes; review step; submit with pending and error states; a retry reuses the idempotency key. Success is confirmed from authoritative state (the case becomes this unit's job), with a 12 s "not visible yet" fallback. Job view: "Stay with the patient" next action, symptoms / suspected cause / crew notes, and a "No connected hospital could be asked" alert when the candidate evaluation leaves nobody to ask. Route map, decision bar, hospital answers and reroute card are unchanged. |
| Shared UI | `packages/ui/src/Map/JivaMap.tsx`, `lib/events.ts` | Backward-compatible `onPick` (crosshair cursor, reports the clicked point); crew-reported dispatch described as "attending". |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/emergency-intake.test.ts` (new) | ✅ 9 checks |
| `tsx tests/unit/aws-lambda-parity.test.ts` (+3 scenarios: S7 crew report, S7b care nobody lists, S7c busy crew) | ✅ 15 checks, local and AWS identical |
| `tsx tests/integration/clinical-journey.test.ts` (new, real API on :4101) | ✅ 40 passed: intake → case with separate symptoms/cause → crew ON_SCENE → referrals to capable hospitals only; idempotent retry; key reuse 422; busy 409; case_exists 409; patient-shared reference; out-of-area 422; validation 400s; 401/403 for every other role; generic `/api/events` path bound to the crew's own unit; realtime scoping |
| `npm run typecheck` | ✅ exit 0 |
| `npm run test:unit` (28 suites) | ✅ exit 0 |
| `npm run test:integration` | ✅ exit 0 (runtime 124/0, journey 40/0) |
| Browser (headless Edge via the DevTools protocol against `npm run dev`; scratch tooling, not committed) | ✅ 12/12: form opens, validation messages, emulated device location ±18 m, map-tap pin, unlisted-care warning, review shows symptoms and cause separately, submit → job view "Stay with the patient", backend ON_SCENE, no console errors, no horizontal overflow at 390 px. One earlier run timed out waiting for the emulated geolocation; the re-run passed (harness timing). |

### Decisions and limitations

- Ambulance-originated creation is a product requirement (Journey A step 1); the minimum change is that the crew may report as itself. The crew's assignment is derived by the engine, not a new crew permission.
- Patient identity is linked only through a case reference the patient shares (demo personas are bound to `CASE-BLR-876/877`). A verified production patient-link flow does not exist — documented limitation.
- The synthetic network lists only emergency/trauma/ICU/ventilator; asking for other care leaves nobody to refer to, which the UI states plainly instead of inventing capability.

---

## Phase 3 — Real hospital directory and map coverage (✅ 2026-10-12)

### What changed

| Area | Files | Summary |
|---|---|---|
| Pre-existing data honesty fix | `scripts/data-normalize.ts`, `data/canonical/hospitals.json` | The normalizer hard-coded capabilities (`emergency/trauma/icu/…: true`) that the raw extracts never state, and labelled typed-in coordinates as `geocoder-nominatim`. Capabilities are now empty ("not listed in source"), coordinates are `MANUAL_UNVERIFIED` / `UNVERIFIED` evidence. `npm run data:validate` still passes for all 7 records. This dataset is only used with `USE_CANONICAL`. |
| Directory model | `packages/domain-models/src/directory.ts` | `FacilityDirectoryEntry` (category + reviewable `categoryBasis`, name-only `specialtyHint`, ownership, address/pincode, listed phone, ROHINI id, `coordinateStatus` = `OSM_FACILITY_MATCH` / `MANUAL_UNVERIFIED` / `UNRESOLVED`, source references down to file + row, `operational: { connectedToJiva: false, acceptanceChannel: NONE, capacity: UNKNOWN }`). No capability or capacity fields exist. |
| Build | `scripts/directory-build.ts`, `scripts/lib/{directory,tabular}.ts`, `data/directory/*` | Dependency-free XLSX/CSV readers; 481 listings from 6 sources → **466 facilities** (15 evidence-based merges; chains keep their branches). Coordinates only from a name-matched OpenStreetMap health facility under strict, documented rules (specialty-class agreement, two-way identity containment, corroboration by postcode/locality for partial or thin names, ambiguity and postcode-conflict rejection, service-area check): **148 placed from OSM, 4 manual-unverified, 314 unresolved**. One Overpass query (snapshot committed with query, timestamp, attribution and ODbL licence); rebuilds are offline and byte-identical (verified). `build-report.json` explains every unplaced facility and every merge. Matches were reviewed by hand; the first rule set produced false positives (e.g. "Cloudnine Jayanagar" → "Jayanagar General Hospital"), the rules were tightened until they were rejected. |
| API | `services/api/src/directory.ts`, `routes/directory.ts` | `GET /api/directory/facilities` (filters `category`, `located`; any authenticated role; 503 if not built) and `GET /api/directory/facilities/near` (straight-line distance, labelled, ≤ 15 km). Directory facilities never enter `hospitalsStore`, so referrals, candidates, routing and the feasibility shadow are untouched. |
| UI | `packages/ui/src/Map/DirectoryLayer.tsx`, `lib/directory.ts`, `JivaMap` legend; `apps/management-web` (`components/Directory.tsx`, `NetworkMap.tsx`, `App.tsx`); `apps/ambulance-web/src/App.tsx` | One GeoJSON circle layer for hundreds of points (neutral gray — listed, not connected; amber ring = unverified location), click → card with category, address, listed phone, how the location was obtained, sources, and "Not connected to JIVA … call ahead". Command Center: map layer toggle + **Directory** tab (coverage summary, search, type filters with counts, on-map filter, inline details for unplaced facilities, loading / not-built / error states). Crew app: "Listed facilities" layer toggle, and when no connected hospital can be asked, the three nearest listed facilities by straight line with the not-connected warning. The gap message now names only care that NO connected hospital lists. |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/facility-directory.test.ts` (new) | ✅ 12 checks: names, pincodes, classification, merges, every match rule (incl. rejected false-positive patterns), placement, determinism, readers, and invariants of the committed directory (nothing operational claimed, unique ids, attribution) |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 3 section) | ✅ 50 passed: auth required; readable by every role; not-connected markers; filters; `near` sorting/bounds/validation; directory never enters the network; referrals and candidates involve network hospitals only |
| `npm run typecheck` / `test:unit` (29 suites) / `test:integration` / `data:validate` | ✅ all exit 0 (runtime 124/0, journey 50/0) |
| Browser (headless Edge, `npm run dev`) | ✅ 11/11: Directory tab summary + not-connected note, search, map card with provenance, inline details for unplaced facility, crew layer loads, crew report needing cardiology → "No connected hospital could be asked" + nearest listed facilities; no console errors |

### Decisions and limitations

- Network hospitals (synthetic, demo) and directory facilities (real, public) are deliberately separate: no directory facility has an acceptance channel, so none can become a destination.
- About two thirds of listings have no verified location; they are listed but not drawn. Name variants across sources are not always merged.
- `Bengaluru.xlsx` and `HospitalsInIndia.csv` have no documented publisher or licence in the repository — recorded in `data/directory/README.md`; verify before redistribution. OSM-derived coordinates are ODbL.

---

## Phase 4 — Hospital referrals and explicit acceptance (✅ 2026-10-12)

### Audit of the existing implementation (verified in code and at runtime)

| Item | Finding |
|---|---|
| Referral creation | ✅ `care.requirement.created` → `evaluateHospitals` → `selectRequestTargets` (capable, not INELIGIBLE) → one `hospital.acceptance.requested` per hospital, `AR-xxxxxxxx`, TTL 15 min. A changed requirement cancels earlier referrals (`REQUIREMENT_CHANGED`). Kept unchanged. |
| Delivery / hospital visibility | ✅ Socket.IO (hospital receives only its own) and `GET /api/hospitals/:id/requests`. |
| Accept / limited / decline | ✅ `ACCEPTED`, `LIMITED`, `REJECTED`. `UNAVAILABLE` ("cannot take any patient") exists in the domain (hospital-wide, time-bounded by its validity) but was not offered by the hospital app. |
| Correlation | ⚠️ An answer was checked only for an open referral for (case, hospital) — **not** for the referral id it claimed to answer; the demo controls sent `AR-demo-control`. Answer times were not checked at the door (the ledger later treated impossible windows as INVALID). |
| Expiry | ⚠️ Unanswered referrals were dropped silently (no event). Acceptance expiry ran off the hospital's **shared slot**: the lapse of the last-written answer rerouted every ambulance heading to that hospital, even those with valid answers of their own, and the lapse of an earlier case's answer rerouted nobody. (The selection itself was already case-scoped via the acceptance ledger.) |
| Duplicates / conflicts | ✅ duplicate eventId ignored; redelivered responseId has no side effect; a conflicting re-use of a responseId changes no decision (ledger CONFLICT, legacy first-wins). Kept. |
| Authorization | ✅ only `HOSPITAL` staff of that hospital (or ADMIN) may answer; clinicians and crews cannot (tested). |
| Realtime / rerouting | ✅ existing; extended below for case-scoped expiry. |

### Routing-adjacent change (documented before making it)

- **Limitation:** expiry handling used the shared one-slot acceptance (the same bug class the Phase 6 work fixed for selection).
- **Change:** `checkAcceptanceExpiry` now (1) keeps the slot's "UNKNOWN on lapse" display behaviour, (2) checks each case's own answer in the existing acceptance ledger and, once per lapse, publishes a case-scoped `hospital.acceptance.expired` (`caseId`, `kind: RESPONSE_VALIDITY`) and re-evaluates only that case's ambulance through the existing `rerouteAmbulance` → `selectDestination` path, and (3) announces unanswered referrals once (`kind: REQUEST_UNANSWERED`). Selection, eligibility, the decision authority and the ledger are untouched.
- **Risks considered:** double reroutes (prevented by the per-ambulance lock + destination check), repeated events (once-per-lapse set, cleared on reset), AWS parity (the AWS stack has no expiry engine at all — pre-existing, documented; parity scenarios unaffected).
- **Tests:** `tests/unit/referral-lifecycle.test.ts` scenario A **fails on the previous engine** (verified by running it against `HEAD`'s `stateEngines.ts`) and passes now; scenario B covers the over-broad reroute; plus once-only announcements and unanswered closure. The existing expiry runtime test still passes.

### What changed

| Area | Files | Summary |
|---|---|---|
| Correlation (shared local/AWS) | `services/api/src/acceptanceCorrelation.ts`, `index.ts`, `lambdas/core/ingestionCore.ts` | An answer must name **the** open referral for that case and hospital (409 `request_mismatch` otherwise — an acceptance can never be attributed to another case), `respondedAt` may not be in the future, and an ACCEPTED/LIMITED answer must be valid after it is given and for at most 6 h (400). |
| Expiry | `services/api/src/stateEngines.ts`, `packages/event-schema/src/events.ts`, `authorization.ts` | As above. `hospital.acceptance.expired` gains optional `caseId` and `kind`; case-scoped expiries reach only that case's crew. |
| Referral overview | `services/api/src/referrals.ts`, `routes/referrals.ts` | `GET /api/cases/:id/referrals`: per connected hospital, **listed** care (directory-level), **assessed** suitability at referral time, the case-specific **referral + explicit answer** (times, validity, limits, trusted provenance, referral id) and the last **reported capacity** with who reported it (`verified` only for hospital-confirmed or authorised-feed reports). Crew and management: all rows; a referred hospital: its own row; patients: 403; unrelated: 404. |
| Clients | `apps/management-web/src/lib/simulator.ts`, `tests/integration/api-runtime.test.ts` | Demo controls and the runtime test answer the real referral id (read from the ledger). |
| UI | `packages/ui/src/lib/{referrals,acceptance,status,events}.ts`, `apps/ambulance-web/src/{useCrew.ts,App.tsx}`, `apps/hospital-web/src/App.tsx`, `apps/management-web/src/components/Details.tsx` | Crew: "Hospital answers" from the server overview (survives reload), each row with an Evidence disclosure (lists / assessed at referral / answer with provenance and referral ref / capacity report and who made it). Hospital: referral id on each request ("your answer is tied to this case only") and the "Can't take any patient right now?" (`UNAVAILABLE`) answer with its hospital-wide consequence stated first. Command Center case detail: "Referral evidence" block. "No answer in time" status. |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/referral-lifecycle.test.ts` (new) | ✅ 7 checks (correlation matrix; expiry scenarios A/B — A proven to fail on the previous engine; once-only; unanswered closure) |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 4) | ✅ 81 passed: overview layers and access rules; wrong / cross-case referral ids 409; future and 7-hour answers 400; clinician cannot answer; explicit answer routes the crew; duplicates and conflicting duplicates change nothing; `UNAVAILABLE` recorded; a 2-second acceptance lapses → case-scoped event to that crew only, overview marks it not current, the other case keeps its destination |
| `tsx tests/integration/api-runtime.test.ts` | ✅ 124 passed (answers now name their referral) |
| `npm run typecheck` / `test:unit` (30 suites) / `test:integration` / `build:lambdas` | ✅ all exit 0 |
| Browser (headless Edge) | ✅ 10/10: demo control answers accepted with the real referral id; hospital card shows the referral reference and the unable-to-take option with its consequence; accept; crew answers + evidence; Command Center referral evidence; no console errors |

### Remaining limitations

- The AWS stack has no expiry engine (no scheduled lambda), so referral and acceptance expiry exist only locally — pre-existing, now documented.
- `UNAVAILABLE` keeps its legacy hospital-wide meaning (until the answer's validity ends); there is no per-service "unavailable for this case only" answer.
- A crew is not re-optimised to a closer hospital that accepts later (destination stability is intentional, unchanged).

---

## Phases 5–6 — Arrival, handover, encounter; doctor assignment (✅ 2026-10-13)

Implemented together: the encounter lifecycle and the doctor assignment share one projector, one command surface and one access model, so they were built, tested and committed as one unit.

### Audit of the existing implementation

| Item | Finding |
|---|---|
| Arrival | Only the GPS geofence (150 m of the destination): `ambulance.arrived` from the telemetry engine, case → `ARRIVED`, the case's referrals withdrawn (`CASE_CLOSED`). No hospital involvement. |
| Handover / encounter | None. The crew stayed `ARRIVED` with the case forever (never released); nothing marked the start of hospital care. |
| Patient app | On the GPS signal: "You have arrived — the emergency team takes over your care" (care asserted from a coordinate). |
| Doctors | `doctors.csv` (repository root): 10 rows — `doctor_id, first_name, last_name, specialization, phone_number, years_experience, hospital_branch, email`. Specialties Dermatology (3), Pediatrics (5), Oncology (2); branches "Westside Clinic" (3), "Eastside Clinic" (3), "Central Hospital" (4) — **none is a JIVA hospital**, none is emergency care, and every row carries a phone number and e-mail address. Not imported (see decisions). |

### Routing-adjacent change (documented before making it)

- **Limitation:** arrival effects lived inline in the GPS handler, outside the per-ambulance routing lock, so a reroute computed concurrently could overwrite an arrival (pre-existing race); and the case-scoped expiry (Phase 4) would still announce "acceptance expired" — and try to re-evaluate — after the patient had arrived.
- **Change:** the effects moved unchanged into `markAmbulanceArrived` (shared by the geofence and the hospital record), which now runs under the same per-ambulance lock as destination commits and re-validates there: a geofence hit counts only while the unit is still heading to that hospital; a hospital record counts while the unit carries that case and wins over the routed destination (diversion: the unit is recorded at the receiving hospital and its route dropped). The expiry loop skips answers whose referral was withdrawn. Selection, eligibility, the decision authority and the ledger are untouched.
- **Risks considered:** lock deadlock (the bus does not await handlers; reroutes queue behind the lock), timing of the GPS arrival (the existing runtime suite, which drives GPS arrivals, still passes 124/0), AWS parity (the AWS stack has no arrival detection — pre-existing).
- **Tests:** journey suite — the GPS geofence alone creates no encounter; diversion scenario; full runtime suite unchanged.

### What changed

| Area | Files | Summary |
|---|---|---|
| Event contracts | `packages/event-schema/src/clinical.ts` | Encounter and clinical payloads gain an optional, server-derived `dataStatus` (`SYNTHETIC_DEMO` for demo personas, `HOSPITAL_CONFIRMED` for real hospital staff). |
| Projection | `services/api/src/clinical/encounters.ts` | Pure transitions (`encounterFromArrival`, `applyHandover`, `applyDoctorAssignment`) re-check every precondition, so a replayed or out-of-order event cannot corrupt an encounter. Arrival → encounter `ARRIVED`, case `ARRIVED`, linked to the encounter and pointing at the receiving hospital, crew unit `ARRIVED` (`ambulance.arrived`, basis `HOSPITAL_CONFIRMED`), referrals withdrawn; the GPS time is kept on the encounter as evidence only. Handover → encounter `IN_CARE`, case `HANDED_OVER`, crew released (`AVAILABLE`, no case, no destination, no route). Assignment → current doctor + history (who, when, why; the previous assignment is closed). |
| Commands and reads | `services/api/src/routes/encounters.ts`, `clinical/{views,roster}.ts`, `commands/support.ts`, `index.ts` | `POST /api/hospitals/:hospitalId/arrivals` — coordinator of that hospital only; the case must be routed there or hold a standing answer of that hospital for that case (otherwise 404 `not_routed_here`, the same answer as for an unknown case — no existence oracle); never a second encounter (409 `already_recorded` / `encounter_elsewhere`); `arrivedAt` not in the future, not before the report, at most 12 h back. `POST /api/encounters/:id/handover` — the same hospital's coordinator; the encounter must be `ARRIVED` (409 `already_handed_over`); not before the arrival. `POST /api/encounters/:id/doctor` — coordinator; the encounter must be `IN_CARE`; an active clinician of the same hospital (422 `practitioner_not_eligible`); the first assignment is `INITIAL_ASSIGNMENT`, later ones `REASSIGNMENT` / `SHIFT_HANDOVER` / `SPECIALTY_REFERRAL`; 409 `already_assigned`. All three: strict bodies, idempotent `clientRequestId` (422 on reuse with another body), per-case lock, canonical event validated against the contract, content-free audit entries for allowed and denied attempts. `GET /api/encounters[?caseId]` and `GET /api/encounters/:id` with the view decided by the policy (hospital staff and the assigned clinician: full; the patient: own encounter with the doctor's name and specialty, no staff identities; the crew of the case and network coordination: summary; anyone else: 404). `GET /api/hospitals/:id/clinicians` (staff of that hospital; includes current workload). Async command failures now answer 500 instead of hanging the request (Express 4; also applied to the emergency intake). |
| Recipient copies | `services/api/src/authorization.ts`, `index.ts` | `eventForRecipient`: encounter and clinical events name the staff member who recorded them only to staff of the same hospital; the patient, the crew and network coordination receive the role only (realtime, ledger and timeline reads). |
| Demo roster | `data/synthetic/bengaluru/clinicians.json` | 7 synthetic clinicians across the 4 synthetic hospitals (one inactive), ids matching the demo clinician personas; loaded **only in demo mode** and labelled `SYNTHETIC_DEMO`. Outside demo mode the roster is empty and no doctor can be assigned — JIVA never invents staff. |
| Hospital app | `apps/hospital-web/src/{Department.tsx,App.tsx,useHospital.ts,api.ts}` | "Patients on the way" → **Record arrival** (the confirmation states that care starts only at handover; GPS is shown as evidence only); "Patient arrived but not listed here?" by case reference (diversions); **In your department**: encounters awaiting handover → **Record handover** (confirmation: the crew is released) and patients in care → **Responsible doctor** (assign / change with a reason; eligible = active roster with workload, inactive count shown; assignment history with the role of who recorded it). API errors are shown as sentences; retries reuse the request id. |
| Crew app | `apps/ambulance-web/src/App.tsx` | The next action distinguishes "At the hospital (GPS) — the hospital records arrival and handover" from "The hospital recorded your arrival"; on the handover record the unit returns to Available with a "Handover recorded" card. |
| Patient app | `apps/patient-web/src/{App.tsx,usePatient.ts}` | Reads its encounter; the headline and the journey ("Arrival recorded by the hospital", "In hospital care") follow the hospital's records only. A GPS arrival says "You have reached the hospital — the hospital will confirm your arrival and take over your care". |
| Command Center | `apps/management-web/src/{derive.ts,App.tsx}`, `components/{Kpis,Details}.tsx` | Cases at a hospital (arrived or handed over) are no longer "open"; KPI hint "N at hospital · M in hospital care"; case detail "At the hospital" (summary: hospital, status, arrival, handover, provenance — no doctor, no clinical content) and "Released after handover". |
| Shared UI | `packages/ui/src/lib/{encounters,status,events}.ts` | Encounter types and status, the `HANDED_OVER` case status, assignment reasons, event copy per audience; the GPS arrival is described as a geofence signal, not as care. |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/encounter-transitions.test.ts` (new) | ✅ 4 checks: arrival → encounter with actor, referral, GPS evidence and provenance; handover never twice, never before arrival, never for another case; assignment only after handover and only to an active clinician of the same hospital; history, reassignment, stale and repeated assignments |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 5: 52, +Phase 6: 25) | ✅ 158 passed: every non-coordinator role and other hospitals refused (401/403/404); an unknown case answers like a case not routed here; future times and a body `hospitalId` rejected; idempotent retry; duplicate arrival and handover 409; crew `ARRIVED` with `basis: HOSPITAL_CONFIRMED`; referrals withdrawn; per-role views (patient without staff ids, summaries, 404 for another hospital and an unassigned clinician); handover → `HANDED_OVER`, crew released and able to take a new case, the hospital keeps seeing its patient; realtime to patient, crew, hospital and management only, role-only copies for non-staff (ledger too); a forged encounter event through `/api/events` → 403; GPS alone → no encounter, the hospital record keeps the GPS time; diversion to a hospital that accepted; roster access and labels; assignment rules, who/when/why, the doctor gains and the previous doctor loses access (and is told), the patient sees the doctor, management does not; workload |
| `npm run typecheck` / `test:unit` (31 suites) / `test:integration` / `build:lambdas` | ✅ all exit 0 (runtime 124/0, journey 158/0) |
| Browser | ⚠️ Not run for these phases: the environment stopped the long-running dev stack (`npm run dev`) for low memory, and it was not restarted. The UI is verified by the strict typecheck and the production builds of all four apps; the behaviour behind it by the API suites above. |

### Decisions and limitations

- **Who may record an arrival:** the coordinator of the destination hospital, or of a hospital whose answer for this case still stands (a diversion is a physical fact the receiving hospital records). Any other hospital is refused, so no hospital can open an encounter — and gain access — for a case it has nothing to do with.
- **The handover releases the crew**, which then loses access to the case (it keeps a "handover recorded" note only).
- **`doctors.csv` is not imported:** it does not belong to JIVA's hospitals, covers no emergency specialty and carries contact details. A small synthetic roster aligned with the demo personas replaces it in demo mode; production needs a hospital staff-directory integration (not built).
- No correction workflow for arrival or handover records (an erroneous record needs an administrative amendment flow — not built). No shift or availability model: "active" is the only eligibility signal. No break-glass access.
- Arrival, handover and assignment exist only in the local API: the AWS stack has no routes, functions or tables for encounters (nothing deployed; revisited in Phases 12 and 14).

---

## Phase 7 — Clinical records and prescriptions (✅ 2026-10-13)

### Starting point

Phase 1 had defined the record models (`Prescription`, `DiagnosticReport` with versions), the strict command bodies, the content-free `clinical.prescription.recorded` / `clinical.report.recorded` events, the policy (`prescription.*` / `report.*` actions) and the store. No workflow, route or screen existed.

### What changed

| Area | Files | Summary |
|---|---|---|
| Record rules (pure) | `services/api/src/clinical/records.ts` | Append-only versions. Prescriptions: `CREATED` (ACTIVE) → `AMENDED` → `DISCONTINUED` (final; restart = new prescription). Reports: `PRELIMINARY` → `PRELIMINARY`/`FINAL`; a final report whose clinical content changes becomes `AMENDED` and never returns to preliminary; sharing with or withdrawing from the patient alone keeps the clinical status. Every change names the version it was based on (409 `version_conflict` otherwise), must change something (422 `no_change`) and carries a reason. `contentHash` = sha256 of the canonical content + status of each version. |
| Commands and reads | `services/api/src/routes/clinicalRecords.ts`, `clinical/views.ts`, `clinical/store.ts`, `commands/support.ts`, `index.ts` | `GET/POST /api/encounters/:id/prescriptions`, `POST …/prescriptions/:rxId/amend`, `POST …/prescriptions/:rxId/discontinue`, `GET/POST /api/encounters/:id/reports`, `GET …/reports/:reportId`, `POST …/reports/:reportId/amend`. Writes: only the clinician assigned to the encounter, only once the patient is in hospital care (409 `not_in_care`); authorization re-checked under the per-case lock (a reassignment between check and write cannot slip through); strict bodies; idempotent `clientRequestId`; report times not in the future; attachments must be verified documents of the same encounter (422 `invalid_document`); record ids are checked against the encounter in the path (no cross-encounter access). A record version is stored and its content-free event recorded together (rolled back if the event cannot be recorded). Reads: the assigned clinician (full records, every version, author names); the patient (own prescriptions; reports only once shared; current version only; prescriber/author by roster name; no staff ids, no change reasons); coordinators, crews, management and admins: 403/404. Writes and denied attempts are audited; reads are access-audited (at most once a minute per reader, record type and encounter). |
| Event copy | `packages/ui/src/lib/{records,events,time}.ts` | Record types, route and category labels, `medicationLine`, prescription/report status, date helpers; patient and staff wording for the content-free events. |
| Clinician workspace | `apps/hospital-web/src/{Root.tsx,main.tsx,personas.ts,ui.tsx}`, `src/clinician/*` | The hospital app now serves both roles (role from `/api/whoami`): coordinators keep their console; clinicians (`?as=demo-doc-3` …) get **My patients** (assigned encounters only) with the intake summary (symptoms, suspected cause labelled unconfirmed, assessed care, crew notes) and two panels. **Prescriptions**: prescribe, change (prefilled, based on the version shown, reason required), stop (reason required, final), history. **Diagnostic reports**: record (type, performed at, title, findings, conclusion, preliminary/final, share with patient), edit/correct, mark final, share / stop sharing, history. Every form shows the server's answer; a version conflict keeps the edits and loads the current version; retries reuse the request id. A patient reassigned to another doctor disappears from the list with their records. |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/clinical-records.test.ts` (new) | ✅ 5 checks: v1 and hashing; amendments (stale, no-change, append-only, input not mutated); discontinuation is final; report status machine incl. release-only changes; patient projections (no user ids, no change reasons, released attachments only) |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 7: 48) | ✅ 206 passed: coordinator / patient / other hospital's clinician / management / released crew / anonymous refused (403/404/401); validation (missing field, unknown route, author override, length, control characters); create, idempotent retry, key reuse 422, stored state; patient read without staff ids; another patient 404; coordinator and management cannot read clinical content; stale edit 409 with current version; amend → v2 with history; discontinue → v3; amending a stopped prescription 409; record id under another encounter 404; patient sees "stopped" without the internal reason; unreleased report invisible to the patient (list and by id); future report 400; unknown attachment 422; finalise + share → visible; final → preliminary 409; correction → AMENDED; realtime events carry no medication, reach only the doctor and the patient (role-only author), never management or the coordinator; management ledger read lists no clinical events; reassignment moves read/write access and back |
| `npm run typecheck` / `test:unit` (32 suites) / `test:integration` | ✅ all exit 0 (runtime 124/0, journey 206/0) |
| Browser | ⚠️ Not run (dev stack stopped by the environment for low memory, not restarted); covered by typecheck and production builds. |

### Decisions and limitations

- **Free-text clinical notes were not added** as a separate record type: the existing model's diagnostic report (category `PROCEDURE` / `OTHER`, findings, conclusion) records documented observations with the same versioning and release rules. A note type with its own release policy is a follow-up.
- Patients always see their own prescriptions (current version, status, prescriber); reports only when the clinician shares them. Change reasons and earlier versions stay with the care team.
- Coordinators (role `HOSPITAL`) never see clinical content — separation of duties from Phase 1.
- No discharge workflow: records can be written while the encounter is `IN_CARE`; there is no end of encounter yet.
- No medication terminology (free text, bounded and validated), no drug-interaction or allergy checks, no e-prescription transmission. Records live in the in-memory clinical store (lost on restart / demo reset); a production store must be encrypted and durable (not built).

---

## Phase 8 — Diagnostic documents and secure file storage (✅ 2026-10-13)

### Existing storage architecture (verified)

| Item | Finding |
|---|---|
| Local API body limit | `express.json({ limit: '100kb' })` in `services/api/src/index.ts` — **unchanged**. |
| File storage | None for clinical files. The CDK stack has one private S3 bucket for audit reports/snapshots (`JivaAuditBucket`, S3-managed encryption, Block Public Access); nothing writes documents to it and nothing is deployed. No S3 client is a dependency of the API. |
| Model | Phase 1 defined `DiagnosticDocument` (status `PENDING_UPLOAD` / `AVAILABLE` / `REJECTED`, sha256, size, type, `patientVisible`), the `DocumentUploadIntentCommandSchema` (20 MB maximum, PDF / PNG / JPEG / DICOM) and the content-free `clinical.document.stored` event. |

### What changed

| Area | Files | Summary |
|---|---|---|
| Storage and integrity | `services/api/src/clinical/documents.ts` | `DocumentStorage` interface + `LocalDocumentStorage` (development): files under `JIVA_DOCUMENT_DIR` (default `data/local/documents/`, git-ignored), named by the server-generated id (`DOC-<16 hex>.bin`), never by the uploaded name; uploads land in a temporary file in the same directory and are committed by rename; `clear()` removes only files matching the provider's own patterns. File-signature checks for PDF (`%PDF-`), PNG, JPEG and DICOM (`DICM` after the 128-byte preamble). Display-name sanitising (no directories or control characters) and RFC 6266/5987 `Content-Disposition`. Upload tickets: 32 random bytes (base64url), single document, single user, declared size/type/sha256, 10 minutes (`JIVA_UPLOAD_TICKET_TTL_MS`), only a hash of the token kept in memory. |
| Workflow | `services/api/src/routes/documents.ts`, `index.ts` | (1) `POST /api/encounters/:id/documents` — upload intent (assigned clinician, patient in care, strict body, idempotent) → `PENDING_UPLOAD` + a one-time `PUT /api/uploads/:token` URL. (2) `PUT /api/uploads/:token` — authenticated and bound to the declaring user (anyone else: the same 404 as an unknown token); content type must equal the declaration (415); a `Content-Length` other than the declared size is refused before reading (400); the body is **streamed** to disk while counted and hashed (no buffering in memory, a body larger than declared is cut off); accepted only if size, sha256 and file signature match → `AVAILABLE` + content-free `clinical.document.stored`; otherwise `REJECTED` with the reason (`HASH_MISMATCH`, `SIZE_MISMATCH`, `CONTENT_TYPE_MISMATCH`) and nothing stored. An interrupted upload stores nothing and may be retried with the same ticket until it lapses; a lapsed declaration is closed as `UPLOAD_EXPIRED` (visible, never silently kept). (3) `GET /api/encounters/:id/documents` — clinician: all, with status and reasons; patient: verified documents released at upload **or attached to a report shared with them**. (4) `GET /api/encounters/:id/documents/:documentId/content` — the document must belong to the encounter in the path; patient only if visible as above; streamed with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store`, `Content-Security-Policy: default-src 'none'; sandbox`. Every download is audited; denials too. Local documents are ephemeral like the rest of local state (cleared at start and on demo reset). |
| Reports | `services/api/src/routes/clinicalRecords.ts` | Attachments of a shared report are visible to the patient (sharing a report shares its attachments). Only verified documents of the same encounter can be attached. |
| Clinician UI | `apps/hospital-web/src/clinician/{DocumentsPanel,ReportsPanel,useClinician,ClinicianWorkspace}.tsx`, `src/api.ts` | **Documents and scans**: pick a file (type and size checked before sending), the browser computes the sha256, declares, uploads, and shows the server's verdict (Verified / Not stored with the reason / Awaiting upload); preview for images and download through the API (credentials in the request, an object URL in the browser — no public URL). Reports: attach verified documents; attachments listed on each report. |
| Shared UI | `packages/ui/src/lib/{records,events}.ts` | Document type/size helpers, verification status with plain reasons, event copy. |
| Test helper | `tests/integration/helpers/api.ts` | Responses also carry the raw bytes (download comparison). |

### Production object storage (designed, not built, nothing deployed)

A production provider would implement the same interface on a private object store: an S3 bucket with Block Public Access, SSE-KMS, TLS-only bucket policy, versioning, lifecycle rules for incomplete uploads and retention; the intent returns a **presigned PUT** bound to `Content-Length`, `Content-Type` and `x-amz-checksum-sha256` (S3 verifies the checksum); an `ObjectCreated` notification runs the signature check and marks the document `AVAILABLE`; downloads stay behind the API (or short-lived presigned GETs issued only after the same authorization check, with `response-content-disposition=attachment`). Not implemented: no S3 client dependency was added, and an untestable provider would be a mock-only claim.

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/diagnostic-documents.test.ts` (new) | ✅ 5 checks: signatures (genuine files pass; HTML-as-PDF, PDF-as-PNG, PNG-as-JPEG, DICOM without preamble, empty fail); display names (paths, control characters, bounds); download header encoding; local storage (id format, atomic commit, read-back, crafted id cannot escape, clears only its own files); tickets (bound to user, token not stored in clear, revocation) |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 8: 40) | ✅ 246 passed: 150 kB JSON still 413; coordinator / patient / other hospital's clinician / anonymous cannot declare; type, size, empty and hash validation; declaration → one-time URL; display name sanitised; idempotent declaration; URL bound to its uploader (patient and another clinician → 404); wrong content type 415; nothing downloadable before upload; upload verified → `AVAILABLE`; URL single-use; tampered bytes → `HASH_MISMATCH`; HTML disguised as PDF → `CONTENT_TYPE_MISMATCH`; size mismatch refused; rejected uploads listed with reasons; lapsed window → 410 + `UPLOAD_EXPIRED`; byte-exact download with the safe headers; unshared: patient cannot list or download; coordinator, management, another patient, and another hospital's clinician (identifier swapping through their own encounter) refused; rejected document cannot be attached; attached to a shared report → the patient lists and downloads the same bytes, without staff ids or the hash; realtime: metadata-only event to the doctor, nothing to the patient for an unshared upload |
| `npm run typecheck` / `test:unit` (33 suites) / `test:integration` | ✅ all exit 0 (runtime 124/0, journey 246/0) |
| Browser | ⚠️ Not run (dev stack stopped by the environment for low memory, not restarted); covered by typecheck and production builds. |

### Decisions and limitations

- The binary upload is a separate, ticket-bound endpoint; the JSON limit stays 100 kB and no file touches the event bus or the ledger.
- A document's visibility to the patient is decided at upload, or by sharing a report it is attached to. There is no separate "share this file" command and no deletion endpoint (medical records are retained; local files are ephemeral by design of local mode).
- Local files are not encrypted at rest (development only); production requires an encrypted object store as above.
- DICOM files are stored and downloadable but not rendered in the browser (no DICOM viewer).

---

## Phase 9 — Patient dashboard and in-hospital experience (✅ 2026-10-13)

### Existing patient app (inspected)

`apps/patient-web/src/App.tsx` had the pre-arrival experience (current care headline, ETA labelled as an estimate, journey steps, "Your hospital", `WhatNext`, AI summary, SOS card, activity timeline) and a `HealthRecords` placeholder ("Not connected yet … Coming later"). Phase 5 had already moved arrival and care onto the encounter. All existing screens were kept.

### What changed

| Area | Files | Summary |
|---|---|---|
| State A → B | `apps/patient-web/src/App.tsx` | **State A** (no encounter, or arrival recorded but not handed over): unchanged coordination screens; the records area says plainly that records become available once the hospital takes over care. **State B** starts only when the patient's own encounter is `IN_CARE` (the hospital's handover record): headline "In the care of …", "Your care team" instead of the acceptance card, in-hospital "What happens next", and a bedside "Feeling worse?" card instead of "Call 108". Journey steps (6) fit small screens. |
| In-hospital sections | `apps/patient-web/src/InHospital.tsx` | **Your care team**: assigned doctor (name, specialty, since when) or "not assigned yet"; arrival and handover times; hospital reference. **Your medications**: current prescriptions with status (stopped ones struck through), instructions, prescriber and dates — no change reasons. **Your reports and results**: shared reports only, with category, date, preliminary warning, findings, conclusion, author, corrections, attached images/documents. **Your scans and documents**: shared X-rays, ECGs and lab documents with view (images) and download through the API. Every section has loading, unavailable ("could not be loaded right now") and empty states; nothing is invented. |
| Data and privacy | `apps/patient-web/src/{usePatient,api}.ts`, `services/api/src/index.ts` | The hook loads the patient's own records for the current encounter only; they are dropped when the encounter changes or on demo reset, so one encounter's records never show under another. Records live in memory only (no browser storage); downloads use the patient's credentials and short-lived object URLs. Realtime events trigger a refresh; a reconnect refetches everything. All `/api` responses now carry `Cache-Control: no-store`, so a browser shared by several personas never serves one person's data from cache to another. |
| Notifications | `apps/patient-web/src/App.tsx` | Doctor assigned/changed; "New in your health records" for content-free clinical events. |

### Tests

| Command | Result |
|---|---|
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 9: 10) | ✅ 256 passed: the patient's encounter is `IN_CARE` with the doctor (state B source); case status agrees; `Cache-Control: no-store`; the patient's realtime connection drops, the doctor prescribes, after reconnecting a refresh shows it and the case history contains the missed content-free event (role-only author); the history never lists unshared reports/documents; another patient gets 403/404; the new connection carries only this case |
| `tsc` (patient app, tests, API) | ✅ |
| Browser | ⚠️ Not run in this phase (dev stack stopped by the environment for low memory); see Phase 14 for the end-of-roadmap browser pass. |

### Decisions and limitations

- The patient sees what the hospital released: own prescriptions (current version), shared reports and documents, the doctor's name. Internal notes, change reasons, earlier versions and unshared results stay with the care team.
- No discharge state yet: state B lasts while the encounter is `IN_CARE`.
- `WhatNext` stays non-clinical (who is caring for you, where updates appear); JIVA does not interpret results.

---

## Phase 10 — Medical telemetry foundation (✅ 2026-10-13)

### Existing telemetry (verified)

Only ambulance GPS (`ambulance.location.updated`) existed. No medical measurement was stored, generated or displayed anywhere. Phase 1 had defined the model (`TelemetryMeasurement` with `source` MANUAL_CLINICIAN / DEVICE_SIMULATED / MEDICAL_DEVICE), validated inputs (`MEASUREMENT_RULES`: unit and plausible range per type; systolic above diastolic), the content-free `clinical.telemetry.recorded` event and the policy (write: assigned clinician; read: assigned clinician and the patient).

### What changed

| Area | Files | Summary |
|---|---|---|
| Rules (pure) | `services/api/src/clinical/telemetry.ts` | Batches from validated inputs with the source decided by the server; latest value per type with age and freshness (current ≤ 15 min, recent ≤ 2 h, then old); observation times not in the future and not older than 24 h; **demo-only** simulated bedside monitor (`simulationAllowed()` is false outside DEMO; deterministic per seed, within the validated ranges); the **medical-device contract** (`checkDeviceBatch`: registered device bound to the encounter, strictly increasing sequence, device clock skew ≤ 5 min) with today's registry being empty, so every device batch is refused (`NO_DEVICE_INTEGRATION`). |
| Contracts | `packages/event-schema/src/commands.ts` | `SimulateTelemetryCommandSchema`; `DeviceObservationBatchSchema` (strict; for review — no endpoint accepts it). |
| API | `services/api/src/routes/vitals.ts`, `clinical/store.ts`, `index.ts` | `GET /api/encounters/:id/vitals` (assigned clinician, the patient): latest per type + entries + `sources: { medicalDeviceIntegrated: false, simulationAvailable }`; the patient's copy has the recorder's roster name, never a staff id. `POST /api/encounters/:id/vitals`: assigned clinician, in care, strict body (a client cannot claim a source), idempotent, stored with `MANUAL_CLINICIAN`. `POST /api/encounters/:id/vitals/simulate`: exists only in DEMO mode (404 otherwise); assigned clinician; values labelled `DEVICE_SIMULATED`, `SYNTHETIC_DEMO`, device `SIM-BEDSIDE-MONITOR`. No route records `MEDICAL_DEVICE`. Batches and their content-free events are committed together (rolled back if the event fails); writes audited, reads access-audited. |
| Clinician UI | `apps/hospital-web/src/clinician/{VitalsPanel,useClinician,ClinicianWorkspace}.tsx` | "Vital signs": latest per type with source and freshness badges, entries over time, a form for measured values (empty fields are not sent), and in demo mode a "Simulated monitor (demo)" button; simulated tiles are tinted and labelled. States that no medical device is connected. |
| Patient UI | `apps/patient-web/src/{InHospital,App,usePatient}.tsx` | "Your vital signs" in state B: value + unit, source ("Entered by clinician" / "Simulated (demo)"), freshness, time; simulated values carry "Simulated for the demo — not a real measurement"; never-measured types are not shown; "No monitoring device is connected to JIVA". |
| Shared UI | `packages/ui/src/lib/{vitals,events}.ts` | Measurement labels and units, value formatting, source and freshness status, event copy (simulated events are not notable for patients). |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/medical-telemetry.test.ts` (new) | ✅ 6 checks: ranges, units, BP order, unknown types, client-claimed source refused (measurement and top level); observation-time bounds; freshness; server-decided source and latest-per-type (no invented types); simulator gate, determinism and 200 seeds × 5 values within the validated ranges; device contract strictness and every refusal code |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 10: 23) | ✅ 279 passed: empty state shows nothing invented; `medicalDeviceIntegrated: false`; simulator offered to the assigned doctor only; coordinator, patient, other hospital's clinician and another patient refused; implausible value / wrong unit / BP order / future time / claimed device source → 400; manual entry `MANUAL_CLINICIAN`; patient sees value, unit, source, recorder name, freshness, no staff id, no untaken types; simulator labels every value, refused to the patient and coordinator; patient sees simulated values marked as simulated; realtime events carry types and times, never values; no telemetry in the management ledger |
| `npm run typecheck` / `test:unit` (34 suites) / `test:integration` | ✅ all exit 0 (runtime 124/0, journey 279/0) |

### Decisions and limitations

- **No medical device is integrated, and nothing claims otherwise.** The device contract is defined and tested, but no endpoint accepts device data; device authentication (e.g. mutual TLS or signed device tokens) and a device registry are not built.
- Operational mode cannot produce a measurement: the simulator route does not exist outside DEMO.
- The plausibility ranges are input checks, not clinical thresholds; JIVA raises no clinical alarms.
- Telemetry is stored in memory (capped at 5,000 measurements per encounter) like the other local clinical records.

---

## Phase 11 — Operational mode, demo mode and data provenance (✅ 2026-10-13)

### Inventory (what is demo or synthetic, as found)

| Element | Where | Labelled before this phase? |
|---|---|---|
| Synthetic network: 4 hospitals, 3 ambulances | `data/synthetic/bengaluru/*.json`, preloaded by `LocalStateStore` **in every mode** | Hospitals `SYNTHETIC_DEMO`; ambulances unlabelled |
| Demo personas (auth) | `packages/auth/src/demoAuth.ts` | Refused in production (Policy 2) |
| Demo cases (`CASE-BLR-876/877` personas, crew reports) | intake | Not distinguishable |
| Simulated hospital answers, demo controls, simulators | `apps/management-web/src/lib/simulator.ts`, `scripts/simulate-*.ts` | Trusted provenance stamps `SYNTHETIC_DEMO` (Phase 6/4) |
| Mock routing and fallback | `packages/mapping` (`MAPPING_PROVIDER`, fallback chain ending in mock) | Routes carry `synthetic` / `provider` |
| Mock AI | `USE_BEDROCK` (default mock) | Health shows the provider |
| Synthetic clinician roster, simulated vital signs | Phases 6 and 10 | Labelled, demo-only |
| `/api/health` | `demoAuth: true` hard-coded | — |
| Hard-coded "demo" wording in screens | crew header, hospital ETA, patient timeline/ETA, document preview | Unconditional |

### What changed

| Area | Files | Summary |
|---|---|---|
| One mode switch | `services/api/src/mode.ts` | `runtimeMode()` = `OPERATIONAL` for `JIVA_ENVIRONMENT=production|prod` or on AWS Lambda, else `DEMO` — the same switch as the evidence-trust layer, so provenance stamps and data loading cannot disagree. Fixed at start-up; local state is in memory, so modes never mix in one process. |
| Operational mode loads nothing synthetic | `services/api/src/infrastructure/stateStore/LocalStateStore.ts`, `clinical/roster.ts` (Phase 6), `clinical/telemetry.ts` (Phase 10), `index.ts` | No synthetic hospitals or ambulances (an empty network is shown as empty), no clinician roster, no simulator, **no demo reset** (404 — it would wipe state). `USE_CANONICAL` (public-listed records, capabilities unknown) still works in both modes. |
| Labels | `packages/domain-models/src/{patient,ambulance}.ts`, `services/api/src/intake.ts` | Optional `dataStatus` on cases and ambulances: every case created in demo mode and every demo unit is `SYNTHETIC_DEMO` (shared with the AWS emergency lambda; on Lambda the mode is operational, so no label). |
| Health / provenance report | `services/api/src/index.ts`, `mode.ts` | `/api/health` adds `mode`, an accurate `demoAuth`, and `provenance`: a plain statement, network counts (total vs synthetic), directory (public, not connected), clinicians (synthetic / none), providers (auth, mapping and AI with a synthetic flag, telemetry simulator), and `liveIntegrations` — hospital capacity feeds, staff directory, medical devices, production document storage: **all false**. |
| Screens | `packages/ui/src/{lib/mode.ts,components/Header.tsx}`, all four apps, clinician workspace | `ModeBadge` replaces the always-on demo chip: shown in DEMO mode and while the mode is unknown (a screen never claims operational data before the server confirms it), hidden in OPERATIONAL. Command Center → System status → "Mode and data" (the provenance report, integrations listed as not integrated) and an accurate sign-in row; "Demo case" on case details; "Demo unit · synthetic GPS telemetry" only for demo units. Unconditional demo wording made conditional (crew header, patient timeline source, ETA wording by route provenance, document preview caption, hospital ETA label). |

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/runtime-mode.test.ts` (new) | ✅ 5 checks: the switch (production/prod/Lambda/explicit demo/local default); operational preload is empty (no hospitals, ambulances, roster, simulator); demo preload labels every hospital, ambulance and clinician; demo-case label in demo mode only; provenance report in both modes, no live integration claimed |
| `tsx tests/unit/emergency-intake.test.ts` (updated) | ✅ the legacy-shape check now runs in both modes: operational = exactly the legacy keys (unchanged assertion); demo = the legacy keys plus the demo label, still no intake fields |
| `tsx tests/integration/operational-mode.test.ts` (new, real API on :4102, `JIVA_ENVIRONMENT=production`) | ✅ 13 passed: mode OPERATIONAL, no demo auth; 0 hospitals/ambulances; no clinicians, no simulator; no live integration claimed; demo personas refused on reads, intake, demo reset and encounters (401); `no-store`; demo realtime handshake refused |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 11: 8) | ✅ 287 passed: demo mode reported with its synthetic counts, synthetic roster, demo-only simulator, mock routing/AI flagged, no live integration; demo cases, units and hospitals labelled |
| `npm run typecheck` / `test:unit` (35 suites) / `test:integration` / `build:lambdas` / app `lint` (oxlint) | ✅ all exit 0 (runtime 124/0, journey 287/0, operational 13/0) |

### Decisions and limitations

- The routing providers were not changed (directive): in either mode, the mapping fallback chain can still end in the mock provider; such routes stay labelled `synthetic` and the health report flags it. Disabling the mock fallback in operational deployments is a configuration decision for the routing owners (`MAPPING_PROVIDER=valhalla|osrm`).
- The operational path of this repository is the AWS stack (API Gateway + Cognito + Lambda); the local Express API in operational mode accepts only verified JWTs, so it is mostly useful to prove that nothing synthetic is loaded.
- Demo tooling (simulators, demo controls, AWS demo scripts) is unchanged and remains demo-only by authorization (management/admin personas exist only in demo auth).

---

## Phase 12 — Security, privacy and audit hardening (✅ 2026-10-13)

The full review (checklist, audit trail, remaining gaps) is in [`docs/security-review.md`](docs/security-review.md). This section lists what changed.

### Findings fixed

| # | Finding | Fix | Files |
|---|---|---|---|
| 1 | AWS realtime fan-out posted **every** event to **every** connection (pre-existing issue #4). | The broadcast Lambda verifies a principal at `$connect` (JWT via `?token=`, never stored; unsigned claims and, in production, demo personas refused) and delivers each event only to connections allowed by the same `canReceiveEvent` rules as Socket.IO, in the recipient's copy; connections without a verified principal receive nothing. The CDK comment now states the remaining step (a Cognito-token authorizer instead of IAM on `$connect`); no infrastructure change. | `services/api/src/lambdas/websocketHandler.ts`, `infrastructure/aws/lib/aws-stack.ts` (comment) |
| 2 | Insecure default: a process configured as production (`ENVIRONMENT`/`NODE_ENV`) but not switched to operational mode would accept demo personas. | The API refuses to start in that configuration, with an explicit message. | `services/api/src/index.ts` |
| 3 | No way to read the audit log. | `GET /api/audit` for administrators only (filters by encounter/case, bounded), reading it is itself audited; `AuditRecord.entityType` gains `AUDIT`. | `services/api/src/routes/audit.ts`, `packages/domain-models/src/clinical.ts` |
| 4 | The AI sidecar collected every event, incl. clinical-record events and staff identities, as model context (sent to Bedrock when enabled). | Clinical-record events are excluded; encounter events reach it with the actor's role only. | `services/api/src/intelligenceEngine.ts` |
| 5 | Unbounded in-memory growth: remembered command results and lapsed upload tickets. | Command results capped (20,000, oldest first); lapsed tickets purged when a new one is issued. | `services/api/src/clinical/{store,documents}.ts` |
| 6 | Missing response hardening header. | `X-Content-Type-Options: nosniff` on every API response (with `Cache-Control: no-store` from Phase 9). | `services/api/src/index.ts` |

### Reviewed and found adequate (no change)

Authentication on every `/api` route; the event-submission allowlist (system and clinical events cannot be submitted); hospital/patient/encounter isolation; record-id-to-encounter checks; strict command bodies (no mass assignment); upload validation; download headers; log hygiene (identifiers only; no payloads, no document bytes); error responses (no internals); secrets scan (none; `config.auth.demoAuthSecret` is an unused placeholder).

### Tests

| Command | Result |
|---|---|
| `tsx tests/unit/realtime-isolation.test.ts` (new) | ✅ 5 checks: a case event reaches only that patient and coordination (never another patient or an anonymous connection); referrals only to the hospital asked; encounter events with role-only copies for the patient and full copies for same-hospital staff; clinical record events never to coordination or another hospital; `$connect` principal: none without credentials, unsigned claims refused, verified token accepted, forged token refused, demo persona refused in production and accepted in demo, nothing token-like stored |
| `tsx tests/integration/clinical-journey.test.ts` (+Phase 12: 15) | ✅ 302 passed: all 17 new endpoints → 401 unauthenticated; `nosniff` + `no-store`; malformed JSON → `{"error":"malformed_json"}`; management, coordinator, doctor, patient and crew cannot read the audit log; invalid filter 400; the administrator's encounter trail contains every expected write, read, download and denial; every entry has actor/action/entity/outcome/time; a denial carries its reason; no clinical content in the trail; audit reads are audited |
| `tsx tests/integration/operational-mode.test.ts` (+1) | ✅ 14 passed: `ENVIRONMENT=production` without `JIVA_ENVIRONMENT=production` → the API refuses to start |
| `npm run typecheck` / `test:unit` (36 suites) / `test:integration` / `build:lambdas` / `cdk synth --quiet` (no deploy) | ✅ all exit 0; cdk warnings are pre-existing (Lambda runtime `nodejs20.x` deprecated; `pointInTimeRecovery` deprecated) |

### Not claimed

No regulatory compliance is claimed. Remaining gaps (production identity, durable encrypted storage, AWS clinical domain, rate limiting, break-glass, tamper-evident audit, consent) are listed in `docs/security-review.md` §3.

---

## Phase 13 — End-to-end integration and regression testing (✅ 2026-10-13)

### The 20-step journey — `tests/integration/e2e-journey.test.ts` (real API on :4104)

One deterministic narrative after a demo reset, with a fixed scene, the demo patient's case reference (`CASE-BLR-876`) and a synthetic PNG. The mapping stack is deliberately unreachable (Valhalla/OSRM on a closed port), so routing runs on the labelled synthetic fallback throughout.

| Step | What is checked |
|---|---|
| 1 | Crew `demo-amb-2` reports the emergency (`POST /api/emergencies`) → case `CASE-BLR-876`, crew assigned |
| 2 | The map-pin starting location is the case location; intake method recorded |
| 3 | Symptoms and suspected cause are separate fields; no diagnosis field |
| 4 | `care.requirement.created`: emergency, trauma, ICU (rule-based) |
| 5 | Referrals to the capable network hospitals only (Hebbal, Whitefield, Indiranagar) |
| 6 | Hebbal receives the referral (REST + realtime); Koramangala (incapable) does not |
| 7 | Indiranagar and Hebbal accept, Whitefield rejects — explicit, referral-bound answers |
| 8 | The crew's referral overview shows each answer; the patient receives the destination |
| 9 | Indiranagar reports it cannot take patients → the crew is rerouted to Hebbal (`route.recalculated` old → new); the route is labelled synthetic |
| 10 | GPS geofence at Hebbal → unit `ARRIVED`, case `ARRIVED`, still **no** encounter |
| 11 | Hebbal records the arrival and the handover |
| 12 | Encounter `IN_CARE`; the crew is released |
| 13 | Dr. Ravi Kumar is assigned |
| 14 | The doctor prescribes (IV ceftriaxone) |
| 15 | The doctor uploads a verified chest X-ray and records a final imaging report with it, shared |
| 16 | The patient's encounter is `IN_CARE` with the doctor; case `HANDED_OVER` (state B source) |
| 17 | The patient reads the prescription and the report and downloads the exact scan bytes |
| 18 | Another patient gets 404 on the encounter, prescriptions, reports and the scan |
| 19 | Vital signs: clinician-entered (`MANUAL_CLINICIAN`) and simulated (`DEVICE_SIMULATED`, `SYNTHETIC_DEMO`), freshness, no device integration |
| 20 | All sockets closed; a new connection + refresh restores the encounter, records and the full ordered case history; realtime resumes |

### Failure scenarios (same suite)

| Scenario | Check |
|---|---|
| Hospital does not respond | No destination is assumed; referrals stay outstanding with a deadline. (The 15-minute deadline itself is a frozen protocol constant; its unanswered closure is tested with a simulated clock in `tests/unit/referral-lifecycle.test.ts`.) |
| Referral answer expires | A 1.5-second acceptance lapses → case-scoped `hospital.acceptance.expired` (`RESPONSE_VALIDITY`); the overview marks it not current |
| Hospital rejects | A hospital that accepted then rejects → the crew is withdrawn from it and holds (`destination.changed` UNASSIGNED) until another acceptance |
| Hospital becomes unavailable | Step 9 |
| Duplicate events | Same event twice → `duplicate_ignored`; a retried command returns the same answer and changes nothing |
| Unauthorized handover | Crew, patient, another hospital, another clinician, management → 403/404 |
| Doctor at another hospital | Another coordinator → 404; a foreign doctor → 422 |
| Another patient's records | 404 (prescriptions, vital signs) |
| Another patient's document | 404, also by swapping identifiers (a crew through the encounter path) |
| Realtime drops and reconnects | Step 20; a dropped socket receives nothing further |
| Live data provider unavailable | Mapping falls back to the labelled synthetic provider; `/api/health` reports the fallback and the synthetic flag |
| Missing / invalid field | Intake without symptoms → 400 naming the field; SpO₂ 140 % → 400; nothing stored |

### Regression

| Command | Result |
|---|---|
| `tsx tests/integration/e2e-journey.test.ts` (new) | ✅ 39 passed (run twice: stable) |
| Flagship scenario `scripts/simulate-full.ts` against a short-lived API (scratch runner; the dev stack stays stopped) | ✅ `SCENARIO COMPLETE` — reset → accept → reroute → GPS arrival → AI sidecar events; shadow: 4 traces, 0 disagreements, 0 failures; no API handler crashes |
| `npm run test:integration` (parity, mapping parity, runtime 124, journey 302, operational mode 14, e2e 39) | ✅ exit 0 |
| `npm run test:unit` (36 suites) / `npm run typecheck` | ✅ exit 0 |

Existing suites were not weakened: the only pre-existing assertion that changed (Phase 11, intake legacy shape) now asserts both modes explicitly.

---

## Phase 14 — Final quality gate and documentation (✅ 2026-10-13)

### Quality gate (actual commands, run on the final code)

| Command | Result |
|---|---|
| `npm run typecheck` (all workspaces incl. the four Vite production builds + tests) | ✅ exit 0 |
| `npm run test:unit` (36 suites: 25 pre-existing + 11 new) | ✅ exit 0 |
| `npm run test:integration` (6 suites) | ✅ exit 0 — parity ✅, mapping parity ✅, runtime **124/0**, journey **302/0**, operational mode **14/0**, end-to-end **39/0** |
| `npm run build:lambdas` | ✅ exit 0 — 7 self-contained bundles |
| `npm run data:validate` | ✅ exit 0 — 7 canonical facilities |
| `npx cdk synth --quiet` (synthesis only; nothing deployed) | ✅ exit 0 — pre-existing warnings only (`nodejs20.x` deprecated; `pointInTimeRecovery` deprecated) |
| `npm run lint` in each app (oxlint) | ✅ exit 0 in all four (warnings only; no errors) |
| `npm run demo:check` (against a short-lived API on :4105) | ✅ `STATUS: READY` (INFO: mock routing, demo auth, AWS not deployed) |
| Flagship scenario `scripts/simulate-full.ts` (Phase 13, short-lived API) | ✅ `SCENARIO COMPLETE`; shadow 0 disagreements |
| Browser pass on the production builds (`vite preview` ×4 + short-lived API + headless Edge; scratch harness) | ✅ **27/27**: coordinator records arrival → handover → assigns a doctor in the UI and sees no clinical content; clinician workspace lists both assigned patients, shows records, verified scan, vital signs with source labels, and prescribes through the form; patient state B on desktop and at 390 px (doctor, medications, reports, scans, vital signs labelled, no staff ids, no horizontal overflow); command center "Mode and data"; released crew available; **no runtime errors on any page** |

The long-running dev stack (`npm run dev`) was stopped by the environment for low memory during the session and was **not** restarted; every runtime check above used short-lived processes that were stopped afterwards.

### Diff review (`main..HEAD`) — findings and fixes

| Check | Result |
|---|---|
| Routing architecture | No change to `routingEngine.ts`, `eligibilityEngine.ts`, `mapping.ts`, `stateTransitions.ts`, `services/api/src/feasibility/**`, `packages/feasibility/**`, `packages/mapping/**`, `authVerification.ts`, `evidenceTrust.ts`. `stateEngines.ts` changes are the documented ones (Phase 2 intake handling, Phase 4 case-scoped expiry, Phase 5 shared arrival effects under the routing lock). `DECISION_AUTHORITY_MODE` stays `SHADOW`. |
| Dead code | `hasOutstandingRequest` became unused when Phase 4 replaced its only caller → **removed**. Exported inferred types in `@jiva/event-schema` stay (package API). |
| Duplication | The policy's clinical event-type sets now derive from the event contracts (one source of truth); the duplicated 60-second clock-skew constants in the command routes are one `CLOCK_SKEW_MS`. |
| Unhandled backend failures | The referral overview route (Phase 4) was the last async route outside `asyncRoute` → **wrapped** (a failure answers 500 instead of hanging). |
| Labels | Clinician view no longer shows the clinician as the recorder of simulated readings ("simulator started by …"). |
| Hard-coded operational data / fake capacity | None added. The only seed data is the labelled synthetic network and roster (demo mode only). |
| Unlabelled synthetic information | None found; remaining demo wording is conditional on mode or provenance (Phase 11). |
| Unprotected clinical APIs / missing authorization | None: every new endpoint is covered by 401/403/404 tests (journey Phase 12, e2e). |
| UI/UX work | The preserved UI commit (`6dbeb8a`) was extended, not removed: the only deleted UI code is the patient "records coming later" placeholder and GPS-based "you have arrived / care takes over" copy, both replaced by authoritative behaviour. |
| Secrets / sensitive files | None committed; local document storage, `.env` and test temp dirs are git-ignored or outside the repo. |
| Documentation accuracy | Unit-suite counts corrected in this tracker (phases 10–13 overstated them by one). |

### Documentation

| File | Content |
|---|---|
| `docs/emergency-to-care.md` (new) | Architecture changes, event contracts, API table, authorization rules, hospital-data provenance, operational vs demo behaviour, clinical record / document / telemetry storage and sources, tests, integrations not implemented, production prerequisites |
| `docs/security-review.md` (Phase 12) | Enforced protections with tests, audit trail, remaining gaps; no compliance claim |
| `README.md` | Implementation table extended (each new capability with its limits), personas, roadmap (journey done in the local API; production prerequisites next), known limitations, documentation index |
| `CLAUDE.md` | Current status, personas incl. clinicians, operational switch, new test suites, roadmap pointer |

### Remaining limitations (explicit)

1. **Local API only**: encounters, clinical records, documents and vital signs have no AWS routes, functions or tables; nothing is deployed.
2. **In-memory clinical storage**: records, documents' metadata, measurements and the audit trail are lost on restart; local document files are not encrypted.
3. **No real integrations**: hospital capacity/acceptance feeds, staff directory (demo roster only), EHR/FHIR, medical devices, production object storage (S3 provider designed, not built), e-prescribing, live-traffic routing (mock fallback, labelled), Bedrock (failure path only).
4. **Identity**: demo personas locally; Cognito modelled but not provisioned; no verified patient-linking flow; the AWS WebSocket `$connect` stays IAM-authorized (filtering is in place, a Cognito-token authorizer is the remaining step).
5. **Clinical workflow gaps**: no discharge, no correction workflow for arrival/handover records, no free-text clinical notes type, no shift/availability model, no break-glass access, no DICOM viewer, no drug-interaction or allergy checks.
6. **Protocol constants**: the 15-minute referral deadline is a frozen constant (tested with a simulated clock, not at runtime); `UNAVAILABLE` keeps its hospital-wide meaning; the AWS stack has no expiry engine.
7. **Operations**: no rate limiting/WAF, no tamper-evident audit, no consent or data-subject workflows; Lambda runtime `nodejs20.x` is deprecated (pre-existing).
8. **Not a medical device**; no clinical validation or regulatory compliance is claimed.

### Handoff

- All phases 0–14 are complete on `feat/emergency-to-care-journey`; `main` is untouched; `start-jiva.bat` remains untracked (not ours).
- Re-verify: `npm run typecheck && npm run test:unit && npm run test:integration && npm run build:lambdas`, then `npx cdk synth --quiet` in `infrastructure/aws` (never deploy without authorization).
- Next concrete task (needs an explicit go-ahead): production identity and durable encrypted storage for the clinical domain, then the AWS clinical routes (see `docs/emergency-to-care.md` §9).

---

## Release hardening (2026-10-13, after phase 14)

Starting point verified: branch `feat/emergency-to-care-journey` at `38cda98`, 29 commits ahead of `main` (`main` still at `b0be67c`), working tree clean except the untracked `start-jiva.bat` (not ours; not modified, not committed).

| Commit | Change |
|---|---|
| `ac5a180` | **fix(security)** demo mode serves only the local machine (finding R1, high): demo personas are not authentication and the API listened on every interface |
| `b189e1d` | **fix(documents)** per-port default document directory (R2): the runtime test API wiped a running demo's uploads |
| `cc27f6b` | **feat(dev)** launcher refuses busy ports and reports `READY` / `NOT READY` (R3) |
| (docs) | `docs/security-review.md` §5 (findings R1–R9), `docs/persistence-plan.md`, `docs/production-readiness.md`, README and runbook notes |

Verification on the final code: `typecheck` ✅; `test:unit` 36 suites ✅; `test:integration` ✅ (runtime 124/0, journey 304/0, operational mode 14/0, e2e 39/0); `build:lambdas` ✅; `data:validate` ✅; `cdk synth --quiet` ✅ (no deploy); lint ✅ ×4; `demo:check` READY; flagship scenario complete (shadow: 0 disagreements); browser journey on production builds 27/27; browser API-outage/recovery check 25/25; launcher busy-port and READY checks.

Open risks: in-memory state (R4, plan written), patient linking (R5), unbounded indexes over long runs (R6), cosmetic hospital answer slot (R7), no upload quota (R8), AWS clinical domain absent (R9). Recommended next step: `SqliteClinicalStore` with transactional command writes (`docs/persistence-plan.md` §4.1).
