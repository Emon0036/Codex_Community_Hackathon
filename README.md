# Nirapod Ops — Duo Dynamics

> **See pressure early. Explain it honestly. Coordinate safely.**

Nirapod Ops is a full-stack, provider-aware decision-support system for simulated multi-provider mobile financial service agents. It keeps **bKash**, **Nagad**, and **Rocket** e-money logically separate while showing shared physical cash, forecasting both forms of liquidity pressure, surfacing explainable unusual activity, and coordinating accountable human review.

The system is **simulated end-to-end**: synthetic data, no real provider integrations, no money movement, no account blocking, and no fraud determinations. Every action is human-owned and every alert carries evidence plus uncertainty.

---

## Table of contents

- [Highlights](#highlights)
- [Architecture at a glance](#architecture-at-a-glance)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Demo roles](#demo-roles)
- [Five-minute judging path](#five-minute-judging-path)
- [Commands](#commands)
- [API surface](#api-surface)
- [Project layout](#project-layout)
- [Submission artifacts](#submission-artifacts)
- [Security and responsible design](#security-and-responsible-design)
- [Testing and quality gates](#testing-and-quality-gates)
- [Limitations and non-goals](#limitations-and-non-goals)

---

## Highlights

- **Correct cash-flow accounting** — cash-in increases physical cash and consumes provider e-money; cash-out does the opposite.
- **Six-hour forecasts** for shared cash and each provider ledger, with documented heuristic confidence.
- **Explainable alerts** — time-bounded repeated-amount detection, feed-freshness checks, conflicting-feed fallback, and connected liquidity signals. Every alert ships with evidence, heuristic uncertainty, English/Bangla summaries, and a safe next step.
- **Optional AI briefings** — OpenAI structured output (Zod-enforced, allowlist-only) generates bilingual explanations. A missing key, refusal, timeout, or unsafe language yields a deterministic safe fallback.
- **Case coordination** — provider-aware routing, assignment, notes, allowed state transitions, timestamps, and an append-only audit trail.
- **Multi-role demo** — four selectable demo roles, session-backed role context, provider-scoped views, CSRF protection, CSP, rate limits, input validation, and pseudonymized imports.
- **Validated CSV ingestion** — synthetic fixtures, editable simulated snapshots, area filters, multi-outlet readiness, and an interactive scenario lab.
- **Resilient persistence** — MongoDB Atlas with an automatic in-memory fallback for offline demonstrations.

---

## Architecture at a glance

```
Browser ──► Express routes (CSRF + CSP + RBAC) ──► Deterministic analytics
                                                  + Case service
                                                  + Optional OpenAI briefing
                                                  ──► MongoDB Atlas
                                                       (or in-memory fallback)
```

- **Browser** renders EJS templates with embedded JSON for charts.
- **Express** serves role-scoped pages and JSON APIs, enforces CSRF and CSP, and applies rate limits.
- **Analytics service** owns signal creation, severity, confidence, evidence hashing, and the safe next-step recommendation. AI is **never** used to make a recommendation.
- **AI service** is optional, language-only, and runs through a deterministic policy gate. No web/tools, `store: false`, short timeout, one retry.
- **Store service** abstracts MongoDB Atlas persistence with a transparent in-memory fallback so the demo never breaks.

Detailed diagrams and data flow live in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

---

## Quick start

Requirements: **Node.js 20+** and **npm**. MongoDB and OpenAI are optional because safe fallbacks are built in.

```powershell
cd D:\Final\Final-Hackathon
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm install
npm start
```

Open <http://localhost:8080>.

On first launch the server logs the active mode:

```
Nirapod Ops running at http://localhost:8080 (mongodb)
Nirapod Ops running at http://localhost:8080 (fallback)
```

`mongodb` means the optional `ATLAS_DB` connection string is present and the cluster is reachable. `fallback` means the in-memory store is active and all features continue to work offline.

### Updating an existing `.env`

If `.env` already exists, keep it and merge only the missing keys from `.env.example`. The required names are `SESSION_SECRET`, `PSEUDONYMIZATION_SECRET`, and optionally `OPENAI_API_KEY`, `OPENAI_MODEL`, `ATLAS_DB`, `MONGODB_DB_NAME`.

> Never paste a real key into source code, never send it to the browser, and never rename a Cloudinary-style `API_KEY` into `OPENAI_API_KEY`. If no key is configured, the same workflow returns a deterministic safe explanation.

---

## Configuration

All runtime configuration is read from environment variables. `.env.example` ships with safe placeholders.

| Variable | Purpose | Required |
|---|---|---|
| `PORT` | HTTP port (default `8080`) | no |
| `NODE_ENV` | `development`, `production`, or `test` | no |
| `SESSION_SECRET` | Express session signing (≥ 32 random chars) | **yes in production** |
| `PSEUDONYMIZATION_SECRET` | HMAC key for CSV label pseudonymization | **yes in production** |
| `ATLAS_DB` | MongoDB Atlas connection string | no (uses fallback) |
| `MONGODB_DB_NAME` | Database name (default `nirapod_ops`) | no |
| `OPENAI_API_KEY` | Optional bilingual briefing API key | no |
| `OPENAI_MODEL` | Optional model name | no |

`.env` is git-ignored. `.env.example` is tracked and contains placeholders only.

---

## Demo roles

Open `/demo`, choose a role, and select **Enter demo**. No email, password, or other credential is requested. The selected role can be changed at any time from the top navigation.

| Role | Scope | Default destination |
|---|---|---|
| **Agent** — Amina Rahman | Own outlet and all separate provider positions | Overview |
| **Operations Team** — Farhana Islam | Provider-scoped operations, alerts, and cases | Cases |
| **Risk Reviewer** — Tanvir Ahmed | Cross-signal review and audit access | Alerts |
| **Management** — Nusrat Chowdhury | Network view, coordination, and feed governance | Network |

Provider scoping is enforced end-to-end (data, alerts, cases, baselines, CSV imports). The Agent, Risk Reviewer, and Management roles see all three providers; the Operations Team role is locked to its assigned provider boundary to demonstrate real multi-tenant isolation.

---

## Five-minute judging path

1. **Enter as Agent.** On **Overview**, point out shared cash, three separate ledgers, the hour-4 Nagad pressure, and the hour-6 shared-cash pressure.
2. **Open Alerts.** Show the connected repeated-amount and liquidity evidence, heuristic uncertainty, Bangla text, and careful "requires review" language.
3. **Generate the bilingual briefing.** With an OpenAI key it uses structured output; without one it visibly uses the safe fallback.
4. **Switch to Operations Team.** Create a case, assign its owner, acknowledge it, add an evidence note, escalate, and resolve it while showing timestamps and audit history.
5. **Data feeds.** Show conflicting-source validation and CSV pseudonymization. **Scenario lab** — select a missing feed and increase activity.
6. **Network and Trust center.** Area prioritization, measured fixture results, architecture, boundaries, and limitations.

The full 7-slide / 5-minute script is in [`docs/PRESENTATION.md`](docs/PRESENTATION.md).

---

## Commands

| Command | Purpose |
|---|---|
| `npm install` | Install dependencies |
| `npm start` | Production-style server (`node app.js`) |
| `npm run dev` | Development server with `nodemon` reload |
| `npm run build:css` | Compile the local Tailwind output |
| `npm test` | Offline unit, integration, and security tests (Node test runner) |
| `npm audit` | Dependency vulnerability audit |
| `node scripts/evaluate.js` | Regenerate the synthetic evaluation report |

---

## API surface

All operational APIs require a selected demo role; state-changing requests also require the existing session CSRF token.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Dependency-safe public readiness metadata, never secrets |
| `GET` | `/api/dashboard` | Role/provider-scoped operational data |
| `GET` | `/api/alerts` | Explainable alert list with evidence and uncertainty |
| `GET` | `/api/cases` | Cases scoped to the active role and provider boundary |
| `POST` | `/api/simulate` | Bounded, non-persistent what-if analysis |
| `POST` | `/api/alerts/:id/explain` | Rate-limited OpenAI / fallback narrative generation |
| `GET` | `/api/audit` | Risk/management-only audit events |

---

## Project layout

```
app.js                       Express app entry, session, CSRF, route mount
package.json                 Manifest and scripts
tailwind.config.js           Local Tailwind config
assets/tailwind.css          Local Tailwind source

Controller/                  Route composition helpers
data/demoData.js             Synthetic seed (providers, transactions, alerts, cases)
docs/                        Architecture, validation, responsible design, matrix, script
middleware/                  auth.js (RBAC) + csrf.js (token + verify)
models/                      Mongoose schemas (Baseline, BaselineTransaction, CurrentTransaction, DatasetImport)
public/                      css, js, generated evaluation report
routes/                      auth.js, api.js, dashboard.js
sample-data/transactions.csv Synthetic CSV fixture
scripts/evaluate.js          Deterministic synthetic evaluation runner
services/                    analytics, ingestion, store, case, auth, AI briefing, evaluation, scenario comparison
test/                        Offline tests (analytics, app, baseline, AI explanation, evaluation, performance, scenario comparison)
Utility/                     expressError + wrapAsync helpers
views/                       EJS templates (dashboard, alerts, cases, simulation, network, data, methodology, login)
.env.example                 Placeholder environment template
.gitignore                   Excludes .env, node_modules, logs, generated reports
```

---

## Submission artifacts

- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Data and simulation note](docs/DATA_SIMULATION.md)
- [Validation evidence](docs/VALIDATION.md)
- [Responsible design](docs/RESPONSIBLE_DESIGN.md)
- [Requirement traceability](docs/REQUIREMENTS_MATRIX.md)
- [Final presentation script](docs/PRESENTATION.md)
- [AI prompts that shaped the build](docs/AI_PROMPTS.md)
- [Synthetic CSV fixture](sample-data/transactions.csv)
- [Evaluation report](public/data/evaluation-report.json) — regenerated by `node scripts/evaluate.js`

---

## Security and responsible design

- **`.env` is git-ignored.** Only `.env.example` (placeholders) is tracked. If any real Atlas, Cloudinary, or OpenAI credential has ever been committed, shared, or shown publicly, rotate it before deployment.
- **Synthetic identifiers only** — CSV labels are transformed with keyed HMAC.
- **Demo entry collects only a selected role.** It never requests passwords, provider/customer credentials, PINs, OTPs, NIDs, or private financial authentication data.
- **Provider-scoped RBAC** minimizes exposure — the Operations Team role cannot read or mutate another provider's data, alerts, cases, baselines, or CSV imports.
- **Server-side secrets.** Database and API keys remain server-side environment variables; nothing is shipped to the browser.
- **Common web risks reduced** — CSP, CSRF, secure cookie settings, rate limits, input limits, escaped output, and audit records.
- **AI boundary** — deterministic code creates signals, evidence, severity, confidence, recipient, safe next step, and allowed workflow states. OpenAI is optional and generates only English/Bangla explanatory language from an allowlist of aggregate alert fields.
- **No automation of financial actions.** The prototype does not perform transfers, settlement, reversals, blocking, provider conversion, fraud decisions, or customer risk scoring.
- **False positives are expected.** Alerts are framed as “unusual” or “requires review,” with evidence and uncertainty visible.
- **Deterministic fallback.** A missing key, refusal, timeout, network error, unsafe language, or invalid schema returns a deterministic fallback. The request uses `store: false`, a short timeout, one retry, and no web/tool access.

## Responsible design note

- Human review first: every case is owned by a person and every workflow change is manual.
- Privacy: synthetic data only, no authentication secrets are requested, and sensitive credentials stay server-side.
- Advisory boundary: AI is only an optional explanatory layer; deterministic rules own signals and recommendations.
- Prototype limits: no money movement, provider transfer, account blocking, fraud verdicts, or automated financial commands.

## Data and simulation note

- The app runs on synthetic seed data from `data/demoData.js` and `sample-data/transactions.csv`.
- CSV ingestion is validated with Zod and pseudonymized with keyed HMAC.
- Forecasts and alert metrics are tested deterministically through `scripts/evaluate.js` and offline fixtures.
- This is a simulation prototype, not a live provider integration or production settlement system.

The full responsible-design note lives in [`docs/RESPONSIBLE_DESIGN.md`](docs/RESPONSIBLE_DESIGN.md).

---

## Testing and quality gates

```bash
npm test
```

The Node test runner executes **50 tests** across analytics, app integration, security, baseline, AI explanation, evaluation, performance, and scenario comparison. Each test runs against an isolated in-memory store and a deterministic seed, so the suite is fully offline.

A separate deterministic evaluation pipeline lives in `scripts/evaluate.js` and writes `public/data/evaluation-report.json` for the Trust center.

## Validation metrics

- **Analytics forecast coverage** — shared-cash warning lead time is validated at **6 simulated hours** and Nagad e-money warning lead time at **4 simulated hours** using `analytics.test.js` measured fixtures.
- **System performance** — a 500-row analytics snapshot runs with **p95 latency below 100 ms** on the local prototype benchmark, confirmed by `performance.test.js`.
- **Reliability and safety** — every generated alert is asserted to include evidence and uncertainty, and the AI briefing path is tested for missing-key / failure fallback behavior.
- **Resilient persistence** — MongoDB Atlas connectivity is optional; the app falls back automatically to in-memory mode without losing core analytics or UI functionality.

---

## Limitations and non-goals

- **No real provider APIs**, wallets, customer credentials, transfers, blocking, or fraud verdicts.
- **Heuristic forecasts** — confidence is documented and uncertainty is shown; do not treat projections as guarantees.
- **Synthetic datasets** — repeated-amount signals and liquidity patterns are seeded to demonstrate the workflow, not to characterize any real environment.
- **Calibration required for production** — provider authorization, legal/privacy review, threat modeling, calibrated thresholds on approved representative data, drift monitoring, incident response, access reviews, retention rules, and documented appeal/correction workflows.

---

Built for the **Duo Dynamics** hackathon team. Demo data is synthetic; all secrets are placeholders or git-ignored; human authority is preserved end-to-end.
