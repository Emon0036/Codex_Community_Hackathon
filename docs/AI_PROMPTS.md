# AI Prompts — Nirapod Ops

This document records the prompts that shaped the Nirapod Ops system during
the Duo Dynamics rebuild. They are preserved so the design decisions can be
audited and reproduced.

> The system itself treats AI as a **language-only**, bounded, optional
> layer. These meta-prompts (used to design the codebase) are separate from
> the runtime prompt inside `services/aiExplanationService.js`, which is
> allowlisted and validated by Zod plus a deterministic policy gate.

---

## 1. Multi-provider accountability

> Design a decision-support system for a mobile financial service agent
> shop that holds one physical cash reserve but three separate e-money
> ledgers (bKash, Nagad, Rocket). The system must keep the providers
> logically separate while still showing shared physical cash, forecast
> liquidity pressure for both forms of money, surface explainable unusual
> activity, and coordinate accountable human review. It must never
> execute transactions, convert balances between providers, block
> accounts, or declare fraud.

Outcome: scoped the analytics surface to per-provider signals plus a
shared-cash signal, and made every alert carry evidence plus heuristic
uncertainty.

## 2. Role-based access

> Create four demo roles: Agent (Amina), Operations Team (Farhana),
> Risk Reviewer (Tanvir), Management (Nusrat). Enforce provider scoping
> end-to-end across data, alerts, cases, baselines, and CSV imports.
> The Operations Team role must be locked to its assigned provider to
> demonstrate real multi-tenant isolation. The role entry screen must
> collect only the selected role — never passwords, PINs, OTPs, NIDs,
> or other private credentials.

Outcome: added session-backed role context, middleware-level RBAC, and
provider-scoped filtering in the role-aware dashboard view.

## 3. Deterministic analytics

> Build a deterministic analytics service that owns signal creation,
> severity, confidence, evidence hashing, and a safe next-step
> recommendation. AI must never be used to make a recommendation. Every
> alert must include time-bounded repeated-amount detection, feed
> freshness checks, conflicting-feed fallback, and connected liquidity
> signals, plus English/Bangla summaries.

Outcome: created `services/analyticsService.js` with explicit signal
types (`repeated_amount`, `provider_stale`, `provider_conflicting`,
`shared_cash_pressure`, `provider_pressure`, `liquidity_signal`), each
emitting evidence, severity, confidence, recipient, and a rule-based
next step.

## 4. Case coordination

> Implement a case service with provider-aware routing, assignment,
> evidence notes, allowed state transitions, timestamps, and an
> append-only audit trail. Allowed transitions only — never free-form
> state writes. Every action must attribute the acting user and time.

Outcome: `services/caseService.js` exposes `createCase`,
`assignCase`, `acknowledgeCase`, `addNote`, `escalateCase`, `resolveCase`
with strict transition validation and an immutable audit log per case.

## 5. AI boundary

> Make AI optional and language-only. Use OpenAI structured output
> enforced by Zod, with a deterministic policy gate that rejects
> allegations, guilt language, fraud verdicts, financial-action
> language, and cross-provider transfer advice. Discard any
> model-proposed next step and replace it with a rule-based one. On
> missing key, refusal, timeout, parse failure, or unsafe language,
> return a deterministic bilingual safe fallback. Do not cache
> fallback results.

Outcome: `services/aiExplanationService.js` runs the prompt with
`store: false`, a short timeout, and one retry. The Zod schema accepts
only the bilingual narrative and a source pointer; everything else is
recomputed by deterministic code.

## 6. Resilient persistence

> Abstract MongoDB Atlas persistence behind a store service with a
> transparent in-memory fallback so the demo never breaks. The server
> must announce the active mode at startup (`mongodb` vs `fallback`)
> and health endpoint must never leak secrets.

Outcome: `services/storeService.js` selects the backend by environment,
falls back automatically, and `routes/api.js` exposes `/api/health`
with dependency-safe metadata only.

## 7. Security guardrails

> Add CSRF protection, CSP, secure cookie settings, rate limits on
> state-changing endpoints, input validation, escaped output, and audit
> records. CSV imports must use HMAC pseudonymization for labels so
> raw identifiers never reach persistence.

Outcome: `middleware/csrf.js` and `middleware/auth.js` enforce the
policy; `services/ingestionService.js` transforms labels with keyed
HMAC and rejects oversized or malformed input.

## 8. Evaluation and trust center

> Build a deterministic synthetic evaluation runner that produces a
> JSON report describing measured fixture results (lead times,
> recall on injected patterns, false positives unflagged, evidence
> and uncertainty on every generated alert) and serve it on the
> Trust center. Add a scenario comparison service that runs the same
> metrics under different assumed conditions for discussion.

Outcome: `scripts/evaluate.js` writes `public/data/evaluation-report.json`,
`services/scenarioComparisonService.js` exposes the comparison API,
and `views/methodology.ejs` renders the Trust center.

## 9. Documentation pass

> Rewrite the README, architecture, presentation, validation,
> responsible design, and requirements matrix documents so a judge can
> understand the system, the boundaries, the limits, and the demo
> path in five minutes. Keep the tone concrete and operational, not
> marketing. Link the docs from the README.

Outcome: `README.md` plus `docs/ARCHITECTURE.md`, `docs/PRESENTATION.md`,
`docs/VALIDATION.md`, `docs/RESPONSIBLE_DESIGN.md`, and
`docs/REQUIREMENTS_MATRIX.md` are all cross-linked and consistent.

## 10. Shipping checklist

> Before any commit: confirm `.env` is git-ignored, `.env.example`
> contains placeholders only, no real secrets appear in tracked
> files, tests pass offline, and the commit message describes the
> design intent rather than the diff.

Outcome: `.gitignore` covers `.env`, `.env.*`, `.puku/`, logs, and
generated reports; `npm test` runs 50 offline tests; commit messages
describe intent and guardrails.