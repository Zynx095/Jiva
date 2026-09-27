# Care Feasibility Engine — promotion preparation (2026-09-27)

**The engine is SHADOW-ONLY.** `FEASIBILITY_ENGINE` accepts `off` and `shadow`; any other value (including `authoritative`) fails safe to `shadow`. Nothing in this document enables or implements an authoritative mode. This is the readiness ledger for a *future* decision.

## 1. AWS readiness matrix

Only what was actually demonstrated is marked. There is **no AWS CLI and no AWS credentials** on this machine (`aws` not found, no `AWS_*` variables, no `~/.aws`), so nothing past *package-load verified* could be attempted.

| Stage | Status | Evidence |
|---|---|---|
| **IMPLEMENTED** | ✅ | Lambda cores (`services/api/src/lambdas/core/*`), ingestion with the same rules as the local API, trusted-evidence stamping, CDK stack. |
| **SYNTHESIZED** | ✅ | `cdk synth` exits 0. All 7 functions use the new self-contained asset (`infrastructure/aws/lambda-dist`), runtime `nodejs20.x`. |
| **PACKAGE-LOAD VERIFIED** | ✅ | The artifact built by `npm run build:lambdas` **and the actual asset directory CDK produced in `cdk.out`** were copied to a folder outside the repository with no `node_modules`; all 7 handlers `require()` and export a function; the ingestion handler was executed there (401 unauthenticated, 400 unknown type, 400 schema-invalid, 403 hospital-dispatching), exercising the bundled zod schemas, auth and RBAC. |
| **PACKAGE-EXECUTED against AWS services** | ❌ not done | The processors were not executed from the artifact: they need DynamoDB/EventBridge. Their logic *is* executed in-repo by the lambda-parity and containment tests over in-memory store/bus doubles wired by the CDK's rules. |
| **DEPLOYED** | ❌ no | No credentials/account access. Nothing was deployed. `demo:check` says "NOT deployed". |
| **LIVE-TESTED** | ❌ no | Nothing ran on real DynamoDB / EventBridge / Lambda / API Gateway / Cognito. DynamoDB conditional-write concurrency is unverified. |

### Lambda packaging (what was wrong, what changed)

* **Was:** `Code.fromAsset(services/api/dist/lambdas)` shipped only that folder. `./core/*`, `../infrastructure/*` and `@jiva/*` could not resolve at runtime, and `tsc`'s extensionless ESNext imports do not load in Node even in place. `demo:check` only tested that a file existed.
* **Now:** `scripts/bundle-lambdas.mjs` (esbuild, already a dependency of `tsx`) bundles each entry in `services/api/src/lambdas/*.ts` into one self-contained CommonJS file (`node20`, no minify, no sourcemap, `@aws-sdk/*` and `@jiva/*` bundled) in `infrastructure/aws/lambda-dist/` (git-ignored, generated). `npm run build` runs it after the workspace builds. Deterministic: two consecutive builds gave a byte-identical manifest (sha256 per file, written alongside; checked manually, not by an automated test). No absolute repository path is embedded.
* `demo:check` now spawns a fresh Node process per handler and requires it to load and export `handler`.
* Trade-off: each file is ~1.3–1.8 MB (SDK bundled) instead of relying on the runtime-provided SDK; that pins versions and makes the artifact self-contained. Not deployed, so cold-start impact is unmeasured.

## 2. History model — assessment

The AWS ledger for a case is `queryEventsByCase(caseId)` (table Query on `PK = CASE#<caseId>`) **plus** `listRecentEvents(500)` (GSI1 `EVENTS#ALL`, newest first).

**What depends on history**

| Consumer | Uses | Authority |
|---|---|---|
| Shadow ledger (each evaluation) | requests, responses, cancellations for the case; hospital-wide `UNAVAILABLE` from other cases | shadow only |
| `loadRequirement` | latest `care.requirement.created` for the case | shadow only |
| `hospitalCore` duplicate-`responseId` check | events earlier than the current one | auxiliary; degrades to "not a known duplicate" when unreadable |
| Ingestion 409 guard | current request state for (case, hospital) | a submission gate; fails closed |
| Legacy hospital/ambulance state decisions | **nothing** — state is in the Dynamo items | authoritative today |

**Findings**

1. **Per-case history was unpaginated and eventually consistent.** A Query returns ≤1 MB per page in *ascending* sort-key order, so a long case silently lost its **newest** events (the responses). **Fixed in this phase:** `queryEventsByCase` follows `LastEvaluatedKey`, uses `ConsistentRead`, and *throws* rather than truncating (tested with a fake client).
2. **The 500-event window is NOT safe. Blocker.** A hospital-wide `UNAVAILABLE` sent for *another* case is only visible through the latest-500 window of *all* events. GPS pings alone push it out. Demonstrated by `feasibility-promotion-prep.test.ts`: with the same evidence the hospital is `INELIGIBLE` with complete history and `ELIGIBLE` with the window — the **unsafe** direction. An authoritative engine must not run on this.
3. **GSI1 is a single hot partition** (`EVENTS#ALL`) and is always eventually consistent (cannot be made consistent). The fallback path when GSI1 is missing is a `Scan` with `Limit` applied *before* the filter, i.e. arbitrary and nondeterministic. It must be removed or made an error.
4. Case partitioning depends on `correlationId || payload.caseId || patientId`. Acceptance and cancellation events carry `payload.caseId`, so they land in the case partition; capacity updates land in a per-event partition (they are not history-derived; the hospital item holds them).

**Minimum queryable data required for authoritative operation** (not implemented; no persistence redesign was done):

* **Per-(case, hospital) acceptance facts, complete and consistent:** the case partition, restricted to acceptance-protocol event types (an `ACC#` sort-key prefix or a filter), paginated, strongly consistent. *(pagination + consistency done; the type-scoped key is a refinement.)*
* **Per-hospital active hospital-wide `UNAVAILABLE`:** a tiny item keyed by hospital holding the newest `UNAVAILABLE` (`responseId`, `respondedAt`, `validUntil`) and the newest accepting `respondedAt`, maintained with a conditional write (max by `respondedAt`), read with a consistent `GetItem`. This replaces the cross-case window entirely.
* **Latest requirement per case:** an item or a type-scoped query.
* All of it is small and bounded by `validUntil`/TTL.

## 3. Environment and trust policy

| Variable | Values | Exact semantics |
|---|---|---|
| `FEASIBILITY_ENGINE` | `off` \| `shadow` (default `shadow`) | `off`: no shadow evaluation, no held-destination observation, no trace events (the ledger is still fed, contained and harmless). `shadow`: engine evaluates alongside legacy; **legacy is the only authority**. Any other value warns and runs as `shadow`. Read at each call locally (flip takes effect immediately, no restart). On AWS it is read when a Lambda execution environment is created (`createAwsDeps`): changing the function configuration takes effect on new environments. |
| `FEASIBILITY_TRACE_EVENTS` | `off` (else on) | `off` silences publication of `feasibility.trace.recorded` only; evaluation and in-memory traces continue. |
| `FEASIBILITY_POLICY_OVERRIDES` | JSON, e.g. `{"OPERATIONAL_CAPACITY":{"maxAgeSeconds":900}}` | Per-evidence-class freshness overrides on the prototype defaults. Invalid JSON → defaults with a warning. The **effective** policy (rules + environment) is hashed (`policyHash`) into every snapshot/audit hash, so an override changes the hashes even though the version string only says `+overrides`. |
| `FEASIBILITY_SHADOW_TIMEOUT_MS` | integer ≥ 0 (default 2000, `0` = none) | Wall-clock budget per shadow evaluation (service layer only). |
| `JIVA_ENVIRONMENT` | `demo` \| `production` | Explicit value wins. If unset: a Lambda runtime (`AWS_LAMBDA_FUNCTION_NAME`) is **production**, everything else **demo**. The value is part of the policy, hence of every hash. |

**DEMO — synthetic evidence is permitted to:** be graded `SYNTHETIC_DEMO` for every demo persona; satisfy operational capacity rules (PASS/FAIL), satisfy acceptance (a response stamped `SYNTHETIC_DEMO` resolves unknowns), and satisfy a `SYNTHETIC_DEMO` capability listing. It is always labelled (`dataStatus`, `coverage.withSyntheticEvidence`).

**PRODUCTION — synthetic evidence is forbidden from:** satisfying **any** operational rule: live capacity status (→ `UNKNOWN / EVIDENCE_NOT_OPERATIONAL_GRADE`), acceptance (→ `UNKNOWN / RESPONSE_EVIDENCE_NOT_TRUSTED`), and capability listings (→ `UNKNOWN / EVIDENCE_NOT_OPERATIONAL_GRADE`). A demo persona in production is graded `UNVERIFIED`. Tested in both environments.

**Production identity/trust requirement (not implemented; no identity provider was integrated).** Live evidence is graded from the *authenticated principal*, not from its claims. For production the ingestion adapter must be given a real, non-demo identity (`isDemo: false`) with: a HOSPITAL role bound to exactly one `hospitalId` (a hospital principal may only report on its own facility — enforced today by `authorizeEventSubmission`); a verified issuer (e.g. Cognito claims validated by API Gateway); and server-side configuration for any machine feed that may be graded `AUTHORIZED_FEED` (only the adapter argument can grant it, never a client field). Until then, production shadow verdicts on evidence from demo personas are `UNKNOWN` by design.

## 4. Static capability evidence policy (documented, NOT changed)

**Exact current behaviour** (pinned by a test): HC-CLIN-01 reads the hospital's capability *listing*. A listing whose `dataStatus` is `HISTORICAL`, `UNVERIFIED`, `PUBLIC_LISTED` or `HOSPITAL_CONFIRMED` is **used**: `listed === true` → `PASS / CAPABILITY_LISTED`, `listed === false` → `FAIL / CAPABILITY_NOT_PROVIDED`, unlisted → `UNKNOWN / NOT_LISTED`. Only `UNKNOWN` and `NOT_DISCLOSED` are unusable (`UNKNOWN / NOT_DISCLOSED`). `SYNTHETIC_DEMO` is usable only in DEMO. Staleness (older than the class's `maxAgeSeconds`, default 365 days) only *warns*; it does not invalidate a listing.

**Consequences.** (a) An `UNVERIFIED` or `HISTORICAL` listing can produce a capability PASS, and therefore contribute to `ELIGIBLE`, when a hospital does not actually provide the service — but `ELIGIBLE` still also requires fresh operational-grade live status *and* a valid acceptance for the case, and a `LIMITED` response must cover every required capability (HC-ACC-03), so a wrong listing cannot by itself select a hospital. (b) An `UNVERIFIED`/`HISTORICAL` explicit *negative* (`trauma: false`) produces a hard `FAIL`, so a stale "no" can exclude a hospital that now has the capability — the conservative direction. (c) A hospital can only *confirm* a capability the listing lacks through a valid exchange.

**Smallest safe policy change (not implemented):** treat listings with `dataStatus ∈ {HISTORICAL, UNVERIFIED}` as *unusable for PASS* (`UNKNOWN / EVIDENCE_NOT_OPERATIONAL_GRADE`) while leaving them usable for an explicit `FAIL` if desired — i.e. a positive claim needs `PUBLIC_LISTED` or better, a negative may come from anything. This is one condition in `ruleRequiredCapability` and one expected-value change in the pinned test. It should be decided together with the data-pipeline labelling of the 4 seeded hospitals, which is why it was not made silently.

## 5. Acceptance-request lifecycle and cancellation

```
requested ─► pending ─► ACCEPTED | LIMITED | REJECTED | UNAVAILABLE
   │             │                 │
   │             └─ expires ───────┴─ expires (validUntil)        [read-time, engine]
   ├─ superseded (a newer request for the same case+hospital)      [ledger: latest requestedAt wins]
   └─ cancelled (withdrawn by JIVA)                                [new event; consumer implemented, no producer]
```

* **Expired** — request: `expiresAt` (engine: `REQUEST_EXPIRED`); response: `validUntil` (engine: stale → `UNKNOWN`). Read-time, no event needed. The legacy `hospital.acceptance.expired` event only reflects the legacy hospital slot.
* **Superseded** — automatic: the ledger keeps every request and the *latest* `(requestedAt, requestId)` is current; a response naming an older id is `RESPONSE_REQUEST_SUPERSEDED`.
* **Cancelled** — **event:** `hospital.acceptance.cancelled` `{requestId, caseId, hospitalId, cancelledAt, reason ∈ CASE_CLOSED | DESTINATION_FINALIZED_ELSEWHERE | REQUIREMENT_CHANGED | OPERATOR_WITHDRAWN}`, defined in `event-schema` next to the other acceptance events. **Emitter (design):** the acceptance protocol (`source: system/acceptance-protocol`), never a client — it is not in `EXTERNAL_EVENT_TYPES` and no role can submit it (tested). **Triggers (design):** the case closes or the patient arrives; a destination is finalized at another hospital (its outstanding requests to others are withdrawn); the requirement changes; an operator withdraws. **Ledger effect (implemented):** a cancelled request is unusable — any response to it, before or after the cancellation, resolves nothing (`RESPONSE_REQUEST_CANCELLED`; with no response, `REQUEST_CANCELLED_NO_RESPONSE`); a *new* request starts a fresh exchange. Order-independent and identical live vs replay (tested). Local: an observation-only handler applies it to the ledger. AWS: replay reads it from history.
* **Not implemented — producer.** Deciding *when* to cancel means changing the legacy request/acceptance flow (new events emitted from legacy decision points, possibly changing what hospitals see). That alters legacy behaviour, so it is a **promotion blocker**, not a change made here. Today no cancellation is ever emitted; the consumer is inert and legacy is untouched (tested).

## 6. Kill switch and soak — how legacy is restored

There is no authoritative mode, so **the legacy path is already the only path that decides.** `FEASIBILITY_ENGINE=shadow` (the default) *is* "legacy continues": the engine observes and can never change a destination, request target, or reroute; `FEASIBILITY_ENGINE=off` additionally removes the observation. The mechanism a future promotion would rely on is proven now, for every failure class, on the real local engines and AWS lambda cores:

| Failure | Result (tested) |
|---|---|
| shadow throws (sync) / rejects / hangs forever | contained; legacy transcript identical to shadow-off |
| shadow timeout (slow provider) | abandoned within budget, recorded `TIMEOUT`, late completion stores/publishes nothing; legacy identical (local + AWS) |
| trace sink failure / trace generation failure | counted; the decision is still returned; legacy identical |
| policy mismatch (policy changes mid-evaluation, same version string) | engine refuses (`Policy hash mismatch`), classified, legacy identical |
| malformed evidence (garbage events on the bus, missing arrays, poisoned history) | contained / skipped; legacy identical |
| history unreadable (throttled / missing / poisoned) | shadow degrades; legacy identical |
| kill switch flipped **mid-flow** (`off`) | shadow activity stops at once, no restart; legacy identical |
| `FEASIBILITY_ENGINE=authoritative` / `on` / garbage | warns, runs as `shadow`; legacy identical |

**How to restore legacy:** locally, `FEASIBILITY_ENGINE=shadow` (or `off`) — read on every call, immediate. On AWS, set it on the Lambda functions' environment; new execution environments pick it up. Legacy code is intact and is the only decider in both.

**Soak instrumentation (implemented):** `GET /api/feasibility/shadow` returns `soak` `{started, completed, errors, timeouts, policyMismatches, traceSinkFailures, disagreements, wouldHaveFallenBack, legacyAuthoritative: true}`. `wouldHaveFallenBack` = evaluations a promoted engine could not have used. A soak is meaningful only with real (non-synthetic) evidence and, on AWS, complete history (see §2). Not yet run.

## 7. Remaining promotion blockers

1. **Legacy one-slot acceptance** is authoritative; an authoritative seam must consume the per-case ledger.
2. **AWS not deployed and not live-tested**; conditional-write concurrency on real DynamoDB unverified; processors not executed from the artifact against real services.
3. **History window** (§2): hospital-wide `UNAVAILABLE` needs a per-hospital consistent item; GSI1 fallback `Scan` must go; case history needs a type-scoped key.
4. **Environment/identity**: no production identity provider; deployed Lambdas default to `production` and would show `UNKNOWN` evidence until one exists or `JIVA_ENVIRONMENT=demo` is set deliberately.
5. **Static listing policy** (`UNVERIFIED`/`HISTORICAL` PASS) undecided (§4).
6. **Cancellation producer** not implemented (§5).
7. **Soak** not run; no fail-closed *adoption* logic exists (deliberately — it would be authoritative mode). Deployed-side `JIVA_ENVIRONMENT` decision. `simulate-*` scripts are demo-only and use demo personas.
8. Residual internal-trace text: the stored (management-only) `DecisionTraceRecord` still contains hospital `limitations` text in one factor summary.
