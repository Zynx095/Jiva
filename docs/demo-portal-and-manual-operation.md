# Demo portal and manual (hardware-independent) operation

JIVA is a software prototype. **No ECG device, bedside monitor, ESP32, ambulance GPS receiver or hospital
capacity feed is connected.** Everything in a demonstration is either typed in by an authorised person or
produced by a demo tool that labels its output as simulated. This guide explains how to run the demo from the
demo portal, how each manual workflow works, how data sources are labelled, and what is not implemented.
The dependency audit behind it is [`hardware-independence.md`](hardware-independence.md).

## 1. Start locally

```bash
npm install
npm run build        # first time: shared packages and apps
npm run dev          # API :4000 and the six apps :5173–:5178; prints READY when all answer
```

Open **http://localhost:5178** — the demo portal is the starting point. (Use `localhost`, not `127.0.0.1`:
the Vite dev servers listen on IPv6 `::1`.) `npm run start:prod` serves production builds on :4173–:4178
instead. Windows: `start-jiva.bat` does the same checks and starts everything.

| App | Dev | Who uses it |
|---|---|---|
| Demo portal | :5178 | The presenter (OLED dark theme; never an operational screen) |
| Management | :5173 | Network coordination |
| Ambulance | :5174 | Crews |
| Hospital | :5175 | Emergency department coordinators |
| Patient | :5176 | Patients |
| Doctor workspace | :5177 | Assigned clinicians |

## 2. The demo portal

**Home** (`/` or `?view=home`) says what JIVA is, lists what is real and what is simulated in this run (read
from `GET /api/health` where possible), shows live counts from the API, and offers:

- **Start a guided demo** → the scenarios.
- **Open a role interface** → one card per role (Patient, Doctor, Hospital, Ambulance, Management). Each card
  says what the role can do and what it can and cannot see, lets you choose a **demo persona**, and opens the
  interface as that persona (same tab, or a new tab with the square button).
- **Reset the demo data** (see §4).

Other views: **Scenarios**, **Controls** (drive the demo case by hand), **Timeline** (what the server recorded),
**Asset library** (synthetic sample documents), **System** (mode, hardware, integrations, connections, links to
every app as every persona). Each view has its own URL (`?view=…`), a breadcrumb back to Home, and works with
the browser's Back button. Every operational app shows a **‹ Demo portal** link in its header — only when the
API is in demo mode.

**Demo personas are demo-only identities.** The API accepts `x-jiva-demo-user` only in demo mode and only from
this machine, and applies the persona's normal role and scope to every call. The portal has no special access:
each scenario step is a real API call as the persona printed next to it. If the API runs in operational mode
(`JIVA_ENVIRONMENT=production`), the portal shows "The demo portal is disabled" and runs nothing.

## 3. Guided scenarios

Ten scenarios: successful acceptance; rejection then rerouting; busy then rerouting; several rejections before
an acceptance; answer expiry (20 s); ambulance arrival and handover; doctor assignment and review; synthetic
scan attached; clinician-authorised demonstration prescription; realtime outage and recovery. Selecting one
shows a briefing — **What it shows, Roles involved, What you do, Expected outcome, Data used** — above the
steps. Run one step at a time (watch the role screens from the *Watch it* links) or all remaining steps. Each
step reads the authoritative state back and shows the server's answer; a failed step is marked and explained.

## 4. Reset

Reset clears every demo case, encounter, vital sign, prescription, note, report and document and re-seeds the
synthetic network, for everyone using the demo. It always asks first:

- Portal Home → **Reset demo data…** → dialog "Reset all demo data?" → **Reset demo data** (or **Keep the
  data**, which changes nothing; the dialog opens focused on it).
- A scenario whose first step resets the demo asks for confirmation before running it.
- `npm run demo:reset` from a terminal. Restarting the API also clears everything (state is in memory).

Only the demo administrator may reset (`POST /api/demo/reset`), and only in demo mode.

## 5. Manual workflows

| Workflow | Where | What happens |
|---|---|---|
| Report an emergency | Ambulance → report form | Location, severity, symptoms, suspected cause, optional vital signs typed by the crew (`MANUAL_CREW`) |
| Patient observations en route | Ambulance → Patient observations | More typed readings and notes until the handover |
| Set the unit's position | Ambulance → **Your position**: "I'm at the scene", "I'm at ‹hospital›", "Set on the map" | Sends a `MANUAL` position. At the destination JIVA marks the unit arrived; the hospital still records the arrival |
| Answer a referral | Hospital → Incoming requests: Accept / Accept with limits / Decline | Bound to that case's referral; JIVA routes only to a hospital that accepted |
| Report service status | Hospital → Facility panel, per service (ED, ICU, trauma, ventilators): Available / Limited / Unavailable / Unknown; or "Report ED unavailable/available" | `hospital.capacity.updated`; other services keep their values |
| Record arrival and handover | Hospital → Patients on the way / In your department | Arrival opens the encounter; the handover (with optional **notes**, ≤ 1000 characters) puts the patient in the hospital's care and releases the crew |
| Assign the responsible doctor | Hospital → In your department | Active roster clinicians only; reassignment removes the previous doctor's access |
| Enter vital signs | Doctor → Vital signs → **Record vital signs** | Heart rate, SpO₂, blood pressure, temperature, breathing rate, blood glucose (mg/dL); units shown; time defaults to now; plausibility bounds reject typing errors only (they are not clinical thresholds) |
| Correct or withdraw a value | Doctor → Vital signs → Observation history → **Correct** | Replace it (a reason is required) or **Withdraw as entered in error**; the original stays in the history with who, when and why. The patient sees only current values |
| Notes, reports, prescriptions, documents | Doctor workspace tabs | Versioned; prescriptions are drafts until explicitly authorised; switching patient with unsaved edits asks first |

Handover notes are visible to the hospital team and the assigned doctor only — never to the patient or network
coordination, and never on an event.

## 6. Data source labels

| Shown as | Means |
|---|---|
| Entered manually · care team | Typed by the assigned clinician |
| Entered manually · ambulance crew | Typed by the crew |
| Simulated (demo) | Generated by the demo simulated monitor (demo mode only; never editable) |
| Set by the crew | Position set in the ambulance app |
| Simulated position | Position from a scenario, the simulator scripts or the management demo controls |
| Position, source not stated | A position sent without a source — never presented as GPS |
| Automatic summary · template, no AI | Handoff briefs and summaries from the template generator (no AI service is connected) |
| Synthetic route · mock provider · no live traffic | Route and ETA from the mock routing provider |
| Demo data / Synthetic demo patient | Everything in a demo-mode API |

The patient's arrival estimate states its basis, e.g. "From the ambulance's last reported position (Set by the
crew · 2 min ago) · synthetic demo routing, without live traffic".

## 7. Manual vs simulated

| Path | Manual (a person types it) | Simulated (labelled) |
|---|---|---|
| Vital signs | Doctor form, crew intake and observations | "Simulated monitor (demo)" buttons (doctor, crew), demo mode only |
| Positions | Crew "Your position" card | Portal scenario steps "(simulated position)", `scripts/simulate-*`, management "Advance ambulance (simulated)" |
| Hospital answers | Hospital console | Portal scenarios and Controls, management demo controls (each acts as the real persona) |
| Scans and lab reports | Upload in the doctor workspace | Synthetic samples from the asset library (labelled on the image and in every list) |

## 8. Hardware and integrations: status

| Integration | Status |
|---|---|
| Medical devices (ECG, bedside monitors, ESP32 sensors) | **Not integrated.** `MEDICAL_DEVICE` exists in the contract, but no route accepts it and the device registry refuses every batch |
| Ambulance GPS | **Not integrated.** A `DEVICE_GPS` position source exists in the contract; nothing sends it |
| Hospital capacity feeds, staff directory, EHR | Not integrated (`/api/health` → `provenance.liveIntegrations`, all `false`) |
| AI service | Not configured: summaries are template text (`USE_BEDROCK=true` would switch to Amazon Bedrock) |
| Live routing / traffic | Valhalla → OSRM → mock; without self-hosted servers every route is synthetic |
| Persistence | In memory; an API restart loses demo state |
| AWS | CDK stack synthesised, **not deployed** |

## 9. Limitations

- Synthetic data only; no clinical validation. Manual and simulated vital signs are not clinically verified,
  and JIVA makes no diagnostic interpretation, alert or treatment recommendation from them.
- Demo personas are not authentication. Operational mode requires Cognito JWTs and has no demo features.
- Positions are only as current as the crew's last manual update; the ETA is computed from that position.
- The clinical workflows exist only in the local API, not in the AWS stack.

## 10. Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `4000` | API port |
| `JIVA_ENVIRONMENT` | (unset) | `production` → operational mode: no demo personas, no synthetic data, no portal, no simulators |
| `JIVA_DEMO_ALLOW_REMOTE` | `false` | `true` lets other machines on the network use demo personas (anyone can act as anyone) |
| `MAPPING_PROVIDER` | `auto` | `auto` (Valhalla → OSRM → mock), `valhalla`, `osrm` or `mock` |
| `USE_BEDROCK` | `false` | `true` uses Amazon Bedrock for summaries (needs AWS credentials; not set up) |
| `CORS_ORIGINS` | the local app ports | Allowed browser origins (comma-separated) |
| `JIVA_DOCUMENT_DIR` | `data/local/documents/<port>` (git-ignored) | Where uploaded and sample documents are stored |
| `ACCEPTANCE_EXPIRY_CHECK_MS` | `2000` | How often lapsed hospital answers are checked |
| `VITE_API_URL` (apps) | `http://localhost:4000` | API the apps and the portal talk to |

## 11. Tests

| Command | Covers |
|---|---|
| `npm run typecheck` | Builds every workspace and typechecks the tests |
| `npm run test:unit` | Unit suites, incl. vitals entry and correction, location source, handover notes, AI generator, app links, runtime mode |
| `npm run test:integration` | Real API processes: clinical journey, operational mode, end-to-end, doctor workspace, portal scenarios, **manual operation** |
| `npm run test:browser` | Installed Edge/Chrome: multi-patient, all ten portal scenarios, **portal + manual workflows** (`test:browser:portal`) |
| `npm run lint --workspace=apps/<app>` | oxlint per app |
| `npm run demo:check` | Demo readiness report |
| `npm run simulate:full:blr` | Self-verifying flagship scenario |

The browser suites use their own ports (API :4107/:4108/:4110, apps :5183–:5188, :5193–:5197, :5203–:5208)
and need Microsoft Edge or Google Chrome installed (`JIVA_BROWSER=chrome` to choose).

## 12. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `npm run dev` refuses to start | A port from an earlier run is still in use: close that window/process and start again |
| An app does not load at `127.0.0.1` | Use `http://localhost:…` (Vite listens on `::1`) |
| `403 demo_local_only` | Demo personas only work from this machine; see `JIVA_DEMO_ALLOW_REMOTE` |
| Portal says "disabled" | The API runs in operational mode (`JIVA_ENVIRONMENT=production`) |
| Portal says "Cannot reach the JIVA API" | Start it (`npm run dev` or `npm run dev:api`); the portal retries by itself |
| Everything vanished | The API restarted (in-memory state). Re-run a scenario |
| A patient card says "Appears once…" | The patient persona's case does not exist yet: run a scenario or report it from the ambulance app |
| Map shows no tiles | Tiles come from tile.openstreetmap.org and need internet access |
| Browser tests fail to launch | Install Edge or Chrome, or set `JIVA_BROWSER` |
