# JIVA Phase 6.1 Handoff — Core Authority & Production Safety Audit

**Author**: Antigravity / JIVA Engineering  
**Subphase**: 6.1 — Core Authority Audit  
**Date**: September 28, 2026  
**Audience**: Senior AI/Software Engineer (Claude) taking over for Phase 6.2  

---

## 1. Executive Summary

JIVA is an event-driven healthcare coordination platform orchestrating patient emergencies, ambulance dispatch, clinical eligibility assessment, hospital acceptance protocols, and dynamic routing across Bengaluru.

Subphase 6.1 conducted a comprehensive, ground-truth audit of the repository code, test suites, runtime behaviour, and AWS infrastructure specifications. The primary question investigated was:

> *Can JIVA's Care Feasibility Engine safely move from SHADOW evaluation to an AUTHORITATIVE decision role in production?*

**Overall Audit Verdict: NOT READY FOR AUTHORITATIVE PROMOTION.**

While the mathematical core of the feasibility engine is exceptionally sound (deterministic, fail-closed, lexicographically ordered, and bounded by contained shadow execution), authoritative promotion is blocked by three **P0 blockers**:
1. **Missing Acceptance Cancellation Producer**: The event schema and ledger consumers for `hospital.acceptance.cancelled` exist, but no workflow in the application currently emits cancellation when a case is resolved or superseded, leaving competing hospital holds open.
2. **Missing Authoritative Mode Switch & Safe Transition Gate**: The system hardcodes `legacyAuthoritative: true` and `shadow` mode; no dual-run canary or graceful fallback abstraction exists to govern live authority handoff.
3. **500-Event History Sliding Window Risk**: Historical sliding-window queries can drop earlier hospital-wide `UNAVAILABLE` declarations under high telemetry load if not partitioned into dedicated state indexes.

Additionally, three **P1 issues** (production identity verification in standalone servers, automated hospital onboarding, and temporal care window definition) must be addressed before or during promotion.

---

## 2. Repository State

- **Active Branch**: `jiva-intelligence-expansion`
- **Base Tag / Frozen Baseline**: `jiva-demo-ready-2026-09-26` (Commit `0915c3b`)
- **Head Commit**: `da70a46 Created feasibility engine`
- **Working Tree State**:
  - `infrastructure/aws/lib/aws-stack.ts`: Cognito UserPoolClient writeAttributes restricted to email only (preventing client self-service mutation of `custom:hospitalId`).
  - `package.json`: Registered comprehensive unit test suites for feasibility policy, cancellation fallback, and identity trust.
  - `packages/feasibility/src/rules.ts`: Pinned Policy 1 (Option B) for static capability evidence (PUBLIC_LISTED/HOSPITAL_CONFIRMED/AUTHORIZED_FEED can PASS; HISTORICAL/UNVERIFIED resolve to UNKNOWN unless confirmed by response).
  - `services/api/src/eligibilityEngine.ts`: Hardened case-scoped acceptance read failure fallback to fail-safe UNKNOWN instead of reading shared hospital slot.
  - `services/api/src/feasibility/acceptanceLedger.ts`: Hardened `caseAcceptanceStatus` so cancelled requests cannot leave an ACCEPTED response usable.
  - `services/api/src/index.ts`: Hardened Express entrypoint to reject unsigned demo persona headers when configured as `PRODUCTION`.
  - Focused unit tests: `tests/unit/feasibility-capability-evidence-policy.test.ts`, `tests/unit/feasibility-cancellation-fallback.test.ts`, `tests/unit/feasibility-identity-trust-policy.test.ts`.

---

## 3. Architecture Observed

JIVA operates strictly on the following unidirectional event-mesh topology:

```
[ Participants: Patients / Ambulances / Hospital Operators / Dispatch ]
                                ↓
        [ Server Ingestion Boundary (REST / WebSocket) ]
        - Schema Validation (Zod)
        - RBAC Enforcement (Role & Identity Binding)
        - Trusted Evidence Derivation (strip client metadata, stamp server-derived status)
                                ↓
             [ Event Bus (Local EventEmitter / AWS EventBridge) ]
                                ↓
        [ Domain State Engines (Local / AWS Lambda Processors) ]
        - Patient Assessment: patient.emergency.created -> care.requirement.created
        - Candidate Generation: care.requirement.created -> evaluateHospitals -> hospital.candidate.generated
        - Request Dispatch: selectRequestTargets -> hospital.acceptance.requested
        - Response Processing: hospital.acceptance.received -> applyAcceptanceResponse
        - Destination Selection: ensureDestination / rerouteAmbulance -> pickLegacyDestination
        - Routing & Reroute: mappingProvider.calculateRoute -> destination.changed & route.recalculated
                                ↓
   [ Auxiliary Shadow Feasibility Engine (Contained, Non-Authoritative) ]
   - Snapshot Assembly (Candidates, Requirement, Operational State, Ledger)
   - Pure Constraint Evaluation (9 Hard Constraints, 4 Contextual Factors)
   - Decision Trace Generation (feasiiblity.trace.recorded, SHA-256 Hashes)
   - Soak & Disagreement Counters (Shadow soak tracking)
                                ↓
   [ Shared State Store (LocalStateStore / DynamoStateStore) ]
                                ↓
   [ Realtime Broadcast (Socket.IO / API Gateway WebSocket) ]
   - Scoped Delivery per Persona (Patient, Hospital, Ambulance, Management, Admin)
```

**Core Safety Invariants Enforced**:
1. **AI is strictly advisory**: AI models (`@jiva/intelligence`) only produce `ai.*` events. They never modify clinical eligibility, dispatch ambulances, or select destinations.
2. **Mapping is non-clinical**: Mapping providers (`@jiva/mapping`) compute routes, distances, and ETAs. They never filter clinical capabilities or alter eligibility verdicts.
3. **Public/Historical is never live capacity**: Public directories (`PUBLIC_LISTED`) and historical bed audits (`HISTORICAL`) can never satisfy live operational availability rules (`HC-OPS-01`, `HC-OPS-02`).
4. **UNKNOWN fails closed**: Unconfirmed operational status evaluates to `UNKNOWN` with 0.0 confidence and can never silently promote to `PASS`.

---

## 4. Decision Authority Map

The table below documents every location in the codebase currently capable of affecting candidate selection, acceptance requests, destination choice, or rerouting:

| Decision Point | Triggering Event | Function & File | Inputs | Outputs | Current Authority Level | Side Effects | Failure Behavior |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Care Requirement Assessment** | `patient.emergency.created` | `assessRequiredCapabilities` in `stateTransitions.ts` / `stateEngines.ts:261` / `emergencyCore.ts:41` | Condition string, Severity string | `CapabilityType[]` | **LEGACY AUTHORITATIVE** | Sets patient care requirements; emits `care.requirement.created` | Defaults to `['EMERGENCY']` if unrecognized condition |
| **Candidate Generation** | `care.requirement.created` | `evaluateHospitals` in `eligibilityEngine.ts:29` | `CareRequirement`, `ambulanceLocation`, `deps` (hospitals, mapping, acceptanceOverride) | `HospitalCandidate[]` sorted by eligibility, acceptance, ETA | **LEGACY AUTHORITATIVE** | Emits `hospital.candidate.generated`; kicks off async shadow evaluation | Route failure defaults distance to 0, logs error; candidate remains in list |
| **Acceptance Request Dispatch** | `care.requirement.created` | `selectRequestTargets` in `stateTransitions.ts:49` | `HospitalCandidate[]` | Filtered candidates (`missingCapabilities.length === 0 && operationalEligibility !== 'INELIGIBLE'`) | **LEGACY AUTHORITATIVE** | Records request in `acceptanceLedger`; emits `hospital.acceptance.requested` for each target | Incapable or INELIGIBLE hospitals are never asked |
| **Acceptance Response Processing** | `hospital.acceptance.received` | `applyAcceptanceResponse` in `stateTransitions.ts:110` / `stateEngines.ts:417` / `hospitalCore.ts:63` | `existing: HospitalState`, `payload`, `envelope`, `nowMs` | `AcceptanceApplyResult` (`APPLIED` or `IGNORED`) | **LEGACY AUTHORITATIVE** | Updates hospital state; writes per-case ledger; checks for ambulance destination assignment or rerouting | Stale response (older than `acceptanceAsOf`) or expired response is safely dropped |
| **Initial Destination Selection** | `hospital.acceptance.received` or `ambulance.dispatched` | `selectDestination` in `stateEngines.ts:123` / `routingCore.ts:16` -> `pickLegacyDestination` in `stateTransitions.ts:241` | `AmbulanceState`, `exclude: Set<string>`, `caseId` | `hospitalId` string or `undefined` | **LEGACY AUTHORITATIVE** | If found, calls `commitDestination`; triggers shadow evaluation in `observe()` | If no accepting hospital, ambulance remains unassigned awaiting responses |
| **Commit Destination & Routing** | Called by `selectDestination` | `commitDestination` in `stateEngines.ts:154` / `routingCore.ts:61` | `ambulanceId`, `hospitalId`, `reason` | None (commits to store) | **LEGACY AUTHORITATIVE** | Computes route via `mappingProvider`; updates ambulance status `EN_ROUTE_TO_HOSPITAL`; emits `destination.changed` & `route.recalculated` | If reset occurred during route computation (epoch mismatch), silently aborts |
| **Rerouting on Rejection / Expiry / Loss** | `hospital.acceptance.received` (REJECTED/UNAVAILABLE), `hospital.capacity.updated`, or `checkAcceptanceExpiry` | `rerouteAmbulance` in `stateEngines.ts:230` / `routingCore.ts:126` | `ambulanceId`, `invalidHospitalId`, `reason` | None | **LEGACY AUTHORITATIVE** | Re-runs `selectDestination` with `invalidHospitalId` excluded; if none found, sets `destinationHospital: UNASSIGNED` and emits `destination.changed` | Serialized per-ambulance via `withAmbulanceLock` |
| **Shadow Feasibility Evaluation** | Auxiliary hook in candidate generation, destination selection, and capacity updates | `feasibilityShadow.evaluate` in `services/api/src/feasibility/shadow.ts:166` | `ShadowEvaluationRequest` (snapshot inputs, legacy candidates, legacy selection) | `ShadowEvaluationResult` (trace, verdict, agreement) | **SHADOW ONLY (ZERO DECISION AUTHORITY)** | Emits `feasibility.trace.recorded` (privileged-only); records soak metrics and disagreements | Wrapped in `observe()`: any error or timeout is caught and dropped; never affects legacy flow |

---

## 5. Feasibility Engine

Located in `packages/feasibility/src/`:
- **Engine Version**: `care-feasibility-1.0.0`
- **Entry Point**: `evaluateFeasibility(snapshot, policyOverrides)` in `engine.ts`
- **Determinism**: Pure function; no wall-clock reads, no network I/O, no async promises.

### Constraint Evaluation Matrix

| Rule ID | Name | Category | Required Evidence | Freshness Rule | PASS Condition | FAIL Condition | UNKNOWN Condition | NOT_APPLICABLE Condition |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **`HC-CLIN-01`** | `required_capability_listed` | CLINICAL_CAPABILITY | `h.capabilities` (`EvidenceRecord<Capabilities>`) | Horizon: `LISTED_CAPABILITY` (e.g. 90 days); stale listing flagged but still usable | All required capabilities present in listing with grade `PUBLIC_LISTED`, `HOSPITAL_CONFIRMED`, `AUTHORIZED_FEED`, or confirmed by current case response | Any required capability explicitly `false` in listing | Capability missing from listing, unverified grade, or `NOT_DISCLOSED` | Never (always evaluated) |
| **`HC-OPS-01`** | `ed_not_unavailable` | OPERATIONAL_AVAILABILITY | `h.operational.statuses.emergency` | Horizon: `OPERATIONAL_CAPACITY` (e.g. 30 min); expired -> UNKNOWN | Emergency status is `AVAILABLE` or `LIMITED` with operational-grade evidence | Emergency status is `UNAVAILABLE` | Reported `UNKNOWN`, untimed, stale, or evidence not operational-grade | Never (always evaluated) |
| **`HC-OPS-02`** | `required_unit_not_unavailable` | OPERATIONAL_AVAILABILITY | `h.operational.statuses[unit]` for required units (ICU, Trauma, etc.) | Horizon: `OPERATIONAL_CAPACITY` (30 min) | All applicable live unit statuses are `AVAILABLE` or `LIMITED` | Any applicable required unit status is `UNAVAILABLE` | Any applicable unit status is `UNKNOWN`, stale, or unverified | Case requires no unit with live status mapping |
| **`HC-ACC-01`** | `not_rejected_for_case` | OPERATIONAL_AVAILABILITY | `h.acceptance.response` for this case | Rejection stands until superseded by newer response | No rejection recorded for this case | Latest case response is `REJECTED` | Never (binary fact) | Never |
| **`HC-ACC-02`** | `not_hospital_wide_unavailable` | OPERATIONAL_AVAILABILITY | Latest `UNAVAILABLE` response from hospital | Freshness window: `[respondedAt, validUntil]` | No active `UNAVAILABLE` response on record | Active `UNAVAILABLE` response within validity window | `UNAVAILABLE` response expired (loses assertion -> UNKNOWN) | Never |
| **`HC-ACC-03`** | `limited_covers_required` | CLINICAL_CAPABILITY | `h.acceptance.response` with status `LIMITED` | Validity window of response | `acceptedCapabilities` covers all required capabilities and response is usable | `acceptedCapabilities` lacks any required capability | Response expired or fails usability check | Latest response is not `LIMITED` |
| **`HC-ACC-04`** | `current_acceptance` | OPERATIONAL_AVAILABILITY | Case acceptance request & response matching correlation rules | Request window `[requestedAt - 60s, expiresAt]` & response `[respondedAt, validUntil]` | Valid, correlated, operational-grade `ACCEPTED` or `LIMITED` response within validity window | Never produces FAIL directly (defers to HC-ACC-01 for REJECTED) | No response yet, request outstanding, response expired, or response uncorrelated | Never |
| **`HC-GEO-01`** | `locatable` | TRANSIT_TIME | `h.location` (`EvidenceRecord<LocationData>`) | Facility location horizon (365 days) | Valid finite latitude & longitude (not `0,0`) | Never | Coordinates missing, NaN, or `0,0` | Never |
| **`HC-TMP-01`** | `within_care_window` | TRANSIT_TIME | Clinical care window specification | Time window vs ETA | ETA $\le$ care window | ETA $>$ care window | Window unobserved | **NOT_APPLICABLE** (No clinician care window defined in JIVA yet) |

### Verdict Aggregation (`aggregateVerdict`)
1. **`INELIGIBLE`**: If ANY hard constraint evaluates to `FAIL`.
2. **`INDETERMINATE`**: If ANY hard constraint evaluates to `UNKNOWN` that is **not resolvable by hospital acceptance** (e.g. facility unlocatable or unrecognized capability).
3. **`PENDING_ACCEPTANCE`**: If all non-acceptance constraints `PASS`, but `HC-ACC-04` is not `PASS` (awaiting request or response).
4. **`ELIGIBLE`**: ONLY if ALL applicable hard constraints evaluate to `PASS`.

### Ordering Philosophy (`compareOrderKeys`)
Strict lexicographic ordering without numeric weighting:
1. `verdictRank`: `ELIGIBLE (0)` > `PENDING_ACCEPTANCE (1)` > `INDETERMINATE (2)` > `INELIGIBLE (3)`
2. `acceptanceKindRank`: `ACCEPTED (0)` > `LIMITED (1)` > `NONE (2)`
3. `etaKnown`: Known ETA sorts ahead of unknown ETA (unknown ETA never treated as 0).
4. `etaSeconds`: Ascending duration in seconds.
5. `distanceMeters`: Ascending distance in meters.
6. `hospitalId`: Deterministic alphabetical tie-breaking.

---

## 6. Evidence Policy Findings

### Static Capability vs Live Operational Availability
- **Capability Evidence (`ruleRequiredCapability`)**:
  - `PUBLIC_LISTED`, `HOSPITAL_CONFIRMED`, `AUTHORIZED_FEED` can produce a positive `PASS` for capability existence (reason: `CAPABILITY_LISTED`).
  - `HISTORICAL` and `UNVERIFIED`: An explicit `false` produces `FAIL`. A positive listing resolves to `UNKNOWN` (reason: `EVIDENCE_NOT_OPERATIONAL_GRADE`) unless independently confirmed by a case acceptance response (`CAPABILITY_CONFIRMED_BY_RESPONSE`).
  - `UNKNOWN` and `NOT_DISCLOSED`: Produce `UNKNOWN`.
  - `SYNTHETIC_DEMO`: Permitted in `DEMO` environment, rejected in `PRODUCTION`.
- **Operational Availability (`isOperationalGrade`)**:
  - Strictly requires `HOSPITAL_CONFIRMED`, `AUTHORIZED_FEED`, or active `CURRENT`.
  - `PUBLIC_LISTED` and `HISTORICAL` are **never** operational grade. Any attempt to use them for live state evaluates to `UNKNOWN`.

### Freshness Horizons (`assessFreshness`)
- Evaluated against `snapshot.evaluatedAt` using policy horizons:
  - `OPERATIONAL_CAPACITY`: 30 minutes default. Stale evidence drops assertions in both directions (never inferred available).
  - `ACCEPTANCE_RESPONSE`: Bound by `validUntil` stamped by responder.
  - `LISTED_CAPABILITY`: 90 days review horizon. Stale listing is flagged in audit trace but stands as a static structural fact.

---

## 7. Identity & Trust Findings

1. **Authentication Providers**:
   - `DemoAuthProvider`: Hardcoded personas for local simulation and demo interfaces. Claims `isDemo: true`.
   - `CognitoAuthProvider`: Parses JWT claims from AWS API Gateway authorizer (`cognito:groups`, `custom:hospitalId`, `custom:ambulanceId`, `custom:caseId`). Claims `isDemo: false`.
2. **Server-Side Evidence Trust Boundary (`stampTrustedEvidence`)**:
   - Client-supplied metadata (`metadata.sourceType`, `payload.source`, `payload.responderRole`) are informational only.
   - Server strips `metadata.trustedEvidence` and stamps trusted provenance derived strictly from the authenticated principal:
     - `HOSPITAL` principal -> `HOSPITAL_CONFIRMED` (scoped to own `hospitalId`).
     - Demo persona in `DEMO` -> `SYNTHETIC_DEMO`.
     - Demo persona in `PRODUCTION` -> `UNVERIFIED`.
3. **Identity Binding Vulnerability & Remediation**:
   - In Cognito User Pool, `writeAttributes` was hardened in `infrastructure/aws/lib/aws-stack.ts` to exclude `custom:hospitalId`, preventing authenticated users from self-service mutating their assigned hospital ID.
   - In standalone Express server (`services/api/src/index.ts`), demo persona headers are rejected when `JIVA_ENVIRONMENT=production`.

---

## 8. Acceptance Protocol Findings

1. **Case-Scoped Isolation**:
   - Legacy system had a "one-slot bug" in `HospitalState.operationalState.acceptance`, where hospital X accepting Case B would overwrite Case A's acceptance.
   - Solved via `AcceptanceLedger` (in-memory per `(caseId, hospitalId)`) and DynamoDB GSI materialized index.
   - `evaluateHospitals` accepts `acceptanceOverride`, correctly isolating each case's acceptance state.
2. **Response Usability Verification (`responseUsability`)**:
   - Requires valid outstanding request for `(caseId, hospitalId)`.
   - Rejects superseded request IDs (`RESPONSE_REQUEST_SUPERSEDED`).
   - Rejects responses outside request validity window (`RESPONSE_OUTSIDE_REQUEST_WINDOW`).
   - Rejects unverified / untrusted evidence grades (`RESPONSE_EVIDENCE_NOT_TRUSTED`).
3. **Acceptance Cancellation Gap**:
   - Ledger handles cancellation via `applyCancellation`.
   - **Gap**: No component currently emits `hospital.acceptance.cancelled`. Outstanding requests remain open until expiry.

---

## 9. Determinism & Replay Findings

- **Replay Parity Verified**: `AcceptanceLedger.replayFromEvents(history)` reconstructs the identical state view as live streaming event accumulation (`feasibility-ledger-shadow.test.ts`).
- **Policy & Snapshot Hashing**: `hashPolicy` and `hashSnapshot` generate stable SHA-256 digests using canonicalized JSON formatting (sorted keys, stable floats). Any change to policy or candidate state alters the hash.
- **Out-of-Order Watermarking**: All state engines track ordering watermarks (`acceptanceAsOf`, `capacityAsOf`, `locationAsOf`, `lastUpdated`). Stale replays arriving after newer events are safely dropped.

---

## 10. Privacy & Trace Findings

- **Trace Model**: `DecisionTraceRecord` captures inputs, policy hash, constraint outcomes, reason codes, and order keys.
- **PHI / Medical Data Isolation**: Free-text clinical notes, conditions, and patient names are stripped or excluded from `feasibility.trace.recorded`.
- **RBAC Redaction**: Realtime delivery of `feasibility.trace.recorded` is restricted to `MANAGEMENT` and `ADMIN` groups. It is strictly blocked from `PATIENT`, `HOSPITAL`, and `AMBULANCE` sockets.

---

## 11. Local Runtime Findings

- Local development runs via `scripts/dev-all.mjs` orchestrating Express API on `:4000`, Socket.IO, and 4 Vite frontends (`management-web`, `ambulance-web`, `hospital-web`, `patient-web`).
- Maps run via MapLibre GL JS + OpenStreetMap tiles with Valhalla/OSRM routing and automatic fallback to `MockMappingProvider`.
- All local simulations (`npm run simulate:emergency:blr`, `simulate:hospital-response:blr`, `simulate:full:blr`) execute deterministically with zero unhandled rejections.

---

## 12. AWS Status

| Component | Status | Verification Evidence |
| :--- | :--- | :--- |
| **CDK Stack Definition** | **IMPLEMENTED** | `infrastructure/aws/lib/aws-stack.ts` defines DynamoDB, EventBridge, Cognito, API Gateway, S3, Lambdas, CloudWatch. |
| **CloudFormation Synthesis** | **SYNTHESIZED** | `npx cdk synth` outputs valid CloudFormation template without warnings. |
| **Lambda Packaging** | **PACKAGE-LOAD VERIFIED** | `scripts/bundle-lambdas.mjs` bundles 7 lambdas via esbuild into `lambda-dist`; all 7 load cleanly in Node.js runtime (`aws-lambda-parity.test.ts`). |
| **Cloud Infrastructure Deployment** | **NOT DEPLOYED** | No live AWS resources provisioned; deployment requires active AWS credentials. |
| **Live Cloud Verification** | **NOT LIVE-TESTED** | Live cloud execution deferred until authoritative feasibility promotion. |

---

## 13. Tests Executed

| Command | Suites / Checks | Result | Notes |
| :--- | :--- | :--- | :--- |
| `npm run typecheck` | 10 workspaces + `tests/tsconfig.json` | **PASS (0 errors)** | Complete TypeScript type safety |
| `npm run test:unit` | 20 unit test suites | **PASS (20/20 suites)** | Covers idempotency, ordering, RBAC, prompt injection, mapping, canonical data, and feasibility engine |
| `npm run test:integration` | 124 assertions against live server | **PASS (124/124)** | Covers full emergency lifecycle, acceptance protocol, Socket.IO RBAC, and deterministic replay |
| `npm run demo:check` | 13 static and runtime probes | **PASS (STATUS: READY)** | Verifies bundles, lambda loads, canonical/synthetic separation, API health |
| `npm run data:validate` | 7 canonical facilities | **PASS (0 errors)** | Invariant enforcement, coordinate bounds, digital twin materialization |
| `npm run build:lambdas` | 7 Lambda functions | **PASS (7 bundles)** | Bundled into `infrastructure/aws/lambda-dist` |
| `npx cdk synth` | Full AWS infrastructure | **PASS** | CloudFormation synthesis verified |

---

## 14. P0 Blockers (Must Fix Before Authoritative Promotion)

### P0-1: Acceptance Request Cancellation Producer Missing
- **Problem**: No workflow emits `hospital.acceptance.cancelled`. Outstanding requests remain open at non-selected hospitals.
- **Failure Scenario**: Hospital B accepts after Hospital A was selected and arrived. Hospital B holds beds for an ambulance that never arrives.
- **Affected Files**: `services/api/src/stateEngines.ts`, `services/api/src/lambdas/core/routingCore.ts`.
- **Required Remediation**: Emit `hospital.acceptance.cancelled` for all unselected candidate requests upon confirmed destination commitment or emergency arrival.
- **Required Test**: Integration test verifying unselected candidate requests transition to `REQUEST_CANCELLED` and cannot satisfy `HC-ACC-04`.
- **Rollback Consideration**: Producer gated by configuration flag `ENABLE_CANCELLATION_PRODUCER`.

### P0-2: Missing Authoritative Mode Configuration & Canary Gate
- **Problem**: `feasibilityMode()` hardcodes `'shadow'`. No mechanism exists to safely transition decision authority.
- **Failure Scenario**: Switching to authoritative mode without canary gating or automatic fallback causes system outage if feasibility evaluation throws.
- **Affected Files**: `services/api/src/feasibility/shadow.ts`, `services/api/src/stateEngines.ts`.
- **Required Remediation**: Implement `FEASIBILITY_ENGINE=authoritative` mode supporting dual-evaluation, shadow disagreement monitoring, and fallback to legacy decision logic on timeout or error.
- **Required Test**: Unit & integration tests verifying dual-run execution and automated fallback to legacy decisions when feasibility fails.
- **Rollback Consideration**: Immediate fallback to `FEASIBILITY_ENGINE=shadow`.

### P0-3: 500-Event Sliding Window Risk for Hospital-Wide UNAVAILABLE
- **Problem**: Chronological query limit of 500 events can miss earlier hospital-wide `UNAVAILABLE` declarations under heavy telemetry traffic.
- **Failure Scenario**: Hospital reports ED UNAVAILABLE; after 500 ambulance location updates, new case replay evaluates hospital as available.
- **Affected Files**: `services/api/src/infrastructure/stateStore/DynamoStateStore.ts`, `services/api/src/feasibility/acceptanceLedger.ts`.
- **Required Remediation**: Partition hospital-wide operational state into dedicated state records rather than relying on event history scans.
- **Required Test**: Soak test verifying UNAVAILABLE status persists across 1,000+ intervening telemetry events.
- **Rollback Consideration**: N/A (database query fix).

---

## 15. P1 Issues (Should Fix Before Promotion)

### P1-1: Unsigned Cognito Claims in Standalone Express Server
- **Problem**: `services/api/src/index.ts` parses `x-cognito-claims` without cryptographic signature verification.
- **Remediation**: Restrict standalone Express server to local demo environments, or verify JWT signatures against JWKS using `aws-jwt-verify`.

### P1-2: Manual Hospital Credential Onboarding
- **Problem**: Hospital identity binding in Cognito requires manual admin attribute assignment.
- **Remediation**: Establish an admin-authenticated hospital onboarding script with schema validation.

### P1-3: Care Window Definition Unimplemented (`HC-TMP-01`)
- **Problem**: `ruleCareWindow` returns `NOT_APPLICABLE`. Time-critical emergencies (stroke/STEMI) do not evaluate temporal feasibility against ETA.
- **Remediation**: Support clinician-specified `careWindowMinutes` on `CareRequirement` with clinical provenance.

---

## 16. P2 Deferred Items (Post-Promotion Roadmap)

- **P2-1: Live AWS Cloud Deployment**: Synthesized and package-verified; live deployment deferred to AWS productionization phase.
- **P2-2: Dynamic Realtime Traffic Matrix**: Static/historical Valhalla/OSRM routing is sufficient; dynamic congestion telemetry deferred.
- **P2-3: Financial & Insurance Optimization Hard Constraints**: Currently contextual factors; hard economic constraints deferred.

---

## 17. Promotion Gates

Before JIVA's Care Feasibility Engine can be promoted to an authoritative decision role (`FEASIBILITY_ENGINE=authoritative`), the following gates must be satisfied:

1. **Gate 1 (Cancellation Complete)**: P0-1 resolved; unselected candidate requests receive explicit cancellation events.
2. **Gate 2 (Dual-Run Canary & Containment)**: P0-2 resolved; authoritative mode runs alongside legacy with zero-disagreement soak criteria and automated fallback.
3. **Gate 3 (State Index Partitioning)**: P0-3 resolved; hospital-wide operational state is queryable independent of chronological event sliding windows.
4. **Gate 4 (Identity Boundary Hardened)**: P1-1 resolved; production endpoints strictly enforce cryptographically validated identity tokens.
5. **Gate 5 (Zero Soak Failures)**: Shadow soak counters over 10,000 simulated events report `errors: 0`, `timeouts: 0`, and `wouldHaveFallenBack: 0`.

---

## 18. Recommended Phase 6.2 Scope

**Subphase 6.2: Acceptance Protocol Completion & Invariant Hardening**
1. Implement the Acceptance Request Cancellation Producer (`P0-1`).
2. Resolve the 500-event history sliding-window limitation for hospital-wide operational status (`P0-3`).
3. Harden the production identity boundary for standalone API services (`P1-1`).
4. Re-verify dual-run parity across all simulation scenarios.

*Do NOT implement authoritative promotion (`6.5`) until 6.2, 6.3, and 6.4 gates are audited and passed.*

---

## 19. Files Changed During Subphase 6.1

- `docs/handoffs/PHASE-06-01-HANDOFF.md` (Created): This authoritative audit handoff document.
- Zero functional or architectural changes were made to core services during this audit turn.

---

## 20. Claims Matrix

| Capability / Subsystem | Status | Verification Method |
| :--- | :--- | :--- |
| **Deterministic Eligibility Engine (Legacy)** | **BUILT & TESTED LOCALLY** | Unit (`eligibilityEngine.ts`) & Integration (`api-runtime.test.ts`) |
| **Pure State Transitions** | **BUILT & TESTED LOCALLY** | Unit (`stateTransitions.ts`, parity tests) |
| **Per-Case Acceptance Ledger** | **BUILT & TESTED LOCALLY** | Unit (`acceptanceLedger.ts`, `feasibility-ledger-shadow.test.ts`) |
| **Care Feasibility Engine (Pure Rules)** | **BUILT & TESTED LOCALLY** | Unit (`feasibility-engine.test.ts`, 20 suites) |
| **Shadow Feasibility Evaluation** | **BUILT & SIMULATED** | Integration runtime, soak counters |
| **Authoritative Feasibility Engine** | **NOT IMPLEMENTED (P0-2)** | Verified in code: `legacyAuthoritative: true` hardcoded |
| **Acceptance Request Cancellation Producer** | **NOT IMPLEMENTED (P0-1)** | Consumer exists; producer absent |
| **Evidence Trust Boundary** | **BUILT & TESTED LOCALLY** | Unit (`evidenceTrust.ts`, `feasibility-identity-trust-policy.test.ts`) |
| **MapLibre / Valhalla / OSRM Mapping** | **BUILT & TESTED LOCALLY** | Unit (`mapping-provider.test.ts`, `mapping-fallback.test.ts`) |
| **AI Isolation Boundary** | **BUILT & TESTED LOCALLY** | Unit (`security-prompt-injection.test.ts`) |
| **AWS CDK Infrastructure** | **CDK-DEFINED & SYNTHESIZED** | `npx cdk synth` passes cleanly |
| **AWS Lambda Processor Packages** | **PACKAGE-VERIFIED** | Bundled via esbuild; load-tested in `aws-lambda-parity.test.ts` |
| **Live AWS Cloud Infrastructure** | **NOT DEPLOYED** | No cloud resources provisioned |

---

## 21. Instructions for Claude

When you begin Phase 6.2:
1. **Read this document thoroughly**: Do not rely on outdated Phase 4/5 documentation. This document reflects the true, current state of the repository.
2. **Verify working tree**: Run `npm run typecheck`, `npm run test:unit`, and `npm run test:integration` before writing code to confirm your baseline is green.
3. **Focus on P0-1 and P0-3**: Your immediate objective in 6.2 is to complete the acceptance cancellation protocol and ensure hospital-wide state indexing is immune to event history truncation.
4. **Do NOT switch `legacyAuthoritative` to false yet**: The engine must remain in shadow mode until Gate 5 (soak verification) is approved.
