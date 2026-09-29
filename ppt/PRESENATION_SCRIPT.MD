0. CURRENT SYSTEM TRUTH TABLE

┌──────────────────────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────┐
│                              Claim                               │                            Status                            │                                Evidence                                │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Event-driven coordination layer (local)                          │ BUILT                                                        │ services/api/src/stateEngines.ts, event schema, local event bus        │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Case-specific hospital acceptance protocol                       │ BUILT                                                        │ hospital.acceptance.requested/.received/.expired,                      │
│                                                                  │                                                              │ authorizationPolicy.ts                                                 │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Dynamic rerouting on rejection/unavailability/expiry             │ BUILT, TESTED LOCALLY                                        │ reroutePredicate, flagship simulation                                  │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Realtime state to 4 role-scoped UIs                              │ BUILT                                                        │ Socket.IO, apps/*-web                                                  │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Deterministic feasibility engine (evidence, freshness,           │ BUILT, SHADOW-ONLY                                           │ packages/feasibility, FEASIBILITY_ENGINE=shadow                        │
│ provenance)                                                      │                                                              │                                                                        │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Case-scoped acceptance (two cases, one hospital, independent)    │ BUILT, TESTED LOCALLY                                        │ evaluateHospitals acceptance override, aws-lambda-parity.test.ts S3    │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Materialized acceptance/requirement indexes                      │ BUILT, TESTED LOCALLY                                        │ materializedAcceptance.ts, both stores                                 │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Route failure → unknown ETA, not ETA=0                           │ BUILT, TESTED LOCALLY                                        │ HC-GEO/transit rules                                                   │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ LIMITED-response capability check                                │ BUILT, TESTED LOCALLY                                        │ HC-ACC-03                                                              │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Held-destination feasibility observation                         │ BUILT, SHADOW-ONLY, OBSERVATIONAL                            │ observeDestination                                                     │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Policy hashing, trace/audit events, trace privacy                │ BUILT, TESTED LOCALLY                                        │ hashPolicy, feasibility.trace.recorded                                 │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Shadow-mode vs legacy comparison                                 │ BUILT, TESTED LOCALLY                                        │ 0 disagreements on flagship                                            │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ AWS CDK stack (API Gateway, EventBridge, Lambda, DynamoDB,       │ CDK-DEFINED                                                  │ infrastructure/aws                                                     │
│ Cognito)                                                         │                                                              │                                                                        │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Lambda bundling/packaging                                        │ PACKAGE-VERIFIED                                             │ esbuild bundle, loaded outside repo, handler executed                  │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ AWS deployment                                                   │ NOT DEPLOYED                                                 │ No AWS credentials on this machine; nothing pushed                     │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Live AWS testing                                                 │ NOT DONE                                                     │ No real DynamoDB/EventBridge/Lambda run                                │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Amazon Bedrock                                                   │ CDK-DEFINED, NOT LIVE-TESTED                                 │ Advisory-only interface, mock provider used locally                    │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Hospital dataset                                                 │ 7 canonical (Govt. of Karnataka/BBMP-derived) + 4 synthetic  │ data/canonical, data/synthetic                                         │
│                                                                  │ demo                                                         │                                                                        │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ "All Bengaluru hospitals"                                        │ FALSE — do not say this                                      │ 7 facilities only                                                      │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Test suite                                                       │ 124/124 integration checks pass (plus unit suites)           │ Verified this session                                                  │
├──────────────────────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────────────────────────┤
│ Financial/insurance feasibility                                  │ FUTURE                                                       │ Domain model stubs exist; not decision-connected                       │
└──────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────┘

---

1. ~3-MINUTE FINAL SCRIPT (VERSION A)

Good [morning/afternoon], judges. I'm Yukith, and this is Pranathi. We're Team Monochrome, and we built JIVA.

Here's the problem. In a medical emergency, no single person has the full picture. The family sees the ambulance. The ambulance sees the road. The hospital sees its own beds. Each of them is working from information that's already a little bit out of date. And here's the part that surprised us most in our own data work: a hospital being listed as having an ICU doesn't tell you it can take this patient, right now. Public directories tell you who exists — not who's available.

So what is JIVA? JIVA is an event-driven coordination layer. Every update — a new emergency, an ambulance dispatch, a hospital response — becomes a timestamped event that updates one shared state, visible to patients, ambulances, and hospitals, each through their own view.

Here's where JIVA actually differs. Instead of assuming a hospital is available because it's on a list, JIVA sends that hospital a case-specific acceptance request. The hospital has to explicitly answer — accepted, limited, rejected, or unavailable. That response becomes part of the decision. And if it changes — the hospital rejects, goes unavailable, or the request just expires — JIVA re-decides the ambulance's destination on the spot.

Technically, this maps naturally to AWS because healthcare events don't arrive in a neat sequence — they arrive asynchronously, from different sources, at different times. That's exactly what EventBridge is for: routing events to the right processor. Lambda handles each event type. DynamoDB holds the operational state between events. API Gateway is the front door for both the REST API and realtime updates. And Bedrock, in our design, is advisory only — it can summarize a case for handoff, it never makes a routing decision.

Now, to be precise about where we are. For this submission, we built and ran the full coordination workflow locally — patients, ambulances, hospitals, the acceptance protocol, dynamic rerouting — on synthetic Bengaluru data, because we don't have and can't claim access to a live hospital feed. Our hospital identity data comes from public Government of Karnataka and BBMP directories — 7 real facilities — which tell us a hospital exists and what it's publicly listed as offering, but say nothing about live bed or ICU status. So JIVA marks that operational state UNKNOWN by design, until a hospital actually responds. The AWS architecture is fully designed in CDK. It is not deployed.

Since preparing this submission, we've kept hardening the decision layer itself. We built a deterministic feasibility engine that checks evidence freshness and where it came from — so old data can never look like current data. We made acceptance case-scoped, so two emergencies at the same hospital are tracked independently, rather than one overwriting the other. And we packaged the AWS Lambda functions and verified they actually load and run outside the repository. All of this currently runs in shadow mode — it observes and compares against our working engine, it doesn't control the demo yet.

So — JIVA doesn't guess whether a hospital is available. It builds a shared, event-driven state, asks the hospital to confirm, and re-decides the moment that confirmation changes. AWS gives us the event-driven infrastructure to take that from a local prototype toward something that scales. Thank you.



---

2. VERSION B — ~90-SECOND COMPRESSED VERSION

We're Team Monochrome, and we built JIVA. In an emergency, every party — the family, the ambulance, the hospital — sees only part of the picture, and it's always a little stale. Crucially, a hospital being listed as having a capability doesn't mean it can take this patient right now.

JIVA is an event-driven coordination layer. Every update becomes a timestamped event updating one shared state. Instead of assuming a hospital is available, JIVA sends it a case-specific acceptance request and routes the ambulance off the actual answer. If that answer changes — rejected, unavailable, expired — JIVA re-decides the destination immediately.

This maps naturally to AWS: EventBridge routes asynchronous healthcare events, Lambda processes them, DynamoDB holds state, and Bedrock is advisory-only — it summarizes, it never decides.

For submission, we built and ran this locally, on synthetic data, because we can't claim a live hospital feed. Our facility identity comes from public Karnataka/BBMP directories — 7 real hospitals — which we deliberately mark UNKNOWN for live availability until a hospital actually confirms. The AWS architecture is designed in CDK; it is not deployed.

Since then, we've hardened the decision engine — deterministic evidence checks, and acceptance that's tracked per case, not per hospital — currently running in shadow mode alongside the working demo.

JIVA doesn't guess availability. It asks, and it re-decides when the answer changes. Thank you.

(~195 words)

---

3. SLIDE-BY-SLIDE SPEAKER NOTES

Slide 1 — Title
- Say: team name, one-line statement almost verbatim ("an event-driven layer that keeps a shared, timestamped care state... and re-decides when that state changes"), and explicitly: "prototype draft — working local demo on synthetic data; AWS architecture designed in CDK, not deployed."
- Don't say: anything implying AWS is live, or that this is a finished product.
- Remember sentence: "We built a local prototype and designed the AWS path — we're honest about which is which."

Slide 2 — Problem Statement
- Say: coordination problem, not just a medical one; four target users; a listing ≠ live availability; you found this directly while building the canonical hospital dataset.
- Don't say: any invented statistic. The slide itself has a bracketed TODO for a sourced stat — do not fill it with a fabricated number live. If asked, say you chose not to use an unverified figure.
- Remember sentence: "A hospital being on a list doesn't tell you it can take this patient right now."

Slide 3 — Proposed Solution
- Say: the 11-step event flow, at a normal pace, without reading every number; the three key features (closed-loop acceptance, continuously updated state, event-driven rerouting); the response states (PENDING → ACCEPTED/LIMITED/REJECTED/UNAVAILABLE/EXPIRED/UNKNOWN).
- Don't say: "automatic" in a way that implies guaranteed treatment.
- Remember sentence: "A hospital must explicitly answer a case-specific request — silence expires to UNKNOWN, it never defaults to available."

Slide 4 — Innovation & Differentiation
- Say: the existing-approach vs our-approach columns as a contrast, ending on the four-part differentiator: event state + hospital confirmation + freshness + dynamic response.
- Don't say: "revolutionary," "world's first," "unique," "best-in-class."
- Remember sentence: "Acceptance is an explicit, time-limited state, not an assumption."

Slide 5 — Technical Approach
- Say: local stack runs fully offline (React/Vite, Node/TypeScript/Zod, Socket.IO); AWS stack is CDK-defined (API Gateway, EventBridge, Lambda, DynamoDB, Cognito, Bedrock) and clearly labeled not deployed; maps are MapLibre/OSM with Valhalla/OSRM/mock routing.
- Don't say: "deployed to AWS" or "running on Bedrock." Use exactly: "the AWS deployment architecture is defined and validated through CDK."
- Remember sentence: "The local prototype runs today; the AWS architecture is designed and ready, not live."

Slide 6 — Impact & Implementation
- Say: the three success metrics are about coordination timing in simulation (acceptance response time, % of flows reaching a confirmed destination, reroute decision time) — not clinical outcomes; walk the four-phase hackathon plan briefly.
- Don't say: "lives saved," "mortality," "survival," "guaranteed faster care."
- Remember sentence: "We measure coordination performance in simulation — we make no clinical claim."

Slide 7 — Team & Execution Readiness
- Say: two-person team, roles, and why the stack/skill match fits fast, friction-free iteration.
- Don't say: overstate team size or claim external validation of the team.
- Remember sentence: "Two people, one stack, no handoff friction."

---

4. 20 JUDGE Q&A ANSWERS

1. Why healthcare coordination?
Because the failure isn't usually a lack of hospitals — it's that the people involved can't see each other's current state. That's a coordination problem, and coordination problems are exactly what event-driven systems are built to solve.

2. Why can't hospitals just update availability?
Some try to, through static listings. But a listing is a point-in-time claim with no expiry and no case context. JIVA doesn't rely on hospitals proactively updating — it asks a specific hospital about a specific case and treats the answer as time-limited evidence, not a permanent fact.

3. Why is JIVA different from a hospital directory?
A directory answers "what does this facility offer, in general." JIVA answers "will this facility take this patient, right now" — by actually asking, and tracking the answer's freshness.

4. Why can't you just choose the nearest hospital?
Nearest doesn't mean capable or willing. Distance is one factor in our ranking, but only after a hospital has explicitly accepted the case — otherwise you might send an ambulance somewhere that then turns the patient away.

5. How do you know current hospital availability?
We don't assume it — we ask. Until a hospital responds to a case-specific request, its operational state is marked UNKNOWN, never optimistically "available."

6. What datasets did you use?
Hospital identity for 7 facilities comes from public Government of Karnataka and BBMP hospital directories. Everything about live operational capacity — beds, ICU status, acceptance — is synthetic demo data, because we don't have a real-time feed.

7. Why synthetic data?
Because we can't legitimately claim access to live hospital operational data, and we didn't want to pretend otherwise. We think that's a strength of the submission, not a gap to hide.

8. Is this actually realtime?
The local prototype updates state and pushes it to clients over Socket.IO as events happen — that part is real. It's not connected to a live hospital system, so "realtime" describes our event pipeline, not real-world hospital feeds.

9. Why AWS?
Because our architecture is already event-driven by design — asynchronous updates from independent sources. AWS's event-driven services map onto that directly, rather than being bolted on because the challenge asked for AWS.

10. What does EventBridge do?
It routes each event type — emergency created, hospital response, capacity update — to the Lambda that should process it, decoupling producers from consumers.

11. Why Lambda?
Each event type has its own, independent handler. Lambda lets each of those scale and fail independently, which fits an event-driven design better than one monolithic service.

12. Why DynamoDB?
It holds the operational state between events — patient, hospital, ambulance records — plus the audit history, at a scale that fits key-value/event-sourced access patterns.

13. What does Bedrock do?
It's advisory only, in the design — generating case summaries or handoff notes. It never chooses a hospital, dispatches an ambulance, or changes state. That boundary is enforced in the architecture, not just a policy.

14. Is AWS actually deployed?
No. The AWS architecture is fully defined in CDK, and we've verified the Lambda code packages and loads correctly outside our repository. It has not been deployed to a live AWS account or tested against real AWS services.

15. What happens if a hospital changes availability while the ambulance is travelling?
That's the core of the design. A rejection, an unavailability report, or a request simply expiring triggers JIVA to re-evaluate and, if needed, reroute the ambulance to a different destination.

16. What happens if hospital data is stale?
Stale evidence never gets treated as current. It falls back to UNKNOWN rather than being assumed positive or negative — we specifically hardened this so old information can never masquerade as a current answer.

17. What happens if two hospitals accept?
JIVA picks one deterministically by its ranking rules. We also specifically fixed and tested a subtler case: two different emergencies both getting a valid acceptance from the same hospital — each case is tracked independently, so one doesn't overwrite the other.

18. How do you avoid AI making unsafe decisions?
By not letting AI make decisions at all. Bedrock, in our design, is advisory-only; the actual eligibility, acceptance, and destination logic is deterministic code we can test and verify without any AI involved.

19. How would this scale beyond Bengaluru?
The event schema and acceptance protocol aren't Bengaluru-specific — scaling would mean onboarding more facilities into the same acceptance workflow and, on the infrastructure side, moving from the local prototype onto the AWS architecture we've already designed.

20. What would you build next?
Real hospital operational integrations where legally and technically available, moving the AWS architecture from designed to actually deployed, and — as a further-out direction — feasibility dimensions like insurance or cost, which today are only domain-model groundwork, not decision inputs.

---

5. WHAT WE SHOULD NOT CLAIM

- Do not claim AWS is deployed, live, or running in production.
- Do not claim Bedrock has been tested live or is making any decision.
- Do not claim real-time hospital data, live bed/ICU feeds, or integration with any hospital system.
- Do not claim coverage of "all Bengaluru hospitals" — it's 7 canonical facilities plus 4 synthetic demo hospitals.
- Do not claim lives saved, reduced mortality, improved survival, or any clinical outcome.
- Do not invent a statistic for the bracketed TODO on slide 2.
- Do not say "revolutionary," "world's first," "unique," or "best."
- Do not describe the feasibility engine, case-scoped acceptance, or materialized indexes as already controlling the live demo — they run in shadow/observational mode.
- Do not describe financial or insurance feasibility as implemented — it is future scope only.
- Do not claim the team tested anything "in production."

---

6. POST-PPT IMPLEMENTATION / FUTURE ROADMAP

Since preparing this submission, we've continued hardening the decision layer (verified in the repository, all still local/shadow-mode, none of it deployed):

1. A deterministic feasibility engine — evaluates each hospital against explicit, auditable rules (capability, live status, current acceptance) instead of ad-hoc checks.
2. Evidence freshness and provenance — every piece of evidence carries when it was observed and how it was verified, so a historical listing can never be mistaken for current operational availability.
3. Case-scoped hospital acceptance — two emergencies can each get a valid, independent acceptance from the same hospital without one overwriting the other. This was a real bug we found and fixed.
4. Materialized operational indexes — instead of scanning a limited window of recent events to answer "is this hospital currently accepting," we now maintain a direct, always-current index per case and hospital.
5. Shadow-mode comparison — the new engine runs alongside the original working engine, comparing its answers, without controlling anything yet.
6. Failure containment — if any part of this new evaluation layer fails, the original decision path is completely unaffected.
7. Deterministic replay — the same sequence of events, processed in any valid order, produces an identical final state and decision.
8. AWS Lambda packaging verification — we bundled the Lambda functions and confirmed, outside the repository, that they load and execute correctly. They have not been deployed to AWS.
9. Stronger trace/audit controls — every automated decision is recorded to a structured, privacy-checked audit trail with no free-text hospital data leaking into it.

Future roadmap (not yet implemented, listed only where a realistic path exists):
- Real hospital operational integrations, where a hospital or authority is willing to provide a live feed.
- Authoritative facility registries (e.g., ABDM/HFR-style sources) where legally and technically accessible.
- Insurance/cashless and patient cost-estimation feasibility, as an additional evidence dimension, not a decision-maker.
- Real traffic/routing feeds in place of Valhalla/OSRM/mock routing.
- Production identity and authentication (Cognito is designed, not wired to a real identity provider).
- Actual AWS deployment and live testing of the CDK-defined architecture.
- Bedrock advisory workflows exercised against a real model rather than a mock provider.
- Broader facility ingestion beyond the current 7 Bengaluru facilities.

---

7. FINAL 30-SECOND EMERGENCY VERSION

We're Team Monochrome. In an emergency, everyone — family, ambulance, hospital — sees only part of the picture, and a hospital being listed as capable doesn't mean it can take this patient right now. JIVA is an event-driven layer that keeps one shared, timestamped state, sends hospitals a case-specific acceptance request instead of assuming availability, and re-decides the ambulance's destination the moment that answer changes. We built and ran this locally on synthetic data; the AWS architecture is fully designed in CDK, not yet deployed. Thank you.