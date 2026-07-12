# Validation Evidence

Run `npm test` from the repository root. The suite is offline and never calls a live OpenAI API or writes to Atlas.

## Deterministic synthetic evaluation

Run the real evaluation harness independently of the web server:

```powershell
node scripts/evaluate.js --write
```

It prints both a readable summary and JSON, then writes the same report to
`public/data/evaluation-report.json`. Use `--json` for JSON-only output or
`--seed <integer>` for a different reproducible dataset. The checked-in report
uses seed `20260711` and the fixed marker
`synthetic-evaluation-v1:seed-20260711:deterministic-no-wall-clock`; therefore
two runs with that seed are byte-for-byte reproducible apart from a CLI path
message. No wall-clock timestamp is placed inside the report.

### Repeated-amount review heuristic

The runner creates 400 independently classified fixtures containing 11,980
synthetic transactions and calls the existing
`analyticsService.detectRepeatedAmounts` function once for every fixture.

| Label group | Count | Composition |
|---|---:|---|
| Injected review-pattern positives | 144 | 108 rule-aligned plus 36 threshold/window/amount-tolerance edge cases |
| Negative fixtures | 256 | 100 ordinary, 52 spaced repetitions, 52 varied bursts, 52 legitimate look-alike hard negatives |

Default-seed results:

| TP | FP | TN | FN | Precision | Recall | FPR |
|---:|---:|---:|---:|---:|---:|---:|
| 108 | 52 | 204 | 36 | 67.5% | 75.0% | 20.3% |

- `Precision = TP / (TP + FP)`
- `Recall = TP / (TP + FN)`
- `FPR = FP / (FP + TN)`

The deliberately non-perfect result is useful evidence of the rule boundary:
three-event patterns, 24-minute patterns, and relatively similar values that
cross rounded-100 buckets are missed. All 52 labelled legitimate merchant
bursts are flagged because transaction purpose is not available to the rule.
These are review-pattern labels, never fraud labels.

### Six-hour liquidity forecast evaluation

The runner also creates 180 forecast fixtures (1,080 hourly observations).
Each fixture has separately generated realized cash-in demand and cash-out
replenishment, plus reproducibly noisy forecast versions. Both realized and
forecast paths are passed through the existing
`analyticsService.projectLiquidity` calculation.

| Measure | Default-seed result |
|---|---:|
| Actual shortage / no-shortage fixtures | 105 / 75 |
| Shortage TP / FP / TN / FN | 82 / 15 / 60 / 23 |
| Shortage precision / recall / FPR | 84.5% / 78.1% / 20.0% |
| Raw ending-balance MAE | BDT 15,583.23 |
| Starting-balance-normalized MAE | 13.57% |
| Mean detected warning lead time | 4.01 hours |
| Shortage-hour MAE (true positives) | 0.305 hours |
| Detected shortage hour within one hour | 100% (82 detected shortages) |

Ending-balance MAE uses the raw projection, including deficits below zero.
Normalized MAE is `sum(abs(forecast ending - actual ending)) / sum(starting
balance)`. Warning lead time is the interval from forecast issuance at hour
zero to the realized shortage hour. Shortage-hour MAE only includes cases in
which both paths predict/realize a shortage; missed shortages remain visible
as false negatives in recall.

The evaluation is a transparent synthetic stress test, not production
accuracy, generalization, or a trained-model claim. Its fixtures, generator,
metric formulas, assumptions, and limitations are tested in
`test/evaluation.test.js`.

## Other reproducible analytical checks

| Measure | Fixture result | Reproduction |
|---|---:|---|
| Shared-cash warning lead time | 6 simulated hours | `analytics.test.js`: calculated runway |
| Nagad e-money warning lead time | 4 simulated hours | `analytics.test.js`: separate ledger runway |
| Evidence/uncertainty coverage | all generated alerts | every alert assertion |
| OpenAI failure containment | all tested failure paths | missing key, API error, invalid schema return fallback |
| 500-row analytics latency | p95 below 100 ms local threshold | `performance.test.js` reports p50/p95 each run |

## Engineering checks

- Cash-in/cash-out accounting directions are asserted independently.
- Activity stress worsens the known shared-cash and Nagad pressure paths.
- Demo-role entry and switching, protected routes, CSRF rejection, provider-scoped APIs, AI fallback, and role-scoped 404 behavior are integration-tested.
- Structured output, allowlisted AI evidence, PII redaction, timeout/retry metadata, and no-key behavior are unit-tested with a mock client.
- `npm audit` checks dependency advisories.
- A 120-run benchmark exercises a 500-transaction snapshot and fails if local analytical p95 exceeds 100 ms. Hardware-dependent measured values are printed by the test; the threshold is a prototype target, not a production SLA.

## Manual acceptance checklist

1. All primary pages render at desktop and mobile widths.
2. Agent sees all separate outlet ledgers; Nagad operations sees only Nagad e-money/cases/network totals.
3. Invalid direct case transitions and cross-provider mutations return 400/403.
4. Conflicting feed without a secondary balance is rejected.
5. CSV account labels never appear in stored/imported output.
6. Removing `OPENAI_API_KEY` still produces a safe briefing; restoring it enables the structured AI path after restart.
7. No workflow offers transfer, settlement, blocking, reversal, or fraud determination.
