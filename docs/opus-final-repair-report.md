# JIVA — Final Repair Report (2026-09-26)

## 1. Executive Summary

Every CRITICAL and HIGH finding from the independent audit (`docs/claude-full-system-audit.md`) was reproduced, root-caused and repaired within the existing architecture. The repairs were verified against a running system:

- a 103-check runtime integration suite against a real API process (now part of `npm test`);
- the flagship scenario run 3× consecutively with identical outcomes;
- production and development builds of all four apps driven in a browser (Edge, headless) during the flagship, with **zero console errors**;
- realtime disconnect/recovery;
- adversarial mapping-provider failures;
- `cdk synth`.

**Verdict: JIVA DEMO READY** for the **local demo**, with the explicit limitations in §16 (demo auth, synthetic data and routes, Valhalla/OSRM unverified, AWS synthesized only).

## 2. Initial Audit Findings

CRITICAL:
- a malformed POST crashed the API;
- the production white-screen;
- no RBAC.

HIGH:
- stale events overwrote newer state;
- reset leaked state;
- the simulator never showed a reroute;
- `npm run dev` started one app;
- the map rendered blank;
- AWS claims were false (WebSocket, authorizer, DLQ);
- the docs overclaimed.

## 3. Issues Reproduced

All reproduced at runtime before any change (commands and outputs in the audit report and `docs/opus-repair-plan.md`).

Newly found during the repair:
- ambulance-web and patient-web had **no Tailwind pipeline** (every class a no-op);
- the MapLibre worker also failed in **production**, so GeoJSON routes never drew;
- hospital markers never repainted on status change, and UNKNOWN rendered blue;
- socket "DISCONNECTED" false negatives;
- the management demo controls **fabricated** `destination.changed` and `ai.*` events;
- the expiry reroute emitted no route;
- `careRequirements` stored free text;
- the handoff was generated for every accepting hospital instead of the destination.

## 4. Root Causes

| Symptom | Root cause |
|---|---|
| API crash | No schema validation at ingress. Async bus handlers threw, and the resulting unhandled rejections exited Node. |
| Prod white-screen | Apps compile `@jiva/ui/src/*`. Vite resolved `react` for those files from `packages/ui/node_modules/react` (18.3.1) while the app used root `react` (19.3.0), so the bundle held two React copies. |
| Blank map | (a) The map container was `height:100%` of a min-height/flex parent → 0 px. (b) The maplibre v6 worker is resolved as a sibling file that Vite never emits (dev and prod). (c) The CSS came from the unpkg CDN at v4.7.1. |
| No RBAC | Demo auth defaulted to MANAGEMENT for any/no header. `AccessControl` was never called. Socket.IO broadcast everything to every connection. |
| Stale overwrite | Engines wrote raw Maps stamped with `now`. The timestamp guard existed only in unused store methods. |
| Reset leak | "Reset" only posted capacity UNKNOWN events. No store/engine reset existed. |
| No reroute in simulator | Script order, first-responder-wins selection, and the capacity UNAVAILABLE state not affecting eligibility. |
| `npm run dev` | `--workspaces` runs sequentially, and the first Vite never exits. |

## 5. Repairs Implemented

- **Backend:**
  - `index.ts`: validation, authn/authz, 409 for responses to requests never sent, JSON error handler, CORS allow-list, reset endpoint, socket auth + filtering, process guards.
  - `LocalEventBus.ts`: handler isolation.
  - `authorization.ts`: new; the single policy module.
  - `stateEngines.ts`: rewritten, covering watermarks, responseId dedupe, case-bound acceptance, per-ambulance lock, unified reroute emitting `destination.changed` + `route.recalculated`, arrival detection, expiry → UNKNOWN, epoch guard.
  - `eligibilityEngine.ts`: ED UNAVAILABLE → ineligible, LIMITED expiry, case binding, ACCEPTED preferred over LIMITED.
  - `intelligenceEngine.ts`: bounded, resettable, destination-scoped handoff, summary on arrival.
  - `mapping.ts`: new; breaks the circular import.
  - `LocalStateStore.reset/appendHistory`.
- **Shared packages:**
  - `packages/auth/demoAuth.ts`: fixed personas only; explicitly demo-only.
  - `packages/auth/rbac.ts`: no blanket patient access.
  - `event-schema`: `ambulance.arrived`, `demo.reset`, `trafficAware`, handoff `hospitalId`.
  - `domain-models`: ordering watermarks, `activeRoute`.
  - `FallbackMappingProvider.getStatus()`.
- **Frontends:**
  - Vite `dedupe` / `optimizeDeps.exclude` / `worker.format`.
  - `JivaMap`: bundled worker via `?worker&url`, local CSS, absolutely positioned container.
  - Marker HTML escaping; marker repaint on status change; UNKNOWN shown grey.
  - Tailwind added to ambulance-web and patient-web.
  - Per-app `api.ts` (persona auth).
  - Surgical App updates: server-derived ETA/route, honest acceptance labels, connection/stale indicators, reroute notices, resync on reconnect/reset, hospital request reload + ED capacity report.
  - Management demo controls rewritten to act as real actors (no fabricated system/AI events).
- **Tooling:**
  - `scripts/dev-all.mjs` (`npm run dev`, `npm run start:prod`), `scripts/demo-reset.ts`.
  - `simulate-full.ts`: deterministic and self-verifying.
  - Legacy simulators given personas; the invalid Koramangala response was replaced.
  - `demo-check.ts`: real probes.
  - `tests/integration/api-runtime.test.ts`.
- **Manifests:**
  - ambulance-web declares `socket.io-client`; ambulance-web and patient-web declare Tailwind.
  - `@jiva/ui` React is a peer dependency.
  - One `npm install`; lockfile diff limited to those 3 workspace entries + metadata flags on existing packages (none added or removed).
- **Data:** synthetic seed `acceptance` `AVAILABLE` (invalid enum) → `UNKNOWN`.
- **AWS CDK:** SQS DLQ on all 6 rule targets, Cognito authorizer on `POST /api/events`, CORS allow-list, WebSocket API (IAM `$connect`), outputs.

## 6. Security/RBAC

Runtime-verified:
- Anonymous or unknown persona → 401 on all data endpoints, and the socket connection is refused.
- A forged `x-jiva-role` header is ignored (401).
- Patients see only their own case.
- Ambulances see only themselves and their assigned case.
- A hospital sees only cases it was asked about or is receiving.
- Management sees all data; reset is ADMIN-only.
- Event submission is bound to role **and** source identity:
  - hospital 1 cannot post for hospital 2 (403);
  - source/payload mismatch → 403;
  - an ambulance cannot dispatch or respond;
  - a patient cannot report capacity;
  - system and `ai.*` events cannot be injected, even by ADMIN (403);
  - a response to a request never sent → 409.
- Foreign CORS origins are not allowed.

**Demo personas are bearer credentials: demo auth, not production auth.**

## 7. Event Ordering

Watermarks come from the event's own timestamp; strictly older events are ignored, and equal timestamps are applied in arrival order. Runtime-verified:
- A→C→B keeps C.
- A stale ACCEPTED replay cannot override REJECTED; older → newer applies.
- An already-expired acceptance is ignored.
- Stale capacity cannot overwrite; GPS never moves backwards.
- A duplicate `eventId` is ignored, and a redelivered `responseId` produces no side effect.
- A/B/C responses (ACCEPTED/LIMITED/REJECTED) coexist.
- Future timestamps → 400.

## 8. Frontend Production Verification

`npm run start:prod` (vite preview :4173–4176) in Edge:
- all four apps mount, with zero console errors and no failed requests;
- the Socket.IO connection is authenticated;
- the maps fill their panels (755 px / 866 px) with OSM tiles, attribution, markers and the route polyline;
- no browser calls to routing providers;
- GPS updates move markers without redrawing the route.

The same checks passed in dev mode (`npm run dev`), including no worker 404.

## 9. Simulation Verification

`npm run simulate:full:blr` runs reset → emergency → assessment → candidates → requests → dispatch → Hebbal ACCEPTED (dest A + route) → Indiranagar ACCEPTED, Whitefield LIMITED (dest unchanged) → telemetry → Hebbal ED UNAVAILABLE → **reroute to Indiranagar** → arrival → AI handoff/anomaly/summary. It exits non-zero on any missing transition.

It completed 3× in the integration suite (identical outcomes) and 4× under browser observation. All four UIs showed the same destination, ETA and status without reload.

## 10. Mapping Verification

- **Mock:** verified; deterministic and labelled synthetic.
- **Fallback chain:** verified against refused ports, hung ports (5 s timeouts) and malformed JSON / empty routes; `/api/health` reports `activeProvider`, `fallbackActive` and the reason.
- **Valhalla/OSRM:** **UNVERIFIED** against real servers (no Docker); fixture/fake-server parsing only.

## 11. AI Isolation Verification

- AI publishes only `ai.*` events, and nothing consumes them.
- Injected instructions in the patient condition and hospital limitations left H3 state and the destination unchanged.
- The Bedrock failure (no credentials) was non-blocking.
- Externally submitted AI events are rejected.

## 12. AWS Reality Check

| Item | Status |
|---|---|
| CDK stack | **SYNTHESIZED** (exit 0) |
| EventBridge + 6 rules + SQS DLQ | CONFIGURED, synthesized |
| REST API + Cognito authorizer | CONFIGURED, synthesized |
| WebSocket API (IAM `$connect`) | CONFIGURED, synthesized. Browser clients cannot connect until a Cognito Lambda authorizer and per-role filtering are added (PLANNED) |
| Lambda processors | IMPLEMENTED, compiled. **Lack the local engine repairs** |
| DynamoDB conditional writes | IMPLEMENTED in code, UNVERIFIED |
| Bedrock | IMPLEMENTED, UNVERIFIED |
| Deployment | **NOT DEPLOYED / NOT LIVE-VERIFIED** (no credentials; nothing deployed) |

## 13. Documentation Reconciliation

- **Rewritten:** `judge-qa.md`, `judge-demo-script.md`, `demo-runbook.md`.
- **Corrected:** `architecture-explanation.md` (event names, engines, AI model, RBAC, AWS status), `security.md`, `local-vs-aws.md`, `mapping.md`, `architecture-diagram.md`, `data-limitations.md`, `pitch-60-seconds.md`, `CLAUDE.md`.
- **Banners added:** `final-readiness-report.md` (superseded, listing its false claims), `architecture-audit.md` (old event names), `aws-architecture.md` / `aws-deployment.md` (synthesized, not deployed).
- **Left unchanged (historical records):** `mapping-migration-*.md`, `phase*-report.md`.

## 14. Test Results (final tree)

| Command | Exit | Duration | Notes |
|---|---|---|---|
| `npm run build` | 0 | 65 s | 2 Vite chunk-size warnings (maplibre) |
| `npm test` | 0 | 61 s | Unit tests + parity + mapping + **runtime integration 103/103** |
| `npm run data:validate` | 0 | ~1 s | |
| `npm run demo:check` | 0 | ~2 s | Real probes; READY with INFO limitations |
| `cdk synth` | 0 | 46 s | nodejs20.x deprecation warning |

## 15. Browser Verification

Microsoft Edge via Playwright, headless with SwiftShader WebGL, in prod and dev:
- four apps observed during the flagship;
- screenshots at destination A, after the reroute and at the end;
- realtime kill/restart: all UIs flagged disconnect, reconnected automatically and resynced to server truth.

A **headed real-GPU browser was not used**. One visual check on the demo machine is recommended.

## 16. Remaining Known Limitations

1. **Demo authentication only.** Personas are bearer ids; the Cognito path is not live.
2. **All operational data is synthetic** (hospital responses, GPS, capacity). Routes are **Mock** unless Valhalla/OSRM are self-hosted; real providers are UNVERIFIED.
3. **AI text is mock templates** locally (e.g. fixed "trauma" alerts); Bedrock is unverified.
4. **AWS is synthesized, not deployed.** The Lambda processors do not include the local engine repairs, and the AWS WebSocket has no per-role filtering (hence IAM-only `$connect`).
5. **In-memory state:** an API restart loses the demo (the UIs resync honestly).
6. **Acceptance is stored per hospital** (the latest response, bound to one case), so concurrent multi-case acceptance at one hospital is not modelled.
7. **Map tiles need internet** (tile.openstreetmap.org).
8. The ambulance **status model is simplified** (dispatched → en route to hospital → arrived).

## 17. Final Readiness Verdict

Stop conditions 1–18 are met for the local demo:
- API survives malformed input.
- Server-side RBAC and WebSocket authorization are enforced.
- No production white screens; all four apps render in production.
- Stale-event protection, idempotency and multi-hospital responses work.
- Reset is deterministic, and the flagship reroute works repeatedly.
- AI cannot mutate state.
- Mapping status is honest.
- The docs are reconciled.
- Build, tests and demo:check pass.
- Runtime verification passed.
- No unresolved CRITICAL issues remain.

## **JIVA DEMO READY** (local demo, with the limitations in §16)
