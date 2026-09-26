# JIVA — 2-Minute Architecture Walkthrough

**Audience:** System Architects, Technical Evaluators, Hackathon Reviewers  
**Format:** 2-Minute High-Level Technical Briefing  

---

## 1. Event-Driven Core & Canonical Event Mesh
At the center of JIVA is an **event-driven architecture**. Rather than point-to-point API polling between dashboards and databases, all coordination is driven by an immutable stream of **canonical events**:
- `patient.emergency.created`, `care.requirement.created`, `hospital.candidate.generated`
- `hospital.acceptance.requested`, `hospital.acceptance.received`, `hospital.acceptance.expired`, `hospital.capacity.updated`
- `ambulance.dispatched`, `ambulance.location.updated`, `ambulance.arrived`
- `destination.changed`, `route.recalculated`
- `ai.handoff.generated`, `ai.anomaly.explained`, `ai.summary.generated` (advisory only)
- `demo.reset` (local demo control)

All event types are defined as Zod schemas in `packages/event-schema` and validated at the API boundary.

Every event carries a unique event ID (deduplication), an ISO timestamp (used as the ordering watermark for the state it updates) and a source. Only five event types may be submitted by clients; the rest are system-generated.

---

## 2. State Engines & Deterministic Eligibility
State is maintained by event handlers in `services/api/src/stateEngines.ts` (emergency/assessment, acceptance protocol, capacity, ambulance telemetry and arrival, routing/rerouting, expiry) and `eligibilityEngine.ts` (deterministic capability + current-response eligibility). Clinical suitability always gates geographic routing.

---

## 3. Hospital Acceptance Protocol
JIVA rejects the dangerous premise that external directories know real-time bed availability. Instead, the platform runs a **closed-loop acceptance protocol**:
1. Candidate hospitals matching patient care requirements are sent an acceptance request (valid 15 minutes).
2. The on-duty emergency clinician evaluates the incoming case and responds (`ACCEPTED`, `LIMITED`, `REJECTED`, or `UNAVAILABLE`).
3. If an acceptance times out or a hospital reports saturation, the state engine triggers an automatic **dynamic reroute** (`destination.changed`), selecting the next best clinically verified facility.

---

## 4. Road-Level Routing & Open Mapping Stack (OSM + MapLibre + Valhalla/OSRM)
Mapping is abstracted behind the canonical `MappingProvider` interface using an open, sovereign architecture:
- **Server-Side Routing & Failover Chain:** Route calculations, distance matrices, and ETA estimates are computed using a three-tier resilience chain: **Valhalla** (primary) → **OSRM** (secondary) → **MockMappingProvider** (offline deterministic fallback).
- **Client-Side Open Rendering:** The frontends (`apps/management-web`, `apps/ambulance-web`) render OpenStreetMap vector/raster tiles and animated markers via **MapLibre GL JS**, completely eliminating proprietary Google Maps API keys and paywalls.
- **Strict Clinical Boundaries:** Mapping computes road distance and travel time only; clinical suitability via `eligibilityEngine` strictly gates all destination assignments.
- **Why Not Google Maps?** Emergency healthcare coordination requires cost predictability, sovereign data residency, and zero runtime dependence on external commercial billing accounts. Self-hosted Valhalla/OSRM with OpenStreetMap delivers sovereign routing without vendor lock-in.

---

## 5. Real-Time Synchronization & Role Isolation
To deliver sub-second updates across all stakeholders:
- **Local Dev / Offline Demo:** Backed by Socket.IO on port 4000.
- **Cloud Architecture (synthesized, not deployed):** API Gateway WebSocket API (IAM-authorized `$connect`) with DynamoDB connection tracking; per-role filtering is not yet implemented on the AWS path.
- **Role Isolation:** Enforced server-side for REST and per Socket.IO event (patient: own case only; ambulance: itself + assigned case; hospital: cases it was asked about / is receiving; management: network). Local mode uses DEMO personas, not real authentication.

---

## 6. Amazon Bedrock Generative AI
Amazon Bedrock (Claude 3 Haiku; mock templates locally) operates strictly as an **advisory sidecar**:
- Generates a clinical handoff brief for the destination hospital.
- Produces **emergency timeline summaries** for retrospective clinical audits.
- Explains **operational anomalies** (e.g. extended transit delays or cascade rejections).
- Outputs are enforced via Zod schema validation and have zero authority over routing or clinical dispatch.

---

## 7. AWS Cloud Serverless Foundation
JIVA’s AWS blueprint is codified in **AWS CDK** and synthesizes cleanly; it has **not** been deployed or live-tested:
- **Event Mesh:** Amazon EventBridge routes canonical events with content-based filtering.
- **Compute:** AWS Lambda functions execute state processors independently without idle server costs.
- **State Store:** DynamoDB Single-Table Design provides single-digit millisecond latency with atomic deduplication.
- **Security & Observability:** Amazon Cognito handles role-based authentication, and CloudWatch provides real-time dashboards and SLA alarms.
