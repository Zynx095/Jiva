# JIVA — Final System Status (2026-09-26)

Legend: **Implemented** = code exists · **Tested** = automated test and/or runtime verification in this repair · **Live Verified** = exercised against the real external system (not applicable locally unless stated).

| Component | Implemented | Tested | Live Verified | Synthetic/Mock | Notes |
|---|---|---|---|---|---|
| Local API (Express) | Yes | Yes: 103-check runtime suite on a real process | n/a (local) | — | Survives all malformed-input cases; structured 4xx; no stack traces |
| Event ingress validation | Yes | Yes | n/a | — | Zod `AnyEventSchema`, future-timestamp guard, 100 kB limit |
| Event bus (local) | Yes | Yes | n/a | — | Handlers isolated; system events recorded in the ledger |
| State engines | Yes | Yes | n/a | — | Watermark ordering, responseId dedupe, case-bound acceptance, serialized per-ambulance routing |
| Hospital acceptance protocol | Yes | Yes | No real hospitals | Responses simulated | Must answer an actual request (409 otherwise); expiry → UNKNOWN |
| Clinical eligibility | Yes | Yes | n/a | — | Capability + current case response + ED not UNAVAILABLE; mapping only orders |
| Dynamic rerouting | Yes | Yes: flagship ×3 identical + browser | n/a | Routes mock | Capacity UNAVAILABLE, REJECTED, UNAVAILABLE response, expiry |
| Demo reset | Yes | Yes | n/a | — | `POST /api/demo/reset` (ADMIN), epoch guard for in-flight work |
| RBAC (REST + event submission) | Yes | Yes | n/a | **Demo personas** | Not production auth; Cognito path exists in code |
| Realtime (Socket.IO) auth + filtering | Yes | Yes | n/a | Demo personas | Handshake auth; per-role event filter; reconnect resync verified in browser |
| Mapping: Mock provider | Yes | Yes | n/a | **Synthetic** | Labelled "synthetic, no live traffic" in every UI |
| Mapping: fallback chain | Yes | Yes (refused, hung, malformed providers) | n/a | — | `/api/health` reports the provider that actually answered + reason |
| Mapping: Valhalla | Yes | Fixture parsing only | **No** (no Docker) | — | UNVERIFIED against a real server |
| Mapping: OSRM | Yes | Fixture + fake-server parsing | **No** | — | UNVERIFIED against a real server |
| MapLibre + OSM tiles | Yes | Yes: browser, prod and dev | Tiles from tile.openstreetmap.org | — | Worker bundled; attribution shown; needs internet for tiles |
| AI sidecar (mock) | Yes | Yes | n/a | **Mock templates** | Emits only `ai.*`; injection has no effect; failure is non-blocking |
| AI sidecar (Bedrock) | Yes | Failure path only (no creds) | **No** | — | Model hard-coded to Claude 3 Haiku / us-east-1 |
| Management UI | Yes | Browser (prod + dev) | n/a | Synthetic data | Honest provider/AI HUD; controls act as real actors |
| Ambulance UI | Yes | Browser (prod + dev) | n/a | Synthetic GPS | Reroute banner, provider label, connection state |
| Hospital UI | Yes | Browser (prod + dev) | n/a | Simulated responses | Requests reloadable; `?as=demo-hosp-4` for hospital B |
| Patient UI | Yes | Browser (prod + dev) | n/a | Synthetic | Own case only; ETA from server; uncertainty and connection shown |
| One-command launch | Yes | Yes (`npm run dev`, `npm run start:prod`) | n/a | — | API :4000, apps :5173–6 dev / :4173–6 prod |
| Canonical dataset | Yes (7 records) | `data:validate` | Sources hand-extracted | — | PUBLIC_LISTED; no capabilities; operational UNKNOWN |
| Synthetic dataset | Yes (4 hospitals, 3 ambulances) | Yes | n/a | **Synthetic** | acceptance seeded UNKNOWN |
| AWS CDK stack | Yes | `cdk synth` exit 0 | **No, not deployed** | — | Adds SQS DLQ, Cognito REST authorizer, WebSocket API (IAM `$connect`) |
| AWS Lambda processors | Yes | Compile only | **No** | — | Separate implementation; lacks this repair's engine fixes |
| DynamoDB conditional writes | Yes | No | **No** | — | Code only |
| CloudWatch / S3 / Cognito | Configured in CDK | Synth only | **No** | — | |
