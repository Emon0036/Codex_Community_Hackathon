const analytics = require("./analyticsService");

const DEFAULT_SEED = 20260711;
const DATASET_VERSION = "synthetic-evaluation-v1";
const HORIZON_HOURS = 6;
const PROVIDERS = ["bkash", "nagad", "rocket"];

function normalizeSeed(seed) {
  const numeric = Number(seed);
  return Number.isFinite(numeric) ? numeric >>> 0 : DEFAULT_SEED;
}

// Mulberry32 is small, deterministic, and sufficient for repeatable fixtures.
// It is not used for security-sensitive randomness.
function createSeededRandom(seed = DEFAULT_SEED) {
  let state = normalizeSeed(seed);
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(random, minimum, maximum) {
  return Math.floor(random() * (maximum - minimum + 1)) + minimum;
}

function randomBetween(random, minimum, maximum) {
  return minimum + random() * (maximum - minimum);
}

function approximatelyNormal(random) {
  let total = 0;
  for (let index = 0; index < 6; index += 1) total += random();
  return total - 3;
}

function shuffle(values, random) {
  const shuffled = values.slice();
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(random, 0, index);
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function roundMetric(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

function safeDivide(numerator, denominator) {
  return denominator ? numerator / denominator : 0;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function makeBackgroundTransactions(fixtureIndex, random) {
  const count = randomInt(random, 22, 30);
  return Array.from({ length: count }, (_, index) => {
    const provider = PROVIDERS[(fixtureIndex + index) % PROVIDERS.length];
    const providerOffset = PROVIDERS.indexOf(provider) * 35;
    return {
      id: `BG-${fixtureIndex}-${index}`,
      provider,
      type: index % 5 === 0 ? "cash-in" : "cash-out",
      // Each cash-out has a distinct rounded-100 bucket inside this fixture.
      amount: 1200 + index * 650 + providerOffset + randomInt(random, -20, 20),
      account: `SYN-BG-${fixtureIndex}-${index}`,
      minute: randomInt(random, 0, 240),
      source: "synthetic-evaluation",
    };
  });
}

function makeRepeatedTransactions({ fixtureIndex, provider, count, baseAmount, minutes, amountOffsets, purpose }, random) {
  return Array.from({ length: count }, (_, index) => ({
    id: `INJ-${fixtureIndex}-${index}`,
    provider,
    type: "cash-out",
    amount: baseAmount + (amountOffsets ? amountOffsets[index] : randomInt(random, -34, 34)),
    account: `SYN-INJ-${fixtureIndex}-${index % Math.min(count, 4)}`,
    minute: minutes[index],
    source: "synthetic-evaluation",
    syntheticPurpose: purpose,
  }));
}

function buildAnomalyFixture(category, fixtureIndex, random) {
  const provider = PROVIDERS[fixtureIndex % PROVIDERS.length];
  const baseAmount = 42000 + (fixtureIndex % 20) * 500;
  const start = randomInt(random, 25, 155);
  const transactions = makeBackgroundTransactions(fixtureIndex, random);
  let injected = [];
  let hasInjectedAnomaly = false;
  let truthReason = "Background activity does not contain a review-worthy repeated-amount pattern.";

  if (category === "rule_aligned_anomaly") {
    const count = randomInt(random, 4, 7);
    const step = Math.max(2, Math.floor(16 / (count - 1)));
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count,
      baseAmount,
      minutes: Array.from({ length: count }, (_, index) => start + index * step),
      purpose: "injected-review-pattern",
    }, random);
    hasInjectedAnomaly = true;
    truthReason = "At least four near-identical cash-outs were injected inside 20 minutes.";
  } else if (category === "low_count_edge_anomaly") {
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count: 3,
      baseAmount,
      minutes: [start, start + 5, start + 11],
      purpose: "injected-review-pattern-threshold-edge",
    }, random);
    hasInjectedAnomaly = true;
    truthReason = "Three tightly grouped transactions form a labelled threshold-edge review pattern.";
  } else if (category === "wide_window_edge_anomaly") {
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count: 4,
      baseAmount,
      minutes: [start, start + 8, start + 16, start + 24],
      purpose: "injected-review-pattern-window-edge",
    }, random);
    hasInjectedAnomaly = true;
    truthReason = "Four repeated transactions span 24 minutes, just outside the configured window.";
  } else if (category === "amount_tolerance_edge_anomaly") {
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count: 5,
      baseAmount,
      minutes: [start, start + 3, start + 6, start + 9, start + 12],
      amountOffsets: [-220, -110, 0, 110, 220],
      purpose: "injected-review-pattern-amount-edge",
    }, random);
    hasInjectedAnomaly = true;
    truthReason = "Five amounts within about one percent were injected, but cross rounded-100 buckets.";
  } else if (category === "spaced_repetition_negative") {
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count: 5,
      baseAmount,
      minutes: [10, 35, 60, 85, 110],
      purpose: "ordinary-spaced-activity",
    }, random);
    truthReason = "Repeated amounts are separated by more than the review window.";
  } else if (category === "varied_burst_negative") {
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count: 5,
      baseAmount,
      minutes: [start, start + 3, start + 6, start + 9, start + 12],
      amountOffsets: [-1000, -500, 0, 500, 1000],
      purpose: "ordinary-varied-demand",
    }, random);
    truthReason = "A busy period contains materially different transaction amounts.";
  } else if (category === "legitimate_burst_hard_negative") {
    const count = randomInt(random, 4, 7);
    const step = Math.max(2, Math.floor(15 / (count - 1)));
    injected = makeRepeatedTransactions({
      fixtureIndex,
      provider,
      count,
      baseAmount,
      minutes: Array.from({ length: count }, (_, index) => start + index * step),
      purpose: "labelled-legitimate-merchant-disbursement",
    }, random);
    truthReason = "A labelled legitimate merchant disbursement deliberately resembles the heuristic pattern.";
  }

  return {
    id: `ANOM-${String(fixtureIndex + 1).padStart(4, "0")}`,
    category,
    provider,
    hasInjectedAnomaly,
    truthReason,
    transactions: shuffle([...transactions, ...injected], random),
  };
}

function generateAnomalyFixtures(seed = DEFAULT_SEED) {
  const random = createSeededRandom(normalizeSeed(seed) ^ 0xa1104a1f);
  const categories = [
    ...Array(108).fill("rule_aligned_anomaly"),
    ...Array(12).fill("low_count_edge_anomaly"),
    ...Array(12).fill("wide_window_edge_anomaly"),
    ...Array(12).fill("amount_tolerance_edge_anomaly"),
    ...Array(100).fill("normal_negative"),
    ...Array(52).fill("spaced_repetition_negative"),
    ...Array(52).fill("varied_burst_negative"),
    ...Array(52).fill("legitimate_burst_hard_negative"),
  ];
  return shuffle(categories, random).map((category, index) => buildAnomalyFixture(category, index, random));
}

function classificationMetrics(matrix) {
  const { truePositive, falsePositive, trueNegative, falseNegative } = matrix;
  const total = truePositive + falsePositive + trueNegative + falseNegative;
  return {
    precision: roundMetric(safeDivide(truePositive, truePositive + falsePositive)),
    recall: roundMetric(safeDivide(truePositive, truePositive + falseNegative)),
    falsePositiveRate: roundMetric(safeDivide(falsePositive, falsePositive + trueNegative)),
    specificity: roundMetric(safeDivide(trueNegative, trueNegative + falsePositive)),
    accuracy: roundMetric(safeDivide(truePositive + trueNegative, total)),
  };
}

function evaluateAnomalyDetection(fixtures) {
  const matrix = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const categoryBreakdown = {};
  let transactionCount = 0;
  let detectedSignalCount = 0;

  fixtures.forEach((fixture) => {
    const signals = analytics.detectRepeatedAmounts({ transactions: fixture.transactions });
    const predictedPositive = signals.length > 0;
    transactionCount += fixture.transactions.length;
    detectedSignalCount += signals.length;
    if (fixture.hasInjectedAnomaly && predictedPositive) matrix.truePositive += 1;
    else if (!fixture.hasInjectedAnomaly && predictedPositive) matrix.falsePositive += 1;
    else if (!fixture.hasInjectedAnomaly) matrix.trueNegative += 1;
    else matrix.falseNegative += 1;

    const breakdown = categoryBreakdown[fixture.category] || {
      fixtures: 0,
      truthPositive: 0,
      predictedPositive: 0,
    };
    breakdown.fixtures += 1;
    breakdown.truthPositive += fixture.hasInjectedAnomaly ? 1 : 0;
    breakdown.predictedPositive += predictedPositive ? 1 : 0;
    categoryBreakdown[fixture.category] = breakdown;
  });

  const injectedAnomalyFixtures = fixtures.filter((fixture) => fixture.hasInjectedAnomaly).length;
  const negativeFixtures = fixtures.length - injectedAnomalyFixtures;
  const hardNegativeFixtures = fixtures.filter((fixture) => fixture.category === "legitimate_burst_hard_negative").length;
  return {
    dataset: {
      fixtureCount: fixtures.length,
      evaluatedFixtureCount: fixtures.length,
      injectedAnomalyFixtures,
      negativeFixtures,
      hardNegativeFixtures,
      transactionCount,
      providers: PROVIDERS,
      configuredWindowMinutes: 20,
    },
    confusionMatrix: matrix,
    metrics: classificationMetrics(matrix),
    detectedSignalCount,
    categoryBreakdown,
  };
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function buildForecastFixture(category, fixtureIndex, random) {
  const actualReplenishment = Array.from({ length: HORIZON_HOURS }, () => randomInt(random, 7000, 26000));
  const hourlyNetOutflow = Array.from({ length: HORIZON_HOURS }, () => randomInt(random, 9000, 31000));
  const actualDemand = actualReplenishment.map((value, index) => value + hourlyNetOutflow[index]);
  const cumulativeNetOutflow = [];
  hourlyNetOutflow.reduce((sum, value, index) => {
    cumulativeNetOutflow[index] = sum + value;
    return cumulativeNetOutflow[index];
  }, 0);

  let startingBalance;
  if (category === "clear_shortage") {
    const shortageHour = randomInt(random, 2, 5);
    const before = shortageHour === 1 ? 0 : cumulativeNetOutflow[shortageHour - 2];
    startingBalance = before + Math.round(hourlyNetOutflow[shortageHour - 1] * randomBetween(random, 0.25, 0.82));
  } else if (category === "borderline_shortage") {
    startingBalance = cumulativeNetOutflow[4] + Math.round(hourlyNetOutflow[5] * randomBetween(random, 0.76, 0.98));
  } else if (category === "near_miss_no_shortage") {
    startingBalance = cumulativeNetOutflow.at(-1) + randomInt(random, 1000, 13000);
  } else {
    startingBalance = cumulativeNetOutflow.at(-1) + randomInt(random, 35000, 90000);
  }

  const demandBias = approximatelyNormal(random) * 0.1;
  const replenishmentBias = approximatelyNormal(random) * 0.1;
  const forecastDemand = actualDemand.map((value, hour) => {
    const trendNoise = approximatelyNormal(random) * 0.11 + (hour - 2.5) * approximatelyNormal(random) * 0.008;
    return Math.max(0, Math.round(value * clamp(1 + demandBias + trendNoise, 0.55, 1.45)));
  });
  const forecastReplenishment = actualReplenishment.map((value) => {
    const noise = approximatelyNormal(random) * 0.14;
    return Math.max(0, Math.round(value * clamp(1 + replenishmentBias + noise, 0.55, 1.45)));
  });

  return {
    id: `FCST-${String(fixtureIndex + 1).padStart(4, "0")}`,
    category,
    provider: PROVIDERS[fixtureIndex % PROVIDERS.length],
    startingBalance,
    actualDemand,
    actualReplenishment,
    forecastDemand,
    forecastReplenishment,
  };
}

function generateForecastFixtures(seed = DEFAULT_SEED) {
  const random = createSeededRandom(normalizeSeed(seed) ^ 0xf04eca57);
  const categories = [
    ...Array(70).fill("clear_shortage"),
    ...Array(35).fill("borderline_shortage"),
    ...Array(45).fill("comfortable_no_shortage"),
    ...Array(30).fill("near_miss_no_shortage"),
  ];
  return shuffle(categories, random).map((category, index) => buildForecastFixture(category, index, random));
}

function evaluateForecasts(fixtures) {
  const matrix = { truePositive: 0, falsePositive: 0, trueNegative: 0, falseNegative: 0 };
  const absoluteEndingErrors = [];
  const actualShortageHours = [];
  const detectedActualShortageHours = [];
  const predictedShortageHours = [];
  const shortageHourAbsoluteErrors = [];
  const shortageHourSignedErrors = [];
  const categoryAccumulator = {};
  let startingBalanceTotal = 0;

  fixtures.forEach((fixture) => {
    const provider = {
      balance: fixture.startingBalance,
      updatedMinutesAgo: 0,
      feedStatus: "healthy",
    };
    const actual = analytics.projectLiquidity(provider, fixture.actualDemand, fixture.actualReplenishment);
    const forecast = analytics.projectLiquidity(provider, fixture.forecastDemand, fixture.forecastReplenishment);
    const actualEndingBalance = actual.rawProjection.at(-1);
    const forecastEndingBalance = forecast.rawProjection.at(-1);
    const endingError = Math.abs(forecastEndingBalance - actualEndingBalance);
    const actualPositive = actual.shortageHour !== null;
    const predictedPositive = forecast.shortageHour !== null;

    absoluteEndingErrors.push(endingError);
    startingBalanceTotal += fixture.startingBalance;
    if (actualPositive) actualShortageHours.push(actual.shortageHour);

    if (actualPositive && predictedPositive) {
      matrix.truePositive += 1;
      detectedActualShortageHours.push(actual.shortageHour);
      predictedShortageHours.push(forecast.shortageHour);
      shortageHourAbsoluteErrors.push(Math.abs(forecast.shortageHour - actual.shortageHour));
      shortageHourSignedErrors.push(forecast.shortageHour - actual.shortageHour);
    } else if (!actualPositive && predictedPositive) matrix.falsePositive += 1;
    else if (!actualPositive) matrix.trueNegative += 1;
    else matrix.falseNegative += 1;

    const category = categoryAccumulator[fixture.category] || {
      fixtures: 0,
      actualShortages: 0,
      predictedShortages: 0,
      totalAbsoluteEndingError: 0,
    };
    category.fixtures += 1;
    category.actualShortages += actualPositive ? 1 : 0;
    category.predictedShortages += predictedPositive ? 1 : 0;
    category.totalAbsoluteEndingError += endingError;
    categoryAccumulator[fixture.category] = category;
  });

  const categoryBreakdown = Object.fromEntries(Object.entries(categoryAccumulator).map(([category, values]) => [category, {
    fixtures: values.fixtures,
    actualShortages: values.actualShortages,
    predictedShortages: values.predictedShortages,
    endingBalanceMae: roundMetric(values.totalAbsoluteEndingError / values.fixtures, 2),
  }]));
  const totalAbsoluteError = absoluteEndingErrors.reduce((sum, value) => sum + value, 0);
  const withinOneHour = shortageHourAbsoluteErrors.filter((value) => value <= 1).length;

  return {
    dataset: {
      fixtureCount: fixtures.length,
      evaluatedFixtureCount: fixtures.length,
      horizonHours: HORIZON_HOURS,
      hourlyObservations: fixtures.length * HORIZON_HOURS,
      actualShortageFixtures: matrix.truePositive + matrix.falseNegative,
      actualNoShortageFixtures: matrix.trueNegative + matrix.falsePositive,
    },
    endingBalanceError: {
      mae: roundMetric(mean(absoluteEndingErrors), 2),
      normalizedMae: roundMetric(safeDivide(totalAbsoluteError, startingBalanceTotal)),
      normalizedMaePercent: roundMetric(safeDivide(totalAbsoluteError, startingBalanceTotal) * 100, 2),
      normalizationBasis: "sum absolute ending-balance error divided by sum starting balance",
      balanceBasis: "raw ending balance, including deficits below zero",
    },
    shortageDetection: {
      confusionMatrix: matrix,
      metrics: classificationMetrics(matrix),
    },
    leadTime: {
      actualShortageCount: actualShortageHours.length,
      detectedShortageCount: detectedActualShortageHours.length,
      meanActualShortageHour: roundMetric(mean(actualShortageHours), 2),
      meanDetectedWarningLeadHours: roundMetric(mean(detectedActualShortageHours), 2),
      medianDetectedWarningLeadHours: roundMetric(median(detectedActualShortageHours), 2),
      minimumDetectedWarningLeadHours: detectedActualShortageHours.length ? Math.min(...detectedActualShortageHours) : 0,
      maximumDetectedWarningLeadHours: detectedActualShortageHours.length ? Math.max(...detectedActualShortageHours) : 0,
      meanPredictedShortageHour: roundMetric(mean(predictedShortageHours), 2),
      shortageHourMae: roundMetric(mean(shortageHourAbsoluteErrors), 3),
      meanSignedShortageHourError: roundMetric(mean(shortageHourSignedErrors), 3),
      withinOneHourRate: roundMetric(safeDivide(withinOneHour, shortageHourAbsoluteErrors.length)),
      comparisonBasis: "shortage-hour errors use true positives only; missed shortages remain false negatives in recall",
    },
    categoryBreakdown,
  };
}

function runEvaluation(options = {}) {
  const seed = normalizeSeed(options.seed ?? DEFAULT_SEED);
  const anomalyFixtures = generateAnomalyFixtures(seed);
  const forecastFixtures = generateForecastFixtures(seed);
  return {
    schemaVersion: "1.0.0",
    datasetVersion: DATASET_VERSION,
    generatedMarker: `${DATASET_VERSION}:seed-${seed}:deterministic-no-wall-clock`,
    seed,
    anomalyEvaluation: evaluateAnomalyDetection(anomalyFixtures),
    forecastEvaluation: evaluateForecasts(forecastFixtures),
    metricDefinitions: {
      precision: "TP / (TP + FP)",
      recall: "TP / (TP + FN)",
      falsePositiveRate: "FP / (FP + TN)",
      endingBalanceMae: "mean absolute difference between forecast and realized raw ending balance",
      normalizedMae: "sum absolute ending-balance error / sum starting balance",
      warningLeadTime: "hours from forecast issuance at hour zero until the realized shortage hour for detected shortages",
      shortageHourMae: "mean absolute predicted-versus-realized shortage-hour error among true positives",
    },
    assumptions: [
      "All records, account labels, balances, and outcomes are synthetic; no customer data is used.",
      "Anomaly labels represent review-worthy repeated-amount scenarios, not fraud or customer wrongdoing.",
      "Positive edge fixtures deliberately include three-event, 24-minute, and relative-amount patterns to expose the heuristic threshold boundary.",
      "Legitimate merchant-disbursement bursts are labelled hard negatives even when they resemble the detector rule.",
      "Provider e-money uses starting balance + cash-out replenishment - cash-in demand for each forecast hour.",
      "Forecast inputs are noisy perturbations of separate realized cash-in demand and cash-out replenishment series.",
      "A balance at or below zero is treated as a shortage, matching analyticsService.projectLiquidity.",
    ],
    limitations: [
      "Synthetic performance does not establish production accuracy or generalization.",
      "The repeated-amount rule has no merchant-purpose context, so legitimate bursts can be false positives.",
      "The six-hour forecast benchmark measures arithmetic under simulated forecast error, not a trained demand model.",
      "Metrics support human review and must not be used for automatic blocking, fraud declarations, or fund movement.",
    ],
  };
}

function percent(value) {
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatEvaluationSummary(report) {
  const anomaly = report.anomalyEvaluation;
  const forecast = report.forecastEvaluation;
  const anomalyMatrix = anomaly.confusionMatrix;
  const shortageMatrix = forecast.shortageDetection.confusionMatrix;
  return [
    "Nirapod Ops deterministic synthetic evaluation",
    `Marker: ${report.generatedMarker}`,
    `Anomaly data: ${anomaly.dataset.fixtureCount} fixtures (${anomaly.dataset.injectedAnomalyFixtures} injected positives, ${anomaly.dataset.negativeFixtures} negatives; ${anomaly.dataset.transactionCount} transactions)`,
    `Anomaly matrix: TP ${anomalyMatrix.truePositive} | FP ${anomalyMatrix.falsePositive} | TN ${anomalyMatrix.trueNegative} | FN ${anomalyMatrix.falseNegative}`,
    `Anomaly metrics: precision ${percent(anomaly.metrics.precision)} | recall ${percent(anomaly.metrics.recall)} | FPR ${percent(anomaly.metrics.falsePositiveRate)}`,
    `Forecast data: ${forecast.dataset.fixtureCount} fixtures / ${forecast.dataset.hourlyObservations} hourly observations`,
    `Ending balance: MAE BDT ${forecast.endingBalanceError.mae.toLocaleString("en-US")} | normalized MAE ${forecast.endingBalanceError.normalizedMaePercent.toFixed(2)}%`,
    `Shortage matrix: TP ${shortageMatrix.truePositive} | FP ${shortageMatrix.falsePositive} | TN ${shortageMatrix.trueNegative} | FN ${shortageMatrix.falseNegative}`,
    `Shortage metrics: precision ${percent(forecast.shortageDetection.metrics.precision)} | recall ${percent(forecast.shortageDetection.metrics.recall)} | FPR ${percent(forecast.shortageDetection.metrics.falsePositiveRate)}`,
    `Lead time: mean ${forecast.leadTime.meanDetectedWarningLeadHours.toFixed(2)}h | shortage-hour MAE ${forecast.leadTime.shortageHourMae.toFixed(3)}h | within one hour ${percent(forecast.leadTime.withinOneHourRate)}`,
    "Synthetic benchmark only; these values are not production or fraud-detection claims.",
  ].join("\n");
}

module.exports = {
  DATASET_VERSION,
  DEFAULT_SEED,
  HORIZON_HOURS,
  createSeededRandom,
  generateAnomalyFixtures,
  generateForecastFixtures,
  evaluateAnomalyDetection,
  evaluateForecasts,
  runEvaluation,
  formatEvaluationSummary,
};
