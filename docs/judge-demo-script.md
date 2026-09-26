# JIVA — Judge Demo Script (5–7 minutes, verified against the running system)

Setup: `npm run start:prod` (or `npm run dev`), then open the four screens (see `docs/demo-runbook.md`). Press **Reset demo** first.

### 1. Command center (0:00–0:40) — `localhost:5173`
"JIVA coordinates ambulances, hospitals and patients through one event stream. The health bar is honest: local bus, local store, and mapping shows **MOCK (SYNTHETIC)** because no road-routing server is running here. The four hospitals on this map are **synthetic demo facilities**, clearly labelled. Our real-facility dataset is separate and its operational state is UNKNOWN, because no public source knows live bed status."

### 2. Emergency (0:40–1:20)
Click **Report emergency + dispatch**. Point at the decision trace: assessment → required EMERGENCY/TRAUMA/ICU → candidates. Koramangala is INELIGIBLE (missing trauma/ICU), so it is never asked. The others receive acceptance requests.
"Mapping only orders eligible hospitals by ETA; it never decides eligibility."

### 3. Hospital responds (1:20–2:10) — hospital console `localhost:5175`
Show the incoming request and click **Accept**. Everything updates without a refresh: the ambulance gets a destination and route, and the patient sees "confirmed it can receive you".
"A hospital can only answer a request it actually received, and only for itself. The server enforces that."

### 4. More responses coexist (2:10–2:40)
Management: **Indiranagar (004) accepts**, **Whitefield (002) limited**. The destination does not flip, but all responses are recorded.

### 5. Telemetry (2:40–3:10)
**Advance ambulance (GPS)** twice. The marker moves; no new route is computed for GPS.

### 6. Hospital overload → reroute (3:10–4:10)
Click **Hebbal (001) ED unavailable** (or "Report ED unavailable" in Hebbal's console). Watch:
- the ambulance banner turns to REROUTED Hebbal → Indiranagar with a new route and ETA;
- the patient sees the destination change notice;
- the command center shows `destination.changed` and `route.recalculated` with the reason.

### 7. AI sidecar (4:10–4:50)
An anomaly explanation and a handoff appear for the new destination.
"AI is advisory. Locally these are mock templates; with Bedrock enabled they'd be generated. The AI cannot change state: the API rejects any submitted AI or system event, and injected instructions in patient text had no effect in our tests."

### 8. Arrival & honesty close (4:50–5:30)
Advance to arrival. Close with what's real vs simulated: event engine, RBAC, ordering and reroute logic are real and tested. Hospitals, responses, GPS, routes and AI text are simulated. AWS is synthesized, not deployed.
