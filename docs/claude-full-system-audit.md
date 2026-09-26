# JIVA — Full System Functional Audit

**Date:** 2026-09-26 · **Mode:** independent QA / red-team, architecture frozen · **Auditor:** Claude (Sonnet 5)
**Environment:** Windows 11, Node 26.7.0, npm 11.19.0, Edge (headless, SwiftShader WebGL), no Docker, no AWS CLI, no AWS credentials.
**Method:** every claim was checked against source, then executed at runtime (real API, real Socket.IO, four real Vite dev servers, a real browser). Existing reports were treated as claims.
**Evidence scripts:** `.audit/*.mjs` (audit-only; no product code was modified).

---

## A. Executive Summary

**Overall: FAIL** (measured against what the documentation claims).

The core event-driven happy path is real. In a clean process I watched an emergency flow through the bus, produce a care requirement, hospital candidates and acceptance requests, assign a destination, calculate a route, and, when Hospital A became unavailable, publish `destination.changed` → `route.recalculated` and generate an AI explanation. Multiple hospital responses coexist, and same-`eventId` duplicates are dropped.

Many headline guarantees do not hold at runtime:

| # | What breaks | Class |
|---|---|---|
| 1 | Two unauthenticated malformed POSTs **crash the whole API process** (202 returned, then `TypeError` kills Node). | CRITICAL |
| 2 | **Production builds of management-web and ambulance-web white-screen** (`Cannot read properties of null (reading 'useRef')`) — two React copies (18.3.1 in `packages/ui`, 19.3.0 in apps). | CRITICAL |
| 3 | **RBAC is essentially absent**: only `GET /api/patients` scopes anything; no role/header defaults to MANAGEMENT; anyone (even anonymous) can POST hospital/ambulance events and every anonymous WebSocket receives every event. | CRITICAL (vs. docs) |
| 4 | **Out-of-order/stale events overwrite newer state** for hospital acceptance, hospital capacity and ambulance location. The passing "ordering" unit test exercises a store method the engines never call. | HIGH |
| 5 | **Demo reset does not reset.** Runs 2 and 3 of the flagship scenario silently lose the reroute (stale acceptance, destination, position, growing provenance). | HIGH |
| 6 | **The shipped flagship simulator (`simulate:full:blr`) does not demonstrate a reroute** — the ambulance goes to the first hospital to respond (LIMITED, 33 km, 67 min), and "Hospital A unavailable" changes nothing. | HIGH |
| 7 | `npm run dev` (root) starts **only one** workspace (ambulance-web). API and other UIs never start. | HIGH |
| 8 | In the documented dev flow, **the map area renders blank** (MapLibre worker 404; 0-px map container) although OSM tiles download. Real-GPU browser check still needed. | HIGH (partly UNVERIFIED) |
| 9 | Valhalla and OSRM **could not be run** (no Docker). Only the fallback chain and a protocol-shaped fake were verified. | NOT AVAILABLE |
| 10 | AWS is **SYNTHESIZED only**; the CDK creates **no WebSocket API**, no authorizer on the REST API, no DLQs — contrary to docs. | HIGH (vs. docs) |

**Final recommendation: NOT READY** (see §H). Most blockers are small; §F lists the minimum set.

---

## B. System Scorecard

| Subsystem | Result | Evidence |
|---|---|---|
| Build | **PASS** (warnings) | `npm run build` exit 0, 24 s; only Vite >500 kB chunk warning on management-web. |
| Tests | **PARTIAL** | `npm test` exit 0, 4 s. All pass, but ordering/idempotency/RBAC unit tests don't cover the runtime path (see D-4, D-3). `mapping-*` tests use mocked fetch. |
| `data:validate` | **PASS (weak)** | Exit 0, 1 s. Only checks "operational data has a source"; canonical hospitals have zero capabilities and it still passes. |
| `demo:check` | **FAIL (misleading)** | Exit 0 "READY", but it only tests `fs.existsSync` on source files. It reported ✓ for a system whose production bundles crash. |
| API | **PARTIAL** | Happy paths work. Malformed event crashes process; malformed JSON returns Express HTML stack trace with local paths; no schema validation (Zod exists but isn't used at ingress). |
| Event Bus | **PARTIAL** | Delivers and fans out. No schema validation; unknown types accepted; realtime order inverted (child event delivered before parent); history/timeline omit all system events. |
| State Engines | **PARTIAL** | Emergency → care requirement → candidates → requests works. No ordering, no source authorization, handlers throw on bad payload. |
| Acceptance | **PARTIAL** | ACCEPTED/LIMITED/REJECTED coexist; same-eventId dup dropped; same responseId with new eventId re-processed; first responder wins destination (LIMITED beat ACCEPTED). |
| Routing | **PARTIAL** | Route + reroute + metadata work with mock provider. No `route.recalculated` after expiry reroute. 10 s per evaluation when providers hang. |
| Valhalla | **NOT AVAILABLE** | Port 8002 closed, Docker not running. Never exercised for real. |
| OSRM | **NOT AVAILABLE (MOCK-verified)** | Port 5000 closed. A protocol-shaped fake server on :5900 produced `provider=osrm, sourceType=osm, synthetic=false` — proves parsing only. |
| Mock Mapping | **PASS** | Used as terminal fallback in every run; `provider=mock, synthetic=true`. |
| MapLibre | **FAIL / UNVERIFIED** | Dev: worker 404 + blank map; prod build: page crash. OSM attribution present in DOM; 8–12 OSM tile requests returned 200. |
| Realtime | **PARTIAL** | Socket.IO delivers. After API restart, UIs keep stale state; no refetch on reconnect; patient UI has no connection indicator. |
| AI | **PASS (as sidecar)** | No write path to state; injection changed nothing; Bedrock failure (no creds) did not disturb the core flow. But it is a mock template locally; timeline summary never triggers locally. |
| RBAC | **FAIL** | See D-3. |
| Privacy | **FAIL** | All patients/ambulances/events downloadable by anyone; patient UI downloads everyone's data and filters client-side. |
| Data Provenance | **PARTIAL** | Canonical: clean labelling, UNKNOWN capacity, but no capabilities/coord source detail. Synthetic: labelled `SYNTHETIC_DEMO` but ships `acceptance:"AVAILABLE"` (invalid enum) and pre-set AVAILABLE capacity. |
| Dynamic Rerouting | **PARTIAL** | PASS on a clean first run (exact sequence in §C). FAIL on repeat runs and in the shipped simulator. |
| Four Frontends | **PARTIAL** | All four load and update live in dev. Patient ETA stuck at `--min`; patient never reaches "Hospital accepted" for LIMITED; two apps crash in prod build. |
| Demo Reset | **FAIL** | See D-5. |
| AWS Architecture | **PARTIAL — SYNTHESIZED, NOT LIVE VERIFIED** | `cdk synth` exit 0 (21 resource types); no deploy, no credentials. |

---

## C. Real vs Simulated

**REAL VERIFIED (executed here)**
- Express API, `LocalEventBus`, in-memory stores, Socket.IO fan-out, 4 Vite dev servers, browser UIs.
- Fallback chain Valhalla→OSRM→Mock against **real refused connections** and **real hung connections** (5 s timeouts observed; 10.2 s per candidate round).
- OSM tile requests from the browser (HTTP 200, internet available).
- `cdk synth` (offline template generation).
- Bedrock provider failing without credentials (`CredentialsProviderError`) with the core flow continuing.

**MOCK VERIFIED**
- OSRM response parsing (fake server, protocol-shaped).
- All AI output (`MockAIProvider` static templates).
- All routes in every run (`provider=mock`, `synthetic=true`).
- Hospital responses and ambulance telemetry (scripted events).

**STATIC VERIFIED (source only)**
- Cognito claim parsing, `DynamoStateStore`, `AwsEventBridgeBus`, Lambda handlers, `BedrockAIProvider` prompt/schema, CDK constructs, IAM statements.

**UNVERIFIED**
- Real Valhalla/OSRM servers; Bedrock success path; any AWS behaviour; DynamoDB conditional-write claims; map rendering on a real-GPU desktop browser; browser console under a non-headless session.

**NOT AVAILABLE**
- Docker, AWS credentials/CLI, Valhalla tiles, OSRM data.

**Recorded flagship sequence (clean process, run 1, socket-captured):**
`hospital.capacity.updated ×4 (UNKNOWN)` → `patient.emergency.created` (delivered *after* its child `care.requirement.created`) → `hospital.candidate.generated` → `hospital.acceptance.requested` ×3 (H1, H2, H4; H3 excluded — lacks TRAUMA/ICU) → `ambulance.dispatched` → `hospital.acceptance.received` H1 ACCEPTED → `destination.changed`(H1) → `route.recalculated`(H1, mock) → `ai.handoff.generated` → H4 ACCEPTED → 2× `ambulance.location.updated` → `hospital.capacity.updated` H1 UNAVAILABLE → `destination.changed`(H4) → `route.recalculated`(H4, 15.1 km/30 min, mock) → `ai.anomaly.explained`. Total 24 events, ~9 s of scripted time.

**Judge-rehearsal timing (shipped `simulate:full:blr`):** 65 s end to end, no manual interaction after services were started separately.

---

## D. Findings

### D-1 · CRITICAL — Unauthenticated malformed event crashes the API
- **Evidence:** `POST /api/events {"eventId":"x2","eventType":"patient.emergency.created"}` → `202 accepted`, then process dies: `TypeError: Cannot read properties of undefined (reading 'location')` at `services/api/src/stateEngines.ts:17`. Same for `hospital.acceptance.received` without `source` (`stateEngines.ts:131`). Reproduced twice; Node exited each time.
- **Impact:** one curl kills the demo; in AWS/Lambda mode the same handlers would throw per event.
- **Recommended action:** validate against `@jiva/event-schema` (already defined) at `/api/events`; wrap handlers in try/catch.

### D-2 · CRITICAL — Production builds of management-web and ambulance-web crash
- **Evidence:** `vite preview` of `dist` → `pageerror: Cannot read properties of null (reading 'useRef')`, 0 canvas, 0 tile requests. `packages/ui/node_modules/react` = 18.3.1; root `node_modules/react` = 19.3.0 (`packages/ui/package.json` pins `^18.2.0`, apps pin `^19.2.8`). No `resolve.dedupe`.
- **Impact:** any "build and serve" demo/judge run shows a blank page for the two map apps. Dev mode (which happens to work) hides it.
- **Action:** align React versions / dedupe; add a build-smoke check.

### D-3 · CRITICAL vs documentation — RBAC/privacy not enforced
- **Evidence (runtime, `.audit/t5.mjs`):**
  - `GET /api/hospitals|ambulances|events/history|cases/:id/timeline` return 200 with full data for every header combination, including none, `x-jiva-role: HACKER`, PATIENT.
  - `GET /api/patients`: PATIENT with `x-jiva-case-id` sees 1; PATIENT **without** caseId sees all 3; HOSPITAL/AMBULANCE see all.
  - `PATIENT` header and anonymous requests successfully `POST` `hospital.capacity.updated` (H2 → UNAVAILABLE confirmed) and `ambulance.dispatched`.
  - Anonymous Socket.IO client received all events including other patients' emergencies.
  - `Access-Control-Allow-Origin: *`; Socket.IO `origin: '*'`.
  - Default with no headers = MANAGEMENT (`demoAuth.ts`); `AccessControl.canAccess*` is never called by the API.
  - Patient UI fetches all patients/ambulances/hospitals and filters in the browser; no auth headers sent by any UI.
- **Impact:** docs (`security.md`, judge-qa Q13) present role isolation as enforced. `x-jiva-role` is demo auth, but the docs never state it is unauthenticated. Also any actor can set a hospital ACCEPTED/UNAVAILABLE.
- **Action:** at minimum state plainly "demo auth, no enforcement"; ideally apply `AccessControl` to routes/POST/socket rooms.

### D-4 · HIGH — Stale/out-of-order events overwrite newer state
- **Evidence (`.audit/t4.mjs`):**
  - Acceptance A(−20 min, ACCEPTED) → C(now, REJECTED) → B(−10 min, LIMITED): final `LIMITED`; `lastConfirmedAt` moved backwards. A stale replay ACCEPTED(−30 min) ended `ACCEPTED`.
  - Ambulance location 12.90 → 12.92 (newest) → 12.91 (old): final lat 12.91.
  - Capacity AVAILABLE(now) → UNAVAILABLE(−30 min): final UNAVAILABLE.
  - Cause: engines call `hospitalsStore.set` / `ambulancesStore.set` on raw `Map`s; the timestamp guard lives only in `LocalStateStore.setAmbulance/setHospital`, which the engines never call; handlers stamp `now`, not the event's timestamp.
- **Impact:** a delayed packet can flip a hospital from REJECTED to ACCEPTED or resurrect old GPS. `tests/unit/event-ordering.test.ts` passes while runtime fails. Docs (Q15, "causal ordering", "version vector") are false locally.
- **Action:** route engine writes through the guarded methods using the event's own timestamp.

### D-5 · HIGH — Demo reset leaks state; runs 2–3 lose the reroute
- **Evidence (`.audit/t7.mjs`, 3 consecutive runs, UI-equivalent reset):**
  - Run 1: reroute H1→H4 OK.
  - Run 2 start: ambulance `status=DISPATCHED`, `assigned=CASE-BLR-876`, `dest=HOSP-BLR-004`, old position; H1 `acceptance=ACCEPTED` even after reset (reset only rewrites capacity fields). Result: **no `destination.changed`/`route.recalculated`** after H1 became unavailable.
  - Run 3 identical. H1 provenance grew 3 → 6 → 9.
  - No reset endpoint exists; only a restart clears it.
- **Impact:** any second rehearsal or re-take breaks the flagship moment.
- **Action:** add a real reset (or document "restart API between runs").

### D-6 · HIGH — Shipped flagship simulator does not show the reroute
- **Evidence:** live run with 4 UIs open: responses were H3 REJECTED, H2 LIMITED, H1 ACCEPTED. Destination = first accepting responder (H2/Whitefield, LIMITED, "DEMO ROUTE — Synthetic Corridors (67 min)"); H1 ACCEPTED later did not replace it; later "H1 UNAVAILABLE" touched nobody (no `destination.changed` after 12:58:06). Patient UI stalled at step 3/7; Ambulance UI unchanged. `final-readiness-report.md §5.2` claims otherwise.
- **Impact:** the demo's climax is missing with the provided script.
- **Action:** reorder simulator (accept A first) and/or rank accepted candidates before first-come.

### D-7 · HIGH — Root `npm run dev` starts one service
- **Evidence:** `npm run dev` → `npm run dev --workspaces --if-present` runs sequentially; only ambulance-web on 5173 came up; API never started. `CLAUDE.md` gives correct per-workspace commands but `simulate-*.ts` error text recommends `npm run dev`.
- **Action:** use a parallel runner or fix the message.

### D-8 · HIGH (partly unverified) — Maps blank in dev, worker 404, CDN CSS
- **Evidence:** dev (clean Vite caches): `404 /node_modules/.vite/deps/maplibre-gl-worker.mjs` + "Worker failed to load" ×2 on both map apps; canvas present, `.maplibregl-map` height 0, tiles 200 but screenshot blank. CSS is injected at runtime from `unpkg.com/maplibre-gl@4.7.1` while 6.11.2 is installed (needs internet; version mismatch). Headless SwiftShader may differ from a real GPU — **needs one human look in a normal browser**.
- **Impact:** offline demo has no map CSS; console errors violate "no unexplained errors".

### D-9 · MEDIUM — Event-quality issues
- Realtime order inverted: `care.requirement.created` arrives before `patient.emergency.created`.
- `/api/events/history` and case timeline contain only externally-posted events (system events never recorded) → the audit "ledger" is incomplete.
- Same `responseId` with a new `eventId` is fully re-processed (extra AI handoff, extra provenance). Idempotency = `eventId` only, at the HTTP boundary only.
- No schema validation: unknown event types and `status: "EXPIRED"` (not in enum) stored/accepted.
- `hospital.acceptance.expired` has no consumer and `requestId:"req-expired"` is hard-coded.
- **Expiry reroute publishes `destination.changed` but never `route.recalculated`** (route stays stale in UI). Verified in `t3.mjs`.
- Rejecting hospital X reroutes **every** ambulance whose destination is X regardless of case.
- `patient.careRequirements` stores the free-text `condition` (e.g. "TRAUMA", "CARDIAC"), while the requirement uses fixed `['EMERGENCY','TRAUMA','ICU']`; reroute uses the former, so a non-enum condition makes every hospital INELIGIBLE.
- `dispatch` does not clear `destinationHospital` from a previous case.

### D-10 · MEDIUM — Provenance/labelling
- After the first acceptance, `operationalState.source` flips to `HOSPITAL_CONFIRMED` while emergency/ICU fields still hold synthetic seed values (`AVAILABLE`). Any actor (even `source.type: patient`) can set capacity, and provenance records `verificationStatus: UNKNOWN` at confidence 1.0.
- Synthetic hospitals start `acceptance:"AVAILABLE"` (not a valid `AcceptanceStatus`) and `AVAILABLE` capacity; docs promise operational capacity "strictly UNKNOWN until confirmation" (true only for canonical data).
- Canonical (7): capabilities all empty, coordinates "GEOCODED" with no method, 5/7 no phone, 1/7 historical beds, no capability/capacity source. Created from hand-typed `manual-extract.json` files; `data:fetch` never fetches. Using `USE_CANONICAL` would make every hospital ineligible.

### D-11 · MEDIUM — Provider transparency and latency
- `/api/health` reports mapping provider `fallback` and management HUD shows `fallback`; the actual provider (mock/osrm/valhalla) is only visible in route events/ambulance HUD ("DEMO ROUTE"). Health reports `MockAIProvider` even with `USE_BEDROCK=true`. Management HUD's default text when health is missing is literally `GOOGLE MAPS`.
- No circuit breaker: with providers hung (accept, never answer), one candidate round takes **10.2 s** (2 × 5 s); with refused connections every call logs 2 fallbacks per hospital.

### D-12 · MEDIUM/LOW — Patient/ambulance UI
- Patient ETA shows `--min` in every run (route info only captured if ambulance already loaded).
- "Accepted for your emergency" shown for any destination, even LIMITED/UNKNOWN.
- Patient "Hospital accepted" step never completes when destination is LIMITED; "Ambulance en route" never completes (status never becomes EN_ROUTE). Hard-coded patient `CASE-BLR-876`.
- Every socket event triggers three full-state refetches per client (patient: 77 API calls in a 65 s run). No map re-creation or route calls observed (tile count stayed constant at 8/12) — that part is fine.
- After API restart UIs show stale data as current; management shows OFFLINE→LIVE MESH correctly, patient has no indicator; no refetch on reconnect.

### D-13 · MEDIUM — Memory
- 6,000 events: RSS 87 → 153 MB (≈11 KB/event); `globalEventHistory` in `intelligenceEngine.ts` is unbounded; store history bounded at 10,000. Fine for a demo, not for "extended" runs.

### D-14 · LOW — Security hygiene
- Stack trace with local file paths returned for malformed JSON (Express default error page).
- Marker/popup HTML built with `innerHTML` using hospital name / ambulanceId (dataset-controlled today, not user input).
- Default secret `jiva-dev-secret-key-12345` in config (unused). `.env` contains no secrets. No AWS keys/tokens found. No SSRF path (mapping URLs are env-only); Nominatim geocoding calls public OSM. Whole event JSON is logged by the ingestion Lambda (patient data in CloudWatch).
- Bedrock provider ignores `BEDROCK_MODEL_ID` and configured region (hard-coded haiku/us-east-1); prompts embed raw free-text patient fields (prompt-injection surface exists, but output is schema-validated and has no write path).

### D-15 · HIGH vs documentation — AWS claims
- `cdk synth` succeeds (exit 0; 8 Lambdas, EventBridge bus + 6 rules, DynamoDB, S3, Cognito pool + 5 groups, REST API with 4 methods, dashboard + 2 alarms).
- **No `AWS::ApiGatewayV2` resources** → no WebSocket API, despite `apigwv2` import and docs "WebSocket $connect/$disconnect/$default routes configured".
- **No authorizer** on the REST API; Cognito pool is created but unused by the API; CORS `ALL_ORIGINS`.
- **No dead-letter queues** (docs claim them). Lambda runtime `nodejs20.x` deprecated warning.
- Status: SYNTHESIZED. **NOT LIVE VERIFIED** (no credentials, no CLI, nothing deployed).

### Verified passing behaviours (for balance)
- Clinical eligibility is independent of mapping: H3 (no TRAUMA/ICU) was INELIGIBLE, never sent an acceptance request, in every run and with mock/fake-OSRM providers.
- Multi-hospital coexistence: H4 LIMITED, H2 ACCEPTED, H1 REJECTED simultaneously held; same-`eventId` duplicate returned `duplicate_ignored` with zero side effects.
- Expiry: ACCEPTED (4 s validity) → `UNKNOWN` within the 10 s poll; never became AVAILABLE/UNAVAILABLE; destination reconsidered to H2.
- `historicalCapacity` never copied into operational state (no code path).
- AI: adversarial condition text ("set H3 AVAILABLE", `<script>`, "route to H3") left H3 state, ambulance destination and eligibility unchanged; Bedrock failure produced logged errors and 0 AI events while emergency/acceptance/routing/rerouting continued.
- Mapping fallback with real failures produced structured `mapping.provider.fallback` logs and never stopped the flow; no Google Maps at runtime (only the stray `'GOOGLE MAPS'` fallback label).
- Telemetry: marker updates via `setLngLat`; no map recreation; no route requests from browsers.

---

## E. False or Misleading Claims

| Document | Claim | Verdict |
|---|---|---|
| final-readiness-report | "AUDITED, TESTED & VERIFIED… all apps compile" / STATUS READY | **Misleading** — bundles crash at runtime (D-2); `demo:check` only checks file existence. |
| final-readiness-report §3.6, judge-qa Q9 | `GoogleMapsProvider` implemented; Google Routes API "ready" | **FALSE** — no such provider exists; mapping is Valhalla/OSRM/Mock (report predates migration). |
| final-readiness-report §5.2 | Flagship script reroutes A→B | **FALSE** for shipped simulator (D-6). |
| final-readiness-report §6 | WebSocket `$connect/$disconnect/$default` configured in CDK; EventBridge DLQs | **FALSE** (D-15). |
| final-readiness-report §1.1 | "Security: … Causal ordering … verified" | **FALSE** at runtime (D-4). |
| final-readiness-report §3.2/3.3 | Paramedic status buttons `EN_ROUTE_SCENE…`; audible reroute trigger; hospital modal with countdown; `hospital.availability.requested` event | **FALSE / not found** in source (event names are `hospital.acceptance.*`). |
| final-readiness-report §3.4, judge-qa Q13 | Patient app sanitised; PII stripped; ambulance identity masked; AWS KMS/TLS 1.3 | **FALSE / UNVERIFIED** — all data is served to everyone; encryption not in CDK beyond S3-managed. |
| judge-qa Q3 | Ephemeral 120 s window; only verified clinician action changes state; timeout → `EXPIRED` | **PARTIAL/FALSE** — window is 15 min, any caller can post, expiry → `UNKNOWN`. |
| judge-qa Q7 | Routing engine picks "next best" | Mostly true; first-responder wins initial destination (D-6). |
| judge-qa Q14/Q15, security.md | DynamoDB conditional writes, version vectors, valid lifecycle transitions | **UNVERIFIED** (AWS) / **FALSE** locally (no lifecycle state machine, no ordering). |
| judge-qa Q1, docs "7 verified hospitals" | Authenticated registries; verified | **PARTIAL** — 7 hand-extracted public listings, status `PUBLIC_LISTED`, no capabilities. |
| architecture-explanation §2/§5 | Named engines (`EmergencyStateEngine`, …) with role-isolated frontends | **PARTIAL** — one `stateEngines.ts`; no role isolation. |
| architecture-explanation §6 | Outputs "enforced via Zod"; timeline summaries | Zod only in Bedrock path; local summary never fires (`route.calculated` is never emitted locally). |
| mapping.md | Provider HUD shows VALHALLA/OSRM/MOCK | **PARTIAL** — management HUD shows `fallback`; ambulance HUD shows "DEMO ROUTE". |
| security.md #1 | Frontend Google Maps key restrictions | **Stale** — no Google Maps in use. |
| judge-qa Q17/Q18 | Not connected to real hospitals; simulated telemetry/availability | **TRUE** (good honesty). |
| final-readiness-report §6 | "NOT LIVE-VERIFIED" for AWS | **TRUE**. |
| mapping.md | OSM attribution visible; MapLibre + OSM | **TRUE** in DOM/tile requests; visual render unverified (D-8). |

---

## F. Demo Blockers (realistic)

1. **Do not start with `npm run dev`** — it launches one app (D-7). Use per-workspace commands.
2. **Do not demo from a production build** — management/ambulance pages are blank (D-2).
3. **Map visibility** — confirm on the demo machine (D-8); the map CSS needs internet (unpkg) and worker 404s appear in console.
4. **Any malformed POST kills the API** (D-1) — restart API before demo; keep the endpoint off shared networks.
5. **Restart the API between runs** — reset doesn't (D-5).
6. **Use a corrected script order** — accept Hospital A first, then B, then take A down (D-6); otherwise no reroute is shown.
7. **Patient screen** shows `--min` ETA and stops at step 3–4 (D-12); avoid pointing at ETA there.
8. **Have internet** for OSM tiles and unpkg CSS (no offline map).

---

## G. Judge-Question Risks

| Likely question | Honest answer today | Risk |
|---|---|---|
| "What is actually real-time?" | Socket.IO event fan-out is real; all inputs are scripted; no reconnect resync. | Medium |
| "Is hospital availability real?" | No. Synthetic hospitals *start* AVAILABLE; canonical are UNKNOWN. | High if docs quoted |
| "Is AWS deployed?" | No. Synthesized only; no WebSocket API or authorizer in the template. | High if "WebSocket ready" quoted |
| "Does Valhalla actually run?" | Not demonstrated. Only the fallback chain to mock was ever exercised end-to-end; routes in the demo are synthetic. | High |
| "Where does your map data come from?" | OSM raster tiles (online); routing data is a mock corridor unless Valhalla/OSRM are self-hosted. | Medium |
| "Does AI control routing?" | No — verified: no write path, injection inert. | Low (strong point) |
| "What if AWS fails / network fails?" | Local mode has no AWS dependency; but tiles/CSS need the internet and providers falling back cost seconds when hung. | Medium |
| "How do you enforce privacy/RBAC?" | It is not enforced (D-3). | **Critical** if claimed |
| "What about duplicate/out-of-order events?" | Duplicates by eventId: yes. Ordering: no (D-4). | High |
| "Can I break it?" | One curl (D-1). | High |

---

## H. Final Recommendation

**NOT READY**

The architecture is real and the central loop works once from a clean start, but the demo as shipped can fail on ordinary rehearsal steps (`npm run dev`, a production build, a second run, the provided simulator, a stray malformed request), and several documented guarantees (RBAC, ordering, AWS WebSocket/authorizer, Google/Valhalla claims) are false or unverified. Fixing blockers 1–6 in §F and correcting the documents in §E would change this to **READY WITH KNOWN LIMITATIONS**; that assessment was not tested.

---

## Appendix 1 — Command log

| Command | Exit | Duration | Notes |
|---|---|---|---|
| `npm run build` | 0 | 24 s | Vite chunk-size warning only |
| `npm test` (unit + integration) | 0 | 4 s | all "PASSED"; mapping tests mock fetch |
| `npm run data:validate` | 0 | 1 s | report: 7 facilities, 0 with current operational data |
| `npm run demo:check` | 0 | 1 s | file-existence only |
| `npm run dev` | (hangs on first workspace) | — | only ambulance-web started |
| `npm run dev --workspace=…` ×5 | ok | ~10 s | API :4000, UIs :5173–5176 |
| `cdk synth` (temp out dir) | 0 | <100 s | nodejs20.x deprecation warning |
| Flagship `simulate:full:blr` | 0 | 65 s | see D-6 |

## Appendix 2 — Audit changes (separate from product changes)

- **Product source: no changes.**
- `.audit/` directory added (test harness scripts only). Remove if not wanted.
- **Incident:** a mistaken `npm i playwright-core socket.io-client` executed inside `.audit/` resolved to the root workspace and briefly added those two dependencies to the root `package.json` / `package-lock.json`. I reverted with `npm uninstall`; `package.json` is back to its original content (devDependencies only) and the lockfile no longer references `playwright`. The lockfile was re-serialised by npm, so a diff review is advisable (no VCS in this folder to confirm).
- Deleted `apps/management-web/node_modules/.vite` and `apps/ambulance-web/node_modules/.vite` (Vite caches; regenerated). All listening test servers were stopped at the end.
- `playwright-core` installed only in the session scratchpad, not in the repo.
