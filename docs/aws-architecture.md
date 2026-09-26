> **Status (2026-09-26): SYNTHESIZED, NOT DEPLOYED.** `cdk synth` succeeds (EventBridge + 6 rules with SQS DLQ, 8 Lambdas, DynamoDB, Cognito + REST authorizer, WebSocket API with IAM-authorized `$connect`, CloudWatch, S3). Nothing below has been deployed or live-tested. The Lambda processors do not yet include the local engine repairs (ordering watermarks, case-bound acceptance, per-role realtime filtering). See `docs/opus-final-system-status.md`.

# JIVA AWS Production Architecture

## Overview
JIVA operates on a dual-mode, event-driven serverless architecture on Amazon Web Services (AWS). It provides real-time emergency healthcare coordination, facility capability matching, routing, and asynchronous clinical intelligence via Amazon Bedrock.

```
       PATIENT               AMBULANCE               HOSPITAL              MANAGEMENT
          │                      │                       │                      │
          └──────────────────────┴───────────┬───────────┴──────────────────────┘
                                             │
                                     API GATEWAY / WEBSOCKET
                                             │
                        ┌────────────────────┴────────────────────┐
                        ▼                                         ▼
                 REST API (INGESTION)                    WEBSOCKET API (REALTIME)
                        │                                         ▲
                        ▼                                         │
                   EVENTBRIDGE                                    │
             (jiva-healthcare-mesh)                               │
                        │                                         │
      ┌─────────────────┼───────────────────┬─────────────────────┤
      ▼                 ▼                   ▼                     ▼
EMERGENCY PROC    ACCEPTANCE PROC     AMBULANCE PROC        ROUTING PROC
      │                 │                   │                     │
      └─────────────────┴─────────┬─────────┴─────────────────────┘
                                  ▼
                         DYNAMODB (Single-Table)
                         (jiva-operational-mesh)
                                  │
                                  ▼
                        AMAZON BEDROCK (Sidecar)
                     (Claude 3 Haiku / Sonnet)
                                  │
                                  ▼
                       S3 AUDIT & CLOUDWATCH
```

---

## 1. AWS Services Breakdown

### 1. Amazon EventBridge (`jiva-healthcare-mesh`)
- **Role**: Central healthcare event bus.
- **Routing Rules**:
  - `EmergencyEventsRule`: Routes `patient.emergency.created`, `care.requirement.created` to `EmergencyProcessorFunction`.
  - `HospitalEventsRule`: Routes `hospital.acceptance.requested`, `hospital.acceptance.received`, `hospital.capacity.updated`, `hospital.acceptance.expired` to `HospitalProcessorFunction`.
  - `AmbulanceEventsRule`: Routes `ambulance.dispatched`, `ambulance.location.updated` to `AmbulanceProcessorFunction`.
  - `RoutingEventsRule`: Routes `destination.changed`, `route.calculated`, `route.recalculated` to `RoutingProcessorFunction`.
  - `AiSidecarEventsRule`: Routes relevant state changes to `AiProcessorFunction`.
  - `RealtimeBroadcastRule`: Triggers `WebSocketHandlerFunction` to beam updates to connected frontends.
- **Event Envelope**: Every event carries `source: "jiva.healthcare"`, `detail-type`, and full canonical metadata (`eventId`, `correlationId`, `causationId`, `timestamp`, `version`).

### 2. AWS Lambda (Domain State Engines)
- **Runtime**: Node.js 20.x on ARM64 / x86_64.
- **Principle**: Lambdas are thin infrastructure adapters around identical domain engines (`eligibilityEngine`, `routingEngine`, `stateEngines`).
- **Grouping**: Grouped by operational domains rather than micro-functions per event.

### 3. Amazon DynamoDB (`jiva-operational-mesh`)
- **Design**: Single-table architecture with clear separation between Current State and Event History.
- **Keys**:
  - `PK` (Partition Key, String)
  - `SK` (Sort Key, String)
  - `GSI1PK` / `GSI1SK` (Global Secondary Index for chronological case history queries)
  - `ttl` (Time to live for WebSocket connections and idempotency tokens)
- **Entity Schemas**:
  - Patient Current State: `PK: PATIENT#<id>`, `SK: STATE#CURRENT`
  - Hospital Current State: `PK: HOSPITAL#<id>`, `SK: STATE#CURRENT`
  - Ambulance Current State: `PK: AMBULANCE#<id>`, `SK: STATE#CURRENT`
  - Event History: `PK: CASE#<correlationId>`, `SK: EVENT#<timestamp>#<eventId>`
  - Idempotency Guard: `PK: EVENT#<eventId>`, `SK: METADATA` (Conditional write `attribute_not_exists(PK)`)
  - WebSocket Connection: `PK: WS_CONN#<connectionId>`, `SK: CONNECTION`

### 4. Amazon Bedrock (Asynchronous Intelligence Sidecar)
- **Model**: `anthropic.claude-3-haiku-20240307-v1:0` (Fast, cost-conscious, clinically precise).
- **Invariants**:
  - AI NEVER mutates operational state, route, or acceptance directly.
  - Bedrock invocations run asynchronously.
  - Bedrock failures never degrade or interrupt core routing and ambulance dispatch.
  - Cached via `CachedAIProvider` to avoid redundant invocations.

### 5. Amazon Cognito
- **User Pool**: `jiva-user-pool`
- **Role Groups**: `MANAGEMENT`, `HOSPITAL`, `AMBULANCE`, `PATIENT`, `ADMIN`.
- **Scoped RBAC**:
  - Hospital clinicians can only view and mutate their assigned facility.
  - Paramedics can only view their assigned ambulance.
  - Patients can only view their specific care timeline.
  - Management has cross-network operational visibility.

### 6. Amazon CloudWatch
- **Dashboard**: `JIVA-Operational-Command-Center`
- **Metrics**: Event throughput, latency, hospital acceptance response times, route calculations, Bedrock invocations, AI failures, and detected operational anomalies.
- **Alarms**: High error rate alarms with proactive notifications.

### 7. Amazon S3
- **Bucket**: `jiva-audit-reports-{account}-{region}`
- **Purpose**: Immutable archival of incident logs, hospital acceptance audit packs, and data ingestion validation snapshots.
