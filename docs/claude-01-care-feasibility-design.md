# CLAUDE-01 — Care Feasibility Engine: Architecture & Safety Design

Status: **APPROVED 2026-09-27 with decisions in §0. Implementation: SHADOW MODE.**

## 0. Approved decisions (these override anything below that conflicts)

| Item | Decision |
|---|---|
| A1 | INDETERMINATE hospitals are **not** sent acceptance requests. |
| A2 | LIMITED that does not cover every required capability → **INELIGIBLE**. LIMITED ≠ ACCEPTED. |
| A3 | Operational evidence: fresh UNAVAILABLE → FAIL; expired UNAVAILABLE → UNKNOWN; fresh AVAILABLE → PASS; expired AVAILABLE → UNKNOWN. **A positive state is never inferred from expired evidence.** |
| A4 | Freshness durations are **configurable prototype defaults, not clinical guarantees**. An explicit `validUntil` always takes precedence over a class default (the "60 min cap" on acceptance in §8 is dropped). |
| D1–D6 | Approved. D3 applies both to initial selection and rerouting. D5: one hospital may hold valid acceptances for several cases at once. |
| Verdicts | ELIGIBLE = all hard constraints pass and current acceptance is satisfied. PENDING_ACCEPTANCE = otherwise feasible enough to request/await acceptance. INDETERMINATE = required information unknown and not resolvable by an acceptance request. INELIGIBLE = a known hard constraint failed. UNKNOWN ≠ ELIGIBLE, UNKNOWN ≠ INELIGIBLE. |
| Rollout | Shadow mode only. The engine never controls demo decisions. Disagreements with the legacy engine are logged. Frozen demo behavior is not changed until shadow comparison is validated. |

Implementation notes that refine the proposal:
- Operational evidence whose `dataStatus` is HISTORICAL/PUBLIC_LISTED/UNVERIFIED/UNKNOWN/NOT_DISCLOSED cannot PASS or FAIL an operational rule; it yields UNKNOWN with a reason code (instead of throwing, §7). SYNTHETIC_DEMO is usable but labeled.
- Operational status with **no observation time** (e.g. seeded synthetic `operationalState`) is `UNTIMED` → UNKNOWN.
- REJECTED for a case does not expire (matches legacy behavior; the hospital can revise).
- Care windows: `HC-TMP-01` is always NOT_APPLICABLE in this phase (no defensible source exists).
- `feasibility.trace.recorded` (renamed from `decision.trace.recorded`, see Phase 2 below) is emitted as observability-only telemetry; traces are also kept in memory and exposed read-only to MANAGEMENT/ADMIN at `GET /api/feasibility/shadow`.
- `FEASIBILITY_ENGINE=on` is not accepted yet; it is treated as `shadow` with a warning.

### Implementation status (shadow mode, 2026-09-27)

| Piece | Location |
|---|---|
| Contracts | `packages/domain-models/src/feasibility.ts`; additive fields in `decisionTrace.ts`; `Capabilities.ventilator` |
| Pure engine | `packages/feasibility/src/` — `policy.ts` (prototype defaults), `capabilityMap.ts`, `rules.ts`, `factors.ts`, `engine.ts`, `trace.ts`, `canonical.ts` |
| Shell | `services/api/src/feasibility/` — `acceptanceLedger.ts`, `snapshotAssembler.ts`, `transportEnricher.ts`, `shadow.ts` |
| Hooks | `stateEngines.ts`: ledger fed from `acceptance.requested/received`; shadow runs after `care.requirement.created` and inside `selectDestination`. No event published, no state written. |
| Inspection | `GET /api/feasibility/shadow[?caseId=]` (MANAGEMENT/ADMIN) |
| Config | `FEASIBILITY_ENGINE=off|shadow` (default shadow); `FEASIBILITY_POLICY_OVERRIDES='{"OPERATIONAL_CAPACITY":{"maxAgeSeconds":900}}'` |
| Tests | `tests/unit/feasibility-engine.test.ts` (32), `tests/unit/feasibility-ledger-shadow.test.ts` (14) |

Flagship `simulate:full:blr` shadow result: 4 traces, **0 disagreements** with the legacy engine. The D1–D6 differences only surface in scenarios the flagship does not exercise (route failure, unlisted capability, LIMITED missing ICU, multi-case acceptance, aged capacity).

Not yet done (next steps, need a go-ahead): steps 6–8 of §20 — switching decisions to the engine, AWS lambda parity (D8), `decision.trace.recorded` event, advisory integration.
Branch: `jiva-intelligence-expansion` · Baseline tag: `jiva-demo-ready-2026-09-26` (untouched)
Date: 2026-09-27

> Note on inputs: no standalone AG-01 / AG-02 report files exist in the repo. Those phases are recorded
> by their artifacts: `packages/domain-models/src/{evidence,digitalTwin,decisionTrace,financial,insurance,canonicalHospital}.ts`,
> `packages/intelligence/src/contracts.ts`, `data/canonical/hospitals.json`, `scripts/data-{normalize,validate}.ts`,
> and `tests/unit/{intelligence-foundation,canonical-data-ingestion}.test.ts`. This design is based on those files.

---

## 1. Architecture assessment

JIVA already follows the right pattern: facts arrive as events, state engines project them, eligibility
comes before mapping, and AI is advisory only. Most of the pieces a feasibility engine needs already exist. They are
**split across layers that don't share one notion of "unknown", "fresh", or "this case"**.

What already works and must be kept:

| Property | Where | Status |
|---|---|---|
| Public listing ≠ live availability | `isValidOperationalEvidence`, `assertNoHistoricalPromotion`, `materializeDigitalTwin` | Enforced at twin build time |
| Acceptance is per case | `operationalState.acceptanceCaseId` check in `eligibilityEngine.ts:38` | Enforced |
| Out-of-order responses are dropped | `acceptanceAsOf` watermark (`stateEngines.ts:361`) | Enforced (local only) |
| Duplicate responses are dropped | `processedResponseIds` + `recordEvent` dedupe | Enforced |
| Responses that arrive already expired are ignored | `stateEngines.ts:366` | Enforced |
| When an acceptance expires, state goes to UNKNOWN, not AVAILABLE | `checkAcceptanceExpiry` | Enforced |
| Mapping never decides eligibility | `selectDestination` comment + implementation | Mostly (see defects) |
| GPS ticks don't trigger rerouting | `stateEngines.ts:483` | Enforced |
| AI cannot mutate state | `assertAdvisoryAuthorityOnly` | Enforced (name-pattern guard) |

Defects found in the current eligibility path. The engine must not copy these.

| # | Defect | Location | Consequence |
|---|---|---|---|
| D1 | A failed route calculation leaves `etaMinutes = 0` | `eligibilityEngine.ts:69-83` | A hospital with an **unknown** ETA sorts as the **closest**. This is a safety bug. |
| D2 | An absent capability key is treated the same as `false` | `eligibilityEngine.ts:19` | "Not listed" becomes "does not have", so UNKNOWN collapses into NO. |
| D3 | `icu`/`trauma` = `UNAVAILABLE` from `capacity.updated` is ignored by `evaluateHospitals` (only `emergency` is checked) | `eligibilityEngine.ts:39` | The reroute handler excludes the old destination, but the next pick can be a *different* hospital whose ICU is also UNAVAILABLE. |
| D4 | `LIMITED` is always treated as fully eligible; `acceptedCapabilities` and `limitations` are never read | `eligibilityEngine.ts:50` | A LIMITED response that explicitly leaves out ICU is still routed to for an ICU case. |
| D5 | Acceptance is one slot per hospital (`acceptance`, `acceptanceCaseId`, `acceptanceAsOf`) | `OperationalState` | If hospital H answers case B, H's still-valid acceptance for case A is **overwritten**. Case A's response can also be dropped as "stale" because the watermark is not scoped to the case. |
| D6 | Capacity status never expires (it has `capacityAsOf` but no `validUntil`) | `hospital.capacity.updated` handler | A 3-hour-old `ICU: AVAILABLE` still counts as current. |
| D7 | `selectDestination` hard-codes `severity: 'HIGH'`. `calculateBestHospitals` hard-codes a fake `caseId: 'sys-case'` | `stateEngines.ts:129`, `routingEngine.ts:19` | The case-scoped acceptance check is bypassed on the AWS reroute path. |
| D8 | The AWS `hospitalAcceptanceProcessor` has no stale-watermark check, no validUntil check, no `acceptanceCaseId` handling, and sets `verificationStatus: 'UNKNOWN'` | `lambdas/hospitalAcceptanceProcessor.ts` | Local and AWS behave differently, so local/AWS parity is already broken for acceptance. |
| D9 | `evaluateHospitals` calls the mapping provider for **every** hospital, including ineligible ones | `eligibilityEngine.ts:72` | Mapping work runs before and alongside eligibility. It is wasted work and blurs the boundary between the two. |
| D10 | Evaluation reads `Date.now()` in several places | `eligibilityEngine.ts:36` | Results can't be replayed or proven deterministic. |
| D11 | `capacity.updated` casts `metadata.sourceType as any` into `verificationStatus` | `stateEngines.ts:435` | Arbitrary strings can end up in the DataStatus taxonomy. |
| D12 | The protocol doc says acceptance moves `UNKNOWN → AVAILABLE` | `docs/hospital-availability-protocol.md:31` | Wrong term. Acceptance states are ACCEPTED/LIMITED. |

Evidence coverage today:
- The canonical dataset has 7 facilities, all `PUBLIC_LISTED`, with all operational fields `UNKNOWN`.
- The demo loads `data/synthetic/bengaluru/hospitals.json` by default. Canonical data loads only with `USE_CANONICAL`.
- **There is no financial or insurance evidence anywhere in the data.** The AG-01 models are types only.
- Capability flags like `ventilator` are present in the data but missing from the `Capabilities` interface.
- **No care-window concept exists anywhere.** `CareRequirement.expiresAt` is when the *requirement record* expires, not a clinical window.
- Required capabilities come from `assessRequiredCapabilities()`, a regex over free-text condition plus severity. That is rule-derived, not clinician-confirmed. The engine must record this in provenance (see §18).

## 2. Current components relevant to feasibility

| Component | Role today | Role under this design |
|---|---|---|
| `packages/domain-models/protocol.ts` (`CareRequirement`, `HospitalAvailabilityRequest/Response`, `HospitalCandidate`) | Requirement plus acceptance protocol types, legacy candidate shape | Reused as they are. `HospitalCandidate` stays as the **legacy projection** of the engine result. |
| `hospital.ts` (`HospitalState`, `OperationalState`, `Capabilities`, `DataStatus`, `AcceptanceStatus`) | Live store shape | Read-only input |
| `evidence.ts` (`EvidenceRecord`, invariant guards) | Provenance wrapper | Every input fact is normalized into `EvidenceRecord`s before evaluation |
| `digitalTwin.ts`, `canonicalHospital.ts` (`materializeDigitalTwin`) | Twin construction | Primary hospital input |
| `decisionTrace.ts` | Trace types (not used yet) | **The** audit output. Needs small additive changes (§11). |
| `financial.ts`, `insurance.ts` | Types only, no data | Inputs to advisory, non-blocking factors |
| `freshness.ts` (one global 600s threshold) | Freshness helper | Replaced **for the engine only** by a per-evidence-class policy. The helper stays for UI. |
| `services/api/eligibilityEngine.ts` | Clinical + operational + mapping in one pass | Becomes a thin adapter: engine → `HospitalCandidate[]` |
| `services/api/routingEngine.ts` | Fake-score wrapper | Kept for AWS lambda compatibility. Later reimplemented on the engine (removes D7). |
| `services/api/stateEngines.ts` | Event handlers, request issuance, reroute, expiry | Unchanged in structure. Calls the engine where it calls `evaluateHospitals` today. |
| `@jiva/mapping` | Route/ETA provider with fallback | Called only for candidates that survive Stage A (§13) |
| `packages/intelligence/contracts.ts` | Advisory-only AI contracts | Consumes `DecisionTraceRecord` read-only |

## 3. Proposed architecture

A **pure, synchronous, deterministic function** in a new package with no I/O. Service code wraps it.

```
            ┌───────────────────────── services/api (impure shell) ─────────────────────────┐
 events ──► │ state engines ──► SnapshotAssembler ──► FeasibilitySnapshot (frozen, hashed)   │
            └───────────────────────────────────────────┬────────────────────────────────────┘
                                                        ▼
            ┌──────────── packages/feasibility (pure; no Date.now, no fetch, no store) ──────┐
            │ Stage A  evaluateHardConstraints(snapshot, policy)  → per-candidate verdict     │
            │          clinical · operational · acceptance · (financial/insurance, advisory)  │
            └───────────────────────────────────────────┬────────────────────────────────────┘
                                   non-INELIGIBLE candidates only
                                                        ▼
            ┌──────────── shell: TransportEnricher (@jiva/mapping) ─────────────────────────┐
            │ ETA / distance as EvidenceRecord (provider, synthetic, calculatedAt), or UNKNOWN│
            └───────────────────────────────────────────┬────────────────────────────────────┘
                                                        ▼
            ┌──────────── packages/feasibility (pure) ───────────────────────────────────────┐
            │ Stage C  evaluateTemporal (only if care window supplied)                        │
            │ Stage D  orderCandidates (lexicographic, §6) · buildDecisionTrace                │
            └───────────────────────────────────────────┬────────────────────────────────────┘
                                                        ▼
         FeasibilityDecision ──► legacy HospitalCandidate[] ──► existing events / routing
                             └─► DecisionTraceRecord (immutable, stored and emitted)
```

Principles:
1. **Pure core.** `evaluatedAt` is an input. The same snapshot and policy always give the same output, byte for byte.
2. **Two-phase separation from mapping.** Mapping runs after hard constraints and only for survivors. Its outputs (ETA) can only *order* candidates or, when a care window exists, apply a temporal rule. It can never change clinical or operational verdicts.
3. **Snapshot, not live reads.** The engine never touches `hospitalsStore`. The shell freezes every input it will use into a `FeasibilitySnapshot` (with `snapshotId` and content hash) and the trace references it.
4. **No aggregate score.** There is no `overallScore`, no weights, and no percentages that combine categories.

## 4. Input / output contracts

### 4.1 Inputs (all new types live in `packages/domain-models/src/feasibility.ts`)

```ts
interface FeasibilitySnapshot {
  snapshotId: string;            // uuid
  contentHash: string;           // sha256 of canonical JSON of everything below
  evaluatedAt: string;           // the ONLY clock the engine sees
  policyVersion: string;         // FreshnessPolicy + rule-set version
  case: CaseInput;
  candidates: HospitalInput[];
  transport?: TransportInput;    // ambulance origin; ETA is filled in by the enricher
  trigger: { eventId: string; eventType: string; sourceId: string };
}

interface CaseInput {
  caseId: string;
  requirement: CareRequirement;                     // existing type, unchanged
  requirementProvenance: EvidenceRecord<'RULE_DERIVED'|'CLINICIAN_CONFIRMED'>;
  urgency: CareRequirement['severity'];             // no parallel urgency enum
  careWindow?: EvidenceRecord<{ latestArrivalAt: string }>;   // absent today; see §9
  financialContext?: PatientFinancialContext;       // AG-01 type
  insuranceProfile?: PatientInsuranceProfile;       // AG-01 type
  declaredMandatoryConstraints?: PatientDeclaredConstraint[]; // e.g. CASHLESS_REQUIRED (non-emergency only, §5)
}

interface HospitalInput {
  hospitalId: string; displayName: string;
  location?: EvidenceRecord<LocationData>;
  capabilities: EvidenceRecord<Capabilities>;          // PUBLIC_LISTED / SYNTHETIC_DEMO / HOSPITAL_CONFIRMED
  operational: EvidenceRecord<OperationalState>;       // capacity statuses + capacityAsOf
  acceptance: CaseAcceptanceView;                      // per (caseId, hospitalId), see §9
  financialProfile?: HospitalFinancialProfile;
  insuranceProfile?: HospitalInsuranceProfile;
}

interface CaseAcceptanceView {
  requestState: 'NOT_REQUESTED'|'OUTSTANDING'|'REQUEST_EXPIRED';
  request?: { requestId: string; requestedAt: string; expiresAt: string };
  response?: EvidenceRecord<HospitalAvailabilityResponse>;   // latest applicable for THIS case
  hospitalWideUnavailable?: EvidenceRecord<HospitalAvailabilityResponse>; // UNAVAILABLE from any case
}

interface TransportInput {
  ambulanceId?: string;
  origin: EvidenceRecord<GeoPoint>;                  // observedAt = locationAsOf
  etaByHospital?: Record<string, EvidenceRecord<{ durationSeconds: number; distanceMeters: number;
                  provider: string; synthetic: boolean; trafficAware: boolean }> | UnknownFact>;
}
```

`UnknownFact = { status: 'UNKNOWN', reasonCode: UnknownReason, detail: string }`. This is a first-class value, never `undefined`.

### 4.2 Output

```ts
type FeasibilityVerdict = 'ELIGIBLE' | 'PENDING_ACCEPTANCE' | 'INDETERMINATE' | 'INELIGIBLE';
type ConstraintOutcome  = 'PASS' | 'FAIL' | 'UNKNOWN' | 'NOT_APPLICABLE';

interface CandidateFeasibility {
  hospitalId: string; hospitalName: string;
  verdict: FeasibilityVerdict;
  hardConstraints: ConstraintResult[];     // every rule, including PASS and NOT_APPLICABLE
  contextualFactors: FactorResult[];       // soft, never change the verdict
  blockingReasons: ReasonCode[];           // FAIL (INELIGIBLE) or UNKNOWN (INDETERMINATE) rule ids
  pendingOn?: 'ACCEPTANCE_REQUEST'|'ACCEPTANCE_RESPONSE';
  evidenceRefs: EvidenceRef[];             // {snapshotId, path, source, observedAt, dataStatus, ageSeconds, freshness}
  orderKey?: OrderKey;                     // only for non-INELIGIBLE candidates (§6)
  orderPosition?: number;
}

interface ConstraintResult {
  ruleId: string; category: DecisionFactorCategory; outcome: ConstraintOutcome;
  reasonCode: ReasonCode; rationale: string; evidenceRefs: EvidenceRef[];
}

interface FeasibilityDecision {
  decisionId: string; traceId: string; snapshotId: string; evaluatedAt: string; policyVersion: string;
  caseId: string;
  outcome: 'SELECTED' | 'AWAITING_ACCEPTANCE' | 'NO_FEASIBLE_CANDIDATE' | 'ESCALATION_REQUIRED';
  selectedHospitalId?: string;              // only if outcome === 'SELECTED'
  candidates: CandidateFeasibility[];       // ALL evaluated, including INELIGIBLE
  coverage: { evaluated: number; withLiveOperationalEvidence: number; withFinancialEvidence: number; withInsuranceEvidence: number };
}
```

**Why these verdict names.** The existing system already publishes `ELIGIBLE | PENDING_ACCEPTANCE | INELIGIBLE`
in `hospital.candidate.generated` and `HospitalCandidate`, and the UIs and tests depend on them. I keep all three
with the same meaning and add **one** state:

- `INDETERMINATE`: a hard constraint is UNKNOWN for a reason that **sending an acceptance request cannot fix**. Examples: capability not listed, no location, stale negative capacity evidence.
  Today these cases are folded into INELIGIBLE (D2), which throws away information, or would have to be folded into PENDING, which falsely suggests the protocol will resolve them.
- The requested name `UNKNOWN` is **not** used for the verdict. It is already an `AcceptanceStatus` and a `CapabilityStatus` value, and reusing it at a third level would make "acceptance UNKNOWN" and "feasibility UNKNOWN" hard to tell apart in traces. `UNKNOWN` is kept for **constraint outcomes and facts**.
- `PENDING` is not a separate verdict. It is `PENDING_ACCEPTANCE`, the existing name.

Legacy projection (`hospital.candidate.generated` schema **unchanged**): `INDETERMINATE → 'INELIGIBLE'`, with `reason` prefixed `"INDETERMINATE: "`.
This keeps today's conservative behavior: such hospitals are neither asked nor routed to.

## 5. Hard constraints

A hard constraint is a rule whose FAIL makes the candidate INELIGIBLE and whose UNKNOWN makes it INDETERMINATE,
or PENDING_ACCEPTANCE for acceptance rules. **No soft factor can override a hard constraint.** They are evaluated in a fixed
order, and *all* of them are evaluated (no short-circuit), so the trace is complete.

| Rule id | Category | PASS | FAIL | UNKNOWN |
|---|---|---|---|---|
| `HC-CLIN-01 required_capability_listed` | CLINICAL_CAPABILITY | every `requiredCapabilities[i]` maps to a `Capabilities` key that is `true`, **or** is in a current, valid, case-scoped response's `acceptedCapabilities` | any key is explicitly `false` | any key is absent or the capability evidence is `UNKNOWN`/`NOT_DISCLOSED` (fixes D2) |
| `HC-OPS-01 ed_not_unavailable` | OPERATIONAL_AVAILABILITY | `emergency` ∈ {AVAILABLE, LIMITED} and fresh | fresh `UNAVAILABLE` | `UNKNOWN`, or any value that is stale (§8) → **does not block** by itself (see note) |
| `HC-OPS-02 required_unit_not_unavailable` | OPERATIONAL_AVAILABILITY | for each required cap with a live status (ICU, TRAUMA, NICU, PICU, VENTILATOR): not UNAVAILABLE | fresh `UNAVAILABLE` for a *required* unit (fixes D3) | as above |
| `HC-ACC-01 not_rejected_for_case` | OPERATIONAL_AVAILABILITY | no REJECTED response for this case | valid REJECTED for this case | n/a |
| `HC-ACC-02 not_hospital_wide_unavailable` | OPERATIONAL_AVAILABILITY | none | valid `UNAVAILABLE` response (any case: hospital-wide, as today) | n/a |
| `HC-ACC-03 limited_covers_required` | CLINICAL_CAPABILITY | LIMITED response's `acceptedCapabilities ⊇ required` | LIMITED response omits a required capability (fixes D4) | n/a |
| `HC-ACC-04 current_acceptance` | OPERATIONAL_AVAILABILITY | ACCEPTED/LIMITED, same caseId, `respondedAt ≤ evaluatedAt < validUntil` | n/a (an absent or expired acceptance is not a *failure*) | → `PENDING_ACCEPTANCE` (pendingOn: REQUEST or RESPONSE) |
| `HC-GEO-01 locatable` | TRANSIT_TIME | hospital has a location | n/a | no coordinates → INDETERMINATE |
| `HC-TMP-01 within_care_window` | TRANSIT_TIME | only if `careWindow` supplied: `evaluatedAt + ETA ≤ latestArrivalAt` | ETA exceeds the window | window supplied but ETA UNKNOWN; **NOT_APPLICABLE** if no window |
| `HC-PAT-01 declared_mandatory` | FINANCIAL/INSURANCE | only for **non-emergency** cases where the patient explicitly declared a mandatory constraint (e.g. cashless) and evidence confirms it | evidence confirms it cannot be met | evidence missing → UNKNOWN |

Notes and decisions:
- **Operational UNKNOWN does not block on its own.** Almost every hospital is UNKNOWN operationally today, and the design intent is that *acceptance* settles current operational feasibility. If UNKNOWN blocked, JIVA would never send a request. The UNKNOWN is still recorded as a constraint outcome and in coverage. It is not silently converted to AVAILABLE: the verdict can be at most PENDING_ACCEPTANCE until a hospital confirms.
- **Why HC-OPS runs even when acceptance exists.** A fresh `capacity.updated: ICU UNAVAILABLE` that arrives *after* an ACCEPTED response must take effect, and `stateEngines` already reroutes on it. The rule makes the engine match the reroute handler.
- **Financial and insurance are never hard constraints for emergency cases (severity HIGH/CRITICAL).** This matches the AG-01 comment ("advisory only, never hard blocking for emergencies") and Indian emergency-stabilization obligations. HC-PAT-01 exists only so a *non-emergency* planned case with an explicit patient declaration can be represented. It is behind a flag and not implemented in the first slice (§19).
- A good ETA cannot rescue a FAIL. For example, a trauma case 5 minutes from `HOSP-BBMP-0132` (maternity home: `trauma` not listed) gets HC-CLIN-01 = UNKNOWN → INDETERMINATE, and the hospital is never asked or routed to.

### Verdict aggregation (a total function)

```
if any hard FAIL                                  → INELIGIBLE
else if any hard UNKNOWN other than HC-ACC-04     → INDETERMINATE
else if HC-ACC-04 not PASS                        → PENDING_ACCEPTANCE
else                                              → ELIGIBLE
```

## 6. Soft / contextual factors

Soft factors **never change a verdict**. Only the ones marked *ordering* can affect position, and only among
candidates with the same verdict. Every other factor is displayed and traced but has no effect on the result.

| Factor id | Why it exists | Effect |
|---|---|---|
| `SF-ACC-KIND` (ACCEPTED over LIMITED) | A full acceptance is operationally stronger than a limited one. This is the existing behavior. | ordering, key 2 |
| `SF-ETA` | Getting there faster is the one universally defensible optimization once feasibility is settled | ordering, key 3. `UNKNOWN` ETA sorts **last** (fixes D1) |
| `SF-DIST` | Tiebreak for equal ETA (existing) | ordering, key 4 |
| `SF-ETA-QUALITY` (provider, synthetic, trafficAware) | ETA can be synthetic or a straight-line estimate | display and trace only |
| `SF-FRESH-MARGIN` (time left before acceptance validUntil) | Warns the dispatcher about acceptances that are about to expire | display only |
| `SF-FIN-EXPOSURE` | Family/dispatcher awareness | display only, §10 |
| `SF-INS-COMPAT` | Cashless awareness | display only, §10 |
| `SF-CONFIDENCE` | Evidence confidence values | display only. **Never** multiplied into anything. |

Ordering is a lexicographic key: `(verdictRank, accKindRank, etaKnown?0:1, etaSeconds, distanceMeters, hospitalId)`.
The final `hospitalId` tiebreak guarantees a total, deterministic order. Today's `sort` is not stable across equal keys.
Adding a new ordering key requires a `policyVersion` bump and a written rationale. Weighted sums are forbidden by design,
and a test asserts that `CandidateFeasibility` has no numeric field that combines categories.

## 7. UNKNOWN semantics

- UNKNOWN is a **value** (`UnknownFact` with `reasonCode`), not a missing field. Reason codes include `NO_LIVE_EVIDENCE`, `EVIDENCE_STALE`, `NOT_LISTED`, `NOT_DISCLOSED`, `NO_RESPONSE_YET`, `REQUEST_EXPIRED_NO_RESPONSE`, `ROUTE_FAILED`, `NO_LOCATION`, `NO_FINANCIAL_EVIDENCE`, `NO_INSURANCE_EVIDENCE`, and `NO_CARE_WINDOW_DEFINED` (the last one gives NOT_APPLICABLE, not UNKNOWN).
- **Allowed transitions:** UNKNOWN → known only when a new evidence record arrives. There is no default, no fallback-to-true, and no `|| 0`.
- **Promotion guard:** the snapshot assembler calls `assertNoHistoricalPromotion` on every operational and acceptance input. HISTORICAL or PUBLIC_LISTED evidence in an operational slot throws, and the evaluation is recorded as failed. It is never silently evaluated.
- `SYNTHETIC_DEMO` evidence is accepted, because the demo depends on it, but it is **labeled** in every `EvidenceRef` and counted separately in `coverage`. It is never reported as HOSPITAL_CONFIRMED.
- Historical ICU bed counts are never read by any hard rule. A test enforces this with a snapshot that has 500 historical ICU beds and `icu: UNKNOWN`, and expects no PASS on HC-OPS-02 attributable to beds.

## 8. Freshness semantics

Replace the single 600s threshold with a **versioned `FreshnessPolicy`**, one entry per evidence class. The rule is
**explicit expiry wins**: if the evidence carries `validUntil`, that governs. Otherwise the class `maxAge` applies.

| Evidence class | Source of expiry | Proposed default `maxAge` | When stale |
|---|---|---|---|
| Facility identity / location | none | ∞ (review flag at 365d) | display warning only |
| Listed capability (PUBLIC_LISTED) | none | 365d → `STALE` flag | stays usable for HC-CLIN-01, with an `EVIDENCE_STALE` warning. **It is not a claim about current readiness in any case.** |
| Capacity status (`capacity.updated`) | none today (D6) | 30 min *(needs ops sign-off)* | positive → UNKNOWN. Negative (UNAVAILABLE) → UNKNOWN as well, which means it no longer blocks by itself. See ambiguity A3. |
| Acceptance response | `validUntil` (hospital-declared) | capped at `min(validUntil, respondedAt + 60 min)` *(cap needs sign-off)* | expired → HC-ACC-04 not PASS → PENDING_ACCEPTANCE, reason `ACCEPTANCE_EXPIRED` |
| Acceptance request | `expiresAt` (15 min today) | as issued | `REQUEST_EXPIRED_NO_RESPONSE` |
| Ambulance position | `locationAsOf` | 2 min | ETA quality flagged `ORIGIN_STALE` |
| Route / ETA | `calculatedAt` | 5 min | ETA recomputed by the shell on the next trigger |
| Financial tariff / deposit | `validUntil` or 180d | 180d | factor → `UNKNOWN (EVIDENCE_STALE)` |
| Insurance empanelment | `validUntil` or 90d | 90d | factor → `UNKNOWN (EVIDENCE_STALE)` |

- Freshness is computed **against `snapshot.evaluatedAt`**, never against wall clock.
- Every `EvidenceRef` records `observedAt`, `ageSeconds`, `freshness`, and the policy entry that was applied.
- A later state change produces a **new** snapshot, decision, and trace. Traces are append-only and never mutated.

## 9. Acceptance-state semantics

The protocol (`HospitalAvailabilityRequest/Response`, the `hospital.acceptance.*` events, the outstanding-request 409 guard,
and the watermark/idempotency rules) is **unchanged**. One additive **read projection** is required to fix D5:

**`AcceptanceLedger`**: a projection keyed by `caseId|hospitalId`, built from the same `requested` / `received` / `expired`
events. It applies the **same** rules as today (dedupe by `responseId`, reject `respondedAt <` watermark, reject responses that arrive already expired),
except that the watermark is scoped **per case and hospital**. `UNAVAILABLE` is additionally recorded as a hospital-wide entry, matching today's `reroutePredicate(() => true)`.
The existing `operationalState.acceptance*` fields remain the hospital-level "last response" that the UIs already display.

Mapping from each state to its effect on feasibility (for case *C*, hospital *H*):

| Ledger state for (C,H) | Rule effect | Verdict (if all other hard rules pass) | Reason code |
|---|---|---|---|
| no request | HC-ACC-04 UNKNOWN | PENDING_ACCEPTANCE (pendingOn REQUEST) | `NO_REQUEST` |
| request OUTSTANDING, no response | HC-ACC-04 UNKNOWN | PENDING_ACCEPTANCE (pendingOn RESPONSE) | `NO_RESPONSE_YET` |
| request expired, no response | HC-ACC-04 UNKNOWN | PENDING_ACCEPTANCE (pendingOn REQUEST) | `REQUEST_EXPIRED_NO_RESPONSE` |
| ACCEPTED, valid | HC-ACC-04 PASS | ELIGIBLE | `ACCEPTED` |
| LIMITED, valid, covers required | HC-ACC-03 PASS, HC-ACC-04 PASS | ELIGIBLE (limitations surfaced as a factor) | `ACCEPTED_LIMITED` |
| LIMITED, valid, omits a required capability | HC-ACC-03 FAIL | INELIGIBLE | `LIMITED_MISSING_<CAP>` |
| ACCEPTED/LIMITED, `validUntil ≤ evaluatedAt` (**EXPIRED**) | HC-ACC-04 UNKNOWN | PENDING_ACCEPTANCE | `ACCEPTANCE_EXPIRED` |
| REJECTED for C | HC-ACC-01 FAIL | INELIGIBLE | `REJECTED` |
| REJECTED for another case only | no effect on C | as otherwise determined | — |
| UNAVAILABLE (any case, valid) | HC-ACC-02 FAIL | INELIGIBLE | `HOSPITAL_UNAVAILABLE` |
| UNAVAILABLE past validUntil | HC-ACC-02 PASS, flagged | as otherwise determined | `UNAVAILABLE_EXPIRED` |
| stale response (older than watermark) | dropped by the projection, as today | — | logged, not traced as evidence |
| response for a different hospital id than the request | rejected by the existing 409 guard | — | — |

Decisions and edge cases:
- **REJECTED has no expiry for the case.** A hospital's refusal of case C stands until that hospital sends a newer response for C. The hospital UI already allows revision, since the request stays open.
- **Multiple independent responders.** Each (C,H) pair is independent. The engine never needs responses from all hospitals before it can act. The first ELIGIBLE candidate can be selected, and later responses produce new decisions.
- **Correlation.** A response is applied to C only if `response.caseId === C` and `response.requestId` matches the ledger's request for (C,H). A mismatched `requestId` is recorded as a warning. It is not rejected, because today's code doesn't check it (see A5).
- **The `EXPIRED` and `PENDING` values of `AcceptanceStatus`** are *derived* by the ledger view. They are not event payload values. The event enum (`ACCEPTED|LIMITED|REJECTED|UNAVAILABLE`) stays as it is.

## 10. Financial and insurance semantics

**Current reality: there is zero financial or insurance evidence in the data.** So for every hospital today the engine
will output `FINANCIAL: UNKNOWN (NO_FINANCIAL_EVIDENCE)` and `INSURANCE: UNKNOWN (NO_INSURANCE_EVIDENCE)`. That is the correct output.

Knowledge levels, applied per sub-fact:

| Level | Meaning | Example |
|---|---|---|
| `KNOWN` | Direct evidence of the exact fact, current per policy | Published PMJAY package rate for procedure X |
| `ESTIMATED` | Range derived from evidence of a *comparable* fact | `InrCostRange` from a tariff sheet, `ESTIMATED` with confidence |
| `UNKNOWN` | No evidence, or stale evidence | default |
| `NOT_DISCLOSED` | The institution withholds it (`priceTransparencyStatus`) | private hospital without a public tariff |

Financial factor (`SF-FIN-EXPOSURE`), advisory only:
- The output is a range, `{minInr, maxInr, level, evidenceRefs}`. **A point estimate is never produced.** The `medianInr` field in `InrCostRange` is not surfaced as "patient will pay".
- The range is produced only if the case has a *procedure code* that matches `standardEmergencyProcedures`. The engine does **not** infer a procedure from the capability list. If there is no match, the result is UNKNOWN.
- Deposit: `depositRequired` is reported with its evidence. If `statutoryWaiverApplies` is KNOWN true for an emergency, it is surfaced next to it.
- The existing trace field `financialExposureRisk: LOW|MODERATE|HIGH|UNKNOWN` requires a threshold against the patient's budget. It is computed **only** when both the budget and a KNOWN or ESTIMATED range exist, and is UNKNOWN otherwise.

Insurance factor (`SF-INS-COMPAT`) has separate sub-facts, which are never collapsed into one:
1. `hospitalEmpanelled(scheme|tpa)`: from `HospitalInsuranceProfile`. This is network evidence only.
2. `patientPolicyKnown`: from `PatientInsuranceProfile.payerType ≠ UNKNOWN`.
3. `specialtyCovered`: `empanelledSpecialties` ∩ required caps. This needs a specialty↔capability map, which does not exist yet, so it is UNKNOWN.
4. `excludedProcedure`: from TPA `excludedProcedures`.
5. `cashlessDeskAvailableNow`: `emergencyCashlessDeskAvailable` / `deskOperational24x7`.
6. `preauthMode`.

`INSURANCE_COMPATIBILITY` is `COMPATIBLE_EVIDENCED` only when 1, 2, and 5 are KNOWN-positive and 4 is KNOWN-negative.
It is `INCOMPATIBLE_EVIDENCED` when 1 is KNOWN-false for the patient's payer. It is UNKNOWN in every other case.
"Empanelled" on its own is **never** reported as "covered". `PatientInsuranceProfile.cashlessFeasibility` is a
patient-side claim, and it is shown with its provenance, not treated as confirmed.

## 11. Decision-trace integration

Reuse `DecisionTraceRecord`, `CandidateEvaluationTrace`, and `DecisionRuleEvaluation`. These are AG-01 types that are not yet used anywhere,
so small **additive** changes are safe:

| Change | Why |
|---|---|
| `DecisionRuleEvaluation.outcome: ConstraintOutcome` (added). `passed` is kept and derived as `outcome === 'PASS'` | A boolean cannot represent UNKNOWN or NOT_APPLICABLE |
| `DecisionRuleEvaluation.evidenceRefs: EvidenceRef[]` (added). `evidenceSnapshot` is kept, optional | References into the immutable snapshot instead of copying mutable values |
| `CandidateEvaluationTrace.overallScore` → **optional, `@deprecated`**, never populated by this engine | Required by the "no hospital scores" rule. It is currently required, so this is the one non-additive tweak. Nothing reads it yet. |
| `CandidateEvaluationTrace.verdict: FeasibilityVerdict` (added). `isEligible` is kept and derived as `verdict === 'ELIGIBLE'` | INDETERMINATE vs PENDING must be visible |
| `clinical.matchPercentage` → deprecated, not populated | A percentage invites the kind of partial-credit reasoning the "no scores" rule forbids |
| `transit` fields → allow `UnknownFact` (e.g. `etaMinutes: number \| null` plus `etaStatus`) | Fixes D1 at the type level |
| `DecisionTraceRecord.snapshotId`, `snapshotHash`, `policyVersion`, `engineVersion`, `evaluatedAt`, `outcome` (added) | Replayability. The trace references the snapshot, not live state. |
| `auditHash` = sha256(canonical trace JSON without `auditHash`, `advisoryExplanation`) | `advisoryExplanation` (AI) is outside the hash, so AI text can never be confused with the audited decision |

What the trace answers:
- **Why eligible?** Every rule PASS, with evidenceRefs.
- **Why rejected?** `blockingReasons` plus the FAIL rules.
- **What evidence was used, and when was it observed?** `EvidenceRef.observedAt`.
- **How fresh was it?** `ageSeconds` and `freshness`.
- **Which rule blocked it?** `ruleId`.
- **Was the result deterministic?** `snapshotHash` + `policyVersion` + `engineVersion`. Re-running `evaluate(snapshot)` must give an identical trace, excluding `traceId` and `auditHash` inputs.

Storage: local keeps an append-only `Map<caseId, DecisionTraceRecord[]>` (capped). AWS stores items `PK=CASE#id, SK=TRACE#ts#traceId` in the existing table.
A **new event** `decision.trace.recorded` (payload: `{traceId, caseId, outcome, selectedHospitalId?}` only, not the full trace) goes into
`packages/event-schema`, as the "event centralization" rule requires. It is added to the union, so existing consumers are unaffected.

## 12. Real-time re-evaluation event matrix

The engine is invoked **only where the state engines already make eligibility decisions**, plus one debounce. It never creates new routing triggers.

| Event | Existing behavior | Re-evaluate? | Scope | Notes |
|---|---|---|---|---|
| `care.requirement.created` | evaluate → candidates → requests | **Yes** (replaces `evaluateHospitals`) | case | Requests are issued to verdict ∈ {PENDING_ACCEPTANCE, ELIGIBLE}. INDETERMINATE and INELIGIBLE are not asked (same set as today, see §17) |
| `hospital.acceptance.received` ACCEPTED/LIMITED | `ensureDestination` if the ambulance has no destination | **Yes**, for case C only, inside `withAmbulanceLock` | case | Does **not** preempt an existing destination. Keeps today's no-flapping behavior. |
| `hospital.acceptance.received` REJECTED | reroute if the destination is H for case C | **Yes**, only when the reroute fires | case | |
| `hospital.acceptance.received` UNAVAILABLE | reroute all ambulances heading to H | **Yes**, per affected case | cases heading to H | |
| `hospital.acceptance.expired` | state → UNKNOWN, reroute | **Yes**, per affected case | as today | |
| `hospital.capacity.updated` → UNAVAILABLE for a needed unit | reroute (predicate) | **Yes**, per affected case | as today | Selection now also excludes *other* hospitals with that unit UNAVAILABLE (D3) |
| `hospital.capacity.updated` → AVAILABLE/UNKNOWN | nothing | **No** automatic reroute. A trace is recorded only if a case is currently `NO_FEASIBLE_CANDIDATE` | — | Improvements never pull an ambulance away from a valid destination |
| `ambulance.location.updated` | position + arrival detection only | **No** | — | The invariant at `stateEngines.ts:483` is preserved. ETAs are refreshed lazily by the next real trigger. |
| `route.recalculated` / `destination.changed` | output events | **No** (they are outputs, so reacting would loop) | — | |
| `ambulance.dispatched` | `ensureDestination` | **Yes** (via ensureDestination) | case | |
| `patient.requirement.changed` | **does not exist** | Future: yes | case | Must be added to event-schema first. Not in scope. |
| `insurance.status.changed` | **does not exist** | Future: advisory re-trace only, never a reroute | case | Not in scope |
| Periodic tick | `checkAcceptanceExpiry` every 2s | Only through the expiry path above | — | |

Debounce: re-evaluations for the same case are coalesced inside the existing per-ambulance lock. A trigger that arrives while an
evaluation is in flight marks the case dirty, and **one** follow-up evaluation runs with a fresh snapshot. `epoch` checks stay as they are.

## 13. Routing integration

```
FeasibilityEngine.stageA(snapshot)                     // pure, no mapping
  → survivors = verdict ≠ INELIGIBLE
TransportEnricher(survivors, origin)                   // @jiva/mapping, bounded concurrency
  → EvidenceRecord<ETA> | UnknownFact(ROUTE_FAILED)    // never 0 on failure (D1)
FeasibilityEngine.stageCD(snapshot + etas)             // temporal rule + ordering + trace
routing (commitDestination) consumes selectedHospitalId only
```

- The mapping provider gets **no** capability, acceptance, or clinical data. The call signature stays `calculateRoute(RouteRequest)`.
- The enricher records `provider`, `synthetic`, `trafficAware`, and `calculatedAt` as ETA evidence. A `mock`/`fallback` ETA is labeled in the trace.
- `commitDestination` still computes the committed route. The enricher's ETAs are for ordering only, and they may be the same provider call cached by `(origin rounded, hospitalId, 60s)`.
- The AWS lambdas (`emergencyProcessor`, `hospitalAcceptanceProcessor`) switch to the same engine through the adapter. That fixes D7 and D8 as a parity task (§17, step 7).

## 14. AI boundary

- The engine package has **no dependency** on `@jiva/intelligence`. A test enforces this with a package.json and import-graph check.
- AI reads `DecisionTraceRecord` through `AdvisoryContextInput.decisionTrace` and can write only `advisoryExplanation`, which is outside `auditHash`.
- AI output never feeds back into a snapshot. `assertAdvisoryAuthorityOnly` gets `override_feasibility` and `select_destination` added to its prohibited patterns.
- AI summaries must quote verdicts and reason codes as they are. A prompt contract test checks that an advisory never says "available" for an HC-ACC-04 UNKNOWN candidate.
- There is no AI in requirement derivation. `assessRequiredCapabilities` remains a deterministic rule and is labeled `RULE_DERIVED`.

## 15. Files and modules to implement (after approval)

New:
- `packages/domain-models/src/feasibility.ts`: all types in §4, `ReasonCode`, `UnknownFact`, `EvidenceRef`.
- `packages/feasibility/` (new workspace package, pure):
  - `src/policy.ts`: `FreshnessPolicy` v1 plus `policyVersion`
  - `src/capabilityMap.ts`: `CapabilityType` ↔ `Capabilities` key map, explicit and total (replaces the camelCase regex). It must also resolve the missing `ventilator` key (see A6).
  - `src/rules/clinical.ts`, `rules/operational.ts`, `rules/acceptance.ts`, `rules/temporal.ts`, `rules/patientDeclared.ts`
  - `src/factors/{transport,financial,insurance,freshness}.ts`
  - `src/aggregate.ts` (verdict function), `src/order.ts` (lexicographic key)
  - `src/trace.ts` (builds `DecisionTraceRecord`, canonical JSON, hash)
  - `src/index.ts`: `evaluateHardConstraints`, `finalizeDecision`
- `services/api/src/feasibility/snapshotAssembler.ts`: store → frozen snapshot (runs promotion guards)
- `services/api/src/feasibility/acceptanceLedger.ts`: per-(case,hospital) projection
- `services/api/src/feasibility/transportEnricher.ts`
- `services/api/src/feasibility/traceStore.ts` (local plus Dynamo implementation behind the existing `IStateStore` pattern)

Modified (thin):
- `services/api/src/eligibilityEngine.ts`: `evaluateHospitals` becomes an adapter returning the legacy `HospitalCandidate[]`
- `services/api/src/stateEngines.ts`: feed the ledger from the existing handlers, and publish `decision.trace.recorded`
- `packages/domain-models/src/decisionTrace.ts`: the additive changes in §11
- `packages/event-schema/src/events.ts`: `DecisionTraceRecorded`
- `packages/intelligence/src/contracts.ts`: two added prohibited patterns
- `docs/hospital-availability-protocol.md`: fix D12
- (later step) `lambdas/*`, `routingEngine.ts`

## 16. Required tests

Pure-engine unit tests (`tests/unit/feasibility-*.test.ts`, run with tsx like the existing ones):
1. **Hard beats soft:** a 5-minute non-trauma hospital vs a 25-minute trauma hospital → the near one is INELIGIBLE/INDETERMINATE and the far one is ordered first.
2. **Absent ≠ false:** capability key absent → UNKNOWN → INDETERMINATE. Explicit `false` → INELIGIBLE.
3. **No historical promotion:** 500 historical ICU beds with `icu: UNKNOWN` → no HC-OPS PASS attributable to beds. A PUBLIC_LISTED operational input throws.
4. Every row of the acceptance table in §9, one test each, including a LIMITED response that omits ICU.
5. **Per-case acceptance (D5):** H accepts A, then H answers B → A is still ELIGIBLE.
6. Expiry boundary: `evaluatedAt === validUntil` → expired. One millisecond earlier → valid.
7. **ETA unknown sorts last (D1):** a route failure never produces ETA 0.
8. Required unit UNAVAILABLE on a *non-destination* hospital excludes it from selection (D3).
9. Freshness: a stale positive capacity → UNKNOWN. Each policy class is tested at its boundary.
10. **Determinism:** the same snapshot evaluated 100 times, with shuffled candidate array order, gives an identical ordered result and hash.
11. **No wall clock:** the engine runs with `Date.now` stubbed to throw.
12. **No composite score:** a structural test that `CandidateFeasibility` and new traces contain no `overallScore` and no `matchPercentage`.
13. Financial: no evidence → UNKNOWN. A range is never a point value. Empanelled without patient policy → insurance UNKNOWN.
14. Emergency financial non-blocking: a CRITICAL case with a declared cashless requirement → HC-PAT-01 is NOT_APPLICABLE.
15. Care window NOT_APPLICABLE when absent. When present and ETA UNKNOWN → UNKNOWN (not PASS).
16. Import-graph test: `packages/feasibility` imports neither `@jiva/intelligence` nor `@jiva/mapping`.

Integration:
17. `simulate:full:blr` passes unchanged (flagship regression gate).
18. Legacy projection: `hospital.candidate.generated` payloads for the flagship scenario are identical before and after the change (golden file), apart from the D1/D3 fixes, which are asserted separately.
19. Existing `event-ordering`, `idempotency`, `parity`, `mapping-parity`, and `api-runtime` suites stay green.
20. Ledger replay: rebuilding from `events/history` gives the same ledger as the live one.

## 17. Migration and backward compatibility

1. **Shadow mode first.** `FEASIBILITY_ENGINE=shadow` (default): the legacy `evaluateHospitals` still decides, while the engine runs alongside it and logs and stores traces. A diff logger records any verdict disagreement. `=on` switches decisions to the engine, and `=off` disables it entirely.
2. The event schemas used by the UIs are unchanged. `decision.trace.recorded` is purely additive.
3. `HospitalCandidate` and `hospital.candidate.generated` are unchanged, with INDETERMINATE projected to INELIGIBLE.
4. **Intentional behavior changes** are listed and each needs explicit approval:
   - D1: unknown ETA no longer sorts first.
   - D3: other hospitals with a needed unit UNAVAILABLE are excluded.
   - D4: a LIMITED response that omits a required capability is no longer routed to. **This changes `scripts/simulate-hospital-response.ts`**, where HOSP-BLR-002 answers LIMITED with `[EMERGENCY, TRAUMA]` and "ICU capacity limited" for a case that may need ICU. The flagship `simulate-full` and the hospital UI echo `requiredCapabilities`, so they are unaffected.
   - D5: per-case acceptance.
   - D6: capacity expiry.
5. The request-issuance set is unchanged (capable and not unavailable). INDETERMINATE hospitals are **not** asked, as today.
6. `routingEngine.calculateBestHospitals` is kept as a shim until the lambdas are migrated.
7. AWS parity (D8) is a separate, later step: the lambdas move to the same pure engine plus a Dynamo-backed ledger. Until then, docs state that the AWS acceptance path is not at parity.
8. The frozen tag and the PPT are untouched. All work stays on `jiva-intelligence-expansion`.

## 18. Risks and unresolved ambiguities (need decisions)

| # | Question | My recommendation |
|---|---|---|
| A1 | Should INDETERMINATE hospitals be *asked* for acceptance, so a response with `acceptedCapabilities` could resolve the unknown? | Not in v1, to stay conservative and match today. Revisit when the canonical data is used live. |
| A2 | Should LIMITED responses with missing capabilities be INELIGIBLE (my proposal, changes one simulator script) or kept as today? | INELIGIBLE. It is the hospital's own statement. |
| A3 | Stale **negative** capacity evidence: should it keep blocking or drop to UNKNOWN? | Drop to UNKNOWN (it no longer blocks). Acceptance still gates the case, so safety is kept. The alternative leaves hospitals blocked forever. Needs ops sign-off. |
| A4 | Freshness default values (30 min capacity, 60 min acceptance cap, etc.) | These are placeholders and need clinical-ops sign-off. They are versioned, so they can change without code changes. |
| A5 | Should a `requestId` mismatch on a response be rejected? | Warn in v1. Reject after the UIs are verified to always send it. |
| A6 | `ventilator` exists in the data and in `CapabilityType` but not in the `Capabilities` interface | Add it to `Capabilities` (additive). Until then, HC-CLIN-01 for VENTILATOR is UNKNOWN. |
| A7 | Required capabilities are regex-derived from free text (`assessRequiredCapabilities`) | Keep, label `RULE_DERIVED`, and do not extend. Any clinician-confirmed requirement path is a separate phase. |
| A8 | Care window: no defensible source exists | Do not implement HC-TMP-01 logic beyond NOT_APPLICABLE until a clinician-supplied, provenance-bearing window exists. |
| A9 | `NO_FEASIBLE_CANDIDATE`: what does the dispatcher see? | Today it is `destination.changed → UNASSIGNED`. Keep that, and add the trace. Escalation UI is out of scope. |
| A10 | The AWS acceptance processor is already out of parity (D8) | This is a pre-existing defect. Fix it in its own step, not silently. |
| R1 | Evaluating traces on every trigger could create large volumes | Store a capped history, and emit only a summary event. |
| R2 | Synthetic demo data looks authoritative | Every EvidenceRef carries `SYNTHETIC_DEMO`, and coverage counts it separately. |
| R3 | 7 canonical facilities | `coverage` is shown on every decision. The engine never claims "no hospital in Bengaluru can take this". It says "none of N evaluated". |

## 19. Must NOT be implemented yet

- Any composite or weighted hospital score, percentage match, or "quality" ranking.
- Care-window rule logic, survival or outcome estimates, or any clinical timing constant.
- Financial calculator logic beyond range passthrough. No procedure inference, no point estimates.
- Insurance specialty↔capability mapping, or treating empanelment as coverage.
- `HC-PAT-01` patient-declared mandatory constraints (types only, behind a flag).
- New events `patient.requirement.changed` and `insurance.status.changed`.
- Preemptive rerouting to a "better" hospital when the current destination is still valid.
- Re-evaluation on GPS telemetry.
- AI anywhere in the evaluation path, including requirement derivation.
- AWS lambda migration (a separate step, after local is proven).
- Changes to the acceptance event payloads, auth/RBAC, the realtime transport, the frozen tag, the demo scripts' default behavior, or the PPT.

## 20. Recommended implementation sequence

Each step ends with `npm run build`, `npm test`, and `npm run simulate:full:blr` green.

1. **Types only.** Add `feasibility.ts`, the additive `decisionTrace.ts` changes, `Capabilities.ventilator`, and `DecisionTraceRecorded` in event-schema.
2. **Pure engine, Stage A**, plus `capabilityMap`, `policy`, and `aggregate`, with unit tests 1–6 and 9–12. There is no service wiring yet.
3. **Acceptance ledger projection** in services/api, fed by the existing handlers with no behavior change, plus the replay test (20).
4. **Snapshot assembler, transport enricher, Stage C/D ordering, and trace builder**, plus tests 7, 8, 13–16.
5. **Shadow mode wiring** in `care.requirement.created` and `selectDestination`, with a disagreement log and trace store. Run the demo and review the diffs.
6. **Approval gate**, then flip to `FEASIBILITY_ENGINE=on`. Apply the approved D1/D3/D4/D5/D6 behavior changes one commit at a time, each with its own test. Update the protocol doc (D12).
7. **AWS parity:** lambdas use the engine, with a Dynamo-backed ledger and trace store. Parity tests are extended.
8. **Advisory integration:** AI explains traces, gets the added prohibited patterns, and passes the prompt contract test.

— End of proposal. Stopping here for approval. —

---

## Phase 2 — D8 local/AWS parity + feasibility trace event (2026-09-27)

Status: **the engine is still SHADOW-ONLY.** Nothing below promotes it to decision authority.

### Corrections to earlier sections

| Earlier text | Now |
|---|---|
| §5 HC-CLIN-01: a response may satisfy a capability | A current, case-scoped response may resolve an **UNKNOWN** capability. It can **never override an explicit `false`** listing (the contradiction is recorded; still INELIGIBLE). Reason: the demo hospital UI echoes the requested capabilities into `acceptedCapabilities`, so a positive there is not independent evidence. |
| §11 event `decision.trace.recorded` (summary only) | Renamed **`feasibility.trace.recorded`** ("decision" implies authority) and carries the full constraint / ordering / evidence-reference record, without free text (see below). |
| §0 "`decision.trace.recorded` is not emitted in shadow mode" | Now emitted (observability only). `FEASIBILITY_TRACE_EVENTS=off` silences publication. |
| Requirement provenance | Was derived from the source *id* (an unknown source could be labelled CLINICIAN_CONFIRMED). Now `RULE_DERIVED` unless the event's source *type* is `clinician`. |

### D8 — one implementation, two environments

Rule: no second AWS implementation of any decision algorithm. Shared modules:

| Concern | Shared module (used by local **and** AWS) |
|---|---|
| Acceptance response / capacity update state rules (stale, expired-on-arrival, watermarks, provenance) | `services/api/src/stateTransitions.ts` (`applyAcceptanceResponse`, `applyCapacityUpdate`, `capacityLossAffectsCase`) |
| Requirement assessment, request-target boundary (INDETERMINATE ⇒ INELIGIBLE ⇒ not requestable, A1), request payload, destination pick | `stateTransitions.ts` (`assessRequiredCapabilities`, `selectRequestTargets`, `buildAcceptanceRequest`, `selectionRequirement`, `pickLegacyDestination`) |
| Legacy candidate evaluation | `eligibilityEngine.ts` (now takes optional `{hospitals, mapping, nowMs}`; defaults preserve local behaviour) |
| **Feasibility engine, freshness policy, ordering, trace** | `packages/feasibility` (pure) |
| Snapshot assembly, transport enrichment, ledger, shadow runner, trace event | `services/api/src/feasibility/*` |
| Submission RBAC | `services/api/src/authorizationPolicy.ts` (pure; local API and AWS ingestion) |

AWS handlers are now thin wirings (`lambdas/*.ts`) over factories in `lambdas/core/*` that take `{store, bus, mapping, shadow}`, so the same code runs against DynamoDB/EventBridge and against in-memory doubles in tests.

**Per-path audit (AWS before → after):**

| AWS path | Before | After |
|---|---|---|
| `hospitalAcceptanceProcessor` — acceptance | no watermark, no already-expired check, no `acceptanceCaseId`, wrong provenance, no duplicate-responseId check | shared transition; duplicate responseId detected from history (earliest event wins, no symmetric drop) |
| — capacity update | **not handled at all** (hospital status never changed) | handled: shared transition + shared reroute predicate |
| — reroute / assignment | first responder assigned; reroute via `calculateBestHospitals` with fake case `sys-case` (would break once `acceptanceCaseId` is set) | shared legacy pick with the real case id; same reroute triggers as local; per-ambulance task failures contained |
| `emergencyProcessor` | requirement hard-coded, `careRequirements=[condition text]`; candidate evaluation read an **empty in-memory store** inside Lambda; requested from UNAVAILABLE hospitals | shared assessment; hospitals read from the state store; shared request-target boundary; requests recorded in history before publication |
| `ambulanceProcessor` — dispatch | no destination assignment from an existing acceptance; previous destination carried over | mirrors local (needs `PutEvents` grant — added in CDK) |
| `ingestion` | any authenticated caller could post any event type; no schema check, no correlation guard, logged full payloads | schema validation, future-timestamp check, RBAC, acceptance-correlation 409 (needs read grant — added in CDK); unknown/system types (incl. the trace event) are never submittable |
| `DynamoStateStore.setHospital` | ordering guard stamped `now` on capacity-only writes ⇒ a later-processed acceptance with an earlier `respondedAt` was **silently dropped** | guard reflects hospital-confirmed time only (`1970-01-01…` floor when none) |
| `websocketHandler` / CDK `RealtimeBroadcastRule` | broadcasts every event to every socket | trace events excluded (rule + handler) |

**Deliberately unchanged (frozen legacy behaviour, both environments):** legacy D1 (ETA 0 on route failure), D2, D3, D5 (hospital-level acceptance slot, last writer) and D7 (`calculateBestHospitals` fake case). They remain visible as shadow disagreements and change only if/when the engine is promoted.

### `feasibility.trace.recorded`

* **Emitter:** `FeasibilityShadow.emitTrace`, called strictly after the decision is final. Its result/failure is never read back; failures are counted and swallowed; a demo reset mid-evaluation drops the event.
* **Envelope:** `source = system/feasibility-shadow`; **no `patientId`** (it would route the event to patients); `causationId` = triggering event when that is a uuid.
* **Payload:** `mode: 'SHADOW'`, `authority: 'NONE'` (schema literals — a trace cannot claim authority), case / trace / decision ids, `snapshot {id, hash}`, `auditHash`, effective freshness policy (version, label, per-class rules), engine version, `evaluatedAt`, trigger, requirement (capability codes + provenance), outcome, coverage, and per candidate: verdict, order position + order key, blocking reasons, every hard-constraint result (`ruleId`, outcome, `reasonCode`, evidence references with freshness/timestamps) and soft-factor levels.
* **Excluded on purpose:** patient condition/severity/location, financial and insurance context, hospital names, and **every externally supplied string** (see *Privacy* in Phase 3 below; enforced structurally, not by a blacklist).
* **Size:** above 200 kB it degrades to `SUMMARY` (no evidence references), then drops the lowest-ranked candidates (`candidatesOmitted`); `coverage.evaluated` stays exact.
* **Visibility:** MANAGEMENT/ADMIN only (realtime, history, `/api/feasibility/shadow`); never patient/hospital/ambulance — including the ambulance *assigned to the case*, which the generic case-based rule would otherwise have admitted. Excluded from the AI sidecar's event history. Submittable by **no** role.
* **AWS:** recorded in the Dynamo event history (audit), published to the bus, and **no EventBridge rule targets it** (the broadcast rule excludes it).
* **Why it cannot affect a decision:** (1) emitted after the result; (2) no subscriber exists (a test asserts listener count 0 plus a static scan of every file that mentions it); (3) the ledger replay consults exactly two event types; (4) re-evaluating with the trace in the history yields the identical snapshot hash; (5) a sink that mutates its input or throws leaves the returned decision byte-identical; (6) publishing it locally changes no store and triggers no other event.

### Configuration

`FEASIBILITY_ENGINE=off|shadow` (default `shadow`; `on` is not accepted and runs as shadow) · `FEASIBILITY_TRACE_EVENTS=off` · `FEASIBILITY_POLICY_OVERRIDES='{"OPERATIONAL_CAPACITY":{"maxAgeSeconds":900}}'`. Freshness defaults are labelled *configurable prototype defaults — not clinical guarantees* in code, in `/api/feasibility/shadow`, and in every trace event.

### Known limitations

1. **AWS was never exercised against real DynamoDB/EventBridge/Lambda.** Parity is proven with the real lambda cores over in-memory store/bus doubles wired by the CDK's rules (a drift test compares the rule lists with `aws-stack.ts`). `cdk synth` succeeds.
2. **Lambda packaging is broken independent of this work:** `Code.fromAsset(services/api/dist/lambdas)` ships only that folder, so imports of sibling modules and `@jiva/*` workspace packages cannot resolve at runtime. It needs a bundling step (e.g. `NodejsFunction`/esbuild). Not changed here.
3. **No acceptance-expiry sweeper on AWS** (local runs `checkAcceptanceExpiry` every 2 s: state → UNKNOWN, `hospital.acceptance.expired`, reroute). Shadow traces are unaffected (expiry is evaluated at read time from `validUntil`); the legacy AWS state/reroute on expiry is not at parity. Needs an EventBridge Scheduler target.
4. AWS also lacks arrival detection (`ambulance.arrived`) and GPS ordering watermarks — not feasibility-related, left as is.
5. The AWS ledger reads the case's events plus the 500 most recent events; a hospital-wide `UNAVAILABLE` older than that window is not seen by the shadow. Acceptable for shadow; a per-hospital index is needed before promotion.
6. The internal `DecisionTraceRecord` (served to management at `/api/feasibility/shadow`) still contains hospital-supplied `limitations` text inside the acceptance factor summary (`responderRole` and source strings were removed in Phase 3). It is excluded from the event, but any future AI consumer must treat trace text as untrusted input.
7. The running local API must be **restarted** to expose the new endpoint and events (an API started before this change returns 404 for `/api/feasibility/shadow`).

---

## Phase 3 — promotion-readiness remediation (2026-09-27, still SHADOW-ONLY)

The engine remains `FEASIBILITY_ENGINE=off|shadow`. There is **no** authoritative mode, and nothing here changes a legacy decision. Blockers from the promotion-readiness audit, and what was done:

| # | Blocker | Status | How |
|---|---|---|---|
| 1 | Shadow/ledger failure could block legacy | **Fixed** | Local: legacy handlers run first (`applyLegacyAcceptance` / `applyLegacyCapacity`); the ledger update and every shadow call run in `finally` through `feasibility/containment.ts#observe`, which catches sync throws and async rejections. AWS: every shadow-side await (requirement-history read, evaluation, trace publish, held-destination observation) is wrapped in `observeValue`. Proven by `tests/unit/feasibility-containment.test.ts`: the real local engines and lambda cores, one variant per auxiliary component (throw, reject, hang, sink down, mapping down, malformed payload); the legacy transcript is identical to shadow-OFF. |
| 2 | AWS legacy depended on ledger replay | **Fixed** | The duplicate-`responseId` check degrades to "not a known duplicate" when history cannot be read (applying the same response twice is idempotent). `AcceptanceLedger.fromEvents` skips a malformed event on its own. Tested: throttled / missing / poisoned history, shadow on and off. Caveat: the **ingestion** lambda's 409 correlation guard still reads history and fails closed (5xx, retryable). That is a submission gate, not a decision. |
| 3 | A response could resolve unknowns with no valid request | **Fixed, in the engine** | `responseUsability()` (pure package): a positive response counts only if a non-cancelled, **current** request exists for the same case and hospital, the response names that request id, was made inside its `[requestedAt - 60 s, expiresAt]` window (60 s tolerates hospital clock skew; `respondedAt` is client-stamped), and carries trusted operational-grade provenance. Negative responses need no correlation (an unsolicited negative can only make the engine more conservative). |
| 4 | Live and replay ledgers could disagree | **Fixed** | The ledger stores a *set* of facts and derives everything at `view()` time, so state does not depend on arrival order or arrival clock. One ordering rule (`compareResponses`): later `respondedAt`; on an exact tie the more restrictive status wins (UNAVAILABLE > REJECTED > LIMITED > ACCEPTED); then `responseId`. The same `responseId` with different payloads is a CONFLICT and neither copy is used. ACCEPTED/LIMITED with `validUntil <= respondedAt` is INVALID; one that merely *arrives* late is kept and expired by the engine at evaluation time. Tested with 300 random histories and arrival orders: `live.snapshot() === replay.snapshot()` and identical views. |
| 5 | SYNTHETIC_DEMO / client-claimed provenance | **Fixed** | See *Trust boundary* below. |
| 6 | Legacy one-slot acceptance | **Isolated, NOT solved** | The engine never reads the legacy slot (tested). Legacy still keeps one acceptance per hospital, and a response for case B still overwrites case A's slot **in legacy state**. Changing that would change legacy decisions, which this phase must not do. The eventual authoritative seam must consume the per-case ledger, not the slot. |
| 7 | Free text in the trace event | **Fixed** | See *Privacy* below. |
| 8 | Policy not bound to hashes | **Fixed** | `hashPolicy()` = sha256 of canonical JSON of `{version, evidenceEnvironment, rules}`. It is in the snapshot (`policyHash`, part of `snapshotHash`), the decision, the trace record (`policyHash`, part of `auditHash`) and the trace event (`policy.hash`). The engine **refuses** a snapshot whose `policyHash` does not match the policy it is given. |
| 9 | No evaluation of the held destination | **Fixed (observation only)** | `FeasibilityShadow.observeDestination()` answers "is the destination this ambulance holds still feasible under the current evidence snapshot?". It stores a `DestinationObservation`, **not** a decision trace: no trace event, no legacy comparison, no state change, no reroute. Wired after the legacy decision on `hospital.acceptance.received` and `hospital.capacity.updated` (local and AWS); exposed at `GET /api/feasibility/shadow` as `destinationObservations`. |
| 10 | No shadow timeout | **Fixed** | `FeasibilityShadow` bounds each evaluation (`FEASIBILITY_SHADOW_TIMEOUT_MS`, default 2000, `0` disables) with a timer **in the service layer**; the pure package has no timers (asserted by a test). A timed-out evaluation is recorded as a `ShadowFailure{kind:'TIMEOUT'}` and its late completion stores and publishes nothing. |
| 11 | Test type safety | **Fixed** | `tests/tsconfig.json` + `npm run typecheck:tests`, included in `npm run typecheck`. `feasibility-ledger-shadow.test.ts` now uses a real `MappingProvider` implementation. One pre-existing file, `security-prompt-injection.test.ts` (6 errors, obsolete fixtures), is excluded explicitly with a comment rather than suppressed. |

### Trust boundary (evidence provenance)

Live evidence (capacity updates, acceptance responses) is graded by **who submitted it and where**, never by what it claims. `services/api/src/evidenceTrust.ts` derives the grade at the trusted ingestion adapter (local `POST /api/events`, AWS ingestion lambda) and stamps `event.metadata.trustedEvidence`, overwriting anything the client sent:

| environment | principal | derived status |
|---|---|---|
| DEMO | demo persona | `SYNTHETIC_DEMO` |
| PRODUCTION | demo persona | `UNVERIFIED` (demo auth is not a production identity) |
| any | real (non-demo) HOSPITAL principal | `HOSPITAL_CONFIRMED` |
| any | any other principal | `UNVERIFIED` |
| any | server-configured feed adapter (the `adapter` argument; none exists yet) | `AUTHORIZED_FEED` |

`metadata.sourceType`, `payload.source`, `responderRole` and similar are kept only as informational legacy fields. The snapshot assembler reads `trustedStatus`; an unstamped event is `UNVERIFIED`. The environment comes from `JIVA_ENVIRONMENT=demo|production`; if unset, a Lambda runtime (`AWS_LAMBDA_FUNCTION_NAME`) is **PRODUCTION** and everything else is DEMO. The environment is part of the policy, so it is in every hash. In PRODUCTION `SYNTHETIC_DEMO` cannot satisfy an operational rule (capacity, acceptance, or a synthetic capability listing); in DEMO it may support simulation.

**Operational consequence:** deployed AWS lambdas default to PRODUCTION, so with the current demo-only authentication their shadow verdicts will show UNKNOWN evidence until `JIVA_ENVIRONMENT=demo` is set on them or a real identity provider is wired. The CDK stack was deliberately not changed in this phase. Legacy decisions are unaffected either way.

Residual limits: the trust of *seeded* hospital record data (capability listings, locations) is whatever the data pipeline labelled it; untimed seeded operational state can never assert current status whatever its label.

### Privacy of `feasibility.trace.recorded`

There is no blacklist. Every field of the event is one of: an enum, a code produced by the engine, a hash, a timestamp that parses as an instant, a number, or an id passed through `opaqueId()` (kept only if it has the shape of an id, otherwise replaced by a one-way hash). The evidence-reference schema is `.strict()` and has **no free-text `source` field** any more; `dataStatus` must be a canonical status (else `UNVERIFIED`); capability codes must be canonical (others are counted in `unrecognizedCapabilityCount`, never echoed); the trigger carries `sourceType` (an enum), not `sourceId`. Removed: `responderRole`, limitation text, arbitrary source strings, trigger source ids. Tested with an adversarial injection through every client-controlled field and an allow-list audit of every string leaf in the wire format.

### P2 — coverage audit (no behaviour changed)

* `assessRequiredCapabilities` runs at `stateEngines.ts` (`patient.emergency.created` handler) and `lambdas/core/emergencyCore.ts`; it emits `care.requirement.created`. The shadow records and uses its **output** as the requirement, but does not evaluate the derivation: it is a pure regex over free text with no second implementation to compare against, and the engine deliberately labels it `RULE_DERIVED`. A shadow comparison would only be possible against a clinician-confirmed requirement, which does not exist.
* `hospital.candidate.generated` ordering **could** be compared (the shadow receives the legacy candidate list in order and holds the engine's order), but it would flood the disagreement log with legacy D1/D7 noise (ETA 0 on route failure, hard-coded severity). Not added; per-hospital verdicts and the selected hospital are compared.
* `calculateBestHospitals` has **no production caller**; its only caller is `tests/integration/mapping-parity.test.ts`. `scripts/simulate-mapping.ts` calls `evaluateHospitals` directly.

### Remaining promotion blockers (after Phase 3)

1. Legacy one-slot acceptance is still authoritative (blocker 6); the authoritative seam must use the per-case ledger.
2. AWS was never run against real DynamoDB / EventBridge / Lambda; conditional-write concurrency is untested. Lambda packaging is broken independent of this work (Known limitations, item 2).
3. AWS ledger/history reads are unindexed (case events + latest 500).
4. The deployed-environment posture must be decided (`JIVA_ENVIRONMENT`, a real identity provider, and the policy on `UNVERIFIED`/`HISTORICAL` static listings still counting for the capability rule).
5. Cancellation of acceptance requests is defined and enforced by the engine, but **no producer emits it** yet.
6. A shadow soak with every disagreement explained, and the fail-closed / kill-switch design for an authoritative mode (not built).
