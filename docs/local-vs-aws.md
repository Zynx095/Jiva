# Local vs AWS Parity Matrix

A foundational principle of JIVA is:
> **LOCAL MODE AND AWS MODE MUST USE THE SAME DOMAIN MODELS, EVENT SCHEMAS, VALIDATION, AND BUSINESS LOGIC. ONLY INFRASTRUCTURE ADAPTERS DIFFER.**

## Parity Matrix

| Subsystem | Local Mode Adapter | AWS Mode Adapter | Shared Logic |
| :--- | :--- | :--- | :--- |
| **Domain Models** | `@jiva/domain-models` | `@jiva/domain-models` | 100% Identical TypeScript models |
| **Event Schemas** | `@jiva/event-schema` | `@jiva/event-schema` | 100% Identical Zod definitions |
| **Eligibility Engine** | `eligibilityEngine.ts` | `eligibilityEngine.ts` (Lambda) | shared code |
| **State / routing engines** | `stateEngines.ts` | `lambdas/*Processor.ts` | **separate implementations**; the Lambdas do not yet include the local ordering/acceptance repairs |
| **Event Bus** | `LocalEventBus` (EventEmitter) | `AwsEventBridgeBus` (EventBridge) | `IEventBus` interface |
| **Persistence Store** | `LocalStateStore` (In-Memory Map) | `DynamoStateStore` (Single-Table) | `IStateStore` interface |
| **Realtime Mesh** | `LocalSocketIoAdapter` (Socket.IO) | `AwsWebSocketAdapter` (API Gateway WS) | `IRealtimeAdapter` interface |
| **Mapping Provider** | `FallbackMappingProvider` (Valhalla → OSRM → Mock) | same chain (self-hosted routing) | `MappingProvider` interface |
| **AI Intelligence** | `MockAIProvider` | `BedrockAIProvider` | `AIProvider` interface |
| **Authentication** | `DemoAuthProvider` (fixed personas, `x-jiva-demo-user`; demo only) | `CognitoAuthProvider` (JWT claims) | server-side `authorization.ts` |
| **Audit Storage** | Local memory ring buffer | Amazon S3 bucket | Immutable event append |
