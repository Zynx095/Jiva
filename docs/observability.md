# JIVA Observability, Tracing & CloudWatch Architecture

## Correlation-Aware Distributed Tracing
Every emergency scenario establishes a unique `correlationId` (e.g. `CASE-BLR-876`) that is propagated across all asynchronous hops, EventBridge rules, and DynamoDB items.

### Tracing Journey Example
```
CASE-BLR-876
 ├── [patient.emergency.created]       (eventId: e-101, correlationId: CASE-BLR-876)
 ├── [care.requirement.created]        (eventId: e-102, causationId: e-101)
 ├── [hospital.acceptance.requested]   (eventId: e-103, causationId: e-102)
 ├── [hospital.acceptance.received]    (eventId: e-104, causationId: e-103)
 ├── [destination.changed]             (eventId: e-105, causationId: e-104)
 ├── [route.recalculated]              (eventId: e-106, causationId: e-105)
 └── [ai.handoff.generated]            (eventId: e-107, causationId: e-104)
```

## Structured JSON Logs
All logs are emitted as single-line JSON objects parseable by CloudWatch Logs Insights:
```json
{
  "timestamp": "2026-09-26T10:15:30.124Z",
  "level": "INFO",
  "service": "routing-engine",
  "message": "Destination changed for ambulance AMB-BLR-001",
  "eventId": "EVT-876-05",
  "correlationId": "CASE-BLR-876",
  "causationId": "EVT-876-04",
  "eventType": "destination.changed",
  "latencyMs": 142
}
```

## CloudWatch Metrics
- `JIVA_EVENTS_PROCESSED`: Total events routed through EventBridge.
- `JIVA_EVENTS_FAILED`: Ingestion or processing errors.
- `HOSPITAL_ACCEPTANCE_LATENCY`: Time from request to clinician response.
- `ROUTE_CALCULATION_LATENCY`: Time taken by Routes API / Mock.
- `ACTIVE_EMERGENCIES`: Count of open non-discharged cases.
- `ACTIVE_AMBULANCES`: Count of units in transit.
- `AI_REQUESTS`: Bedrock calls made.
- `AI_FAILURES`: Bedrock errors caught and handled safely.
- `AI_LATENCY`: Duration of Bedrock generation.
- `ANOMALIES_DETECTED`: Count of reroutes, diversions, or capacity drops.
