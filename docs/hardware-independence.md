# JIVA without hardware — dependency audit and manual paths

JIVA is a software prototype. **No ESP32, ECG sensor, bedside monitor, ambulance GPS unit or hospital bed
feed is connected.** Every demonstration action must therefore be possible through an authorised person's
explicit input, or through a simulation that is labelled as such everywhere it appears.

This document records what the code actually does (verified in the source, not taken from older docs), and
which manual or simulated path covers each dependency.

## 1. Verified dependencies (audit at the start of this work)

| Area | What the code does today | Manual / simulated path | Gap found |
|---|---|---|---|
| In-hospital vital signs | `POST /api/encounters/:id/vitals` (assigned clinician) stores heart rate, SpO₂, blood pressure, temperature, breathing rate with source `MANUAL_CLINICIAN`; `…/vitals/simulate` (DEMO only) adds one reading labelled `DEVICE_SIMULATED`; source `MEDICAL_DEVICE` exists in the contract but the device registry refuses every batch (`NO_DEVICE_REGISTRY`). | Manual entry form in the doctor workspace; labelled simulated monitor in demo mode. | No blood glucose. An entered value cannot be corrected (append-only, no "entered in error"). |
| Pre-hospital vital signs | Crew enters values at intake and en route (`MANUAL_CREW`); DEMO-only simulated ambulance monitor (labelled). | Ambulance intake form and "Patient observations" card. | No blood glucose. |
| ECG | No ECG signal is received anywhere. "ECG" exists only as a document type (an uploaded file) and a report category. | Upload a file; synthetic sample library (labelled "not this patient"). | None — but the UI must never imply a live ECG. |
| Ambulance location | Only `ambulance.location.updated` events change a unit's position (sent by `scripts/simulate-*`, the management demo controls and the demo portal). The payload has no source, and screens call every position "GPS". The crew app cannot update the position. | Simulated updates from demo tools. | No crew-controlled position; positions are labelled GPS although no GPS exists. |
| Arrival | A position within 150 m of the destination marks the unit `ARRIVED` (derived, "geofence"); the hospital records the authoritative arrival (`POST /api/hospitals/:id/arrivals`). | Hospital "Record arrival" (manual). | The crew cannot report its own arrival without a position event. |
| Hospital acceptance | Coordinator answers each referral: accept, accept with limits, decline, "cannot take any patient" (`hospital.acceptance.received`, referral-bound). | Hospital console (manual); demo controls and portal (labelled demo). | None. |
| Bed / service capacity | "Report ED unavailable / available" sets emergency, trauma and ICU together (`hospital.capacity.updated`). | Hospital console (manual). | ICU, trauma and ventilator status cannot be reported individually. |
| Doctor assignment | Coordinator assigns / reassigns an active roster clinician (`POST /api/encounters/:id/doctor`). | Hospital console (manual). | None. |
| Handover | Coordinator records the handover (`POST /api/encounters/:id/handover`), which releases the crew. | Hospital console (manual). | No handover notes. |
| Reports, notes, prescriptions, documents | All entered by the assigned clinician; versioned. | Doctor workspace (manual). | None. |
| AI summaries and briefs | Default provider is `MockAIProvider`: a deterministic template that restates input facts (`USE_BEDROCK=true` would use Bedrock; not configured). Screens label the output "AI-generated". | Template fallback. | The label claims AI although no AI service is connected. |
| Emergency creation / dispatch | Crew intake (`POST /api/emergencies`); dispatch through the event API (management demo controls). | Ambulance intake form; demo controls (labelled). | None. |
| Routing / ETA | Valhalla → OSRM → mock chain; without the servers, the mock provider draws a straight-line synthetic route, labelled "synthetic route · no live traffic". | Mock provider (labelled). | ETA is computed from the unit's last position (see location). |
| Demo events | Demo portal scenarios and controls call the real API as each persona; management demo controls likewise. | Demo portal. | None. |

## 2. Principles applied

- A value is labelled by where it came from: **entered manually** (clinician or crew), **simulated (demo)**,
  or — only if a real integration existed — imported from a device. No screen may call a value "from the
  monitor", "GPS" or "live" unless it is.
- Missing data stays missing ("No measurement recorded"); nothing is defaulted.
- Manual controls go through the same API, validation and authorization as automated events.
- No clinical thresholds, alerts or interpretations are invented. Plausibility bounds reject entry errors
  only and are documented as such.
