# Data and Simulation Note

## Data creation

All outlets, balances, account labels, transactions, people, and demand series are fictional. The primary scenario was hand-constructed to demonstrate the challenge conditions; no production customer or provider data was used.

The fixture contains four Sylhet-area outlets and three logically separate providers. The primary outlet starts with ৳245,000 physical cash and separate bKash, Nagad, and Rocket e-money balances.

## Accounting model

Two demand series are deliberately separate:

- **Cash-in:** the customer gives cash to the agent. Shared physical cash increases; that provider's agent e-money decreases.
- **Cash-out:** the customer gives e-money to the agent. Shared physical cash decreases; that provider's agent e-money increases.

For hour `h`:

```text
provider_e_money[h] = prior + provider_cash_out[h] - provider_cash_in[h]
shared_cash[h]      = prior + total_cash_in[h]    - total_cash_out[h]
```

This produces a reproducible Nagad e-money shortage near hour 4 and shared-cash shortage near hour 6. Balances are clamped only for display; the raw projection retains negative values for detection.

## Unusual-activity fixture

Five Nagad cash-outs near ৳9,900 occur within 12 simulated minutes across three pseudonymous accounts. The detector rounds to ৳100 buckets and requires at least four events within a 20-minute sliding window. It labels this “unusual” and connects it to simultaneous Nagad liquidity pressure, but does not infer cause or fraud.

## Data-quality scenarios

- Rocket has two conflicting simulated balance sources; confidence is capped at 50%.
- Scenario Lab can remove one feed; the last known value remains visible at 42% heuristic confidence.
- Snapshot ingestion accepts `healthy`, `late`, or `conflicting`; conflicting requires a secondary value.

## Confidence definition

Displayed percentages are heuristic engineering indicators, not calibrated probabilities. Forecast confidence begins with feed freshness, subtracts a bounded demand-volatility term, and is capped for late/conflicting feeds. The anomaly fixture uses a fixed 0.86 review-priority indicator. These values require calibration and backtesting before any real use.

## CSV contract

Headers: `provider,type,amount,account,minute`. Only synthetic rows are allowed, with at most 500 rows and 512 KB. The account column is replaced by a keyed HMAC pseudonym before storage. PINs, OTPs, NIDs, passwords, real phone numbers, and production transactions are prohibited.

## Expected false positives and limits

Repeated festival demand, salary-day patterns, batch processing, duplicate upstream events, or agent workflow can produce similar amounts without wrongdoing. Forecasts assume the six-hour fixture pattern continues and omit weather, outages, customer arrivals, and approved support already in transit. Every output therefore requires human verification.
