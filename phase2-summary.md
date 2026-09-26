# Phase 2 Complete: Real-Time Hospital Acceptance Protocol

Phase 2 implementation has been built according to the strict architectural guidelines.

## 1. Domain Models & Strict Types
- Created `CareRequirement`, `HospitalAvailabilityRequest`, `HospitalAvailabilityResponse`, and `HospitalCandidate` within `@jiva/domain-models`.
- Upgraded `OperationalState`'s `acceptance` property to enforce exact active states (`ACCEPTED | LIMITED | REJECTED | UNAVAILABLE | EXPIRED | UNKNOWN | PENDING`).

## 2. Deterministic Eligibility Engine
- Migrated naive routing into a robust `eligibilityEngine.ts` that enforces:
  1. Facility must possess static required capabilities (assessed against historical capability flags).
  2. The facility must explicitly authorize the reception (`ACCEPTED` or `LIMITED`) for the *current request*.
  3. Acceptance logic naturally prevents `UNKNOWN` facilities from being routed without a positive active response.

## 3. Real-Time Event State Engines
- Added handlers in `services/api/src/stateEngines.ts`:
  - `care.requirement.created`: Scans all Bengaluru hospitals, extracts capabilities, invokes Maps routes for ETAs, and generates `HospitalCandidate`s.
  - `hospital.acceptance.requested`: Dispatches targeted availability checks to capable candidates.
  - `hospital.acceptance.received`: Dynamically mutates `operationalState.acceptance`, triggering `destination.changed` and `route.recalculated` *only* if the ambulance currently lacks a valid target (ensuring idempotent routing on simultaneous accepts).
- **Expiration Engine**: Integrated a loop in `stateEngines.ts` checking `validUntil`. Expirations revert operational state to `UNKNOWN` and strip destinations off stranded ambulances to trigger reallocation.

## 4. Hospital Clinician Dashboard
- Constructed `apps/hospital-web/src/App.tsx`.
- Connects via Socket.io to the event mesh, providing an operational view of active Emergency Requests.
- Features `ACCEPT`, `LIMITED`, and `REJECT` actionable flows that dispatch payload events downstream.
- Interface unmistakably marked as "SYNTHETIC DEMO / SIMULATED HOSPITAL RESPONSE".

## 5. Management Decision Tracing
- Enhanced `apps/management-web/src/App.tsx`.
- The Event Stream panel has been upgraded to a "Decision Trace". It visualizes `hospital.candidate.generated` inside the event history log with expanded case IDs, capability matching arrays, Maps ETAs, and explicit string reasons for eligibility or ineligibility.

## 6. Deterministic Simulator
- Shipped `npm run simulate:hospital-response:blr` running from `scripts/simulate-hospital-response.ts`.
- Automates the full flow:
  - Scaffolds mock patients and ambulances.
  - Emits Phase 1's `patient.emergency.created`.
  - Simulates Hospital C rejecting, Hospital B accepting with limits, and Hospital A fully accepting.
  - Showcases the engine dynamically re-assigning routes based on response arrival ordering and subsequential unavailability (Hosp A going dark).

The implementation strictly honors Phase 1 (no replaced event buses or mappings) and meets the exact idempotency and expiration constraints.
