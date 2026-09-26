# JIVA Security & Privacy Architecture

## Core Security Invariants

### 1. Zero Secrets in Client Bundles
- Frontend clients (`apps/*-web`) NEVER contain AWS credentials, Bedrock API keys, DynamoDB credentials, or server-side Google Maps Routes API keys.
- No map API keys exist: MapLibre renders public OpenStreetMap tiles and routing is server-side.
- Server-side route calculations are executed exclusively by backend providers.

### 2. Role-Based Access Control (RBAC)
Authorization is enforced **server-side** in `services/api/src/authorization.ts` for every REST endpoint, every submitted event (role + source-identity binding) and every Socket.IO event. Locally, identities come from fixed **DEMO personas** (`x-jiva-demo-user` header / socket `auth.demoUser`); unknown or missing credentials get 401 and there is no default role. This is demo authentication, not production authentication. In AWS, API Gateway uses a Cognito authorizer (synthesized, not deployed).
- **`PATIENT`**: Isolated strictly to their own emergency case ID. Cannot view internal hospital operational states, rejection rationales, or network topologies.
- **`AMBULANCE`**: Scoped strictly to the paramedic's active ambulance unit and assigned patient.
- **`HOSPITAL`**: Clinicians and triage officers can only view and mutate the operational acceptance capacity of their own assigned facility.
- **`MANAGEMENT`**: Network-wide situational awareness across all ambulances, hospitals, and emergencies.
- **`ADMIN`**: Destructive infrastructure management.

### 3. Least Privilege IAM Policies
- Each Lambda execution role is restricted to its required actions:
  - `EventIngestionFunction`: `events:PutEvents` only on `jiva-healthcare-mesh`.
  - `EmergencyProcessorFunction`: Read/Write only on `jiva-operational-mesh` table and `events:PutEvents`.
  - `AiProcessorFunction`: Restricted to `bedrock:InvokeModel` specifically on Claude 3 Haiku and Sonnet ARNs.

### 4. Idempotency & Replay Protection
- Local (verified at runtime): duplicate `eventId` → `duplicate_ignored`; redelivered hospital `responseId` → ignored; per-field ordering watermarks from the event timestamp (`acceptanceAsOf`, `capacityAsOf`, `locationAsOf`) so stale events never overwrite newer state; events more than 60 s in the future are rejected.
- AWS path (in code, not live-verified): DynamoDB conditional writes `attribute_not_exists(PK)` and `#lastUpdated <= :newUpdated`.

### 5. Input safety
- Every submitted event is validated against the Zod schema before it reaches the bus (400 with structured issues); malformed JSON gets 400 without stack traces; body size is capped at 100 kB.
- Bus handlers are isolated: an exception in one handler is logged (identifiers only, no payload) and cannot crash the process.
- CORS is restricted to the local app origins (override with `CORS_ORIGINS`).
