# JIVA — Production-readiness gap analysis (2026-10-13)

**JIVA is not production-ready.** It is a reliable, locally verified demonstration with production-minded
foundations. A passing local test suite says nothing about real hospitals, real devices, real identities or a
deployed cloud stack — none of which exist here. Related: [`emergency-to-care.md`](emergency-to-care.md),
[`security-review.md`](security-review.md), [`persistence-plan.md`](persistence-plan.md).

## A. Implemented and locally verified

Verified by automated suites against real local API processes, and (where noted) in a browser on the
production builds.

| Capability | Evidence |
|---|---|
| Crew emergency intake, care requirement, referrals to capable network hospitals | journey + e2e suites |
| Explicit, referral-bound, time-limited hospital answers; case-scoped expiry; reroute on reject/unavailable/expiry within the existing routing engine; `DECISION_AUTHORITY_MODE=SHADOW` | runtime, journey, e2e, flagship scenario (0 shadow disagreements) |
| Hospital-recorded arrival and handover, encounters, doctor assignment | journey, e2e, browser |
| Versioned prescriptions and reports; release rules; patient view without staff identities | unit + journey + browser |
| Diagnostic documents: ticket-bound streamed upload, sha256 + signature checks, authorized download | unit + journey + e2e |
| Vital signs with server-decided source and freshness; simulator demo-only | unit + journey + browser |
| Patient state A/B driven by the hospital's records | journey + e2e + browser (desktop and 390 px) |
| Authorization matrix (401/403/404) for every clinical API; per-recipient realtime copies; audit trail | journey, e2e, unit |
| Operational vs demo separation (no synthetic data, no demo logins in operational mode; insecure config refuses to start) | operational-mode suite |
| Demo served to the local machine only | unit + journey (LAN address refused) |
| Screens survive API outage and recover by themselves | browser outage check (5 apps/roles, 25/25) |
| Launcher refuses busy ports and reports readiness | bounded launcher run |
| Public facility directory (OSM-matched where verifiable) | unit + journey |

## B. Implemented but not validated against real external systems

| Item | Why not validated |
|---|---|
| Cognito JWT verification (RS256, issuer/audience) | No user pool exists; tested with fixtures only |
| DynamoDB state store and conditional writes | No table; never run against AWS |
| EventBridge bus, Lambda handlers (bundles load), API Gateway | Synthesized (`cdk synth`), never deployed |
| AWS WebSocket per-principal fan-out | Unit-tested logic; no deployed WebSocket API |
| Valhalla / OSRM routing | Fixture-tested; no live server (mock fallback, labelled) |
| Amazon Bedrock AI sidecar | Failure path only; no credentials |

## C. Requires additional implementation

| Gap | Notes |
|---|---|
| Durable persistence for all runtime and clinical state | Plan in `persistence-plan.md` (local SQLite behind existing interfaces; DynamoDB/S3 on AWS) |
| Clinical domain on AWS (routes, functions, tables) | Exists only in the local API |
| Production document storage (S3 provider) | Designed, not built |
| Discharge, correction workflow for arrival/handover, clinical notes, break-glass access | Not built |
| Verified patient identity and case linking | Today a crew-entered case reference links the patient (finding R5) |
| Rate limiting / WAF, upload quotas, tamper-evident audit, consent and data-subject workflows | Not built |
| Expiry engine on AWS (scheduler) | Exists only locally |
| Monitoring, alerting and dashboards for the clinical paths | Not built (CloudWatch resources exist only for the operational mesh in CDK) |

## D. Requires external integration, credentials or authoritative data

| Integration | Today |
|---|---|
| Hospital acceptance/capacity feeds | Answers come from the hospital app; no hospital system is connected |
| Hospital staff directory | Synthetic demo roster only |
| EHR / FHIR exchange | None |
| Medical devices | Ingestion contract only; no endpoint, no device |
| Authoritative hospital data (capabilities, beds) | Public listings only; capacity unknown unless a hospital reports it |
| Identity provider accounts (crews, staff, clinicians, patients) | None |
| Live traffic routing | None |

## E. Requires deployment or operational testing

| Activity | Status |
|---|---|
| Deploy the CDK stack to a non-production account (needs explicit authorization; incurs cost) | Not done |
| End-to-end tests against deployed APIs, WebSocket, DynamoDB and S3 | Not done |
| Load and soak tests; failure injection (region, table, bus) | Not done |
| Backup (PITR, S3 versioning) and **restore drill** | Not done |
| Security review by an independent party; penetration test | Not done |
| Clinical safety review and governance before any change to decision authority | Not done |
| Lambda runtime upgrade (`nodejs20.x` deprecated) | Not done |

## Recommended next implementation step

`SqliteClinicalStore` with transactional command writes (persistence plan §4 step 1): it removes the largest
demo and production risk (losing encounters and records on restart) without new infrastructure, behind the
existing `IClinicalStore` interface.
