process.env.NODE_ENV = "test";
process.env.PSEUDONYMIZATION_SECRET = "baseline-test-pseudonymization-secret";

const crypto = require("node:crypto");
const { after, test } = require("node:test");
const assert = require("node:assert/strict");
const analytics = require("../services/analyticsService");
const ingestionService = require("../services/ingestionService");
const storeService = require("../services/storeService");
const demoData = require("../data/demoData");

const clone = (value) => JSON.parse(JSON.stringify(value));
const initialBaselineState = clone({
  baselineTransactions: storeService.getState().baselineTransactions || [],
  datasetImports: storeService.getState().datasetImports || [],
  baselines: storeService.getState().baselines || [],
  auditLog: storeService.getState().auditLog || [],
});

after(async () => {
  await storeService.mutate((state) => {
    state.baselineTransactions = initialBaselineState.baselineTransactions;
    state.datasetImports = initialBaselineState.datasetImports;
    state.baselines = initialBaselineState.baselines;
    state.auditLog = initialBaselineState.auditLog;
  });
});

test("baseline statistics use amount distributions, same-import gaps, and equivalent rolling 10-minute windows", () => {
  const rows = [
    { provider: "nagad", type: "cash-out", amount: 100, account: "A-1", minute: 0, importId: "IMPORT-A", dataRole: "baseline" },
    { provider: "nagad", type: "cash-out", amount: 200, account: "A-1", minute: 5, importId: "IMPORT-A", dataRole: "baseline" },
    { provider: "nagad", type: "cash-out", amount: 300, account: "A-1", minute: 12, importId: "IMPORT-A", dataRole: "baseline" },
    { provider: "nagad", type: "cash-out", amount: 400, account: "A-1", minute: 100, importId: "IMPORT-B", dataRole: "baseline" },
    { provider: "nagad", type: "cash-out", amount: 500, account: "A-1", minute: 110, importId: "IMPORT-B", dataRole: "baseline" },
    { provider: "nagad", type: "cash-out", amount: 999999, account: "A-1", minute: 111, importId: "CURRENT", dataRole: "current" },
  ];

  const calculation = analytics.calculateBaselines(rows);
  const baseline = calculation.baselines.find((entry) => entry.scopeKey === "provider_account_type|nagad|A-1|cash-out");

  assert.ok(baseline);
  assert.equal(calculation.transactionCount, 5, "current rows must not enter historical statistics");
  assert.equal(baseline.sampleSize, 5);
  assert.equal(baseline.avgAmount, 300);
  assert.equal(baseline.medianAmount, 300);
  assert.equal(baseline.amountStdDev, 141.42);
  assert.equal(baseline.p95Amount, 500);
  assert.equal(baseline.avgTimeGapMinutes, 7.33);
  assert.equal(baseline.medianTimeGapMinutes, 7, "the 88-minute gap between imports must not be counted");
  assert.equal(baseline.observationWindowMinutes, 10);
  assert.equal(baseline.windowCount, 5);
  assert.equal(baseline.avgTransactionsPerWindow, 1.4);
  assert.equal(baseline.p95TransactionsPerWindow, 2);
  assert.equal(baseline.baselineConfidence, "LOW");
  assert.deepEqual(baseline.importIds, ["IMPORT-A", "IMPORT-B"]);
});

test("baseline confidence thresholds and fallback hierarchy prefer the first sufficient scope", () => {
  const rows = Array.from({ length: 50 }, (_, index) => ({
    provider: "nagad",
    type: "cash-out",
    amount: 1000 + index,
    account: index < 5 ? "SPARSE-ACCOUNT" : "PEER-ACCOUNT",
    minute: index * 20,
    importId: "CONFIDENCE-IMPORT",
    dataRole: "baseline",
  }));
  const calculation = analytics.calculateBaselines(rows);
  const providerBaseline = calculation.baselines.find((entry) => entry.scopeType === "provider" && entry.provider === "nagad");
  const sparseBaseline = calculation.baselines.find((entry) => entry.scopeType === "provider_account_type" && entry.account === "SPARSE-ACCOUNT");

  assert.equal(analytics.MIN_BASELINE_SAMPLE_SIZE, 20);
  assert.equal(analytics.HIGH_BASELINE_SAMPLE_SIZE, 50);
  assert.equal(providerBaseline.baselineConfidence, "HIGH");
  assert.equal(sparseBaseline.baselineConfidence, "LOW");

  const resolved = analytics.resolveBaseline(calculation, {
    provider: "nagad",
    account: "SPARSE-ACCOUNT",
    transactionType: "cash-out",
  });
  assert.equal(resolved.sufficient, true);
  assert.equal(resolved.usedFallback, true);
  assert.equal(resolved.baselineScopeUsed, "provider_type");
  assert.equal(resolved.baseline.sampleSize, 50);
  assert.equal(resolved.baselineConfidence, "HIGH");

  const mediumCalculation = analytics.calculateBaselines(rows.slice(0, 20).map((row) => ({ ...row, account: "MEDIUM-ACCOUNT" })));
  const mediumProvider = mediumCalculation.baselines.find((entry) => entry.scopeType === "provider");
  assert.equal(mediumProvider.baselineConfidence, "MEDIUM");

  const missing = analytics.resolveBaseline([], { provider: "rocket", account: "UNKNOWN", transactionType: "cash-in" });
  assert.equal(missing.baseline, null);
  assert.equal(missing.sufficient, false);
  assert.equal(missing.baselineConfidence, "LOW");
  assert.match(missing.explanation, /No historical baseline/i);
});

test("rolling historical windows do not create fixed-bin boundary false positives", () => {
  const historicalRows = Array.from({ length: 50 }, (_, index) => ({
    provider: "rocket", type: "cash-out", amount: 1000, account: "U-BOUNDARY",
    minute: Math.floor(index / 2) * 20 + (index % 2 === 0 ? 9 : 10), importId: "HISTORICAL-BOUNDARY", dataRole: "baseline",
  }));
  const state = clone(demoData);
  state.baselines = analytics.calculateBaselines(historicalRows).baselines;
  state.cases = [];
  state.transactions = [100, 101].map((minute, index) => ({
    id: `BOUNDARY-${index}`, provider: "rocket", type: "cash-out", amount: 1000, account: "U-BOUNDARY",
    minute, importId: "CURRENT-BOUNDARY", dataRole: "current",
  }));
  assert.equal(analytics.getAlerts(state).some((alert) => alert.type === "behavior" && alert.provider === "rocket"), false);
});

test("labelled anomalies are excluded from normal baselines and produce honest validation metrics", () => {
  const normalRows = Array.from({ length: 50 }, (_, index) => ({
    provider: "nagad", type: "cash-out", amount: 1000, account: "U-LABELLED", minute: index * 20,
    importId: "LABELLED-DATASET", dataRole: "baseline", groundTruthLabel: false,
  }));
  const anomalyRows = [1000, 1002, 1004, 1006, 1008].map((minute) => ({
    provider: "nagad", type: "cash-out", amount: 5000, account: "U-LABELLED", minute,
    importId: "LABELLED-DATASET", dataRole: "baseline", groundTruthLabel: true,
  }));
  const rows = [...normalRows, ...anomalyRows];
  const calculation = analytics.calculateBaselines(rows);
  assert.equal(calculation.transactionCount, normalRows.length);
  assert.equal(calculation.baselines.find((entry) => entry.scopeType === "provider").p95Amount, 1000);
  const metrics = analytics.evaluateLabelledTransactions({ ...clone(demoData), baselines: calculation.baselines }, rows, calculation.baselines);
  assert.equal(metrics.groundTruthAvailable, true);
  assert.equal(metrics.evaluatedRows, rows.length);
  assert.ok(metrics.truePositive > 0);
  assert.ok(metrics.trueNegative > 0);
  assert.ok(metrics.precision !== null && metrics.recall !== null && metrics.falsePositiveRate !== null);
});

test("memory baseline CSV import reports mixed validation results and deduplicates by fingerprint", async () => {
  await storeService.mutate((state) => {
    state.baselineTransactions = [];
    state.datasetImports = [];
    state.baselines = [];
  });

  const csv = Buffer.from([
    "provider,type,amount,account,minute",
    "nagad,cash-out,1000,SYN-A100,0",
    "nagad,cash-in,2000,SYN-B200,00:10",
    "unknown,cash-out,3000,SYN-C300,20",
    "bkash,refund,4000,SYN-D400,30",
    "rocket,cash-out,-1,SYN-E500,40",
    "nagad,cash-out,5000,,50",
  ].join("\n"));
  const user = { id: "test-manager", name: "Test Manager", role: "management", provider: null };

  const imported = await ingestionService.importBaselineCsv(csv, "mixed-baseline.csv", "Mixed baseline", user);
  assert.equal(imported.duplicate, false);
  assert.equal(imported.totalRows, 6);
  assert.equal(imported.validRows, 3);
  assert.equal(imported.invalidRows, 3);
  assert.deepEqual(imported.providers, ["bkash", "nagad"]);
  assert.equal(imported.accountsDetected, 3);
  assert.equal(imported.baselineStatus, "complete");
  assert.equal(imported.errorSummary.reduce((sum, issue) => sum + issue.count, 0), 3);

  const storedRows = await storeService.getBaselineTransactions();
  assert.equal(storedRows.length, 3);
  assert.ok(storedRows.every((row) => row.dataRole === "baseline" && row.importId === imported.importId));
  assert.ok(storedRows.every((row) => /^U-[A-F0-9]{10}$/.test(row.account)));
  assert.ok(storedRows.every((row) => !row.account.includes("SYN-")));
  assert.ok(storedRows.some((row) => row.type === "refund"));
  assert.deepEqual(storedRows.map((row) => row.minute), [0, 10, 30]);
  assert.ok(storeService.getState().baselines.length > 0);

  const rowCount = storedRows.length;
  const baselineCount = storeService.getState().baselines.length;
  const duplicate = await ingestionService.importBaselineCsv(csv, "renamed.csv", "Renamed duplicate", user);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.importId, imported.importId);
  assert.equal(storeService.getState().datasetImports.length, 1);
  assert.equal((await storeService.getBaselineTransactions()).length, rowCount);
  assert.equal(storeService.getState().baselines.length, baselineCount);
});

test("hackathon schema baseline CSV import maps exact headers and day-aware timestamps", async () => {
  await storeService.mutate((state) => {
    state.baselineTransactions = [];
    state.datasetImports = [];
    state.baselines = [];
  });

  const csv = Buffer.from([
    "transaction_id,timestamp,day,agent_id,provider,area,transaction_type,amount,status,opening_provider_balance,closing_provider_balance,opening_physical_cash,closing_physical_cash,event_flag,case_status,heuristic_score,confidence,review_required",
    "TX-HIST-1,2026-07-11 09:15:30,1,SYN-A100,nagad,Sylhet,cash_out,\"1,250\",completed,100000,98750,45000,46250,normal,open,12,0.8,false",
    "TX-HIST-2,2026-07-11 09:15:30,2,SYN-A100,nagad,Sylhet,send_money,500,completed,98750,99250,46250,45750,cash_pressure,open,82,0.9,true",
    "TX-HIST-3,2026-07-11 09:15:30,3,SYN-A100,nagad,Sylhet,cash_out,900,completed,99250,98350,45750,46650,normal_negative,open,6,0.2,false",
    "TX-HIST-4,2026-07-11 09:15:30,4,SYN-A100,nagad,Sylhet,cash_out,950,completed,98350,97400,46650,47600,legitimate_burst_hard_negative,open,24,0.4,false",
    "TX-HIST-5,2026-07-11 09:15:30,5,SYN-A100,nagad,Sylhet,cash_out,5000,completed,97400,92400,47600,52600,rule_aligned_anomaly,open,94,0.95,true",
  ].join("\n"));
  const user = { id: "test-manager", name: "Test Manager", role: "management", provider: null };

  const imported = await ingestionService.importBaselineCsv(csv, "hackathon-baseline.csv", "Hackathon baseline", user);
  assert.equal(imported.validRows, 5);
  assert.equal(imported.invalidRows, 0);
  assert.equal(imported.validation.groundTruthAvailable, true);

  const storedRows = await storeService.getBaselineTransactions();
  assert.deepEqual(storedRows.map((row) => row.type), ["cash-out", "send-money", "cash-out", "cash-out", "cash-out"]);
  assert.deepEqual(storedRows.map((row) => row.amount), [1250, 500, 900, 950, 5000]);
  assert.deepEqual(storedRows.map((row) => row.minute), [555.5, 1995.5, 3435.5, 4875.5, 6315.5]);
  assert.deepEqual(storedRows.map((row) => row.groundTruthLabel), [false, true, false, false, true]);
});

test("reimport repairs stale event_flag validation failures for the same file", async () => {
  await storeService.mutate((state) => {
    state.baselineTransactions = [];
    state.datasetImports = [];
    state.baselines = [];
  });

  const csv = Buffer.from([
    "transaction_id,timestamp,day,agent_id,provider,area,transaction_type,amount,status,opening_provider_balance,closing_provider_balance,opening_physical_cash,closing_physical_cash,event_flag,case_status,heuristic_score,confidence,review_required",
    "TX-REPAIR-1,2026-07-11 09:15:30,1,SYN-A100,nagad,Sylhet,cash_out,1000,completed,100000,99000,45000,46000,normal,open,8,0.2,false",
    "TX-REPAIR-2,2026-07-11 09:18:30,1,SYN-A100,nagad,Sylhet,cash_out,5000,completed,99000,94000,46000,51000,cash_pressure,open,90,0.9,true",
  ].join("\n"));
  const fingerprint = crypto.createHash("sha256").update(csv).digest("hex");
  const importId = `BASE-${fingerprint.slice(0, 12).toUpperCase()}`;
  await storeService.mutate((state) => {
    state.datasetImports = [{
      _id: "stale-event-flag-import",
      importId,
      name: "Stale event flag import",
      fileName: "stale-event-flag.csv",
      fingerprint,
      totalRows: 2,
      validRows: 1,
      invalidRows: 1,
      errorSummary: [{ field: "groundTruthLabel", message: "Invalid input: expected boolean, received string", count: 1, exampleRows: [3] }],
      providers: ["nagad"],
      providerStats: [{ provider: "nagad", validRows: 1, accountsDetected: 1 }],
      accountsDetected: 1,
      status: "complete",
      baselineStatus: "complete",
      importedBy: "Test Manager",
      importedAt: new Date(0).toISOString(),
    }];
    state.baselineTransactions = [{
      provider: "nagad",
      type: "cash-out",
      amount: 1000,
      account: "U-STALE",
      minute: 555.5,
      groundTruthLabel: false,
      rowNumber: 2,
      dataRole: "baseline",
      importId,
      source: "baseline-csv",
    }];
  });

  const user = { id: "test-manager", name: "Test Manager", role: "management", provider: null };
  const repaired = await ingestionService.importBaselineCsv(csv, "stale-event-flag.csv", "Repaired event flag import", user);
  assert.equal(repaired.duplicate, false);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.validRows, 2);
  assert.equal(repaired.invalidRows, 0);
  assert.deepEqual(repaired.errorSummary, []);

  const storedRows = await storeService.getBaselineTransactions({ importId });
  assert.equal(storedRows.length, 2);
  assert.deepEqual(storedRows.map((row) => row.groundTruthLabel), [false, true]);
  assert.equal(storeService.getState().datasetImports.length, 1);
  assert.equal(storeService.getState().datasetImports[0].invalidRows, 0);
});

test("all-invalid baseline files report row totals and provider boundaries reject the whole import", async () => {
  const manager = { id: "test-manager", name: "Test Manager", role: "management", provider: null };
  const invalidCsv = Buffer.from("provider,type,amount,account,minute\nnagad,cash-out,-5,SYN-A,0");
  await assert.rejects(
    ingestionService.importBaselineCsv(invalidCsv, "invalid.csv", "Invalid baseline", manager),
    (error) => error.status === 400 && error.validation.totalRows === 1 && error.validation.validRows === 0 && error.validation.invalidRows === 1 && /Total rows: 1/.test(error.message),
  );

  const before = (await storeService.getBaselineTransactions()).length;
  const operationsUser = { id: "test-ops", name: "Nagad Operations", role: "operations", provider: "nagad" };
  const outsideBoundary = Buffer.from("provider,type,amount,account,minute\nbkash,cash-out,1000,SYN-B,0");
  await assert.rejects(
    ingestionService.importBaselineCsv(outsideBoundary, "bkash.csv", "Outside provider boundary", operationsUser),
    (error) => error.status === 403 && /provider boundary/i.test(error.message),
  );
  assert.equal((await storeService.getBaselineTransactions()).length, before);
});

test("baseline-aware behavior alerts expose structured comparisons and decision-support language", () => {
  const historicalRows = Array.from({ length: 50 }, (_, index) => ({
    provider: "nagad",
    type: "cash-out",
    amount: 1000 + (index % 5) * 10,
    account: "U-BASELINE-ACCOUNT",
    minute: index * 20,
    importId: "HISTORICAL-IMPORT",
    dataRole: "baseline",
  }));
  const calculation = analytics.calculateBaselines(historicalRows);
  const state = clone(demoData);
  state.baselines = calculation.baselines;
  state.cases = [];
  state.transactions = [100, 102, 104, 106, 108].map((minute, index) => ({
    id: `CURRENT-${index + 1}`,
    provider: "nagad",
    type: "cash-out",
    amount: 5000,
    account: "U-BASELINE-ACCOUNT",
    minute,
    importId: "CURRENT-EVIDENCE",
    dataRole: "current",
    source: "synthetic-test",
  }));

  const alert = analytics.getAlerts(state).find((entry) => entry.type === "behavior" && Array.isArray(entry.reasons));
  assert.ok(alert, "a baseline-aware behavior alert should be generated");
  assert.equal(alert.requiresHumanReview, true);
  assert.equal(alert.baselineConfidence, "HIGH");
  assert.ok(Number.isInteger(alert.advisoryRiskScore));
  assert.ok(alert.advisoryRiskScore >= 0 && alert.advisoryRiskScore <= 100);
  assert.ok(alert.reasons.some((reason) => reason.signal === "TRANSACTION_VELOCITY"));
  assert.ok(alert.reasons.some((reason) => reason.signal === "TIME_GAP"));
  assert.ok(alert.reasons.some((reason) => reason.signal === "AMOUNT_DEVIATION"));
  assert.ok(alert.reasons.every((reason) => reason.currentDisplay && reason.baselineDisplay && reason.deviationDisplay && reason.explanation));
  assert.ok(alert.evidence.some((item) => /Advisory risk score: \d+\/100/.test(item)));

  const userFacingText = [alert.title, alert.explanation, alert.recommendation, ...alert.evidence, ...alert.reasons.map((reason) => reason.explanation)].join(" ");
  assert.match(userFacingText, /human review|requires review/i);
  assert.match(userFacingText, /not a fraud probability|not a fraud determination|not proof/i);
  assert.doesNotMatch(userFacingText, /fraud detected|fraudulent user|criminal|scammer/i);
});

test("concentrated individually typical amounts expose a data-derived splitting indicator", () => {
  const historicalRows = Array.from({ length: 50 }, (_, index) => ({
    provider: "bkash", type: "cash-out", amount: 1000, account: "U-SPLIT", minute: index * 20,
    importId: "HISTORICAL-SPLIT", dataRole: "baseline",
  }));
  const state = clone(demoData);
  state.baselines = analytics.calculateBaselines(historicalRows).baselines;
  state.cases = [];
  state.transactions = [100, 103, 106].map((minute, index) => ({
    id: `SPLIT-${index}`, provider: "bkash", type: "cash-out", amount: 1000, account: "U-SPLIT", minute,
    importId: "CURRENT-SPLIT", dataRole: "current",
  }));
  const alert = analytics.getAlerts(state).find((entry) => entry.type === "behavior" && entry.provider === "bkash");
  assert.ok(alert?.reasons.some((reason) => reason.signal === "TRANSACTION_SPLITTING"));
  assert.match(alert.reasons.find((reason) => reason.signal === "TRANSACTION_SPLITTING").explanation, /legitimate concentrated demand|human review/i);
});
