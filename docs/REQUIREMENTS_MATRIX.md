# Challenge Requirement Traceability

| PDF expectation | Implementation evidence |
|---|---|
| Shared cash plus separate provider balances | Overview cards/chart; `analyticsService.getDashboard` |
| Shortage source and approximate time | Nagad hour 4; shared cash hour 6; net-flow projections |
| Unusual activity with reason | 20-minute repeated-amount detector and evidence list |
| Careful language, no fraud claim | UI copy, AI prompt, tests, responsible-design note |
| Recipient, owner, next step, final status | Case route/service/UI with allowed transitions |
| Missing/late/conflicting data fallback | feed status, confidence caps, Scenario Lab |
| Meaningful AI/API/analytics | deterministic analytics plus Responses API structured bilingual briefing |
| Provider/agent/area/time prioritization | role scope, provider filters, Network area filter, six-hour view |
| Alert evidence and history | evidence cards, linked cases, timestamps and audit trail |
| Bengali/Banglish/English | Bengali and English alert/AI explanations |
| Provider-specific escalation and notes | case recipient/boundary/assignment/notes/transitions |
| Human review and auditability | demo-role context, named actors, audit events, no automatic action |
| Privacy/security/responsible AI | RBAC, CSRF, CSP, HMAC, rate limits, safe prompt/fallback |
| Demonstration scenarios | hidden provider pressure, shared-cash pressure, feed conflict, coordinated closure |
| Required artifacts | README plus all files under `docs/` and `sample-data/` |
