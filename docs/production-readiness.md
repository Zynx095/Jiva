# JIVA — Production-readiness gap analysis (2026-10-13)

**JIVA is not production-ready.** It is a reliable, locally verified demonstration with production-minded
foundations. A passing local test suite says nothing about real hospitals, real devices, real identities or a
deployed cloud stack — none of which exist here. Related: [`emergency-to-care.md`](emergency-to-care.md),
[`clinical-workspace.md`](clinical-workspace.md), [`security-review.md`](security-review.md),
[`persistence-plan.md`](persistence-plan.md).

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
| Doctor workspace (assigned encounters only; overview with the crew's record, handover and history) | doctor-workspace suite + browser (desktop and 390 px) |
| Prescription drafts and explicit, attested authorisation; catalogue agreement; patient sees authorised prescriptions only | unit + doctor-workspace suite + browser |
| Clinical notes (internal, versioned) | unit + doctor-workspace suite + browser |
| Ambulance pre-hospital record (vital signs with time, source, quality, unavailable reasons; narrative) reaching only the assigned clinician and the patient | unit + doctor-workspace suite + browser |
| Versioned clinical catalogue with CSV/JSON import preview/apply and export; synthetic sample documents verified by size, hash and type | unit + doctor-workspace suite + browser (catalogue administration) |
| Document types and versions; demo-only synthetic samples labelled as samples for clinician and patient | unit + doctor-workspace suite + browser |
| Demo portal: ten scenarios through real workflows; SHADOW authority unchanged | demo-portal-scenarios suite + browser |
| Nothing synthetic in operational mode (no samples, no simulators, no fault injection, no bundled medication list) | operational-isolation unit suite + browser (portal disabled) |
| Realtime interruption and automatic recovery of the screens | doctor-workspace + demo-portal-scenarios suites + browser |

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
| A unit of work for clinical commands (record + event + audit + idempotency in one transaction) and a split of the encounter projector | Prerequisite of durable storage; designed in `persistence-plan.md` §0/§4 |
| Durable catalogue imports; an operational catalogue-administration UI | Imports are in memory; administration is API-only outside the demo portal |
| Patient view of the crew's pre-hospital record | API exists; no patient screen |
| Clinical decision support (dose checks, interactions, allergies), e-prescribing, discharge | Not built — and nothing in JIVA may present catalogue data as advice |

## D. Requires external integration, credentials or authoritative data

| Integration | Today |
|---|---|
| Hospital acceptance/capacity feeds | Answers come from the hospital app; no hospital system is connected |
| Hospital staff directory | Synthetic demo roster only |
| EHR / FHIR exchange | None |
| Medical devices (bedside and ambulance monitors) | Ingestion contract only; no endpoint, no device; crew and clinician values are typed in |
| Authoritative medication database / hospital formulary | Only an illustrative 21-product list in demo mode; operational mode starts empty |
| Imaging (PACS/DICOM) and laboratory systems (LIS) | None; documents are uploaded files or demo samples; no DICOM viewer |
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
| Clinical safety case and usability testing of the prescribing workflow (drafts, attestation, catalogue) with clinicians | Not done |
| Crew workflow review (what may be written in the pre-hospital narrative, device-free vital-sign entry under time pressure) | Not done |
| Lambda runtime upgrade (`nodejs20.x` deprecated) | Not done |

## Recommended next implementation step

The unit of work for clinical commands and the encounter-projector split (persistence plan §4 step 1), then the
opt-in `SqliteClinicalStore` that must pass `tests/unit/clinical-store-contract.test.ts` (step 2), then the
state store (step 3) so that a restart is coherent for operational and clinical data alike.
