# JIVA Platform - Claude Handoff

Welcome to **JIVA**, the Privacy-Preserving, Real-Time Healthcare Coordination Platform.

## 1. Context & Product
JIVA is an event-driven healthcare mesh that connects hospitals, ambulances, and patients in real-time. It uses events to continuously derive states (Patient, Hospital, Ambulance) without exposing internal hospital databases.

## 2. Architecture

### Core Pattern
Everything is driven by **Events** flowing through a central **Event Bus**. State engines listen to events and project current operational reality into State Stores.

### Local vs AWS Mode
- **Local Mode**: Uses `services/api` (Node.js/Express) which runs an in-memory `EventEmitter` and in-memory Map stores. Events are streamed to frontends via Socket.IO.
- **AWS Mode**: Modeled in `infrastructure/aws` using AWS CDK. Replaces the local bus with **Amazon EventBridge**, REST API with **API Gateway**, and stores with **DynamoDB**.

## 3. Monorepo Structure
We use standard npm workspaces.

```text
jiva/
├── apps/                 # React + Vite + Tailwind UIs (e.g., management-web)
├── packages/             # Shared logic
│   ├── event-schema/     # Zod definitions for canonical healthcare events
│   ├── domain-models/    # TS Interfaces for Patient, Hospital, Ambulance state
│   └── ui/               # Shared components
├── services/             # Backend services
│   └── api/              # Local REST + Socket.io + In-memory EventBus & State Engines
├── infrastructure/aws/   # AWS CDK Infrastructure-as-code
├── scripts/              # Event simulator for local testing
└── docs/                 # Documentation
```

## 4. Development Rules
1. **Strict TypeScript**: No `any` unless absolutely necessary.
2. **Event Centralization**: All new events MUST be defined in `packages/event-schema`.
3. **No Inference as Fact**: AI and state engines must distinguish between confirmed facts and estimations via `confidence` and `provenance` metadata.
4. **Local-First Development**: Always ensure the local setup (`npm run dev`) works.

## 5. Current Status (Initialization Complete)
- Monorepo initialized.
- Event schemas and domain models created and building.
- Local API (Express) with real-time Socket.IO streams implemented.
- `management-web` React dashboard created to visualize state and event stream.
- Event simulator `npm run simulate:emergency` implemented.
- AWS CDK skeleton written.

## 6. How to Run Locally
From the project root:
1. `npm install`
2. `npm run dev` — starts the API (:4000) and all four apps (management :5173, ambulance :5174, hospital :5175, patient :5176). `npm run start:prod` serves production builds on :4173–:4176.
3. `npm run simulate:full:blr` — deterministic, self-verifying flagship scenario (reset → accept → reroute → arrival).
4. `npm run demo:reset` — reset demo state.

Auth is DEMO-only: clients send `x-jiva-demo-user: <persona>` (see `packages/auth/src/demoAuth.ts`); the server enforces role scope. Status: `docs/opus-final-system-status.md`.

## 7. Roadmap for Claude
1. Replace mock data with more exhaustive realistic (synthetic) datasets.
2. Enhance `services/routing-engine` to use real geolocation calculations and proper matching rules.
3. Build out the Patient, Ambulance, and Hospital specific web dashboards in `apps/`.
4. Migrate the UI to use the shared `packages/ui` package and a more robust state management library (like Zustand or RTK).
5. Extract state engines from `services/api` into standalone Lambda handlers and wire them up securely.
6. Write full integration tests using Vitest or Jest.
