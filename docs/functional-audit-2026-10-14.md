# JIVA — functional audit, debugging and repair (2026-10-14)

Branch `feat/jiva-doctor-clinical-workspace`. Local demo stack only (`npm run dev`, in-memory API, mock
mapping, mock AI). Nothing was deployed to AWS; AWS code was exercised only through its local unit tests.

## Why earlier passing suites missed these defects

Every repository suite (`test:unit`, `test:integration`) talks to the API. The defects below live in the
screens (React state that outlives a patient switch, badges that read a hospital-wide field) or in a
state precondition that the HTTP event endpoint did not check. Earlier browser checks were ad hoc and
followed the single flagship case (`CASE-BLR-876`), never two or three patients at once. The new
`npm run test:browser` suite (real Edge/Chrome, real apps, real API) fails on each of these defects
before its fix.

## Method

1. Baseline: `test:unit` (exit 0) and `test:integration` (exit 0: 124 / 304 / 14 / 39 / 64 / 14 checks in the
   counted suites) before any change.
2. Three distinct synthetic patients (CASE-BLR-876 "alpha chest pain", CASE-BLR-877 "bravo head injury",
   a server-generated CASE-… "charlie burns"), each reported by a different crew, staged through the real API.
3. Every screen driven in headless Microsoft Edge (playwright-core from the session scratchpad, later as a
   dev dependency): forms filled, buttons clicked, reloads, persona switches, live updates without reload.
4. Each defect reproduced, root-caused, fixed at the narrowest layer, regression-tested, re-run.

## Defects found and fixed

| # | Interface | Defect (reproduction) | Root cause | Fix | Regression test |
|---|---|---|---|---|---|
| 1 | Doctor | Open "Enter values" for CASE-BLR-876, type HR 55, click CASE-BLR-877, press Record → HR 55 recorded **on CASE-BLR-877**. Same for prescription, note, report, upload and sample forms, and on reassignment. | Per-encounter panels were not keyed by encounter, so form state survived a patient switch while `encounterId` changed. | `DoctorWorkspace.tsx`: panels in a `Fragment key={encounterId}`. `useClinician.ts`: an older, slower record load can no longer overwrite newer records. | browser: "half-filled form … gone after switching", "update reached patient 2 only" |
| 2 | Management | Hebbal accepts 876, then declines 877 → case 876 shows "Hebbal · **Declined**" (also incident card, ambulance detail). | Badge read `hospital.operationalState.acceptance` = the hospital's latest answer to **any** case. | `DestinationAnswer` (bits.tsx): the case's own referral response; the hospital slot only when it names the case. | browser: "accepted case shows Hebbal Accepted" |
| 3 | Management | Same sequence → "Hospitals accepting: 0", map shows Hebbal "Declined" while an ambulance drives there on a valid acceptance. | Same single-slot field. | `acceptingHospitals` + `hospitalDisplayStatus` (derive.ts): hospital-wide unavailability first, then any current acceptance for an open case, then the latest answer. | browser: "Hospitals accepting counts Hebbal" |
| 4 | Patient | Same sequence → patient 1 (en route to Hebbal) sees "Hospital confirmed (in progress)" and "Waiting for the hospital to confirm". | Same single-slot field (patients receive the status without the case id). | `patient-web/App.tsx`: confirmed = ambulance destination or an answer naming this case. | browser: "patient 1 Hospital confirmed is done" |
| 5 | Patient | Crew-reported case (crew ON_SCENE) → headline "Help is on the way — Ambulance … is coming". | Headline ignored the ambulance status. | Status-aware headline ("An ambulance crew is with you"). | browser: "patient 2 … not that one is coming" |
| 6 | Ambulance | Destination withdrawn (hospital reported unavailable) and crew reloads → "Proceed to the patient" while transporting the patient. | "Destination lost" came only from a live event held in component state. | `nextAction` also derives the hold from state (EN_ROUTE_TO_HOSPITAL without destination). | browser reproduction (scratch script) before/after; no committed test (see limitations) |
| 7 | Ambulance | Observations card could keep one case's data/open form for the next case. | Card not keyed by case. | `key={caseId}`. | — (defensive; same class as #1) |
| 8 | API (+ AWS ingestion) | `ambulance.dispatched` for AMB-BLR-001 (transporting 876) to a new case → 202; the unit was reassigned, 876 left IN_TRANSIT with an ambulance that no longer carried it. A second `patient.emergency.created` for an open case → 202 but silently ignored (the management "Report emergency" control reported success for a no-op). | `/api/events` had no state precondition for these events (the crew intake path did). | `submissionState.ts`, used by `/api/events` and `ingestionCore.ts`: 409 `ambulance_busy` / `ambulance_unavailable` / `case_exists`; retries of an applied event still `duplicate_ignored`. | `tests/unit/submission-state.test.ts` |
| 9 | AI (mock) | Every handoff brief said "High severity trauma · Prepare trauma bay" (also chest pain, burns); every summary said "Hospital accepted" even before any acceptance. | Hard-coded mock output presented as derived. | `mockProvider.ts` restates input facts only (symptoms marked "not a diagnosis", assessed care, milestones present in the events). | `tests/unit/mock-ai-facts.test.ts` |

Commits: `e6f6f2d`, `a281fd9`, `52b28f9`, `0ce7708`, `f897d8c`, `7366718`, `39fdb96`, `6051f76`, `7e39469`, `fbd4477`.

## Test matrix (feature inventory)

Method codes: **B** = driven in the browser, **A** = real API calls, **I** = existing integration suite,
**U** = unit test. Result after fixes; "before" shows failures found.

| Area | Feature | Method | Before | After |
|---|---|---|---|---|
| Ambulance | Open console as each crew (amb-1/2/3) | B | pass | pass |
| Ambulance | Intake form (coordinates, severity, symptom, review, submit) for two crews | B | pass | pass |
| Ambulance | Case survives reload | B | pass | pass |
| Ambulance | Hospital answers list / destination after acceptance (live) | B | pass | pass |
| Ambulance | Decline → "Stay with the patient" | B | pass | pass |
| Ambulance | Destination withdrawn after reload | B | **fail (#6)** | pass |
| Ambulance | Observations recorded at intake shown in job view | B | pass | pass |
| Ambulance | Map and synthetic route render | B (screenshot) | pass | pass |
| Ambulance | Duplicate case reference refused (409) | A | pass | pass |
| Hospital | Three simultaneous requests listed individually | B | pass | pass |
| Hospital | Accept one / decline another with reason; isolation between cases | B | pass | pass |
| Hospital | Accept with limits; "can't take any patient" reroutes | B | pass | pass |
| Hospital | Record arrival ×3, handover ×3, assign doctor ×3 | B | pass | pass |
| Hospital | Answer to closed/expired/unknown referral refused | I | pass | pass |
| Hospital | New request appears live | B | pass | pass |
| Doctor | Three assigned patients listed | B | pass | pass |
| Doctor | Each patient opens with its own record | B | pass | pass |
| Doctor | Form state isolated per patient | B | **fail (#1)** | pass |
| Doctor | Vital signs: enter, questionable flag, simulated monitor | B | pass | pass |
| Doctor | Prescription: catalogue draft, edit draft, authorise, change, stop, manual, discard | B | pass | pass |
| Doctor | Reports: create, finalise, share, correct | B | pass | pass |
| Doctor | Notes: create, amend | B | pass | pass |
| Doctor | Documents: sample attach (shared), upload PDF with checksum, preview | B | pass | pass |
| Doctor | Records persist across reload; update affects only the intended patient | B + A | pass (after #1) | pass |
| Doctor | Reassignment removes the patient and closes open forms | B | **fail (#1)** | pass |
| Doctor | New patient appears live after assignment | B | pass | pass |
| Doctor | Concurrent amend → 409; cross-encounter amend → 404; key reuse on another patient → 422 | A | pass | pass |
| Doctor | Other hospital's doctor 404; invalid values 400 | A | pass | pass |
| Patient | Own case only (both personas); cross-patient reads 404/403 | B + A | pass | pass |
| Patient | Journey "Hospital confirmed" | B | **fail (#4)** | pass |
| Patient | Headline while crew is on scene | B | **fail (#5)** | pass |
| Patient | Doctor, authorised prescriptions, vitals, shared documents (live) | B | pass | pass |
| Patient | Drafts and notes never visible | A + I | pass | pass |
| Management | KPIs match underlying data (open cases, units, awaiting, requests) | B + A | pass | pass |
| Management | "Hospitals accepting" KPI / map status | B | **fail (#3)** | pass |
| Management | Case detail per patient (three cases), destination badge | B | **fail (#2)** | pass |
| Management | Search | B | pass | pass |
| Management | Demo control "Report emergency" pressed twice | A | **fail (#8, silent no-op)** | 409 shown |
| Demo portal | All 10 scenarios via the portal UI | B | pass | pass |
| Demo portal | Controls, Timeline, Asset library, System pages load | B | pass | pass |
| Cross-interface | Crew report → hospital → accept → ambulance/patient/management live → arrival → doctor → prescription → patient live | B | pass | pass |
| Cross-interface | Two requests, accept one, reject other; each follows its own path | B | pass (UI badges failed: #2–#4) | pass |
| Backend | Busy-ambulance dispatch / duplicate emergency | A + U | **fail (#8)** | pass |
| Backend | RBAC / patient isolation matrix (21 checks) | A | pass | pass |
| AI | Mock outputs factual | U | **fail (#9)** | pass |
| Flagship | `simulate:full:blr` | script | pass | pass |
| Readiness | `demo:check` | script | pass | pass |

Totals: 47 inventoried features, 47 tested, 38 passed before fixes, 9 failed before fixes (one feature
can show more than one defect; 9 distinct defects), 9 fixed, 0 known reproducible defects open.

## Commands and outcomes (final)

| Command | Outcome |
|---|---|
| `npm run typecheck:tests` | exit 0 |
| `npm run test:unit` | exit 0 (incl. new `mock-ai-facts`, `submission-state`) |
| `npm run test:integration` | exit 0 (124, 304, 14, 39, 64, 14 checks in the counted suites; parity suites pass) |
| `npm run test:browser` | 15 passed, 0 failed (Edge, headless); on the pre-fix code: 5–6 failures |
| `npm run simulate:full:blr` | scenario complete, 0 unexpected shadow disagreements |
| `npm run demo:check` | all PASS |

## Limitations and open items (not fixed here)

- **Crew-reported cases route from the depot.** A crew that reports an emergency is ON_SCENE, but its
  position stays at its last GPS fix (the depot in the demo) until GPS arrives, so the route/ETA shown to
  hospital, management and patient is computed from the depot while the referral ETA uses the scene
  (e.g. "ETA then 4 min" vs. "22 min · 11 km"). Changing the routing origin is a business-rule decision
  (GPS is the only position source by design), so it is documented rather than changed.
- Hospitals' `operationalState.acceptance` (one slot, latest answer) is still sent to patients and crews
  without the case id; the screens no longer use it for per-case statements.
- Patient personas exist only for CASE-BLR-876 / 877 (demo authentication); a third patient has no
  patient-app login unless the crew enters one of those references.
- No discharge / encounter closing exists (encounter statuses are ARRIVED and IN_CARE only).
- In-memory only: an API restart loses all demo state (as documented in `persistence-plan.md`).
- Defects #6 and #7 have no committed automated test (verified in the browser by scratch scripts).
- AWS: not deployed; only local unit tests of the lambda cores ran. Real mapping providers (Valhalla/OSRM)
  were unreachable; the mock provider was used. Bedrock was not exercised.
- Browser checks ran headless (SwiftShader); no headed real-GPU visual check.
