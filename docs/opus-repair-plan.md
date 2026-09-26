# JIVA — Repair Plan

Status legend: OPEN → FIXED (verified) / DOCUMENTED (cannot fix here, reported honestly).
Reproduction evidence for every item was captured at runtime in this session (see `docs/claude-full-system-audit.md`, scripts in `.audit/`).

| # | Issue | Reproduction | Observed | Root cause | Fix | Verification | Risk | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | Malformed event crashes API | `POST /api/events {"eventId":"x","eventType":"patient.emergency.created"}` | 202, then Node exits (`TypeError ... reading 'location'`, stateEngines.ts:17) | No schema validation at ingress; async bus handlers throw → unhandled rejection kills process | Zod validation (`AnyEventSchema`) at ingress; bus wraps every handler in try/catch; JSON error handler; `unhandledRejection` guard | `tests/integration/api-runtime.test.ts` (10 negative cases, liveness after each) | Low | FIXED |
| 2 | Prod white-screen (mgmt, ambulance) | `vite build && vite preview` → `Cannot read properties of null (reading 'useRef')` | Blank page | Apps import `@jiva/ui/src/*` source; Vite resolves `react` for those files from `packages/ui/node_modules/react` **18.3.1** while app code uses root **19.3.0** → two React copies | `resolve.dedupe: ['react','react-dom']` in all app Vite configs; `@jiva/ui` React moved to `peerDependencies` | Browser test against `vite preview` of all four apps | Low | FIXED |
| 3 | RBAC not enforced | anonymous `GET /api/patients`, `POST hospital.capacity.updated`, anonymous socket | 200/202, all events streamed | Demo auth defaulted to MANAGEMENT; `AccessControl` never called; socket broadcast to all | Demo auth accepts only known personas (no default role, no free-form role header); per-endpoint & per-event-type authorization; source-identity binding; socket handshake auth + per-event filtering; CORS allow-list | Integration test role matrix + socket filter tests | Medium (UIs must send persona) | FIXED |
| 4 | Stale events overwrite newer state | A→C→B acceptance / capacity / GPS | Older event wins | Engines write raw Maps with `now` timestamps; guard exists only in unused store methods | Per-field `…AsOf` watermarks from the event's own timestamp; responseId dedupe; expired responses ignored; future timestamps rejected | Integration test ordering cases | Low | FIXED |
| 5 | Reset leaks state | 3 consecutive runs | run 2–3 lose reroute | "Reset" only posts capacity UNKNOWN events | `POST /api/demo/reset` (ADMIN): clears stores, history, idempotency sets, AI cache/timers, re-seeds; epoch guard aborts in-flight async work; `demo.reset` event tells UIs to resync | Flagship scenario ×3 identical outcome | Low | FIXED |
| 6 | Simulator doesn't reroute | `npm run simulate:full:blr` | First responder (LIMITED) wins; A-unavailable changes nothing | Script order + engine "first ACCEPTED/LIMITED wins"; UNAVAILABLE capacity didn't make hospital ineligible | Deterministic script (A accepts → dest A → B accepts → A unavailable → reroute B → arrival); destination selection prefers ACCEPTED over LIMITED; eligibility honours operational UNAVAILABLE | Scenario run ×3 + browser | Low | FIXED |
| 7 | Root `npm run dev` starts one app | `npm run dev` | only ambulance-web | `npm run dev --workspaces` is sequential and vite never exits | `scripts/dev-all.mjs` orchestrator (API + 4 apps, fixed ports) | Launch & port check | Low | FIXED |
| 8 | Blank map / worker 404 (dev) | dev server + browser | 404 `maplibre-gl-worker.mjs`; map div height 0 | (a) Vite dep-optimizer rewrites maplibre v6 and drops its sibling worker file; (b) inner map container `height:100%` of a min-height parent → 0 px; (c) CSS from unpkg v4.7.1 | `optimizeDeps.exclude: ['maplibre-gl']`; absolute-inset container; local `maplibre-gl/dist/maplibre-gl.css` import | Browser: canvas height > 0, no worker 404 | Low | FIXED |
| 9 | Real Valhalla/OSRM unverified | no Docker | — | Environment | Keep UNVERIFIED; fixtures + fallback tests; health reports *actual last provider* | Unit tests + adversarial provider test | — | DOCUMENTED (UNVERIFIED) |
| 10 | Provider transparency | health says `fallback` | — | FallbackMappingProvider hides the provider actually used | Track `lastProvider`/`lastFallbackReason`; route events carry `trafficAware` | Health & route event check | Low | FIXED |
| 11 | AWS claims (WebSocket, authorizer, DLQ) | `cdk synth` template | none present | Not implemented | Add Cognito authorizer, SQS DLQs, WebSocket API in CDK; docs say SYNTHESIZED not DEPLOYED | `cdk synth` resource check | Low | FIXED (synthesized; NOT deployed) |
| 12 | Docs overclaim | read docs | GoogleMapsProvider, availability.* events, KMS, etc. | Stale docs | Reconcile docs | grep | — | FIXED |
| 13 | ambulance-web undeclared `socket.io-client` | manifest | hoisting only | missing dep | declare in manifest | build | — | FIXED |
| 14 | careRequirements stores free text; expiry reroute emits no route | runtime | reroute can find no hospital | engine bug | store capabilities; unified reroute function emits destination.changed + route.recalculated | integration test | Low | FIXED |
| 15 | System events missing from ledger | `/api/events/history` | only external events | only POSTed events recorded | append all bus events to history | integration test | Low | FIXED |

## Additional issues found and fixed during the repair
| Issue | Root cause | Fix | Status |
|---|---|---|---|
| ambulance-web / patient-web unstyled | No Tailwind/PostCSS pipeline | postcss config + `@import "tailwindcss"` + devDeps | FIXED |
| MapLibre worker fails in **production** (GeoJSON routes never drawn) | v6 worker resolved as sibling file Vite doesn't emit | `?worker&url` + `setWorkerUrl` | FIXED |
| Hospital markers never repaint; UNKNOWN shown blue | effect deps `[map,isLoaded]`; colour choice | deps include status; UNKNOWN grey | FIXED |
| Socket "DISCONNECTED" while connected | socket connected before listener registration | sync from `socket.connected` | FIXED |
| Management controls fabricated `destination.changed` / `ai.*` events | demo shortcuts | controls act as real actors; API rejects system/AI events | FIXED |
| AI handoff generated for every accepting hospital | trigger on ACCEPTED | trigger on `destination.changed` for the destination | FIXED |
| Legacy simulators unauthenticated / invalid H3 response | pre-RBAC scripts | persona headers; capable hospital used | FIXED |
| `demo:check` printed READY from file existence | design | real probes | FIXED |

Final evidence: `docs/opus-final-repair-report.md`, `docs/opus-final-system-status.md`.
