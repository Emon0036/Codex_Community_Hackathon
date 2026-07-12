process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const analytics = require("../services/analyticsService");
const seed = require("../data/demoData");

const clone = (value) => JSON.parse(JSON.stringify(value));

test("analytics remains responsive at the documented 500-row demo volume", (t) => {
  const snapshot = clone(seed);
  snapshot.transactions = Array.from({ length: 500 }, (_, index) => ({
    id: `PERF-${index}`, provider: ["bkash", "nagad", "rocket"][index % 3], type: index % 4 === 0 ? "cash-in" : "cash-out",
    amount: 1000 + (index % 37) * 113, account: `U-PERF-${index % 80}`, minute: index * 2,
  }));
  const timings = [];
  for (let index = 0; index < 120; index += 1) {
    const start = performance.now(); analytics.getDashboard(snapshot); timings.push(performance.now() - start);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(timings.length * 0.5)]; const p95 = timings[Math.floor(timings.length * 0.95)];
  t.diagnostic(`500-row analytics latency: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
  assert.ok(p95 < 100, `expected p95 below 100ms, received ${p95.toFixed(2)}ms`);
});
