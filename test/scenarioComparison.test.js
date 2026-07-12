process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const seed = require("../data/demoData");
const { compareScenarios } = require("../services/scenarioComparisonService");

const clone = (value) => JSON.parse(JSON.stringify(value));

test("compares a 1.5x demand scenario with the fixed 1x baseline", () => {
  const comparison = compareScenarios({ demandMultiplier: 1.5 });
  const shared = comparison.rows.find((row) => row.id === "shared");
  const bkash = comparison.rows.find((row) => row.id === "bkash");
  const nagad = comparison.rows.find((row) => row.id === "nagad");

  assert.equal(comparison.inputSummary.demandMultiplier, 1.5);
  assert.equal(comparison.inputSummary.demandChangePercent, 50);
  assert.equal(shared.baseline.shortageHour, 6);
  assert.equal(shared.scenario.shortageHour, 5);
  assert.equal(shared.changes.runwayHours, -1);
  assert.equal(bkash.scenario.shortageHour, null);
  assert.equal(bkash.scenario.runwayLabel, "Beyond 6h");
  assert.equal(nagad.baseline.shortageHour, 4);
  assert.equal(nagad.scenario.shortageHour, 3);
  assert.equal(nagad.changes.direction, "worsened");
  assert.deepEqual(comparison.chartData.labels, comparison.rows.map((row) => row.name));
  assert.equal(comparison.chartData.datasets[1].data.length, comparison.rows.length);
});

test("missing feed caps confidence and makes the scenario human-reviewable", () => {
  const rocket = compareScenarios({ demandMultiplier: 1.5, missingProvider: "rocket" })
    .rows.find((row) => row.id === "rocket");

  assert.equal(rocket.baseline.feedState, "conflicting");
  assert.equal(rocket.baseline.heuristicConfidence, 0.5);
  assert.equal(rocket.scenario.feedState, "missing");
  assert.equal(rocket.scenario.heuristicConfidence, 0.42);
  assert.equal(rocket.scenario.requiresReview, true);
  assert.equal(rocket.scenario.severity, "watch");
  assert.match(rocket.scenario.fallbackBehavior, /unavailable|last known/i);
});

test("comparison output is deterministic", () => {
  const state = clone(seed);
  const input = { demandMultiplier: 1.5, missingProvider: "bkash" };
  assert.deepEqual(compareScenarios(input, state), compareScenarios(input, state));
});

test("comparison does not mutate the caller's input or state", () => {
  const state = clone(seed);
  const input = { demandMultiplier: "1.5", missingProvider: "nagad", marker: { keep: true } };
  const stateBefore = clone(state);
  const inputBefore = clone(input);

  compareScenarios(input, state);

  assert.deepEqual(state, stateBefore);
  assert.deepEqual(input, inputBefore);
});
