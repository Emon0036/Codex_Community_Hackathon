const crypto = require("crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const analytics = require("../services/analyticsService");
const scenarioComparisonService = require("../services/scenarioComparisonService");
const storeService = require("../services/storeService");
const aiService = require("../services/aiExplanationService");
const authService = require("../services/authService");
const wrapAsync = require("../Utility/wrapAsync");
const { verifyCsrf } = require("../middleware/csrf");

const router = express.Router();
const explanationLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false, message: { error: "AI briefing limit reached. Use the existing evidence or try later.", status: 429 } });

const visibleTo = (user, item) => !user.provider || item.provider === user.provider;

function scopeDatasetImports(imports, user) {
  if (!user.provider) return imports.slice();
  return imports.map((item) => {
    if (item.providers?.length === 1 && item.providers[0] === user.provider) return item;
    const providerStat = item.providerStats?.find((stat) => stat.provider === user.provider);
    if (!providerStat) return null;
    return {
      ...item,
      totalRows: providerStat.validRows,
      validRows: providerStat.validRows,
      invalidRows: 0,
      errorSummary: [],
      providers: [user.provider],
      accountsDetected: providerStat.accountsDetected,
      validation: { groundTruthAvailable: false, precision: null, recall: null, falsePositiveRate: null, message: "Labelled validation metrics are available only in the authorized cross-provider view." },
    };
  }).filter(Boolean);
}

router.get("/dashboard", (req, res) => {
  const state = storeService.getState();
  const data = analytics.getDashboard(state);
  data.providers = data.providers.filter((provider) => !req.user.provider || provider.id === req.user.provider);
  data.alerts = data.alerts.filter((alert) => visibleTo(req.user, alert));
  data.cases = data.cases.filter((item) => visibleTo(req.user, item));
  data.summary.totalEmoney = data.providers.reduce((sum, provider) => sum + provider.balance, 0);
  data.summary.openAlerts = data.alerts.filter((alert) => alert.status !== "resolved").length;
  if (req.user.provider) {
    const scopedBaselines = (state.baselines || []).filter((baseline) => baseline.provider === req.user.provider);
    data.baselineSummary = data.baselineSummary.filter((summary) => summary.provider === req.user.provider);
    data.baselineMetrics = analytics.getBaselineMetrics({ ...state, baselines: scopedBaselines, datasetImports: scopeDatasetImports(state.datasetImports || [], req.user) }, data.alerts);
    data.baselineOverview = { ...data.baselineOverview, baselineCount: scopedBaselines.length, providerCount: data.baselineSummary.length, summary: data.baselineSummary, metrics: data.baselineMetrics };
  }
  res.json(data);
});

router.get("/alerts", (req, res) => {
  let alerts = analytics.getAlerts(storeService.getState()).filter((alert) => visibleTo(req.user, alert));
  if (req.query.provider) alerts = alerts.filter((alert) => alert.provider === req.query.provider);
  if (req.query.severity) alerts = alerts.filter((alert) => alert.severity === req.query.severity);
  if (req.query.type) alerts = alerts.filter((alert) => alert.type === req.query.type);
  res.json({ data: alerts, count: alerts.length });
});

router.get("/baselines", (req, res) => {
  const state = storeService.getState();
  const summaries = analytics.getBaselineSummary(state).filter((summary) => !req.user.provider || summary.provider === req.user.provider);
  const imports = scopeDatasetImports(state.datasetImports || [], req.user)
    .slice()
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));
  const alerts = analytics.getAlerts(state).filter((alert) => visibleTo(req.user, alert));
  const analyticalMetrics = analytics.getBaselineMetrics(state, alerts);
  res.json({
    data: summaries,
    latestImport: imports[0] || null,
    metrics: {
      explanationCoverage: analyticalMetrics.explanationCoverage.percentage,
      explainedHighImpactAlerts: analyticalMetrics.explanationCoverage.coveredAlertCount,
      highImpactAlerts: analyticalMetrics.explanationCoverage.eligibleAlertCount,
      baselineCalculationDurationMs: imports[0]?.baselineCalculationDurationMs ?? null,
      importProcessingDurationMs: imports[0]?.importProcessingDurationMs ?? null,
      validation: imports[0]?.validation || { groundTruthAvailable: false, message: "Precision/recall unavailable because the imported baseline dataset does not contain ground-truth anomaly labels." },
    },
  });
});

router.post("/simulate", verifyCsrf, (req, res) => {
  const comparison = scenarioComparisonService.compareScenarios(req.body, storeService.getState());
  if (req.user.provider) {
    const visibleIndexes = comparison.rows.map((row, index) => ({ row, index })).filter(({ row }) => row.id === req.user.provider || row.id === "shared");
    comparison.rows = visibleIndexes.map(({ row }) => row);
    comparison.chartData.labels = visibleIndexes.map(({ row }) => row.name);
    comparison.chartData.datasets = comparison.chartData.datasets.map((dataset) => ({ ...dataset, data: visibleIndexes.map(({ index }) => dataset.data[index]) }));
    comparison.projectionChartData = comparison.projectionChartData.filter((chart) => chart.id === req.user.provider || chart.id === "shared");
    if (comparison.coordination?.supportOptions) {
      comparison.coordination.supportOptions = comparison.coordination.supportOptions.filter((option) => option.rowId === req.user.provider || option.rowId === "shared");
    }
    if (comparison.coordination) {
      comparison.coordination.reviewLedgerCount = comparison.rows.filter((row) => row.scenario.requiresReview || row.changes.direction === "worsened").length;
      comparison.coordination.supportNeeded = comparison.coordination.reviewLedgerCount > 0;
      const optionCount = comparison.coordination.supportOptions?.length || 0;
      comparison.coordination.flashMessage = `Scenario complete: ${comparison.coordination.reviewLedgerCount} ${comparison.coordination.reviewLedgerCount === 1 ? "ledger needs" : "ledgers need"} review; ${optionCount ? `${optionCount} nearby support ${optionCount === 1 ? "option" : "options"}` : "no nearby support option"} discovered. No state was changed.`;
    }
  }
  res.json({ comparison, data: comparison.rows.map((row) => ({ id: row.id, name: row.name, balance: row.initialBalance, ...row.scenario })), advisoryOnly: true, generatedAt: new Date().toISOString() });
});

router.post("/alerts/:id/explain", explanationLimiter, verifyCsrf, wrapAsync(async (req, res) => {
  const state = storeService.getState();
  const alert = analytics.getAlertById(req.params.id, state);
  if (!alert) return res.status(404).json({ error: "Alert not found", status: 404 });
  if (!visibleTo(req.user, alert) || !authService.canAccessProvider(req.user, alert.provider === "shared" ? null : alert.provider)) return res.status(403).json({ error: "Provider boundary denied", status: 403 });
  const evidenceHash = crypto.createHash("sha256").update(JSON.stringify({ id: alert.id, evidence: alert.evidence, confidence: alert.confidence, explanation: alert.explanation })).digest("hex");
  const existing = state.aiExplanations?.[alert.id];
  const mayForce = ["risk", "management"].includes(req.user.role);
  if (existing?.mode === "ai" && existing.evidenceHash === evidenceHash && !(req.body.force === true && mayForce)) return res.json({ data: existing, cached: true });
  const explanation = await aiService.explainAlert(alert);
  const record = { ...explanation, alertId: alert.id, evidenceHash, model: aiService.getStatus().model, promptVersion: "safe-alert-v1", generatedAt: new Date().toISOString(), generatedBy: req.user.name };
  await storeService.mutate((current) => {
    current.aiExplanations ||= {};
    if (record.mode === "ai") current.aiExplanations[alert.id] = record;
    current.auditLog.push({ at: record.generatedAt, actor: req.user.name, action: `ai.explanation_${record.mode}`, target: alert.id });
  });
  res.json({ data: record, cached: false });
}));

router.get("/cases", (req, res) => res.json({ data: storeService.getState().cases.filter((item) => visibleTo(req.user, item)) }));
router.get("/audit", (req, res) => {
  if (!["risk", "management"].includes(req.user.role)) return res.status(403).json({ error: "Audit access requires risk or management role", status: 403 });
  res.json({ data: storeService.getState().auditLog.slice().reverse().slice(0, 200) });
});

module.exports = router;
