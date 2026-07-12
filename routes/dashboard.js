const express = require("express");
const multer = require("multer");
const analytics = require("../services/analyticsService");
const storeService = require("../services/storeService");
const caseService = require("../services/caseService");
const ingestionService = require("../services/ingestionService");
const authService = require("../services/authService");
const wrapAsync = require("../Utility/wrapAsync");
const { verifyCsrf } = require("../middleware/csrf");
const { requireCaseAccess, requireIngestAccess, requireBaselineAccess, requireDataAccess } = require("../middleware/auth");

const router = express.Router();
const csvFileFilter = (req, file, callback) => callback(null, file.originalname.toLowerCase().endsWith(".csv") || file.mimetype === "text/csv");
const upload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024, files: 1 },
  fileFilter: csvFileFilter,
});
const baselineUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: csvFileFilter,
});

function uploadBaselineCsv(req, res, next) {
  baselineUpload.single("baselineFile")(req, res, (error) => {
    if (error) error.status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    next(error);
  });
}

function roleAwareDashboard(user) {
  const state = storeService.getState();
  const data = analytics.getDashboard(state);
  if (!user.provider) return data;
  data.providers = data.providers.filter((provider) => provider.id === user.provider);
  data.alerts = data.alerts.filter((alert) => alert.provider === user.provider);
  data.cases = data.cases.filter((item) => item.provider === user.provider);
  data.summary.totalEmoney = data.providers.reduce((sum, provider) => sum + provider.balance, 0);
  data.summary.openAlerts = data.alerts.filter((alert) => alert.status !== "resolved").length;
  const scopedBaselines = (state.baselines || []).filter((baseline) => baseline.provider === user.provider);
  data.baselineSummary = data.baselineSummary.filter((summary) => summary.provider === user.provider);
  data.baselineMetrics = analytics.getBaselineMetrics({ ...state, baselines: scopedBaselines, datasetImports: scopeDatasetImports(state.datasetImports || [], user) }, data.alerts);
  data.baselineOverview = { ...data.baselineOverview, baselineCount: scopedBaselines.length, providerCount: data.baselineSummary.length, summary: data.baselineSummary, metrics: data.baselineMetrics };
  return data;
}

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

function baselineView(user) {
  const state = storeService.getState();
  const summaries = analytics.getBaselineSummary(state).filter((summary) => !user.provider || summary.provider === user.provider);
  const imports = scopeDatasetImports(state.datasetImports || [], user)
    .slice()
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt));
  const visibleAlerts = analytics.getAlerts(state).filter((alert) => !user.provider || alert.provider === user.provider);
  const scopedState = user.provider
    ? { ...state, baselines: (state.baselines || []).filter((baseline) => baseline.provider === user.provider), datasetImports: imports }
    : state;
  const analyticalMetrics = analytics.getBaselineMetrics(scopedState, visibleAlerts);
  return {
    latestImport: imports[0] || null,
    importCount: imports.length,
    summaries,
    metrics: {
      highImpactAlerts: analyticalMetrics.explanationCoverage.eligibleAlertCount,
      explainedAlerts: analyticalMetrics.explanationCoverage.coveredAlertCount,
      explanationCoverage: analyticalMetrics.explanationCoverage.percentage,
      baselineCalculationDurationMs: imports[0]?.baselineCalculationDurationMs ?? null,
      importProcessingDurationMs: imports[0]?.importProcessingDurationMs ?? null,
      validation: imports[0]?.validation || { groundTruthAvailable: false, message: "Precision/recall unavailable because the imported baseline dataset does not contain ground-truth anomaly labels." },
    },
  };
}

function currentImportView(user, showCurrent = false) {
  const visibleRows = (storeService.getState().transactions || [])
    .filter((row) => row.dataRole !== "baseline" && row.source === "csv-import" && (!user.provider || row.provider === user.provider));
  const latest = visibleRows
    .slice()
    .sort((a, b) => new Date(b.importedAt || 0) - new Date(a.importedAt || 0))[0];
  if (!latest?.importId) return { latestImport: null, rows: [], totalRows: 0, headers: [], visible: false };
  const rows = visibleRows
    .filter((row) => row.importId === latest.importId)
    .sort((a, b) => Number(a.minute) - Number(b.minute));
  const headers = latest.csvHeaders?.length ? latest.csvHeaders : ["provider", "type", "amount", "account", "minute"];
  return {
    latestImport: { importId: latest.importId, importedAt: latest.importedAt },
    rows: showCurrent ? rows : [],
    totalRows: rows.length,
    headers,
    visible: showCurrent,
  };
}

async function historicalDataView(user, showHistorical) {
  if (!showHistorical) return { visible: false, rows: [], totalRows: 0 };
  const rows = await storeService.getBaselineTransactions(user.provider ? { provider: user.provider } : {});
  return {
    visible: true,
    rows,
    totalRows: rows.length,
  };
}

router.get("/", (req, res) => res.render("dashboard", { title: "Command Center", data: roleAwareDashboard(req.user) }));
router.get("/alerts", (req, res) => res.render("alerts", { title: "Explainable Alerts", data: roleAwareDashboard(req.user), notice: req.query.notice || null }));
router.get("/cases", (req, res) => {
  const data = roleAwareDashboard(req.user);
  data.cases = data.cases.map((item) => ({ ...item, workflow: caseService.getWorkflow(item) }));
  res.render("cases", {
    title: "Case Coordination",
    data,
    owners: authService.users.filter((user) => ["operations", "risk", "management"].includes(user.role)),
    workflowSteps: caseService.workflowSteps,
    notice: req.query.notice || null,
  });
});
router.get("/simulation", (req, res) => res.render("simulation", { title: "Scenario Lab", data: roleAwareDashboard(req.user) }));
router.get("/methodology", (req, res) => res.render("methodology", { title: "Trust & Methodology", data: roleAwareDashboard(req.user), persistence: storeService.getStatus() }));
router.get("/network", (req, res) => {
  const network = analytics.getNetworkDashboard(storeService.getState(), req.query);
  if (req.user.provider) {
    network.outlets = network.outlets.map((outlet) => ({ ...outlet, totalEmoney: outlet.providerBalances[req.user.provider] }));
    network.scopeLabel = `${req.user.provider} e-money`;
  } else network.scopeLabel = "Separate e-money total";
  res.render("network", { title: "Network Readiness", network, data: roleAwareDashboard(req.user) });
});
router.get("/data", requireDataAccess, wrapAsync(async (req, res) => res.render("data", {
  title: "Simulation Data",
  data: roleAwareDashboard(req.user),
  baseline: baselineView(req.user),
  currentImport: currentImportView(req.user, req.query.showCurrent === "1"),
  historicalData: await historicalDataView(req.user, req.query.showHistorical === "1"),
  notice: req.query.notice || null,
})));

router.post("/alerts/:id/cases", requireCaseAccess, verifyCsrf, wrapAsync(async (req, res) => {
  const item = await caseService.createCase(req.params.id, req.user);
  res.redirect(`/cases?notice=${encodeURIComponent(`${item.id} was routed and is ready for owner assignment.`)}#${item.id}`);
}));

router.post("/cases/:id/status", requireCaseAccess, verifyCsrf, wrapAsync(async (req, res) => {
  await caseService.transitionCase(req.params.id, String(req.body.status), req.user);
  res.redirect(`/cases?notice=${encodeURIComponent("Case status and audit trail updated.")}#${req.params.id}`);
}));
router.post("/cases/:id/notes", requireCaseAccess, verifyCsrf, wrapAsync(async (req, res) => {
  await caseService.addNote(req.params.id, req.body.note, req.user);
  res.redirect(`/cases?notice=${encodeURIComponent("Case note added.")}#${req.params.id}`);
}));
router.post("/cases/:id/assign", requireCaseAccess, verifyCsrf, wrapAsync(async (req, res) => {
  await caseService.assignCase(req.params.id, req.body.ownerId, req.user);
  res.redirect(`/cases?notice=${encodeURIComponent("Case owner updated.")}#${req.params.id}`);
}));

router.post("/data/snapshot", requireIngestAccess, verifyCsrf, wrapAsync(async (req, res) => {
  await ingestionService.updateSnapshot(req.body, req.user);
  res.redirect(`/data?notice=${encodeURIComponent("Snapshot validated, saved, and analytics recalculated.")}`);
}));
router.post("/data/transactions", requireIngestAccess, upload.single("transactions"), verifyCsrf, wrapAsync(async (req, res) => {
  if (!req.file) { const error = new Error("Choose a valid CSV file under 512 KB."); error.status = 400; throw error; }
  const result = await ingestionService.importCsv(req.file.buffer, req.user);
  res.redirect(`/data?notice=${encodeURIComponent(`${result.imported} anonymized rows imported.`)}`);
}));
router.post("/data/baseline", requireBaselineAccess, uploadBaselineCsv, verifyCsrf, wrapAsync(async (req, res) => {
  if (!req.file) { const error = new Error("Choose a valid baseline CSV file under 5 MB."); error.status = 400; throw error; }
  const result = await ingestionService.importBaselineCsv(req.file.buffer, req.file.originalname, req.body.datasetName, req.user);
  const notice = result.duplicate
    ? `This baseline dataset was already imported as ${result.name}. No duplicate rows were stored.`
    : `Baseline dataset imported successfully: ${result.validRows.toLocaleString()} valid rows, ${result.invalidRows.toLocaleString()} invalid rows, ${result.providers.length} providers, and ${result.accountsDetected.toLocaleString()} synthetic accounts. Baseline recalculated successfully.`;
  res.redirect(`/data?notice=${encodeURIComponent(notice)}#baseline-dataset`);
}));
router.post("/data/baseline/recalculate", requireBaselineAccess, verifyCsrf, wrapAsync(async (req, res) => {
  const result = await ingestionService.recalculateBaselines(req.user);
  res.redirect(`/data?notice=${encodeURIComponent(`Baseline recalculated successfully in ${result.baselineCalculationDurationMs} ms across ${result.baselineCount} stored scopes.`)}#baseline-dataset`);
}));

module.exports = router;
