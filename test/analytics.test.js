process.env.NODE_ENV = "test";

const test = require("node:test");
const assert = require("node:assert/strict");
const analytics = require("../services/analyticsService");
const seed = require("../data/demoData");

const clone = (value) => JSON.parse(JSON.stringify(value));

test("dashboard preserves separate ledgers and calculates both runway types", () => {
  const dashboard = analytics.getDashboard();
  assert.deepEqual(dashboard.providers.map((provider) => provider.id), ["bkash", "nagad", "rocket"]);
  assert.equal(dashboard.summary.totalEmoney, dashboard.providers.reduce((sum, provider) => sum + provider.balance, 0));
  assert.equal(dashboard.cashForecast.shortageHour, 6);
  assert.equal(dashboard.providers.find((provider) => provider.id === "nagad").forecast.shortageHour, 4);
});

test("cash-in and cash-out have correct opposite accounting effects", () => {
  const provider = { balance: 1000, updatedMinutesAgo: 0, feedStatus: "healthy" };
  assert.equal(analytics.projectLiquidity(provider, [300], [100]).rawProjection[0], 800, "cash-in consumes e-money and cash-out replenishes it");
  assert.equal(analytics.projectLiquidity(provider, [1000], [0]).shortageHour, 1, "exact exhaustion is a shortage");
  const snapshot = clone(seed); snapshot.outlet.sharedCash = 1000; snapshot.cashOutDemand = { bkash: [300], nagad: [0], rocket: [0] }; snapshot.cashInDemand = { bkash: [100], nagad: [0], rocket: [0] };
  assert.equal(analytics.projectSharedCash(snapshot).rawProjection[0], 800, "cash-out consumes physical cash and cash-in replenishes it");
});

test("detects the injected pattern only inside the configured time window", () => {
  const patterns = analytics.detectRepeatedAmounts();
  assert.equal(patterns.length, 1); assert.equal(patterns[0].provider, "nagad"); assert.equal(patterns[0].count, 5);
  const transaction = (minute, index, amount = 5000) => ({ id: `N-${index}`, provider: "bkash", type: "cash-out", amount, account: `U-${index}`, minute });
  const fixtures = [
    [0, 25, 50, 75].map(transaction),
    [1, 4, 7].map(transaction),
    [1, 4, 7, 10].map((minute, index) => transaction(minute, index, 5000 + index * 500)),
  ];
  fixtures.forEach((transactions) => { const negative = clone(seed); negative.transactions = transactions; assert.equal(analytics.detectRepeatedAmounts(negative).length, 0); });
});

test("repeated-pattern detection includes non cash-out transaction types", () => {
  const snapshot = clone(seed);
  snapshot.transactions = [1, 4, 7, 10].map((minute, index) => ({
    id: `SM-${index}`, provider: "bkash", type: "send-money", amount: 2500, account: `U-SM-${index}`, minute,
  }));
  const patterns = analytics.detectRepeatedAmounts(snapshot);
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].transactionType, "send-money");
  assert.equal(patterns[0].count, 4);
});

test("stress activity worsens the known Nagad and shared-cash pressure paths", () => {
  const baseline = analytics.simulate({ demandMultiplier: 1 }); const stressed = analytics.simulate({ demandMultiplier: 2 });
  for (const id of ["shared", "nagad"]) {
    const base = baseline.find((entry) => entry.id === id); const stress = stressed.find((entry) => entry.id === id);
    const baseEnd = base.rawProjection?.at(-1) ?? base.projection.at(-1); const stressEnd = stress.rawProjection?.at(-1) ?? stress.projection.at(-1);
    assert.ok(stressEnd <= baseEnd);
  }
});

test("missing feed lowers confidence and returns a safe fallback", () => {
  const result = analytics.simulate({ missingProvider: "rocket" }).find((provider) => provider.id === "rocket");
  assert.equal(result.confidence, 0.42); assert.match(result.fallback, /unavailable/i);
});

test("every alert carries evidence, uncertainty, and careful language", () => {
  const alerts = analytics.getAlerts();
  assert.ok(alerts.length >= 4);
  alerts.forEach((alert) => { assert.ok(alert.evidence.length); assert.ok(alert.confidence > 0 && alert.confidence <= 1); assert.doesNotMatch(`${alert.title} ${alert.explanation}`, /is fraud|fraudulent customer/i); });
});
