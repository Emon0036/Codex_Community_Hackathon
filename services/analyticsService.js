const defaultState = require("../data/demoData");
const { performance } = require("node:perf_hooks");

const round = (number) => Math.round(number);
const getState = (candidate) => candidate || defaultState;
const providerName = (snapshot, id) => snapshot.providers.find((provider) => provider.id === id)?.name || id;

// Prototype assumptions are explicit so the advisory score remains auditable.
const BASELINE_OBSERVATION_WINDOW_MINUTES = 10;
const MIN_BASELINE_SAMPLE_SIZE = 20;
const HIGH_BASELINE_SAMPLE_SIZE = 50;
const NEAR_IDENTICAL_AMOUNT_BUCKET = 100;
const RISK_SCORE_WEIGHTS = Object.freeze({ velocity: 0.30, timeGap: 0.25, amount: 0.20, repeatedAmount: 0.15, liquidityPressure: 0.10 });
const SCENARIO_LOCAL_EVENTS = Object.freeze({
  none: { cashInMultiplier: 1, cashOutMultiplier: 1, confidencePenalty: 0 },
  market_day: { cashInMultiplier: 1.12, cashOutMultiplier: 1.25, confidencePenalty: 0.02 },
  festival_payout: { cashInMultiplier: 1.18, cashOutMultiplier: 1.4, confidencePenalty: 0.04 },
  weather_disruption: { cashInMultiplier: 0.96, cashOutMultiplier: 1.18, confidencePenalty: 0.08 },
});
const SCENARIO_AGENT_AVAILABILITY = Object.freeze({
  normal: { capacity: 1, confidencePenalty: 0 },
  limited: { capacity: 0.72, confidencePenalty: 0.08 },
  unavailable: { capacity: 0.38, confidencePenalty: 0.16 },
});

const clamp = (value, minimum = 0, maximum = 100) => Math.min(maximum, Math.max(minimum, Number(value) || 0));
const fixed = (value, digits = 2) => Number(Number(value || 0).toFixed(digits));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length : null;

function boundedMultiplier(value, fallback = 1, minimum = 0.5, maximum = 3) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback));
}

function scenarioEventProfile(value) {
  return SCENARIO_LOCAL_EVENTS[String(value || "none")] || SCENARIO_LOCAL_EVENTS.none;
}

function scenarioAvailabilityProfile(value) {
  return SCENARIO_AGENT_AVAILABILITY[String(value || "normal")] || SCENARIO_AGENT_AVAILABILITY.normal;
}

function applyScenarioConfidence(forecast, eventProfile, availabilityProfile) {
  const penalty = Number(eventProfile.confidencePenalty || 0) + Number(availabilityProfile.confidencePenalty || 0);
  return { ...forecast, confidence: fixed(Math.max(0.42, Number(forecast.confidence || 0) - penalty), 2) };
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = values.slice().sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index];
}

function populationStandardDeviation(values) {
  if (!values.length) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length);
}

function baselineConfidence(sampleSize) {
  if (sampleSize >= HIGH_BASELINE_SAMPLE_SIZE) return "HIGH";
  if (sampleSize >= MIN_BASELINE_SAMPLE_SIZE) return "MEDIUM";
  return "LOW";
}

function transactionImportId(transaction, fallback = "legacy") {
  return String(transaction.importId || transaction.datasetImportId || transaction.batchId || fallback);
}

function baselineDocuments(candidate) {
  if (Array.isArray(candidate)) return candidate;
  if (Array.isArray(candidate?.baselines)) return candidate.baselines;
  if (Array.isArray(candidate?.baselineCalculation?.baselines)) return candidate.baselineCalculation.baselines;
  return [];
}

function repeatedRate(transactions) {
  if (!transactions.length) return 0;
  const buckets = new Map();
  transactions.forEach((transaction) => {
    const bucket = Math.round(Number(transaction.amount) / NEAR_IDENTICAL_AMOUNT_BUCKET) * NEAR_IDENTICAL_AMOUNT_BUCKET;
    buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
  });
  const repeated = [...buckets.values()].reduce((sum, count) => sum + (count >= 2 ? count : 0), 0);
  return repeated / transactions.length;
}

function calculateGroupStatistics(rows, context, calculatedAt) {
  const amounts = rows.map((row) => Number(row.amount));
  const importIds = [...new Set(rows.map((row) => transactionImportId(row, "legacy-baseline")))].sort();
  const gaps = [];
  const windowCounts = [];
  const windowAmounts = [];
  const windowRepeatedRates = [];

  importIds.forEach((importId) => {
    const importRows = rows.filter((row) => transactionImportId(row, "legacy-baseline") === importId).sort((left, right) => Number(left.minute) - Number(right.minute));
    for (let index = 1; index < importRows.length; index += 1) gaps.push(Number(importRows[index].minute) - Number(importRows[index - 1].minute));

    let start = 0;
    let end = 0;
    let rollingAmount = 0;
    let repeatedTransactions = 0;
    const amountBuckets = new Map();
    const addAmount = (amount) => {
      const bucket = Math.round(Number(amount) / NEAR_IDENTICAL_AMOUNT_BUCKET) * NEAR_IDENTICAL_AMOUNT_BUCKET;
      const previous = amountBuckets.get(bucket) || 0;
      if (previous === 1) repeatedTransactions += 2;
      else if (previous >= 2) repeatedTransactions += 1;
      amountBuckets.set(bucket, previous + 1);
    };
    const removeAmount = (amount) => {
      const bucket = Math.round(Number(amount) / NEAR_IDENTICAL_AMOUNT_BUCKET) * NEAR_IDENTICAL_AMOUNT_BUCKET;
      const previous = amountBuckets.get(bucket) || 0;
      if (previous === 2) repeatedTransactions -= 2;
      else if (previous > 2) repeatedTransactions -= 1;
      if (previous <= 1) amountBuckets.delete(bucket);
      else amountBuckets.set(bucket, previous - 1);
    };

    while (end < importRows.length) {
      const windowEndMinute = Number(importRows[end].minute);
      while (end < importRows.length && Number(importRows[end].minute) === windowEndMinute) {
        rollingAmount += Number(importRows[end].amount);
        addAmount(importRows[end].amount);
        end += 1;
      }
      while (start < end && Number(importRows[start].minute) <= windowEndMinute - BASELINE_OBSERVATION_WINDOW_MINUTES) {
        rollingAmount -= Number(importRows[start].amount);
        removeAmount(importRows[start].amount);
        start += 1;
      }
      const count = end - start;
      windowCounts.push(count);
      windowAmounts.push(rollingAmount);
      windowRepeatedRates.push(count ? repeatedTransactions / count : 0);
    }
  });

  const cashInRows = rows.filter((row) => row.type === "cash-in");
  const cashOutRows = rows.filter((row) => row.type === "cash-out");
  const typeCounts = new Map();
  rows.forEach((row) => typeCounts.set(row.type, (typeCounts.get(row.type) || 0) + 1));
  const dominantTransactionType = [...typeCounts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0] || null;
  const sampleSize = rows.length;

  return {
    scopeKey: `${context.scopeType}|${context.provider}|${context.account || "*"}|${context.transactionType || "*"}`,
    scopeType: context.scopeType,
    provider: context.provider,
    account: context.account || null,
    transactionType: context.transactionType || null,
    sampleSize,
    avgAmount: fixed(mean(amounts)),
    medianAmount: fixed(median(amounts)),
    amountStdDev: fixed(populationStandardDeviation(amounts)),
    p05Amount: fixed(percentile(amounts, 0.05)),
    p95Amount: fixed(percentile(amounts, 0.95)),
    avgTimeGapMinutes: gaps.length ? fixed(mean(gaps)) : null,
    medianTimeGapMinutes: gaps.length ? fixed(median(gaps)) : null,
    p05TimeGapMinutes: gaps.length ? fixed(percentile(gaps, 0.05)) : null,
    observationWindowMinutes: BASELINE_OBSERVATION_WINDOW_MINUTES,
    normalWindowMinutes: BASELINE_OBSERVATION_WINDOW_MINUTES,
    windowCount: windowCounts.length,
    avgTransactionsPerWindow: fixed(mean(windowCounts)),
    medianTransactionsPerWindow: fixed(median(windowCounts)),
    p95TransactionsPerWindow: fixed(percentile(windowCounts, 0.95)),
    maxTransactionsPerWindow: windowCounts.length ? Math.max(...windowCounts) : 0,
    avgAmountPerWindow: fixed(mean(windowAmounts)),
    p95AmountPerWindow: fixed(percentile(windowAmounts, 0.95)),
    cashInCount: cashInRows.length,
    cashOutCount: cashOutRows.length,
    cashInOutRatio: cashOutRows.length ? fixed(cashInRows.length / cashOutRows.length, 4) : null,
    totalCashInAmount: fixed(cashInRows.reduce((sum, row) => sum + Number(row.amount), 0)),
    totalCashOutAmount: fixed(cashOutRows.reduce((sum, row) => sum + Number(row.amount), 0)),
    dominantTransactionType,
    repeatedNearIdenticalRate: fixed(windowRepeatedRates.length ? windowRepeatedRates.reduce((sum, value, index) => sum + value * windowCounts[index], 0) / Math.max(sampleSize, 1) : 0, 4),
    p95RepeatedRatePerWindow: fixed(percentile(windowRepeatedRates, 0.95), 4),
    baselineConfidence: baselineConfidence(sampleSize),
    importIds,
    calculatedAt,
  };
}

function calculateBaselines(transactions = []) {
  const startedAt = performance.now();
  const candidates = Array.isArray(transactions) ? transactions : [];
  const hasExplicitBaselineRows = candidates.some((transaction) => transaction?.dataRole === "baseline");
  const rows = candidates.filter((transaction) => {
    if (hasExplicitBaselineRows && transaction?.dataRole !== "baseline") return false;
    return transaction && transaction.groundTruthLabel !== true && transaction.provider && transaction.type && transaction.account && Number.isFinite(Number(transaction.amount)) && Number.isFinite(Number(transaction.minute));
  }).map((transaction) => ({ ...transaction, amount: Number(transaction.amount), minute: Number(transaction.minute), importId: transactionImportId(transaction, "legacy-baseline") }));
  const calculatedAt = new Date().toISOString();
  const groups = new Map();
  const addToGroup = (context, row) => {
    const key = `${context.scopeType}|${context.provider}|${context.account || "*"}|${context.transactionType || "*"}`;
    if (!groups.has(key)) groups.set(key, { context, rows: [] });
    groups.get(key).rows.push(row);
  };
  rows.forEach((row) => {
    addToGroup({ scopeType: "provider", provider: row.provider, account: null, transactionType: null }, row);
    addToGroup({ scopeType: "provider_type", provider: row.provider, account: null, transactionType: row.type }, row);
    addToGroup({ scopeType: "provider_account", provider: row.provider, account: row.account, transactionType: null }, row);
    addToGroup({ scopeType: "provider_account_type", provider: row.provider, account: row.account, transactionType: row.type }, row);
  });
  const baselines = [...groups.values()].map(({ context, rows: groupRows }) => calculateGroupStatistics(groupRows, context, calculatedAt));
  baselines.sort((left, right) => left.scopeKey.localeCompare(right.scopeKey));
  return {
    baselines,
    calculatedAt,
    calculationDurationMs: fixed(performance.now() - startedAt, 3),
    transactionCount: rows.length,
    observationWindowMinutes: BASELINE_OBSERVATION_WINDOW_MINUTES,
  };
}

function resolveBaseline(candidate, context = {}) {
  const documents = baselineDocuments(candidate);
  const provider = context.provider;
  const account = context.account || null;
  const transactionType = context.transactionType || context.type || null;
  const scopes = [
    { scopeType: "provider_account_type", account, transactionType, allowed: Boolean(account && transactionType) },
    { scopeType: "provider_account", account, transactionType: null, allowed: Boolean(account) },
    { scopeType: "provider_type", account: null, transactionType, allowed: Boolean(transactionType) },
    { scopeType: "provider", account: null, transactionType: null, allowed: true },
  ];
  const candidates = scopes.filter((scope) => scope.allowed).map((scope) => documents.find((document) => document.scopeType === scope.scopeType && document.provider === provider && (document.account || null) === scope.account && (document.transactionType || null) === scope.transactionType)).filter(Boolean);
  const selected = candidates.find((document) => Number(document.sampleSize) >= MIN_BASELINE_SAMPLE_SIZE) || candidates[0] || null;
  if (!selected) return { baseline: null, baselineScopeUsed: null, baselineConfidence: "LOW", sufficient: false, usedFallback: false, explanation: "No historical baseline is available for this provider context." };
  const sufficient = Number(selected.sampleSize) >= MIN_BASELINE_SAMPLE_SIZE;
  return {
    baseline: selected,
    baselineScopeUsed: selected.scopeType,
    baselineConfidence: sufficient ? selected.baselineConfidence || baselineConfidence(selected.sampleSize) : "LOW",
    sufficient,
    usedFallback: selected.scopeType !== scopes.find((scope) => scope.allowed)?.scopeType,
    explanation: sufficient ? `Comparison uses the ${selected.scopeType.replaceAll("_", " + ")} historical baseline.` : `Only ${selected.sampleSize} historical records are available for the best matching scope; at least ${MIN_BASELINE_SAMPLE_SIZE} are required for a supported comparison.`,
  };
}

function projectLiquidity(provider, demand, replenishment = []) {
  const series = Array.isArray(demand) && demand.length ? demand : [0, 0, 0, 0, 0, 0];
  let balance = Number(provider.balance) || 0;
  let shortageHour = null;
  const rawProjection = series.map((outflow, index) => {
    balance += Number(replenishment[index]) || 0;
    balance -= Number(outflow) || 0;
    if (balance <= 0 && shortageHour === null) shortageHour = index + 1;
    return round(balance);
  });
  const projection = rawProjection.map((value) => Math.max(0, value));
  const freshness = Math.max(0.42, 1 - (Number(provider.updatedMinutesAgo) || 0) / 30);
  const maximum = Math.max(...series, 1);
  const volatility = Math.min(0.2, (maximum - Math.min(...series)) / maximum / 4);
  let confidence = Math.max(0.42, Math.min(0.96, freshness - volatility + 0.12));
  if (provider.feedStatus === "conflicting") confidence = Math.min(confidence, 0.5);
  if (provider.feedStatus === "late") confidence = Math.min(confidence, 0.46);
  return { projection, rawProjection, shortageHour, confidence: Number(confidence.toFixed(2)), totalDemand: series.reduce((sum, value) => sum + Number(value || 0), 0), totalReplenishment: replenishment.reduce((sum, value) => sum + Number(value || 0), 0) };
}

function projectSharedCash(snapshot = defaultState, multiplier = 1) {
  const combinedDemand = Array.from({ length: 6 }, (_, index) => snapshot.providers.reduce((sum, provider) => sum + (snapshot.cashOutDemand[provider.id]?.[index] || 0) * multiplier, 0));
  const combinedReplenishment = Array.from({ length: 6 }, (_, index) => snapshot.providers.reduce((sum, provider) => sum + (snapshot.cashInDemand[provider.id]?.[index] || 0) * multiplier, 0));
  const forecast = projectLiquidity({ balance: snapshot.outlet.sharedCash, updatedMinutesAgo: 2, feedStatus: "healthy" }, combinedDemand, combinedReplenishment);
  const averageNetOutflow = combinedDemand.reduce((sum, value, index) => sum + Math.max(0, value - combinedReplenishment[index]), 0) / combinedDemand.length;
  return { ...forecast, coverageHours: Number((snapshot.outlet.sharedCash / Math.max(averageNetOutflow, 1)).toFixed(1)), combinedDemand, combinedReplenishment };
}

function detectRepeatedAmounts(snapshot = defaultState, windowMinutes = 20) {
  const grouped = new Map();
  (snapshot.transactions || []).filter((transaction) => transaction.dataRole !== "baseline" && transaction.provider && transaction.type && Number.isFinite(Number(transaction.amount))).forEach((transaction) => {
    const key = `${transaction.provider}:${transaction.type}:${Math.round(Number(transaction.amount) / 100) * 100}`;
    grouped.set(key, [...(grouped.get(key) || []), transaction]);
  });
  const signals = [];
  for (const group of grouped.values()) {
    const sorted = group.slice().sort((a, b) => Number(a.minute) - Number(b.minute));
    let best = [];
    for (let start = 0; start < sorted.length; start += 1) {
      const window = sorted.filter((transaction) => Number(transaction.minute) >= Number(sorted[start].minute) && Number(transaction.minute) - Number(sorted[start].minute) <= windowMinutes);
      if (window.length > best.length) best = window;
    }
    if (best.length < 4) continue;
    signals.push({
      provider: best[0].provider,
      transactionType: best[0].type,
      count: best.length,
      average: round(best.reduce((sum, transaction) => sum + Number(transaction.amount), 0) / best.length),
      accounts: new Set(best.map((transaction) => transaction.account)).size,
      windowMinutes: Math.max(...best.map((transaction) => Number(transaction.minute))) - Math.min(...best.map((transaction) => Number(transaction.minute))),
    });
  }
  return signals;
}

function currentTransactionBatch(snapshot) {
  const rows = (snapshot.transactions || []).filter((transaction) => transaction.dataRole !== "baseline" && Number.isFinite(Number(transaction.minute)) && Number.isFinite(Number(transaction.amount)));
  if (!rows.length) return [];
  const last = rows.at(-1);
  const hasBatchMarker = Boolean(last.importId || last.datasetImportId || last.batchId);
  if (!hasBatchMarker) return rows.filter((transaction) => !(transaction.importId || transaction.datasetImportId || transaction.batchId));
  const latestImportId = transactionImportId(last, "legacy-current");
  return rows.filter((transaction) => transactionImportId(transaction, "legacy-current") === latestImportId);
}

function deviationAbove(currentValue, baselineValue) {
  if (Number(baselineValue) <= 0) return Number(currentValue) > 0 ? 100 : 0;
  return clamp((Number(currentValue) / Number(baselineValue) - 1) * 100);
}

function scoreLiquidityPressure(snapshot, providerId) {
  const provider = (snapshot.providers || []).find((entry) => entry.id === providerId);
  if (!provider) return 0;
  const forecast = projectLiquidity(provider, snapshot.cashInDemand?.[providerId] || [], snapshot.cashOutDemand?.[providerId] || []);
  if (forecast.shortageHour) return fixed(clamp((7 - forecast.shortageHour) / 6 * 100));
  return forecast.projection.at(-1) <= Number(provider.balance) * 0.18 ? 35 : 0;
}

function analyzeBehaviorContext(snapshot, documents, context, rows) {
  const resolution = resolveBaseline(documents, context);
  const sorted = rows.slice().sort((left, right) => Number(left.minute) - Number(right.minute));
  const latestMinute = Number(sorted.at(-1)?.minute || 0);
  const recent = sorted.filter((transaction) => Number(transaction.minute) > latestMinute - BASELINE_OBSERVATION_WINDOW_MINUTES && Number(transaction.minute) <= latestMinute);
  const currentRepeatedRate = repeatedRate(recent);

  if (!resolution.sufficient) {
    if (context.account || recent.length < 4 || currentRepeatedRate === 0) return null;
    return {
      provider: context.provider,
      transactionType: context.transactionType,
      account: null,
      count: recent.length,
      average: fixed(mean(recent.map((row) => Number(row.amount)))),
      accounts: new Set(recent.map((row) => row.account)).size,
      windowMinutes: BASELINE_OBSERVATION_WINDOW_MINUTES,
      advisoryRiskScore: null,
      riskLevel: "LOW",
      baselineConfidence: "LOW",
      baselineScopeUsed: resolution.baselineScopeUsed,
      baselineSampleSize: Number(resolution.baseline?.sampleSize || 0),
      reasons: [{
        signal: "INSUFFICIENT_BASELINE",
        currentValue: recent.length,
        minimumSampleSize: MIN_BASELINE_SAMPLE_SIZE,
        currentDisplay: `${recent.length} transactions / ${BASELINE_OBSERVATION_WINDOW_MINUTES} min`,
        baselineDisplay: resolution.baseline ? `${resolution.baseline.sampleSize} historical records` : "No matching historical records",
        deviationDisplay: "Not scored",
        explanation: `${resolution.explanation} The activity requires cautious human review and is not a fraud determination.`,
        score: null,
      }],
      riskScoreComponents: { velocity: null, timeGap: null, amount: null, repeatedAmount: null, liquidityPressure: scoreLiquidityPressure(snapshot, context.provider) },
      requiresHumanReview: true,
      insufficientBaseline: true,
    };
  }

  const baseline = resolution.baseline;
  const reasons = [];
  const componentScores = { velocity: 0, timeGap: 0, amount: 0, repeatedAmount: 0, liquidityPressure: scoreLiquidityPressure(snapshot, context.provider) };
  const currentCount = recent.length;
  const velocityP95 = Number(baseline.p95TransactionsPerWindow || 0);
  if (currentCount > velocityP95) {
    componentScores.velocity = deviationAbove(currentCount, velocityP95);
    const ratio = velocityP95 > 0 ? currentCount / velocityP95 : null;
    reasons.push({
      signal: "TRANSACTION_VELOCITY", currentValue: currentCount, baselineAverage: baseline.avgTransactionsPerWindow, baselineP95: velocityP95, unit: `transactions/${BASELINE_OBSERVATION_WINDOW_MINUTES}min`,
      currentDisplay: `${currentCount} transactions / ${BASELINE_OBSERVATION_WINDOW_MINUTES} min`, baselineDisplay: `Average ${baseline.avgTransactionsPerWindow}; P95 ${velocityP95} / ${BASELINE_OBSERVATION_WINDOW_MINUTES} min`, deviationDisplay: ratio ? `${fixed(ratio)}× historical P95` : "Historical P95 was zero",
      explanation: "Current transaction frequency is above the historical P95 for the selected baseline scope and requires review.", score: componentScores.velocity,
    });
  }

  const recentGaps = recent.slice(1).map((transaction, index) => Number(transaction.minute) - Number(recent[index].minute));
  const currentMedianGap = median(recentGaps);
  if (currentMedianGap !== null && Number(baseline.p05TimeGapMinutes) > 0 && currentMedianGap < Number(baseline.p05TimeGapMinutes)) {
    componentScores.timeGap = fixed(clamp((1 - currentMedianGap / Math.max(Number(baseline.medianTimeGapMinutes), 1)) * 100));
    const shorter = fixed((1 - currentMedianGap / Math.max(Number(baseline.medianTimeGapMinutes), 1)) * 100, 1);
    reasons.push({
      signal: "TIME_GAP", currentValue: fixed(currentMedianGap), baselineMedian: baseline.medianTimeGapMinutes, baselineP05: baseline.p05TimeGapMinutes, unit: "minutes",
      currentDisplay: `Recent median ${fixed(currentMedianGap)} min`, baselineDisplay: `Median ${baseline.medianTimeGapMinutes} min; P05 ${baseline.p05TimeGapMinutes} min`, deviationDisplay: `${shorter}% shorter than historical median`,
      explanation: "Recent transaction gaps are shorter than the lower historical range; this is an anomaly indicator, not proof of wrongdoing.", score: componentScores.timeGap,
    });
  }

  const currentP95Amount = percentile(recent.map((row) => Number(row.amount)), 0.95) || 0;
  const currentWindowAmount = recent.reduce((sum, row) => sum + Number(row.amount), 0);
  if (currentP95Amount > Number(baseline.p95Amount || 0)) {
    componentScores.amount = deviationAbove(currentP95Amount, baseline.p95Amount);
    reasons.push({
      signal: "AMOUNT_DEVIATION", currentValue: currentP95Amount, baselineMedian: baseline.medianAmount, baselineP95: baseline.p95Amount, unit: "BDT",
      currentDisplay: `BDT ${round(currentP95Amount).toLocaleString()}`, baselineDisplay: `Median BDT ${round(baseline.medianAmount).toLocaleString()}; P95 BDT ${round(baseline.p95Amount).toLocaleString()}`, deviationDisplay: `${fixed(currentP95Amount / Math.max(Number(baseline.p95Amount), 1))}× historical P95`,
      explanation: "The recent amount is above the historical P95 for the selected baseline scope and should be reviewed in context.", score: componentScores.amount,
    });
  }

  const baselineWindowAmountP95 = Number(baseline.p95AmountPerWindow || 0);
  if (context.account && recent.length >= 3 && currentP95Amount <= Number(baseline.p95Amount || 0) && currentWindowAmount > baselineWindowAmountP95) {
    const splittingScore = deviationAbove(currentWindowAmount, baselineWindowAmountP95);
    componentScores.velocity = Math.max(componentScores.velocity, splittingScore);
    reasons.push({
      signal: "TRANSACTION_SPLITTING", currentValue: currentWindowAmount, baselineP95: baselineWindowAmountP95, unit: `BDT/${BASELINE_OBSERVATION_WINDOW_MINUTES}min`,
      currentDisplay: `${recent.length} transactions totaling BDT ${round(currentWindowAmount).toLocaleString()}`, baselineDisplay: `Historical P95 window total BDT ${round(baselineWindowAmountP95).toLocaleString()}`, deviationDisplay: `${fixed(currentWindowAmount / Math.max(baselineWindowAmountP95, 1))}× historical P95`,
      explanation: "Several individually typical amounts produced an unusually high window total. This may indicate transaction splitting or legitimate concentrated demand and requires human review.", score: splittingScore,
    });
  }

  const baselineRepeatedP95 = Number(baseline.p95RepeatedRatePerWindow || 0);
  if (recent.length >= 4 && currentRepeatedRate > baselineRepeatedP95) {
    componentScores.repeatedAmount = fixed(clamp((currentRepeatedRate - baselineRepeatedP95) * 100));
    reasons.push({
      signal: "REPEATED_AMOUNT", currentValue: fixed(currentRepeatedRate, 4), baselineAverage: baseline.repeatedNearIdenticalRate, baselineP95: baselineRepeatedP95, unit: "share of transactions",
      currentDisplay: `${fixed(currentRepeatedRate * 100, 1)}% near-identical`, baselineDisplay: `Historical rate ${fixed(Number(baseline.repeatedNearIdenticalRate) * 100, 1)}%; P95 ${fixed(baselineRepeatedP95 * 100, 1)}%`, deviationDisplay: `${fixed((currentRepeatedRate - baselineRepeatedP95) * 100, 1)} percentage points above P95`,
      explanation: "Near-identical amounts occur more often than the historical baseline; legitimate demand or data issues remain possible.", score: componentScores.repeatedAmount,
    });
  }

  if (!context.account) {
    if (currentWindowAmount > Number(baseline.p95AmountPerWindow || 0)) {
      const demandScore = deviationAbove(currentWindowAmount, baseline.p95AmountPerWindow);
      componentScores.velocity = Math.max(componentScores.velocity, demandScore);
      reasons.push({
        signal: "PROVIDER_DEMAND", currentValue: currentWindowAmount, baselineAverage: baseline.avgAmountPerWindow, baselineP95: baseline.p95AmountPerWindow, unit: `BDT/${BASELINE_OBSERVATION_WINDOW_MINUTES}min`,
        currentDisplay: `BDT ${round(currentWindowAmount).toLocaleString()} / ${BASELINE_OBSERVATION_WINDOW_MINUTES} min`, baselineDisplay: `Average BDT ${round(baseline.avgAmountPerWindow).toLocaleString()}; P95 BDT ${round(baseline.p95AmountPerWindow).toLocaleString()}`, deviationDisplay: `${fixed(currentWindowAmount / Math.max(Number(baseline.p95AmountPerWindow), 1))}× historical P95`,
        explanation: "Provider-level transaction demand is above its historical P95 and may add operational pressure.", score: demandScore,
      });
    }
  }

  if (!reasons.length) return null;
  const advisoryRiskScore = round(Object.entries(RISK_SCORE_WEIGHTS).reduce((sum, [component, weight]) => sum + Number(componentScores[component] || 0) * weight, 0));
  const riskLevel = advisoryRiskScore >= 70 ? "HIGH" : advisoryRiskScore >= 40 ? "MEDIUM" : "LOW";
  return {
    provider: context.provider,
    transactionType: context.transactionType,
    account: context.account || null,
    count: recent.length,
    average: fixed(mean(recent.map((row) => Number(row.amount)))),
    accounts: new Set(recent.map((row) => row.account)).size,
    windowMinutes: BASELINE_OBSERVATION_WINDOW_MINUTES,
    advisoryRiskScore,
    riskLevel,
      baselineConfidence: resolution.baselineConfidence,
      baselineScopeUsed: resolution.baselineScopeUsed,
      baselineSampleSize: Number(baseline.sampleSize),
    reasons,
    riskScoreComponents: componentScores,
    requiresHumanReview: advisoryRiskScore >= 60 || reasons.length >= 2,
    insufficientBaseline: false,
  };
}

function analyzeBaselineBehavior(candidateState) {
  const snapshot = getState(candidateState);
  const documents = baselineDocuments(snapshot);
  if (!documents.length) return [];
  const rows = currentTransactionBatch(snapshot);
  const groups = new Map();
  const addGroup = (context, row) => {
    const key = `${context.provider}|${context.account || "*"}|${context.transactionType}`;
    if (!groups.has(key)) groups.set(key, { context, rows: [] });
    groups.get(key).rows.push(row);
  };
  rows.forEach((row) => {
    addGroup({ provider: row.provider, account: row.account, transactionType: row.type }, row);
    addGroup({ provider: row.provider, account: null, transactionType: row.type }, row);
  });
  const candidates = [...groups.values()].map(({ context, rows: groupRows }) => analyzeBehaviorContext(snapshot, documents, context, groupRows)).filter(Boolean);
  const providerOrder = new Map((snapshot.providers || []).map((provider, index) => [provider.id, index]));
  const strongestByProvider = new Map();
  candidates.forEach((candidate) => {
    const current = strongestByProvider.get(candidate.provider);
    const candidateScore = candidate.advisoryRiskScore ?? -1;
    const currentScore = current?.advisoryRiskScore ?? -1;
    if (!current || candidateScore > currentScore || (candidateScore === currentScore && candidate.account && !current.account)) strongestByProvider.set(candidate.provider, candidate);
  });
  return [...strongestByProvider.values()].sort((left, right) => (providerOrder.get(left.provider) ?? 999) - (providerOrder.get(right.provider) ?? 999));
}

function getBaselineSummary(candidateState) {
  const snapshot = getState(candidateState);
  return baselineDocuments(snapshot).filter((baseline) => baseline.scopeType === "provider").map((baseline) => ({
    ...baseline,
    providerName: providerName(snapshot, baseline.provider),
    historicalTransactions: baseline.sampleSize,
  })).sort((left, right) => left.providerName.localeCompare(right.providerName));
}

function getBaselineMetrics(candidateState, candidateAlerts) {
  const snapshot = getState(candidateState);
  const alerts = Array.isArray(candidateAlerts) ? candidateAlerts : getAlerts(snapshot);
  const highImpact = alerts.filter((alert) => alert.type === "behavior" && alert.requiresHumanReview && Number.isFinite(alert.advisoryRiskScore));
  const covered = highImpact.filter((alert) => Array.isArray(alert.reasons) && alert.reasons.some((reason) => reason.signal !== "INSUFFICIENT_BASELINE"));
  const latestImport = (snapshot.datasetImports || []).slice().sort((left, right) => String(right.importedAt || right.createdAt || "").localeCompare(String(left.importedAt || left.createdAt || "")))[0] || null;
  return {
    explanationCoverage: { eligibleAlertCount: highImpact.length, coveredAlertCount: covered.length, percentage: highImpact.length ? fixed(covered.length / highImpact.length * 100, 1) : null },
    baselineCalculationDurationMs: latestImport?.baselineCalculationDurationMs ?? latestImport?.calculationDurationMs ?? snapshot.baselineMetadata?.calculationDurationMs ?? null,
    csvProcessingDurationMs: latestImport?.importProcessingDurationMs ?? latestImport?.processingDurationMs ?? latestImport?.importDurationMs ?? null,
    precisionRecall: { available: false, reason: "Precision and recall are unavailable unless an imported evaluation dataset contains ground-truth anomaly labels." },
  };
}

function getBaselineOverview(candidateState, candidateAlerts) {
  const snapshot = getState(candidateState);
  const summary = getBaselineSummary(snapshot);
  const documents = baselineDocuments(snapshot);
  return {
    available: documents.length > 0,
    baselineCount: documents.length,
    providerCount: summary.length,
    observationWindowMinutes: BASELINE_OBSERVATION_WINDOW_MINUTES,
    minimumSampleSize: MIN_BASELINE_SAMPLE_SIZE,
    calculatedAt: documents.map((document) => document.calculatedAt).filter(Boolean).sort().at(-1) || null,
    summary,
    metrics: getBaselineMetrics(snapshot, candidateAlerts),
  };
}

function evaluateLabelledTransactions(candidateState, transactions = [], calculatedBaselines) {
  const labelledRows = (Array.isArray(transactions) ? transactions : []).filter((row) => typeof row.groundTruthLabel === "boolean");
  if (!labelledRows.length) return {
    groundTruthAvailable: false,
    precision: null,
    recall: null,
    falsePositiveRate: null,
    message: "Precision/recall unavailable because the imported baseline dataset does not contain ground-truth anomaly labels.",
  };

  const documents = baselineDocuments(calculatedBaselines || candidateState);
  if (!documents.length) return {
    groundTruthAvailable: true,
    precision: null,
    recall: null,
    falsePositiveRate: null,
    evaluatedRows: 0,
    message: "Ground-truth labels are present, but there are not enough labelled normal rows to calculate a comparison baseline.",
  };

  const snapshot = { ...getState(candidateState), baselines: documents };
  const groups = new Map();
  labelledRows.forEach((row) => {
    const key = `${transactionImportId(row, "labelled-evaluation")}|${row.provider}|${row.account}|${row.type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  });
  const counts = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };

  groups.forEach((groupRows) => {
    const sorted = groupRows.slice().sort((left, right) => Number(left.minute) - Number(right.minute));
    const endpoints = [...new Set(sorted.map((row) => Number(row.minute)))];
    endpoints.forEach((endpoint) => {
      const currentWindow = sorted.filter((row) => Number(row.minute) > endpoint - BASELINE_OBSERVATION_WINDOW_MINUTES && Number(row.minute) <= endpoint);
      const context = { provider: sorted[0].provider, account: sorted[0].account, transactionType: sorted[0].type };
      const signal = analyzeBehaviorContext(snapshot, documents, context, currentWindow);
      const predictedAnomaly = Boolean(signal && !signal.insufficientBaseline && signal.requiresHumanReview);
      sorted.filter((row) => Number(row.minute) === endpoint).forEach((row) => {
        if (predictedAnomaly && row.groundTruthLabel) counts.truePositive += 1;
        else if (predictedAnomaly) counts.falsePositive += 1;
        else if (row.groundTruthLabel) counts.falseNegative += 1;
        else counts.trueNegative += 1;
      });
    });
  });

  const precisionDenominator = counts.truePositive + counts.falsePositive;
  const recallDenominator = counts.truePositive + counts.falseNegative;
  const falsePositiveDenominator = counts.falsePositive + counts.trueNegative;
  return {
    groundTruthAvailable: true,
    evaluatedRows: labelledRows.length,
    ...counts,
    precision: precisionDenominator ? fixed(counts.truePositive / precisionDenominator, 4) : null,
    recall: recallDenominator ? fixed(counts.truePositive / recallDenominator, 4) : null,
    falsePositiveRate: falsePositiveDenominator ? fixed(counts.falsePositive / falsePositiveDenominator, 4) : null,
    message: "Metrics evaluate labelled rows against baselines calculated from rows not labelled as anomalies; results are prototype validation evidence, not production performance claims.",
  };
}

function getAlerts(candidateState) {
  const snapshot = getState(candidateState);
  const alerts = [];
  const cashForecast = projectSharedCash(snapshot);
  if (cashForecast.shortageHour || cashForecast.coverageHours < 5) alerts.push({
    id: "ALT-SHARED-CASH", provider: "shared", type: "liquidity", severity: cashForecast.shortageHour ? "high" : "medium",
    title: "Shared physical cash reserve may face pressure",
    explanation: `Combined simulated cash-out demand may exhaust the shared physical cash reserve in about ${cashForecast.shortageHour || cashForecast.coverageHours} hours. Provider e-money remains separate.`,
    banglaExplanation: `সিমুলেটেড নিট চাহিদায় শেয়ার্ড নগদ প্রায় ${cashForecast.shortageHour || cashForecast.coverageHours} ঘণ্টায় শেষ হতে পারে। এটি একটি আনুমানিক সতর্কতা; প্রোভাইডারের ই-মানি আলাদা থাকবে।`,
    banglaNextStep: "আউটলেটের চাহিদা যাচাই করে অনুমোদিত ক্যাশ সহায়তার জন্য দায়িত্বপ্রাপ্ত টিমের সাথে যোগাযোগ করুন; প্রোভাইডারের ব্যালেন্স স্থানান্তর করবেন না।",
    evidence: [`Shared cash: ৳${snapshot.outlet.sharedCash.toLocaleString()}`, `Projected cash-out demand: ৳${cashForecast.totalDemand.toLocaleString()}`, `Projected cash-in replenishment: ৳${cashForecast.totalReplenishment.toLocaleString()}`, `Net cash outflow: ৳${(cashForecast.totalDemand-cashForecast.totalReplenishment).toLocaleString()}`, `Coverage estimate: ${cashForecast.coverageHours} hours`],
    confidence: cashForecast.confidence,
    recommendation: "Verify demand and coordinate authorized cash support. Do not convert or move balances between providers.",
    status: snapshot.cases.find((item) => item.alertId === "ALT-SHARED-CASH")?.status || "open",
  });
  snapshot.providers.forEach((provider) => {
    const forecast = projectLiquidity(provider, snapshot.cashInDemand[provider.id], snapshot.cashOutDemand[provider.id]);
    if (forecast.shortageHour || forecast.projection.at(-1) <= provider.balance * 0.18) alerts.push({
      id: `ALT-${provider.id.toUpperCase()}-LIQ`, provider: provider.id, type: "liquidity", severity: forecast.shortageHour ? "high" : "medium",
      title: `${provider.name} balance may face service pressure`,
      explanation: forecast.shortageHour ? `At the current simulated demand rate, the separate ${provider.name} balance may be exhausted in about ${forecast.shortageHour} hours.` : `${provider.name} is projected to retain less than 18% of its current balance.`,
      banglaExplanation: `সিমুলেটেড হিসাবে আলাদা ${provider.name} ই-মানি ব্যালেন্স প্রায় ${forecast.shortageHour || 6} ঘণ্টার মধ্যে চাপে পড়তে পারে। হিউরিস্টিক আস্থা ${Math.round(forecast.confidence * 100)}%; এটি নিশ্চিত ফল নয়।`,
      banglaNextStep: `${provider.name} অপারেশনস টিমের সাথে প্রত্যাশিত ক্যাশ-ইন চাহিদা যাচাই করুন; অন্য প্রোভাইডার থেকে ব্যালেন্স স্থানান্তর করবেন না।`,
      evidence: [`Current balance: ৳${provider.balance.toLocaleString()}`, `Projected cash-in e-money demand: ৳${forecast.totalDemand.toLocaleString()}`, `Projected cash-out replenishment: ৳${forecast.totalReplenishment.toLocaleString()}`, `Feed status: ${provider.feedStatus}`],
      confidence: forecast.confidence,
      recommendation: `Contact ${provider.name} operations and verify expected demand. Do not move funds across providers.`,
      status: snapshot.cases.find((item) => item.alertId === `ALT-${provider.id.toUpperCase()}-LIQ`)?.status || "open",
    });
    if (provider.feedStatus === "conflicting") alerts.push({
      id: `ALT-${provider.id.toUpperCase()}-DATA`, provider: provider.id, type: "data-quality", severity: "medium",
      title: `${provider.name} balance feeds conflict`,
      explanation: `Two simulated ${provider.name} sources disagree by ৳${Math.abs(provider.balance - provider.alternateBalance).toLocaleString()}. Automated recommendations are intentionally limited until a human verifies the source.`,
      banglaExplanation: `দুইটি সিমুলেটেড ${provider.name} উৎসে ৳${Math.abs(provider.balance - provider.alternateBalance).toLocaleString()} পার্থক্য আছে। হিউরিস্টিক আস্থা ৫০%; সঠিক উৎস মানব যাচাই না করা পর্যন্ত ফল সীমিত।`,
      banglaNextStep: `${provider.name}-এর অনুমোদিত উৎস ও সময় যাচাই করুন; যাচাইয়ের আগে আর্থিক সিদ্ধান্ত নেবেন না।`,
      evidence: [`Primary feed: ৳${provider.balance.toLocaleString()}`, `Secondary feed: ৳${provider.alternateBalance.toLocaleString()}`, "Confidence capped at 50%"],
      confidence: 0.5,
      recommendation: `Verify the approved ${provider.name} source and timestamp before acting on this balance.`,
      status: snapshot.cases.find((item) => item.alertId === `ALT-${provider.id.toUpperCase()}-DATA`)?.status || "open",
    });
  });
  const hasBaselines = baselineDocuments(snapshot).length > 0;
  if (hasBaselines) analyzeBaselineBehavior(snapshot).forEach((signal) => {
    const id = `ALT-${signal.provider.toUpperCase()}-BASELINE-01`;
    const evidence = [
      ...signal.reasons.map((reason) => `${reason.signal}: ${reason.currentDisplay}; historical baseline: ${reason.baselineDisplay}; ${reason.deviationDisplay}`),
      `Baseline scope used: ${signal.baselineScopeUsed || "insufficient historical evidence"}`,
      ...(signal.account ? [`Pseudonymous account context: ${signal.account}`] : []),
      ...(signal.advisoryRiskScore === null ? [] : [`Advisory risk score: ${signal.advisoryRiskScore}/100 (not a fraud probability)`]),
    ];
    const confidence = ({ HIGH: 0.86, MEDIUM: 0.68, LOW: 0.42 }[signal.baselineConfidence] || 0.42);
    const explanation = signal.insufficientBaseline
      ? `${signal.count} recent transactions need cautious review, but the matching historical sample is too small for a supported anomaly score. No fraud conclusion has been generated.`
      : `${signal.count} recent ${signal.transactionType} transactions differ from the selected historical baseline. The advisory risk score is ${signal.advisoryRiskScore}/100; this is an anomaly indicator for human review, not a fraud probability or determination.`;
    alerts.push({
      id, provider: signal.provider, account: signal.account, transactionType: signal.transactionType, type: "behavior", severity: signal.riskLevel === "HIGH" ? "high" : signal.riskLevel === "MEDIUM" ? "medium" : "low",
      title: signal.insufficientBaseline ? "Activity requires review with limited historical evidence" : "Activity differs from its historical baseline",
      explanation,
      banglaExplanation: "ঐতিহাসিক বেসলাইনের তুলনায় বর্তমান লেনদেনের আচরণ ভিন্ন হতে পারে। এটি একটি পর্যালোচনা-সহায়ক সংকেত; জালিয়াতির সিদ্ধান্ত নয়।",
      banglaNextStep: "বর্তমান ও ঐতিহাসিক প্রমাণ মানব পর্যালোচনা করুন; কোনো অ্যাকাউন্ট ব্লক বা অর্থ স্থানান্তর করবেন না।",
      evidence,
      confidence,
      advisoryRiskScore: signal.advisoryRiskScore,
      riskLevel: signal.riskLevel,
      baselineConfidence: signal.baselineConfidence,
      baselineScopeUsed: signal.baselineScopeUsed,
      baselineSampleSize: signal.baselineSampleSize,
      reasons: signal.reasons,
      riskScoreComponents: signal.riskScoreComponents,
      requiresHumanReview: signal.requiresHumanReview,
      recommendation: `Ask ${providerName(snapshot, signal.provider)} risk review to validate the recorded evidence while operations checks service continuity. Do not block accounts or move funds across providers.`,
      status: snapshot.cases.find((item) => item.alertId === id)?.status || "open",
    });
  });
  if (!hasBaselines) detectRepeatedAmounts(snapshot).forEach((signal, index) => {
    const id = `ALT-${signal.provider.toUpperCase()}-${String(index + 1).padStart(2, "0")}`;
    alerts.push({
      id, provider: signal.provider, type: "behavior", severity: "medium",
      title: "Activity requires review with limited historical evidence",
      explanation: `${signal.count} near-identical transactions appeared in the current observation window, but no historical baseline is loaded. This is a low-confidence review indicator; no advisory anomaly score or fraud conclusion has been generated.`,
      banglaExplanation: `${signal.windowMinutes} মিনিটে ${signal.count}টি কাছাকাছি লেনদেন দেখা গেছে, কিন্তু কোনো ঐতিহাসিক বেসলাইন লোড করা নেই। এটি কম-আস্থার পর্যালোচনা সংকেত; কোনো জালিয়াতির সিদ্ধান্ত তৈরি করা হয়নি।`,
      banglaNextStep: `${providerName(snapshot, signal.provider)} রিস্ক ও অপারেশনস টিমকে রেকর্ড করা প্যাটার্ন মানব যাচাই করতে বলুন; কোনো স্বয়ংক্রিয় ব্লক বা অর্থ স্থানান্তর করবেন না।`,
      evidence: [`Transaction type: ${signal.transactionType}`, `${signal.count} repeated amounts`, `${signal.accounts} anonymized accounts`, `${signal.windowMinutes}-minute window`, "Historical baseline unavailable; no advisory anomaly score was calculated"],
      confidence: 0.42,
      advisoryRiskScore: null,
      riskLevel: "LOW",
      baselineConfidence: "LOW",
      baselineScopeUsed: null,
      baselineSampleSize: 0,
      reasons: [{ signal: "INSUFFICIENT_BASELINE", currentValue: signal.count, currentDisplay: `${signal.count} transactions / ${signal.windowMinutes} min`, baselineDisplay: "No historical baseline loaded", deviationDisplay: "Not scored", explanation: "Historical evidence is insufficient for a supported anomaly conclusion.", score: null }],
      riskScoreComponents: { velocity: null, timeGap: null, amount: null, repeatedAmount: null, liquidityPressure: scoreLiquidityPressure(snapshot, signal.provider) },
      requiresHumanReview: true,
      recommendation: `Ask ${providerName(snapshot, signal.provider)} risk review to validate the pattern while operations checks service continuity. Do not block accounts or move funds across providers.`,
      status: snapshot.cases.find((item) => item.alertId === id)?.status || "open",
    });
  });
  alerts.forEach((alert) => {
    alert.relatedAlertIds = alerts.filter((candidate) => candidate.id !== alert.id && candidate.provider === alert.provider).map((candidate) => candidate.id);
    if (alert.type === "behavior" && alert.relatedAlertIds.some((id) => id.endsWith("-LIQ"))) alert.evidence.push("Provider liquidity pressure is present at the same time; causes remain unconfirmed");
  });
  return alerts.sort((a, b) => (a.status === "resolved") - (b.status === "resolved") || b.confidence - a.confidence);
}

function getDashboard(candidateState) {
  const snapshot = getState(candidateState);
  const providers = snapshot.providers.map((provider) => ({ ...provider, forecast: projectLiquidity(provider, snapshot.cashInDemand[provider.id], snapshot.cashOutDemand[provider.id]) }));
  const alerts = getAlerts(snapshot);
  const cashForecast = projectSharedCash(snapshot);
  const baselineOverview = getBaselineOverview(snapshot, alerts);
  return {
    outlet: snapshot.outlet, providers, alerts, cases: snapshot.cases, cashForecast,
    summary: { totalEmoney: providers.reduce((sum, provider) => sum + provider.balance, 0), sharedCash: snapshot.outlet.sharedCash, openAlerts: alerts.filter((alert) => alert.status !== "resolved").length, coverageHours: cashForecast.coverageHours },
    baselineOverview, baselineSummary: baselineOverview.summary, baselineMetrics: baselineOverview.metrics,
    labels: ["Now", "+1h", "+2h", "+3h", "+4h", "+5h", "+6h"], generatedAt: new Date().toISOString(),
  };
}

function getNetworkDashboard(candidateState, filters = {}) {
  const snapshot = getState(candidateState);
  const area = String(filters.area || "all");
  const outlets = snapshot.networkOutlets.filter((outlet) => area === "all" || outlet.area === area);
  return { outlets, areas: [...new Set(snapshot.networkOutlets.map((outlet) => outlet.area))], counts: { total: outlets.length, high: outlets.filter((outlet) => outlet.pressure === "high").length, watch: outlets.filter((outlet) => outlet.pressure === "watch").length }, area };
}

function simulate(input = {}, candidateState) {
  const snapshot = getState(candidateState);
  const scenarioInput = input && typeof input === "object" ? input : {};
  const multiplier = boundedMultiplier(scenarioInput.demandMultiplier);
  const providerDemandMultiplier = boundedMultiplier(scenarioInput.providerDemandMultiplier, 1, 1, 3);
  const providerDemandTarget = snapshot.providers.some((provider) => provider.id === scenarioInput.providerDemandProvider)
    ? scenarioInput.providerDemandProvider
    : "all";
  const eventProfile = scenarioEventProfile(scenarioInput.localEvent);
  const availabilityProfile = scenarioAvailabilityProfile(scenarioInput.agentAvailability);
  const providerFactor = (providerId, flow) => {
    const focused = providerDemandTarget === "all" || providerDemandTarget === providerId ? providerDemandMultiplier : 1;
    const eventFactor = flow === "cashOut" ? eventProfile.cashOutMultiplier : eventProfile.cashInMultiplier;
    return multiplier * focused * eventFactor;
  };
  const capacity = Number(availabilityProfile.capacity || 1);
  const affected = snapshot.providers.some((provider) => provider.id === scenarioInput.missingProvider) ? scenarioInput.missingProvider : null;
  const combinedDemand = Array.from({ length: 6 }, (_, index) => snapshot.providers.reduce((sum, provider) => sum + (snapshot.cashOutDemand[provider.id]?.[index] || 0) * providerFactor(provider.id, "cashOut"), 0)).map(round);
  const combinedReplenishment = Array.from({ length: 6 }, (_, index) => snapshot.providers.reduce((sum, provider) => sum + (snapshot.cashInDemand[provider.id]?.[index] || 0) * providerFactor(provider.id, "cashIn"), 0)).map(round);
  const cash = applyScenarioConfidence(projectLiquidity({ balance: snapshot.outlet.sharedCash, updatedMinutesAgo: 2, feedStatus: "healthy" }, combinedDemand, combinedReplenishment), eventProfile, availabilityProfile);
  const sharedServiceLoad = cash.totalDemand + cash.totalReplenishment;
  const sharedResult = {
    id: "shared",
    name: "Shared physical cash",
    balance: snapshot.outlet.sharedCash,
    projection: cash.projection,
    rawProjection: cash.rawProjection,
    shortageHour: cash.shortageHour,
    confidence: cash.confidence,
    totalDemand: cash.totalDemand,
    totalReplenishment: cash.totalReplenishment,
    serviceCapacityPercent: Math.round(capacity * 100),
    unservedDemand: round(sharedServiceLoad * Math.max(0, 1 - capacity)),
    localEvent: String(scenarioInput.localEvent || "none"),
    agentAvailability: String(scenarioInput.agentAvailability || "normal"),
  };
  const providers = snapshot.providers.map((provider) => {
    const demand = snapshot.cashInDemand[provider.id].map((value) => round(value * providerFactor(provider.id, "cashIn")));
    const replenishment = snapshot.cashOutDemand[provider.id].map((value) => round(value * providerFactor(provider.id, "cashOut")));
    let forecast = applyScenarioConfidence(projectLiquidity(provider, demand, replenishment), eventProfile, availabilityProfile);
    if (provider.id === affected) {
      forecast.confidence = 0.42;
      forecast.fallback = "Provider feed unavailable; the last known balance is shown with low confidence and no automatic action.";
    }
    const serviceLoad = forecast.totalDemand + forecast.totalReplenishment;
    return {
      id: provider.id,
      name: provider.name,
      balance: provider.balance,
      ...forecast,
      serviceCapacityPercent: Math.round(capacity * 100),
      unservedDemand: round(serviceLoad * Math.max(0, 1 - capacity)),
      localEvent: String(scenarioInput.localEvent || "none"),
      agentAvailability: String(scenarioInput.agentAvailability || "normal"),
    };
  });
  return [sharedResult, ...providers];
}

function getAlertById(id, candidateState) {
  return getAlerts(candidateState).find((alert) => alert.id === id) || null;
}

module.exports = {
  BASELINE_OBSERVATION_WINDOW_MINUTES,
  MIN_BASELINE_SAMPLE_SIZE,
  HIGH_BASELINE_SAMPLE_SIZE,
  RISK_SCORE_WEIGHTS,
  calculateBaselines,
  resolveBaseline,
  analyzeBaselineBehavior,
  getBaselineSummary,
  getBaselineOverview,
  getBaselineMetrics,
  evaluateLabelledTransactions,
  getDashboard,
  getNetworkDashboard,
  getAlerts,
  getAlertById,
  projectLiquidity,
  projectSharedCash,
  simulate,
  detectRepeatedAmounts,
};
