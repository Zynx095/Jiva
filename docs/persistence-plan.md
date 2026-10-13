# JIVA — Persistence plan

Status: **plan, not implemented.** Today every piece of runtime state in the local API lives in memory and is
lost when the process stops (finding R4 in [`security-review.md`](security-review.md) §5). Nothing here has been
deployed or provisioned.

## 1. What exists today

| State | Where it lives now | Interface |
|---|---|---|
| Patients/cases, hospitals, ambulances (current state) | `LocalStateStore` maps; engines also read/write the maps synchronously (`patientsStore`, `hospitalsStore`, `ambulancesStore`) | `IStateStore` (Local / **Dynamo** implementations) |
| Event ledger + duplicate guard (`eventId`) | `LocalStateStore.eventHistory` (capped 10,000) + `processedEventIds` (unbounded) | `IStateStore.recordEvent / queryEventsByCase / listRecentEvents` |
| Referrals (open requests, answered set, expiry bookkeeping) | `stateEngines.ts` `engine.requests`, `engine.answered`, `engine.expiryNotified` | none (engine-internal) |
| Acceptance responses and their validity | `acceptanceLedger` (frozen Phase-6 component) + materialized indexes in the store | `IStateStore.put/getAcceptance*`, `rebuildAcceptanceRecords` |
| Encounters, doctor assignments, prescriptions/reports (all versions), document metadata, measurements, audit, command results (idempotency) | `LocalClinicalStore` | `IClinicalStore` (Local only) |
| Document bytes | files under `data/local/documents/<port>/` (cleared at start) | `DocumentStorage` (local provider only) |
| Upload tickets | `UploadTickets` in memory (hashes only) | none |

Two facts shape the plan:

- **Operational state is event-sourced, clinical content is not.** Canonical events are content-free by design,
  so encounters and records cannot be rebuilt from the ledger: the clinical store must itself be durable.
- **The engines are not replay-safe.** Re-publishing past events would make them emit new derived events
  (requests, routes, AI). Recovery must therefore *load* state, not replay the bus.

## 2. Smallest suitable local option: one SQLite file

Use Node's built-in `node:sqlite` (no new dependency; available from Node 22.5 — the README currently states Node 20+, so the documented minimum would rise; verified present on the development machine's Node 26) with WAL, one file
per API port (`data/local/jiva-<port>.db`, git-ignored), behind the **existing** interfaces:

| Interface | Local durable implementation | Tables (sketch) |
|---|---|---|
| `IStateStore` | `SqliteStateStore` (replaces `LocalStateStore` when `JIVA_LOCAL_DB=on`) | `patients`, `hospitals`, `ambulances` (JSON documents keyed by id, `version` column); `events` (append-only, `event_id` primary key = duplicate guard, indexed by case and time); `acceptance_requests`, `acceptance_responses` (the existing materialized records) |
| `IClinicalStore` | `SqliteClinicalStore` | `encounters`; `practitioners`; `prescription_versions`, `report_versions` (append-only, `(record_id, version)` primary key — history cannot be rewritten); `documents` (metadata); `measurements` (indexed by encounter and time); `audit` (append-only); `command_results` (key, fingerprint, response, `expires_at`) |
| `DocumentStorage` | unchanged local provider, but **not cleared at start** once metadata is durable; an orphan sweep removes files without a metadata row | — |
| Engine bookkeeping | new `engine_state` table: open referrals (`requests`, `answered`) and `expiry_notified` | — |

Write discipline: one SQLite transaction per command (record + its canonical event + audit + idempotency
result), so "a record exists iff its event is in the ledger" becomes an atomic guarantee instead of the
current store-then-rollback. The synchronous maps the engines use remain as a **write-through cache** loaded
at start, so engine code does not change.

Recovery after a crash: open the file → load current-state tables into the maps → load open referrals and
re-arm the expiry timer → `rebuildAcceptanceRecords()` (already exists) → load the clinical store. No event is
re-published. Demo reset becomes a `DELETE` of all tables in one transaction.

Rejected alternatives: a JSON-lines journal with replay (the engines are not replay-safe; snapshots would be
needed anyway); a local Postgres or DynamoDB Local (a second database technology and a container just for
development); persisting the in-memory maps as periodic JSON snapshots (loses the last seconds and is not
atomic with the ledger).

## 3. Intended AWS architecture (not provisioned)

| Concern | AWS design | Notes |
|---|---|---|
| Cases, hospitals, ambulances, events, acceptance | existing `DynamoStateStore` single table (`jiva-operational-mesh`) | Already uses conditional writes (`attribute_not_exists(PK)`, version/`lastUpdated` guards) — unverified against a real table |
| Referrals and expiry | `engine_state` items in the same table with a TTL attribute; expiry as an **EventBridge Scheduler** one-shot per referral (the AWS stack has no expiry engine today) | |
| Clinical store | a **separate** DynamoDB table `jiva-clinical` with a customer-managed KMS key, point-in-time recovery, and an IAM policy that only the clinical functions can use | Separation keeps operational roles (routing, AI) unable to read clinical items |
| Record versions | items `PK=RX#<id>, SK=V#<n>` written with `attribute_not_exists` → append-only by construction | |
| Documents | S3 bucket: Block Public Access, SSE-KMS, versioning, TLS-only policy, presigned PUT bound to `Content-Length`/`x-amz-checksum-sha256`, `ObjectCreated` → verification function → metadata `AVAILABLE`; lifecycle for incomplete uploads | The `DocumentStorage` interface already matches this flow |
| Audit | DynamoDB items + stream to an S3 bucket with **Object Lock** (WORM) for tamper evidence | Today's audit is mutable in memory |
| Idempotency | `CMD#<scope>#<user>#<key>` items with `attribute_not_exists` and a TTL | Same semantics as `commands/support.ts` |
| Telemetry | DynamoDB items `PK=ENC#<id>, SK=OBS#<time>#<id>` with a retention TTL policy (or a time-series store if volume requires) | |
| Backups / recovery | PITR on both tables, S3 versioning, cross-region copy if the region strategy requires it; documented restore drill | |

## 4. Order of work

1. `SqliteClinicalStore` + transactional command writes (largest risk: clinical data loss) — tests: restart
   the API mid-journey and continue the encounter.
2. `SqliteStateStore` + engine bookkeeping load/re-arm — tests: restart with an open referral; expiry still fires
   once; no duplicate derived events.
3. Stop clearing local documents at start; orphan sweep.
4. AWS: clinical table, document bucket, audit WORM, scheduler-based expiry, then the clinical API routes —
   each behind its own authorization and only after explicit approval to provision.

Each step keeps the current interfaces, so the in-memory implementations remain available for the test suites.
