# JIVA — Persistence plan

Status: **plan, not implemented.** Every piece of runtime state in the local API lives in memory and is lost
when the process stops (finding R4 in [`security-review.md`](security-review.md) §5). Nothing here has been
deployed or provisioned. **No data survives an API restart today**, in demo or operational mode.

## 0. Evaluation on `feat/jiva-doctor-clinical-workspace` (2026-10-13)

The branch evaluated implementing the SQLite clinical store (§4 step 1) and **decided not to ship it in this
branch**. What was found:

1. **Transactional consistency needs a unit of work that does not exist yet.** Each clinical command today
   stores its record, records the canonical event (in-memory ledger + bus), then appends the audit entry and the
   idempotency result as separate steps, and rolls the record back if the event fails. A durable store must
   write record + event + audit + idempotency result in **one** transaction. With `node:sqlite` that transaction
   must be synchronous (an open transaction across `await` would let concurrent requests' statements join it),
   so every command handler (prescriptions ×5, reports ×2, notes ×2, documents ×3, vital signs ×2, pre-hospital
   ×2 + intake, arrival, handover, doctor) must be restructured into *prepare (pure) → one synchronous write →
   deliver to the bus*. That is a cross-cutting change to every clinical write path.
2. **The encounter projector is not replay-safe.** Encounters are projected from `encounter.*` events by a bus
   handler that also changes operational state (ambulance arrival, referral withdrawal, crew release). Recovering
   from a crash between "event persisted" and "encounter projected" needs the projector split into a pure
   clinical projection (safe to re-apply) and the operational effects (never re-applied).
3. **A clinical-only durable store would leave a split state after a restart.** Cases, referrals, ambulances
   and the event ledger would restart (re-seeded in demo mode, empty in operational mode) while encounters and
   records persisted. In the demo that means an old encounter for `CASE-BLR-876` blocks the next scenario's
   arrival (`already_recorded`) unless the operator resets first; in operational mode it is the safer failure
   (records are kept) but coordination state is still lost.

Given that scope, the branch implemented the **contract work** instead and documents the dependency:

- `tests/unit/clinical-store-contract.test.ts` — an executable conformance suite for `IClinicalStore` (lookups
  never cross an encounter or case, copies out, rollback helpers, bounds, ordering, reset keeps the roster).
  It runs against `LocalClinicalStore` today; a durable implementation must pass the same suite.
- New clinical data introduced by this branch (notes, pre-hospital entries, document versions and samples,
  prescription drafts and authorisations) is behind the same `IClinicalStore` interface — no route keeps its
  own map — so a durable store covers it without route changes.

**Node.js versions.** `node:sqlite` is available without a flag from Node 22.13 / 23.4 (behind
`--experimental-sqlite` from 22.5). The README states Node 20+. Because no durable store ships in this branch,
**the runtime requirement is unchanged (Node 20+)**. When the durable store lands it must be opt-in
(`JIVA_CLINICAL_STORE=sqlite`) with a start-up compatibility check that refuses to start — never silently falls
back to memory — on a Node without `node:sqlite`, and the README, launcher and `demo:check` must state the
higher requirement for that mode.

## 1. What exists today

| State | Where it lives now | Interface |
|---|---|---|
| Patients/cases, hospitals, ambulances (current state) | `LocalStateStore` maps; engines also read/write the maps synchronously (`patientsStore`, `hospitalsStore`, `ambulancesStore`) | `IStateStore` (Local / **Dynamo** implementations) |
| Event ledger + duplicate guard (`eventId`) | `LocalStateStore.eventHistory` (capped 10,000) + `processedEventIds` (unbounded) | `IStateStore.recordEvent / queryEventsByCase / listRecentEvents` |
| Referrals (open requests, answered set, expiry bookkeeping) | `stateEngines.ts` `engine.requests`, `engine.answered`, `engine.expiryNotified` | none (engine-internal) |
| Acceptance responses and their validity | `acceptanceLedger` (frozen Phase-6 component) + materialized indexes in the store | `IStateStore.put/getAcceptance*`, `rebuildAcceptanceRecords` |
| Encounters, doctor assignments, prescriptions (incl. drafts and authorisations), reports, clinical notes, document metadata (incl. versions and catalogue samples), in-hospital measurements, pre-hospital entries (crew vital signs and narrative), audit, command results (idempotency) | `LocalClinicalStore` | `IClinicalStore` (Local only; contract suite in `tests/unit/clinical-store-contract.test.ts`) |
| Document bytes | files under `data/local/documents/<port>/` (cleared at start and on demo reset) | `DocumentStorage` (local provider only) |
| Upload tickets | `UploadTickets` in memory (hashes only) | none |
| Clinical catalogue (medications, sample documents), import previews | `CatalogueStore` in memory; DEMO loads the bundled `data/catalogue/*.json` at start and on reset; OPERATIONAL starts empty (medications) and has no samples; imports are lost on restart | `CatalogueStore` (in-memory only) |
| Demo fault injection (realtime interruption window) | `routes/demo.ts` module state | none (demo only) |

Two facts shape the plan:

- **Operational state is event-sourced, clinical content is not.** Canonical events are content-free by design,
  so encounters and records cannot be rebuilt from the ledger: the clinical store must itself be durable.
- **The engines are not replay-safe.** Re-publishing past events would make them emit new derived events
  (requests, routes, AI). Recovery must therefore *load* state, not replay the bus.

## 2. Smallest suitable local option: one SQLite file

Use Node's built-in `node:sqlite` (no new dependency; Node ≥ 22.13 without a flag — see §0) with WAL, one file
per mode and API port (`data/local/jiva-<mode>-<port>.db`, git-ignored), so a demo reset can never touch an
operational file, behind the **existing** interfaces:

| Interface | Local durable implementation | Tables (sketch) |
|---|---|---|
| `IStateStore` | `SqliteStateStore` (replaces `LocalStateStore` when enabled) | `patients`, `hospitals`, `ambulances` (JSON documents keyed by id, `version` column); `events` (append-only, `event_id` primary key = duplicate guard, indexed by case and time); `acceptance_requests`, `acceptance_responses` (the existing materialized records) |
| `IClinicalStore` | `SqliteClinicalStore` | `encounters`; `practitioners`; `prescription_versions`, `report_versions`, `note_versions` (append-only, `(record_id, version)` primary key — history cannot be rewritten); `documents` (metadata, incl. version links and sample references); `measurements` (indexed by encounter and time); `prehospital_entries` (indexed by case); `audit` (append-only); `command_results` (key, fingerprint, response, `expires_at`); `outbox` (clinical/encounter events written with their record) |
| `CatalogueStore` | catalogue tables with an import log | `catalogue_entries` (kind, id, revision, entry JSON), `catalogue_versions` (kind, version, imported by/at) |
| `DocumentStorage` | unchanged local provider, but **not cleared at start** once metadata is durable; an orphan sweep removes files without an `AVAILABLE` metadata row | — |
| Engine bookkeeping | new `engine_state` table: open referrals (`requests`, `answered`) and `expiry_notified` | — |

Write discipline (the unit of work from §0.1): *prepare* the record, the canonical event (validated and
trust-stamped), the audit entry and the idempotency result as plain values; write them in **one synchronous
SQLite transaction** (record + `outbox` event + audit + command result); then deliver the event to the in-memory
ledger and the bus. A record exists if and only if its event is in the outbox — atomically, instead of today's
store-then-rollback. The synchronous maps the engines use remain as a **write-through cache** loaded at start,
so engine code does not change.

Recovery after a crash: open the file → load current-state tables into the maps → load open referrals and
re-arm the expiry timer → `rebuildAcceptanceRecords()` (already exists) → load the outbox's clinical events into
the in-memory ledger **without publishing them** → re-apply the pure clinical encounter projection (§0.2) for
any encounter event whose projection is missing. No event is re-published and no operational effect is replayed.
Demo reset becomes a `DELETE` of all tables of the demo file in one transaction.

Rejected alternatives: a JSON-lines journal with replay (the engines are not replay-safe; snapshots would be
needed anyway); a local Postgres or DynamoDB Local (a second database technology and a container just for
development); persisting the in-memory maps as periodic JSON snapshots (loses the last seconds and is not
atomic with the ledger); a clinical-only durable store shipped alone (the split state of §0.3).

## 3. Intended AWS architecture (not provisioned)

| Concern | AWS design | Notes |
|---|---|---|
| Cases, hospitals, ambulances, events, acceptance | existing `DynamoStateStore` single table (`jiva-operational-mesh`) | Already uses conditional writes (`attribute_not_exists(PK)`, version/`lastUpdated` guards) — unverified against a real table |
| Referrals and expiry | `engine_state` items in the same table with a TTL attribute; expiry as an **EventBridge Scheduler** one-shot per referral (the AWS stack has no expiry engine today) | |
| Clinical store | a **separate** DynamoDB table `jiva-clinical` with a customer-managed KMS key, point-in-time recovery, and an IAM policy that only the clinical functions can use | Separation keeps operational roles (routing, AI) unable to read clinical items |
| Record versions | items `PK=RX#<id>, SK=V#<n>` (and `RPT#`, `NOTE#`) written with `attribute_not_exists` → append-only by construction | Drafts and authorisations are versions like any other |
| Unit of work | `TransactWriteItems` (record version + outbox item + audit item + idempotency item, ≤ 100 items) | Same boundary as the local transaction |
| Documents and catalogue samples | S3 bucket: Block Public Access, SSE-KMS, versioning, TLS-only policy, presigned PUT bound to `Content-Length`/`x-amz-checksum-sha256`, `ObjectCreated` → verification function → metadata `AVAILABLE`; lifecycle for incomplete uploads; samples in a separate prefix/bucket that operational accounts cannot read | The `DocumentStorage` interface already matches this flow |
| Clinical catalogue | DynamoDB items per entry revision + an import log; imports by administrators only | |
| Audit | DynamoDB items + stream to an S3 bucket with **Object Lock** (WORM) for tamper evidence | Today's audit is mutable in memory |
| Idempotency | `CMD#<scope>#<user>#<key>` items with `attribute_not_exists` and a TTL | Same semantics as `commands/support.ts` |
| Telemetry (in-hospital and pre-hospital) | DynamoDB items `PK=ENC#<id>, SK=OBS#<time>#<id>` / `PK=CASE#<id>, SK=PH#<time>#<id>` with a retention TTL policy (or a time-series store if volume requires) | |
| Backups / recovery | PITR on both tables, S3 versioning, cross-region copy if the region strategy requires it; documented restore drill | |

## 4. Order of work

1. **Unit of work + projector split** (no new storage): restructure the clinical command handlers into
   prepare → single synchronous write → deliver, and split the encounter projector into a pure clinical
   projection and operational effects. Verified by the existing suites (journey, e2e, doctor workspace, portal
   scenarios) plus the store contract suite.
2. `SqliteClinicalStore` + outbox, opt-in (`JIVA_CLINICAL_STORE=sqlite`) with the Node check of §0 — tests: the
   store contract suite against it; restart the API mid-journey and continue the encounter (records, documents,
   pre-hospital entries, audit and idempotent replays still there); a failed write leaves nothing behind.
3. `SqliteStateStore` + engine bookkeeping load/re-arm — tests: restart with an open referral; expiry still
   fires once; no duplicate derived events. Only after this step is the restart story coherent for the demo.
4. Stop clearing local documents at start; orphan sweep; durable catalogue imports.
5. AWS: clinical table, document bucket, audit WORM, scheduler-based expiry, then the clinical API routes —
   each behind its own authorization and only after explicit approval to provision.

Each step keeps the current interfaces, so the in-memory implementations remain available for the test suites.
