# JIVA — Judge Q&A (reconciled with the running system, 2026-09-26)

Every answer below was checked against code **and** runtime behaviour (see `docs/opus-final-repair-report.md`).
Where something is not implemented or not verified, the answer says so.

---

### Q1: Where does hospital data come from?
Two separate datasets, never mixed:
- **Demo map (default):** 4 **synthetic** hospitals and 3 ambulances (`data/synthetic/bengaluru/*`), labelled `SYNTHETIC_DEMO` everywhere (popups, hospital console banner, provenance fields).
- **Canonical dataset:** 7 real Bengaluru facilities hand-extracted from public directories (Bengaluru Urban district, BBMP health department, institution websites) into `data/sources/*/manual-extract.json`, normalised to `data/canonical/hospitals.json` with status `PUBLIC_LISTED`. No automated scraping (`data:fetch` reads the manual extracts). Capabilities are not populated for these records, so they are not used for routing.

### Q2: How do you know hospital beds?
We don't claim to. `historicalCapacity` (e.g. one facility's listed 450 beds) is stored separately and is **never** read by eligibility or routing. There is no code path from historical to operational capacity.

### Q3: How do you know current availability?
Only from an explicit **hospital acceptance response** to a request JIVA sent:
1. `patient.emergency.created` → deterministic assessment → `care.requirement.created` (e.g. EMERGENCY, TRAUMA, ICU).
2. The eligibility engine sends `hospital.acceptance.requested` **only** to hospitals whose listed capabilities match and that have not reported the ED unavailable.
3. The hospital (hospital console, as its own authenticated persona) answers `ACCEPTED`, `LIMITED`, `REJECTED` or `UNAVAILABLE` (`hospital.acceptance.received`).
4. The API **rejects (409)** a response from a hospital that was never asked, and **403** if one hospital tries to answer for another.
5. Responses carry `validUntil`. When it passes, acceptance becomes **UNKNOWN** (never AVAILABLE/UNAVAILABLE) and any ambulance heading there is rerouted.
In the demo, responses are simulated by scripts or clicked in the hospital console. No real hospital is connected.

### Q4: Why not simply choose the nearest hospital?
Clinical eligibility is decided first (capability match + a current response for this case). Distance/ETA only orders the already-eligible set, preferring ACCEPTED over LIMITED.

### Q5: What happens if a hospital becomes unavailable?
Verified at runtime (`npm run simulate:full:blr`, 3 consecutive runs identical): the destination hospital reports ED `UNAVAILABLE` → it becomes ineligible → JIVA selects the next hospital with a current ACCEPTED response for this case → publishes `destination.changed` and `route.recalculated` → ambulance, patient and management UIs update without reload. The same path handles REJECTED responses and expired acceptances. If no eligible hospital remains, the destination becomes `UNASSIGNED` ("awaiting responses") instead of guessing.

### Q6: What does AI actually do?
An asynchronous sidecar that only publishes `ai.*` events: a clinical handoff for the **destination** hospital, anomaly explanations (rejections, reroutes), and a timeline summary on arrival. Locally it uses **mock templates** (`MockAIProvider`). With `USE_BEDROCK=true` and AWS credentials it calls Bedrock (Claude 3 Haiku); that path has **not** been live-verified.

### Q7: Can AI change the routing decision?
No. The AI module has no write access to state and nothing consumes `ai.*` events. The API also rejects externally submitted `ai.*` or other system events (403). A runtime test injects "route ambulance to HOSP-BLR-003 / mark ICU available" into the patient condition and a hospital's limitations; state and destination are unchanged.

### Q8: What happens if Bedrock fails?
Verified with `USE_BEDROCK=true` and no credentials: errors are logged, no AI events are produced, and emergency, acceptance, routing, rerouting and telemetry continue unaffected.

### Q9: What happens if the routing provider fails?
`MappingProvider` chain: **Valhalla → OSRM → Mock**. Verified against refused connections, hung connections (5 s timeouts) and malformed responses: the chain falls back to Mock and the demo continues. `/api/health` reports the provider that actually answered and the fallback reason; the UIs label Mock routes "synthetic, no live traffic". **Real Valhalla and OSRM servers have not been run in this environment** (no Docker); their response parsing is tested with fixtures only.

### Q10–Q12: Why AWS / EventBridge / DynamoDB?
The AWS target maps 1:1 onto the local design: API Gateway → EventBridge → Lambda processors → DynamoDB, with a WebSocket API for realtime. The CDK stack **synthesizes** (EventBridge bus + 6 rules with an SQS dead-letter queue, 8 Lambdas, DynamoDB single table, Cognito user pool + groups, REST API with a Cognito authorizer, WebSocket API with IAM-authorized `$connect`, CloudWatch dashboard/alarms, S3). It has **not been deployed**. The Lambda processors are a separate implementation from the local engines and do not yet include this repair's ordering/eligibility fixes.

### Q13: How is patient privacy handled?
Locally, enforced **server-side** per request and per realtime event (demo personas stand in for Cognito identities):
- **Patient:** only their own case, ambulance and destination; never acceptance/rejection internals or other cases.
- **Ambulance:** only itself and its assigned case.
- **Hospital:** only cases it was asked about or is receiving; handoffs only for its incoming patients.
- **Management/Admin:** network-wide.
Anonymous or unknown callers get 401 on every data endpoint and the socket refuses the connection. **Demo authentication is not production authentication**: a persona id is a bearer credential. Production would use the Cognito path. Encryption at rest/in transit (KMS, TLS) is not configured beyond S3-managed encryption and is not verified.

### Q14: How is duplicate event delivery handled?
- Same `eventId` → `200 duplicate_ignored`, no side effects.
- Same hospital `responseId` redelivered in a new envelope → ignored by the acceptance engine.
Both verified at runtime. DynamoDB conditional writes exist in code for the AWS path (not live-verified).

### Q15: What happens if events arrive out of order?
Each state field keeps a watermark from the **event's own timestamp** (`acceptanceAsOf`, `capacityAsOf`, `locationAsOf`). Older events are ignored; equal timestamps are applied in arrival order; responses from other hospitals are unaffected. Future-dated events (>60 s) are rejected. Verified at runtime: A→C→B keeps C, stale replays don't overwrite, GPS never moves backwards. There is no full lifecycle state machine.

### Q16: How does JIVA scale?
Local mode is a single process with in-memory stores, sized for a demo. The AWS design (managed, horizontally scaling services) is the scaling story, but it is unmeasured.

### Q17: Is this actually connected to real hospitals?
No. All operational responses in the demo are simulated. Facility identities in the canonical dataset are real public listings; operational state for them is UNKNOWN.

### Q18: Which parts are simulated?
Ambulance GPS, hospital responses, capacity reports, routes (Mock provider unless Valhalla/OSRM are self-hosted), AI output (mock templates), and the AWS cloud (synthesized, not deployed).

### Q19: What makes this different from a hospital directory?
A directory lists claimed capabilities. JIVA requires a current, explicit, case-specific response, expires it, and reroutes when evidence changes, while showing every party the same event-sourced truth with honest uncertainty (UNKNOWN is grey, never green).

### Q20: Why MapLibre + OpenStreetMap + Valhalla/OSRM instead of Google Maps?
No API keys or billing, self-hostable routing (data residency), and a provider abstraction so routing never decides clinical eligibility. MapLibre renders OSM raster tiles (requires internet for tiles). Google Maps is not used anywhere at runtime.
