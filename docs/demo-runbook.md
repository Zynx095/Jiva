# JIVA — Demo Runbook (verified 2026-09-26)

## 1. Start everything (one command)

```bash
npm install          # first time only
npm run dev          # API + all four apps (development)
# or
npm run start:prod   # builds, then serves production bundles (vite preview)
```

Wait for `[dev-all] READY — API healthy (DEMO mode) and all four apps answering.` If a port is still held by an
earlier run, the launcher says so and starts nothing: close the old window (or the process) and start again.
`npm run demo:check` gives a full readiness report.

The demo API only answers the machine it runs on (`403 demo_local_only` from other devices), because demo
personas are not authentication. For phones on the same Wi-Fi, start with `JIVA_DEMO_ALLOW_REMOTE=true` — then
anyone on that network can act as any persona, including admin.

**Restarting the API loses all demo state** (cases, encounters, records, uploads): state is in memory
(see `docs/persistence-plan.md`). The screens show "reconnecting" while it is down and recover by themselves;
re-run the scenario after a restart. Clinician screens: `http://localhost:5175/?as=demo-doc-3`.

| Service | Dev URL | Prod-preview URL | Demo persona (DEMO auth only) |
|---|---|---|---|
| API (REST + Socket.IO) | http://localhost:4000 (`/api/health`) | same | — |
| Management / command center | http://localhost:5173 | http://localhost:4173 | `demo-mgmt-1` (reads); controls act as each real actor |
| Ambulance (AMB-BLR-001) | http://localhost:5174 | http://localhost:4174 | `demo-amb-1` |
| Hospital (HOSP-BLR-001 Hebbal) | http://localhost:5175 | http://localhost:4175 | `demo-hosp-1` — open `?as=demo-hosp-4` for Indiranagar |
| Patient (CASE-BLR-876) | http://localhost:5176 | http://localhost:4176 | `demo-patient-1` |

Environment (`.env`): `MAPPING_PROVIDER=auto` (Valhalla → OSRM → Mock), `PORT=4000`, `USE_BEDROCK=false`.
Without self-hosted Valhalla/OSRM (see `infrastructure/local/mapping/`), every route is **Mock / synthetic** and is labelled as such. Map tiles come from tile.openstreetmap.org and need internet access.

## 2. Reset

`npm run demo:reset` (or the **Reset demo** button). Reset clears all runtime state, event history, idempotency sets, pending AI work and timers, and re-seeds the synthetic dataset. Every UI resyncs automatically.

## 3. Flagship scenario (automated, self-verifying)

```bash
npm run simulate:full:blr        # ~45 s at the default pace; SIM_STEP_MS=500 for faster
```

Timeline: reset → emergency (CASE-BLR-876, severe polytrauma) → assessment (EMERGENCY, TRAUMA, ICU) → candidates → acceptance requests (Hebbal, Whitefield, Indiranagar; Koramangala excluded for missing TRAUMA/ICU) → AMB-BLR-001 dispatched → **Hebbal ACCEPTED → destination + route** → Indiranagar ACCEPTED, Whitefield LIMITED (destination unchanged) → GPS telemetry → **Hebbal reports ED UNAVAILABLE → reroute to Indiranagar** → arrival → AI handoff / anomaly / summary. The script exits non-zero if any expected transition does not happen.

## 4. Manual flow (management demo controls)

Reset demo → Report emergency + dispatch → Hebbal (001) accepts → Indiranagar (004) accepts → Whitefield (002) limited → Advance ambulance (GPS) ×2 → Hebbal (001) ED unavailable → watch the reroute on all four screens → Advance ambulance until arrival.
The same responses can instead be clicked in the hospital console (open it once as `demo-hosp-1` and once as `?as=demo-hosp-4`). "Report ED unavailable" in Hebbal's console triggers the reroute.

## 5. What to say is simulated

Hospitals (synthetic), responses, GPS, routes (mock), AI text (mock templates), AWS (synthesized only). See `docs/judge-qa.md` Q18.

## 6. Known limitations

- The API keeps state in memory. Restarting it loses the demo state; the UIs detect this and resync.
- Demo auth: persona ids act as bearer credentials. Not production auth.
