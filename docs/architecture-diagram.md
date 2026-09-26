# JIVA Architecture Diagrams

## 1. End-to-End System Architecture

```mermaid
flowchart TD
    subgraph Clients["Actors & Frontends"]
        P[Patient Web]
        A[Ambulance Web]
        H[Hospital Web]
        M[Management Web]
    end

    subgraph Ingress["AWS Ingress & Authentication"]
        COG[Amazon Cognito RBAC]
        APIGW[Amazon API Gateway REST]
        WSGW[API Gateway WebSocket API]
    end

    subgraph EventMesh["Event-Driven Core"]
        EB[Amazon EventBridge\n'jiva-healthcare-mesh']
    end

    subgraph StateProcessors["AWS Lambda State Engines"]
        L_ING[Event Ingestion Lambda]
        L_EMERG[Emergency Processor]
        L_HOSP[Hospital Acceptance Processor]
        L_AMB[Ambulance Processor]
        L_ROUTE[Routing Engine Lambda]
        L_AI[Bedrock AI Sidecar Lambda]
        L_WS[WebSocket Broadcast Lambda]
    end

    subgraph Storage["Persistence & Intelligence"]
        DDB[(Amazon DynamoDB\n'jiva-operational-mesh')]
        S3[(Amazon S3 Audit Bucket)]
        BEDROCK[Amazon Bedrock\nClaude 3 Haiku / Sonnet]
        MAPS[Self-hosted routing\nValhalla / OSRM / Mock]
        CW[Amazon CloudWatch\nDashboards & Alarms]
    end

    Clients --> COG
    Clients --> APIGW
    Clients <--> WSGW

    APIGW --> L_ING
    L_ING --> EB

    EB --> L_EMERG
    EB --> L_HOSP
    EB --> L_AMB
    EB --> L_ROUTE
    EB --> L_AI
    EB --> L_WS

    L_EMERG --> DDB
    L_HOSP --> DDB
    L_AMB --> DDB
    L_ROUTE --> DDB
    L_ROUTE --> MAPS
    L_AI --> BEDROCK
    L_AI --> DDB
    L_WS --> WSGW

    StateProcessors --> CW
    DDB --> S3
```

---

## 2. Public Data vs Operational State Pipeline Separation

```mermaid
flowchart LR
    subgraph Phase1["Data Provenance Pipeline (Public Data)"]
        PUB_DIR[Karnataka Open Govt Data]
        BBMP[BBMP Health Directory]
        FETCH[scripts/data-fetch.ts]
        NORM[scripts/data-normalize.ts]
        VAL[scripts/data-validate.ts]
        CANONICAL[data/canonical/hospitals.json]

        PUB_DIR --> FETCH
        BBMP --> FETCH
        FETCH --> NORM
        NORM --> VAL
        VAL --> CANONICAL
    end

    subgraph Phase2to5["Operational Coordination Mesh (Real-time Events)"]
        CANONICAL -.->|Initial Seed / Reference| DDB[(DynamoDB Single-Table)]
        EMERG[Emergency Created] --> EB[EventBridge Mesh]
        EB --> ENGINES[Deterministic Engines]
        ENGINES --> DDB
        ENGINES --> AI[Bedrock Intelligence Sidecar]
    end

    style Phase1 fill:#1e293b,stroke:#3b82f6,color:#fff
    style Phase2to5 fill:#0f172a,stroke:#10b981,color:#fff
```

**Key Architectural Invariant**: Operational events NEVER overwrite canonical public master data facts. Master facility capabilities remain grounded in verified source registries, while operational statuses (`ACCEPTED`, `LIMITED`, `UNKNOWN`) are updated strictly through cryptographic event protocols.
