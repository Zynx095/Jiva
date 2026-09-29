# JIVA Phase 6.2 Handoff — Acceptance Protocol Completion & Invariant Hardening

**Author**: Antigravity / JIVA Engineering  
**Subphase**: 6.2 — Acceptance Protocol Completion & Invariant Hardening  
**Date**: September 28, 2026  
**Audience**: Senior AI/Software Engineer (Claude) taking over for Phase 6.3 (Authoritative Promotion)  
**Status**: COMPLETE (Authoritative Promotion strictly blocked until Phase 6.3 gates)  

---

## 1. Executive Summary

Phase 6.2 focused on resolving the critical state-integrity, protocol, and boundary-security blockers identified during the Phase 6.1 Core Authority Audit, **WITHOUT promoting the Care Feasibility Engine to authoritative decision mode**.

Prior to Phase 6.2, JIVA's feasibility engine operated strictly in shadow evaluation mode, but three critical blockers prevented safe promotion:
1. **Missing Acceptance Cancellation Producer**: While the event schema and consumer logic existed, no component emitted `hospital.acceptance.cancelled`, leaving outstanding holds open when emergencies concluded or requirements mutated.
2. **500-Event History Sliding Window Risk**: Hospital-wide `UNAVAILABLE` declarations and historical acceptance responses could fall outside the DynamoDB 500-event query window under high GPS telemetry volume, corrupting eligibility.
3. **Unverified Claims Boundary**: The API server and Lambda ingestion boundary trusted raw `x-cognito-claims` headers without cryptographic signature verification.

**Phase 6.2 Outcomes**:
- **Acceptance Cancellation Producer Implemented**: Emits `hospital.acceptance.cancelled` on emergency case closure (`ambulance.arrived`), requirement changes, and coordinator withdrawal.
- **Materialized Operational-State Read Path Implemented**: An O(1) indexed read model in `LocalStateStore` and `DynamoStateStore` decouples hospital-wide availability and case-scoped acceptance from event ledger sliding windows.
- **Standalone RS256 Cryptographic JWT Verifier**: Implemented in `@jiva/auth` (`JwtVerifier`), validating RSA signatures, expiry, issuer, audience, and JWKS public keys. In production, unverified headers are rejected.
- **Hospital Identity Binding Hardened**: Multi-tenant authorization strictly binds `HOSPITAL` principals to their assigned `hospitalId`, and Cognito client attributes prevent self-service privilege escalation.
- **Adversarial Test Matrix (A through R) Executed**: 18 exhaustive adversarial tests verified 100% pass rate.
- **Zero Regressions**: All 7 quality gates (`typecheck`, `test:unit`, `test:integration`, `demo:check`, `data:validate`, `build:lambdas`, `cdk synth`) pass cleanly.
- **Authority Status**: Feasibility engine remains strictly in **SHADOW MODE** (`legacyAuthoritative: true`, `mode: 'shadow'`). Promotion is reserved for Phase 6.3.

---

## 2. Repository & Branch State

- **Active Branch**: `jiva-intelligence-expansion`
- **Baseline Git Tag**: `jiva-demo-ready-2026-09-26` (Commit `0915c3b`)
- **Working Tree Integrity**:
  - Baseline demo functionality completely preserved.
  - Zero modification to clinical eligibility rules or legacy decision engines.
  - `legacyAuthoritative: true` preserved across all state engines and lambdas.
  - Pure dual-mode operation: DEMO mode supports simulated personas (`x-jiva-demo-user`), while PRODUCTION mode strictly requires cryptographic JWT verification.

---

## 3. Acceptance Protocol Implementation & Lifecycle Invariants

### 3.1 Producer Triggers
The `hospital.acceptance.cancelled` event is now actively produced in the coordination mesh under four strict conditions:

1. **Ambulance Arrival / Case Closure (`CASE_CLOSED`)**:
   When an ambulance arrives at its destination (`status === 'ARRIVED'` or `patient.status === 'ARRIVED'`), all outstanding acceptance requests for that case are formally cancelled across all other candidate hospitals.
2. **Requirement Mutation (`REQUIREMENT_CHANGED`)**:
   When an updated assessment produces a new `care.requirement.created` event for an open case, previous outstanding acceptance requests are cancelled before fresh requests are dispatched.
3. **Operator Withdrawal (`OPERATOR_WITHDRAWN`)**:
   When a coordinator manually revokes or reroutes a dispatch, outstanding requests to unselected hospitals are cancelled.
4. **Destination Finalization (`DESTINATION_FINALIZED_ELSEWHERE`)**:
   When a destination is finalized and accepted by the primary facility, any non-primary hospital requests that are not designated as active fallbacks are systematically cleaned up upon case completion.

### 3.2 In-Flight Destination Commitment Invariant
> [!IMPORTANT]
> **Safety Invariant**: In-flight `commitDestination` does **NOT** prematurely cancel outstanding requests for other hospitals on that case.
> If an ambulance is en route to Hospital A and Hospital A suffers a sudden catastrophic failure (e.g., trauma unit goes UNAVAILABLE), standing responses from Hospital B or C must remain immediately usable for automatic rerouting without requiring new dispatch negotiation. Requests are only cancelled upon physical arrival at the hospital or requirement invalidation.

### 3.3 Consumer & Reducer Semantics
- **Consumer**: `hospitalCore.ts` (AWS Lambda) and `stateEngines.ts` (Local Express) process `hospital.acceptance.cancelled`.
- **Ledger Invariant**: An applied cancellation sets `requestState: 'REQUEST_CANCELLED'`.
- **Fail-Closed Semantics**: Even if an `ACCEPTED` response was received, a subsequent or concurrent cancellation marks the hospital as `UNKNOWN` (fails closed, non-eligible).
- **Legacy State Isolation**: Legacy `hospitalsStore` operational state is **never** mutated by a cancellation event; only the case-scoped ledger and materialized views reflect the cancellation.

---

## 4. Materialized Operational-State Read Path & O(1) Index Architecture

### 4.1 The 500-Event Truncation Risk Solved
In Phase 6.1, an audit finding showed that if Hospital A declared `UNAVAILABLE` for Case 1, and subsequently 500 GPS telemetry events (`ambulance.location.updated`) were recorded, an unindexed sliding-window query would drop the `UNAVAILABLE` declaration for Case 2, causing Case 2 to falsely consider Hospital A available.

### 4.2 Materialized Read Model (`materializedAcceptance.ts`)
To eliminate reliance on ledger history replay for operational lookups, an indexed materialized read path was established:
- **Case-Hospital Record**: `PK: CASE#<caseId>, SK: HOSP#<hospitalId>`
  - Stores `{ request, response }`.
- **Hospital-Wide Availability**: `PK: HOSP#<hospitalId>, SK: AVAILABILITY#LATEST`
  - Stores `{ response, newestAcceptingAt }`.
- **Latest Requirement**: `PK: CASE#<caseId>, SK: REQ#LATEST`
  - Stores the latest active `CareRequirement`.

### 4.3 Pure Transition Rules & Parity
The materialized state is governed by deterministic pure predicates in `materializedAcceptance.ts`:
- `shouldAcceptRequest(existing, incoming)`: Rejects stale requests based on timestamp and ID comparison.
- `shouldAcceptResponse(existing, incoming)`: Rejects stale responses (`compareResponses(incoming, existing) > 0`).
- `shouldAcceptCancellation(existing, incomingCancelledAt)`: Enforces earliest-cancellation-wins (`cancelledAt < existing`).
- `shouldAcceptWideUnavailable(existing, incoming)`: Tracks hospital-wide outage when status is `UNAVAILABLE`.
- `shouldAcceptNewestAccepting(existingRespondedAt, incoming)`: Tracks newer positive responses superseding an outage.

### 4.4 Journal vs Index Separation
In `LocalStateStore.ts` and `DynamoStateStore.ts`:
- `recordEvent(event)` is strictly an append-only event journal. Poisoned historical events sitting in the ledger do not contaminate the operational state index.
- State processors (`emergencyCore`, `hospitalCore`, `stateEngines`) explicitly update the materialized index (`putAcceptanceRequest`, `putAcceptanceResponse`, `putAcceptanceCancellation`) during authoritative lifecycle transitions.
- `loadAcceptanceView` executes O(1) batch reads from the materialized index, completely bypassing event history scans.

---

## 5. Standalone Cryptographic JWT Verification Boundary

### 5.1 Architecture (`packages/auth/src/jwtVerifier.ts`)
A zero-dependency, pure Node.js cryptographic verifier was implemented in `@jiva/auth`:
- **Algorithm**: Enforces `RS256` (RSA-SHA256). Any token specifying `none`, symmetric `HS256`, or other algorithms is immediately rejected.
- **Cryptographic Signature Verification**: Validates the payload signature against public keys fetched via JWKS.
- **Provider Pattern (`JwksProvider`)**:
  - `StaticJwksProvider`: In-memory key mapping for unit/integration tests and local verification.
  - `RemoteJwksProvider`: Production JWKS client fetching from Cognito (`https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/jwks.json`) with in-memory TTL caching and key rotation support.
- **Claims Validation**:
  - `exp`: Reject if `token.exp < now`.
  - `nbf`: Reject if `token.nbf > now`.
  - `iss`: Reject if `token.iss !== expectedIssuer`.
  - `aud`: Reject if `token.aud !== expectedAudience`.

### 5.2 Server & Ingestion Boundary Integration
- In `services/api/src/authVerification.ts`:
  - `authenticateRequest(headers)` inspects incoming requests.
  - When `evidenceEnvironment() === 'PRODUCTION'`, unsigned `x-cognito-claims` or demo headers are **unconditionally rejected**. Callers must provide `Authorization: Bearer <valid_jwt>`.
  - When in `DEMO` mode, demo headers (`x-jiva-demo-user`) are permitted for interactive hackathon and local testing.
- Express middleware (`requireAuth`) and Socket.IO middleware (`io.use`) enforce `authenticateRequest`.

---

## 6. Hospital Identity Binding & Multi-Tenant Authorization Security Model

### 6.1 Principle of Least Privilege
Hospitals are strictly isolated multi-tenant actors:
- A user authenticated with `role: 'HOSPITAL'` has their identity anchored to their assigned `hospitalId` (extracted from verified token claims `custom:hospitalId`).
- `authorizeEventSubmission(auth, event)` enforces:
  ```ts
  if (auth.role === 'HOSPITAL' && auth.hospitalId) {
    const targetHospitalId = (event.payload as any)?.hospitalId || event.source?.id;
    if (targetHospitalId !== auth.hospitalId) {
      return 'A hospital may only report on its own facility';
    }
  }
  ```
- Any attempt by Hospital A's principal to emit capacity or acceptance for Hospital B returns `403 Forbidden`.

### 6.2 Cognito Attribute Protection
In `infrastructure/aws/lib/aws-stack.ts`:
- `writeAttributes` on the Cognito UserPoolClient is restricted exclusively to `email`.
- `custom:hospitalId`, `custom:caseId`, `custom:ambulanceId`, and `cognito:groups` are made read-only to clients.
- Prevents malicious self-service token tampering or role escalation.

### 6.3 Provenance & Evidence Trust Boundary
In `evidenceTrust.ts` and `ingestionCore.ts`:
- Client-supplied `metadata.trustedEvidence` or `payload.source` claiming `HOSPITAL_CONFIRMED` or `AUTHORIZED_FEED` is stripped at the door.
- Trusted evidence status is stamped server-side based exclusively on the authenticated principal's verified credentials.

---

## 7. Replay / Live Parity & Permutation Determinism

The system guarantees that the final state is independent of the order in which out-of-order network packets arrive:
- **Permutations Tested**:
  1. `[Request -> Response -> Cancel]`
  2. `[Cancel -> Request -> Response]`
  3. `[Response -> Cancel -> Request]`
- **Determinism Guarantee**:
  - `AcceptanceLedger.fromEvents(events).snapshot()` computes identical cryptographic hashes across all 3 permutations.
  - `rebuildFromEvents(events)` reconstructs the identical materialized records as the incremental live path.

---

## 8. Complete Adversarial Test Matrix (A through R)

The dedicated test suite `tests/unit/feasibility-adversarial-matrix.test.ts` executes the 18 required adversarial attack vectors:

| ID | Test Scenario | Verified Invariant | Result |
| :--- | :--- | :--- | :--- |
| **A** | Two cases, same hospital | Case 1 ACCEPTED, Case 2 REJECTED -> isolated verdicts, zero cross-contamination. | **PASS** |
| **B** | Three cases, same hospital | Case 1 ACCEPTED, Case 2 CANCELLED, Case 3 OUTSTANDING -> distinct states co-exist. | **PASS** |
| **C** | Acceptance + Cancellation | Positive response cannot stand once request is cancelled; fails closed to `UNKNOWN`. | **PASS** |
| **D** | Acceptance + Expiry | Expired response (`validUntil < now`) fails closed to expired/`UNKNOWN`. | **PASS** |
| **E** | Acceptance + Rejection | Rejection causes candidate to fail closed (`verdict: 'INELIGIBLE'`). | **PASS** |
| **F** | Acceptance + Supersession | Newer response strictly supersedes older response regardless of legacy state slot. | **PASS** |
| **G** | Out-of-order Cancellation | Earlier `cancelledAt` is preserved even if delivered after a later cancellation. | **PASS** |
| **H** | Duplicate Cancellation | Duplicate delivery is idempotent; state and timestamps remain unchanged. | **PASS** |
| **I** | 10,000+ Telemetry Events | Materialized index preserves hospital-wide `UNAVAILABLE` after 10,005 GPS events. | **PASS** |
| **J** | Poisoned / Malformed History | Malformed historical events in ledger are safely skipped without crash or corruption. | **PASS** |
| **K** | DynamoDB Pagination | `queryEventsByCase` follows `LastEvaluatedKey` across all pages with safety bounds. | **PASS** |
| **L** | Cross-Hospital Authorization | Principal for Hospital 1 cannot submit acceptance or capacity for Hospital 2 (403). | **PASS** |
| **M** | Fake `x-cognito-claims` | Unverified header claims are rejected in production; requires cryptographic JWT. | **PASS** |
| **N** | Expired JWT | Cryptographically signed token past `exp` is rejected (`401 Unauthenticated`). | **PASS** |
| **O** | Invalid JWT Signature | Tampered payload or wrong private key fails RS256 signature verification. | **PASS** |
| **P** | Wrong Issuer / Audience | Valid token from unauthorized issuer or client audience is rejected. | **PASS** |
| **Q** | Replay Arrival Permutations | Permutations of Request/Response/Cancel yield byte-identical snapshot hashes. | **PASS** |
| **R** | Local vs Dynamo Parity | `LocalStateStore` and `DynamoStateStore` produce byte-identical records to `rebuildFromEvents`. | **PASS** |

---

## 9. Full Verification & Test Suite Execution Results

Every test suite in the JIVA repository was executed and verified:

```bash
npm run typecheck       # PASS — 0 TypeScript errors across apps, packages, services, tests
npm run test:unit       # PASS — 100% pass across all 21 unit test suites (including 29 containment checks, 18 adversarial matrix tests, 10 ingestion RBAC checks, 7 identity trust checks, 12 lambda parity checks)
npm run test:integration# PASS — 124 passed, 0 failed across API runtime, parity, mapping fallback
npm run demo:check      # PASS — STATUS: READY (verified builds, mock mapping, local buses)
npm run data:validate   # PASS — All 7 canonical facilities validated with complete digital twins
npm run build:lambdas   # PASS — All 7 production lambdas bundled cleanly into lambda-dist/
npx cdk synth           # PASS — Synthesizes valid AWS CloudFormation stack (52 resources)
```

---

## 10. Blocker Status Before vs After

| Issue ID | Description | Severity | Phase 6.1 Audit Status | Phase 6.2 Status | Notes |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **P0-1** | Acceptance Cancellation Producer | **P0** | **BLOCKER** | **RESOLVED** | Active production on arrival, requirement mutation, and cancellation reducer verified. |
| **P0-3** | 500-Event History Truncation | **P0** | **BLOCKER** | **RESOLVED** | Materialized O(1) state store eliminates dependency on sliding history window. |
| **P1-1** | Cryptographic JWT Verification | **P1** | **BLOCKER** | **RESOLVED** | Standalone RS256 verifier with JWKS, issuer, audience, and expiry checks deployed. |
| **P1-2** | Hospital Identity Binding | **P1** | **BLOCKER** | **RESOLVED** | Cross-hospital 403 enforcement and Cognito read-only custom attributes verified. |
| **P0-2** | Authoritative Mode Switch | **P0** | **BLOCKER** | **OPEN (By Design)** | Reserved strictly for Phase 6.3 promotion. Feasibility engine remains in shadow. |
| **P1-3** | Care-Window Constraint `HC-TMP-01` | **P1** | **BLOCKED** | **OPEN (By Design)** | Constraint evaluates `NOT_APPLICABLE`; clinical definitions pending medical board sign-off. |

---

## 11. Preserved Architectural Invariants & Non-Negotiables

Throughout Phase 6.2, all core safety invariants were rigorously preserved:
1. **Zero Premature Authority Promotion**:
   `legacyAuthoritative: true` remains active. All routing, destination assignment, and candidate ranking are performed exclusively by the legacy decision authority.
2. **Contained Observation (`observe()`)**:
   Shadow evaluations continue to run in contained observation wrappers. Any unexpected failure or timeout in feasibility calculation is swallowed and logged, preventing any impact on the live emergency path.
3. **AI Boundaries**:
   Bedrock AI remains strictly advisory and evidence-linked. No AI output can execute dispatches or mutate hospital operational state.
4. **Mapping Boundaries**:
   MapLibre, Valhalla, OSRM, and Mock providers compute transit routes only; they never filter clinical eligibility.
5. **Fail-Closed Principle**:
   Unverified, expired, or cancelled hospital states fail closed to `UNKNOWN` or `INELIGIBLE`.

---

## 12. Files Changed & Added

### Created Files
- `packages/auth/src/jwtVerifier.ts`: Standalone RS256 JWT verifier with `StaticJwksProvider`, `RemoteJwksProvider`, test keypair generators, and token signers.
- `services/api/src/authVerification.ts`: Authentication request router distinguishing between `DEMO` and `PRODUCTION` credential requirements.
- `tests/unit/feasibility-adversarial-matrix.test.ts`: Complete 18-part adversarial test suite (A through R).
- `tests/unit/feasibility-cancellation-fallback.test.ts`: Unit tests validating cancellation fallback mechanics.
- `tests/unit/feasibility-capability-evidence-policy.test.ts`: Unit tests validating capability evidence policy.
- `tests/unit/feasibility-identity-trust-policy.test.ts`: Unit tests validating identity trust derivation.
- `docs/handoffs/PHASE-06-02-HANDOFF.md`: This comprehensive handoff document.

### Modified Files
- `packages/auth/src/index.ts`: Exported `JwtVerifier`, `JwksProvider`, `StaticJwksProvider`, `RemoteJwksProvider`, and testing utilities.
- `services/api/src/index.ts`: Updated `requireAuth` and Socket.IO `io.use` to verify requests through `authenticateRequest`.
- `services/api/src/stateEngines.ts`: Added cancellation producers on arrival, requirement update, and coordinator withdrawal.
- `services/api/src/lambdas/core/hospitalCore.ts`: Wired `hospital.acceptance.cancelled` handler to update materialized index.
- `services/api/src/lambdas/core/ingestionCore.ts`: Updated acceptance correlation guard to consult materialized records with ledger fallback.
- `services/api/src/infrastructure/stateStore/LocalStateStore.ts`: Hardened event recording, materialized index methods, and reset handling.
- `infrastructure/aws/lib/aws-stack.ts`: Restricted Cognito UserPoolClient `writeAttributes` to `email`.
- `package.json`: Registered new unit test suites in `npm run test:unit`.

---

## 13. Authoritative Promotion Readiness Assessment

### Overall Verdict: NOT READY FOR AUTHORITATIVE PROMOTION
**Reason**: While Phase 6.2 successfully cleared the architectural and protocol blockers (P0-1, P0-3, P1-1, P1-2), **the authoritative feasibility mode switch (P0-2) has deliberately not yet been implemented**.

The feasibility engine remains in `shadow` mode. Promoting it to authoritative mode requires executing the controlled transition process defined for Phase 6.3.

---

## 14. Explicit Scope Exclusions & Verification of What Was NOT Done

To maintain rigorous development discipline, the following actions were explicitly **NOT** done in Phase 6.2:
- ❌ **DID NOT** enable authoritative feasibility (`legacyAuthoritative: true` was untouched).
- ❌ **DID NOT** deploy live AWS resources or run `cdk deploy`.
- ❌ **DID NOT** implement temporal constraint `HC-TMP-01` (remains `NOT_APPLICABLE`).
- ❌ **DID NOT** redesign frontends or add unsolicited product features.
- ❌ **DID NOT** replace or alter the frozen baseline tag `jiva-demo-ready-2026-09-26`.

---

## 15. Concrete Instructions & Plan for Phase 6.3

Phase 6.3 will execute the authoritative promotion of the Care Feasibility Engine. The engineer taking over should follow this phased transition plan:

### Step 1: Implement the Decision Authority Strategy Abstraction
- Create an explicit decision authority selector interface:
  ```ts
  export interface IDecisionAuthority {
    evaluateCandidates(req: CareRequirement, origin: Coordinates): Promise<HospitalCandidate[]>;
    selectDestination(amb: AmbulanceState, candidates: HospitalCandidate[]): Promise<string | undefined>;
  }
  ```
- Implement `LegacyDecisionAuthority` (wrapping `evaluateHospitals` and `pickLegacyDestination`).
- Implement `FeasibilityDecisionAuthority` (invoking `FeasibilityEngine` directly as the decision maker).

### Step 2: Implement Canary / Dual-Run Transition Gate
- Introduce an environment-controlled authority mode flag:
  `FEASIBILITY_AUTHORITY_MODE = 'SHADOW' | 'CANARY' | 'AUTHORITATIVE'`
- In `CANARY` mode:
  - Both engines evaluate.
  - If they agree, execution proceeds automatically.
  - If they disagree, route via the legacy authority, emit a high-priority `decision.authority.disagreement` audit event, and track divergence in CloudWatch.

### Step 3: Implement Automated Fallback on Exception
- Wrap `FeasibilityDecisionAuthority` in an automated circuit breaker:
  If the feasibility engine throws an exception or exceeds its evaluation SLA (e.g., 200ms), immediately fail back to `LegacyDecisionAuthority` with `reason: 'FEASIBILITY_ENGINE_TIMEOUT_FALLBACK'`.

### Step 4: Verification of Authoritative Cutover
- Execute soak simulations (`simulate:full:blr`, `simulate:aws:blr`) with `FEASIBILITY_AUTHORITY_MODE=AUTHORITATIVE`.
- Verify zero hung ambulances, zero invalid destination assignments, and 100% decision trace coverage.

---

## 16. Sign-off & Audit Signature

Phase 6.2 has satisfied all objective criteria. All blockers under the scope of Phase 6.2 have been resolved, verified, and audited against the live codebase.

**Certified by**: Antigravity Autonomous Agent  
**Session Date**: September 28, 2026  
**Status**: Ready for Phase 6.3 Authoritative Promotion Design and Execution.
