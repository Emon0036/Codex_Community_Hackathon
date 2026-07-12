# Architecture and Data Flow

```text
 Browser (Bootstrap + compiled Tailwind + Chart.js)
   │  selected demo role + CSRF + role/provider scope
   ▼
 Express routes ──────────────── public /api/health
   │
   ├─ Ingestion service ── Zod/CSV validation ── HMAC pseudonymization
   │
   ├─ Deterministic analytics
   │    ├─ shared-cash net-flow runway
   │    ├─ provider e-money net-flow runway
   │    ├─ 20-minute repeated-amount window
   │    └─ late/conflicting feed confidence caps
   │
   ├─ Case service ── routing / owner / notes / transitions / audit
   │
   └─ AI explanation service (language only)
        ├─ allowlisted aggregate evidence
        ├─ OpenAI Responses API + Zod structured output
        └─ deterministic fallback on no key, timeout, refusal, or schema error
   │
   ▼
 Store service ── MongoDB Atlas `nirapod_ops` ── in-memory safe fallback
```

## Interfaces

- EJS server-rendered pages provide overview, alerts, cases, feeds, network, simulation, and trust views.
- JSON APIs provide role-scoped data and bounded analysis. The browser never receives provider credentials, database credentials, or the OpenAI key.
- Synthetic adapters currently live in `data/demoData.js`. An approved provider adapter can later map provider payloads into the same snapshot contract without changing analytics or case rules.

## Provider boundary

The outlet agent can see physically co-located balances. A provider operations identity is restricted to its own provider in routes, services, CSV imports, case changes, and network totals. Risk/management can coordinate but cannot execute financial actions. Shared cash is owned by the outlet agent/management, not a single provider.

## Coordination flow

```text
signal → evidence + heuristic uncertainty → human creates case
       → provider recipient → named owner → acknowledge → escalate/resolve
       → note/timestamp/audit event → linked alert reflects final status
```

Direct transitions are allowlisted. A resolved case may be reopened; skipped workflow states are rejected.

## Security and monitoring

- Helmet CSP, frame denial, same-origin forms, self-hosted frontend dependencies.
- HTTP-only SameSite session cookie, production Mongo session store, CSRF verification, request/file limits, API and AI-specific rate limits.
- Zod validation, escaped EJS output, DOM `textContent` for API results, generic production errors.
- `/api/health` reports simulation/database/AI readiness without secrets. Audit records track actor, action, target, and timestamp.
