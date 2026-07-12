process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DEFAULT_SEED,
  generateAnomalyFixtures,
  generateForecastFixtures,
  runEvaluation,
} = require("../services/evaluationService");

const closeTo = (actual, expected, tolerance = 0.000001) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} should be within ${tolerance} of ${expected}`);
};

test("seeded fixture generation and complete reports are deterministic", () => {
  assert.deepEqual(generateAnomalyFixtures(DEFAULT_SEED), generateAnomalyFixtures(DEFAULT_SEED));
  assert.deepEqual(generateForecastFixtures(DEFAULT_SEED), generateForecastFixtures(DEFAULT_SEED));
  assert.deepEqual(runEvaluation({ seed: DEFAULT_SEED }), runEvaluation({ seed: DEFAULT_SEED }));
  assert.notDeepEqual(generateAnomalyFixtures(DEFAULT_SEED), generateAnomalyFixtures(DEFAULT_SEED + 1));
});

test("anomaly benchmark uses hundreds of labelled fixtures and thousands of transactions", () => {
  const evaluation = runEvaluation().anomalyEvaluation;
  const { dataset, confusionMatrix: matrix, metrics } = evaluation;
  assert.ok(dataset.injectedAnomalyFixtures >= 120);
  assert.ok(dataset.negativeFixtures >= 200);
  assert.ok(dataset.hardNegativeFixtures >= 40);
  assert.ok(dataset.transactionCount >= 5000);
  assert.equal(dataset.fixtureCount, dataset.evaluatedFixtureCount);
  assert.equal(matrix.truePositive + matrix.falseNegative, dataset.injectedAnomalyFixtures);
  assert.equal(matrix.trueNegative + matrix.falsePositive, dataset.negativeFixtures);
  assert.equal(matrix.truePositive + matrix.falsePositive + matrix.trueNegative + matrix.falseNegative, dataset.fixtureCount);
  closeTo(metrics.precision, matrix.truePositive / (matrix.truePositive + matrix.falsePositive));
  closeTo(metrics.recall, matrix.truePositive / (matrix.truePositive + matrix.falseNegative));
  closeTo(metrics.falsePositiveRate, matrix.falsePositive / (matrix.falsePositive + matrix.trueNegative));

  // The benchmark intentionally contains detector boundary cases and legitimate
  // look-alike bursts; it should be useful, not a cherry-picked perfect score.
  assert.ok(metrics.precision > 0.5 && metrics.precision < 0.95);
  assert.ok(metrics.recall > 0.5 && metrics.recall < 0.95);
  assert.ok(metrics.falsePositiveRate > 0.05 && metrics.falsePositiveRate < 0.4);
  assert.ok(evaluation.categoryBreakdown.rule_aligned_anomaly.predictedPositive > 0);
  assert.ok(evaluation.categoryBreakdown.legitimate_burst_hard_negative.predictedPositive > 0);
});

test("forecast benchmark calculates balance error and non-perfect shortage classification", () => {
  const evaluation = runEvaluation().forecastEvaluation;
  const { dataset, endingBalanceError, shortageDetection, leadTime } = evaluation;
  const { confusionMatrix: matrix, metrics } = shortageDetection;
  assert.ok(dataset.fixtureCount >= 150);
  assert.equal(dataset.hourlyObservations, dataset.fixtureCount * dataset.horizonHours);
  assert.equal(dataset.actualShortageFixtures + dataset.actualNoShortageFixtures, dataset.fixtureCount);
  assert.equal(matrix.truePositive + matrix.falseNegative, dataset.actualShortageFixtures);
  assert.equal(matrix.trueNegative + matrix.falsePositive, dataset.actualNoShortageFixtures);
  closeTo(metrics.precision, matrix.truePositive / (matrix.truePositive + matrix.falsePositive));
  closeTo(metrics.recall, matrix.truePositive / (matrix.truePositive + matrix.falseNegative));
  closeTo(metrics.falsePositiveRate, matrix.falsePositive / (matrix.falsePositive + matrix.trueNegative));

  assert.ok(endingBalanceError.mae > 0);
  assert.ok(endingBalanceError.normalizedMae > 0 && endingBalanceError.normalizedMae < 0.3);
  assert.ok(metrics.precision > 0.6 && metrics.precision < 1);
  assert.ok(metrics.recall > 0.6 && metrics.recall < 1);
  assert.ok(metrics.falsePositiveRate > 0 && metrics.falsePositiveRate < 0.5);
  assert.ok(leadTime.detectedShortageCount > 0);
  assert.ok(leadTime.shortageHourMae > 0 && leadTime.shortageHourMae < 2);
  assert.ok(leadTime.withinOneHourRate > 0.7 && leadTime.withinOneHourRate <= 1);
});

test("the report records reproducibility, formulas, assumptions, and limitations", () => {
  const report = runEvaluation({ seed: 42 });
  assert.equal(report.seed, 42);
  assert.match(report.generatedMarker, /seed-42.*no-wall-clock/);
  assert.equal(report.metricDefinitions.precision, "TP / (TP + FP)");
  assert.match(report.forecastEvaluation.endingBalanceError.normalizationBasis, /starting balance/i);
  assert.ok(report.assumptions.length >= 5);
  assert.ok(report.limitations.some((item) => /production accuracy/i.test(item)));
});
