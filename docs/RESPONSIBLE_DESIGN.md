# Responsible Design Note

## Human authority

Nirapod Ops supports prioritization and coordination. A human owns every case and chooses every status change. It does not automate money movement, provider conversion, account blocking, disciplinary action, or final fraud decisions.

## AI boundary

Deterministic code creates signals, evidence, severity, confidence, recipient, safe next step, and allowed workflow states. OpenAI is optional and generates only English/Bangla explanatory language from an allowlist of aggregate alert fields. Zod enforces the response shape, then a deterministic policy gate rejects allegations and financial-action language. Any model-proposed next step is discarded and replaced with the rule-based alert recommendation. The request uses `store: false`, a short timeout, one retry, and no web/tool access. A missing key, refusal, timeout, network error, unsafe language, or invalid schema returns a deterministic fallback.

The prompt prohibits invented facts, allegations, guilt, financial commands, and cross-provider transfer advice. Successful AI records store model name, prompt version, evidence hash, generation time, and human requester for traceability. Fallback results are not cached, so a restored AI service can recover.

## Privacy and security

- Synthetic identifiers only; CSV labels are transformed with keyed HMAC.
- Demo entry collects only a selected role. It does not request passwords, provider/customer credentials, PINs, OTPs, NIDs, or private financial authentication data.
- Provider-scoped RBAC minimizes exposure; database and API keys remain server-side environment variables.
- CSP, CSRF, secure cookie settings, rate limits, input limits, escaped output, and audit records reduce common web risks.

## Fairness and uncertainty

Repeated values can reflect legitimate cultural, festival, salary-day, or operational patterns. The product consistently says “unusual” or “requires review,” displays evidence and heuristic uncertainty, and documents expected false positives. Area/provider prioritization must not be used as an accusation or customer risk score.

## Production gate

Real deployment requires provider authorization, legal/privacy review, threat modeling, calibrated thresholds on approved representative data, drift and false-positive monitoring, incident response, access reviews, retention rules, and documented appeal/correction workflows.
