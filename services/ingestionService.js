const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const { z } = require("zod");
const storeService = require("./storeService");
const authService = require("./authService");
const analyticsService = require("./analyticsService");

const MAX_BASELINE_ROWS = 25_000;
const COLUMN_ALIASES = Object.freeze({
  provider: ["provider", "provider_id", "provider_name"],
  type: ["type", "transaction_type", "transactiontype"],
  amount: ["amount", "transaction_amount", "value"],
  account: ["account", "account_id", "agent", "agent_id", "account_agent"],
  minute: ["minute", "time", "timestamp", "transaction_time", "transaction_minute"],
  day: ["day", "transaction_day", "timeline_day"],
  groundTruthLabel: ["is_anomaly", "anomaly", "label", "ground_truth", "ground_truth_label", "event_flag", "review_required"],
});

const snapshotSchema = z.object({
  sharedCash: z.coerce.number().min(0).max(100_000_000),
  provider: z.enum(["bkash", "nagad", "rocket"]),
  balance: z.coerce.number().min(0).max(100_000_000),
  alternateBalance: z.union([z.literal(""), z.coerce.number().min(0).max(100_000_000)]).optional(),
  feedStatus: z.enum(["healthy", "late", "conflicting"]),
  updatedMinutesAgo: z.coerce.number().int().min(0).max(1440),
}).superRefine((value, context) => {
  if (value.feedStatus === "conflicting" && (value.alternateBalance === "" || value.alternateBalance === undefined)) context.addIssue({ code: "custom", path: ["alternateBalance"], message: "A conflicting feed requires a secondary balance." });
});

const transactionSchema = z.object({
  provider: z.enum(["bkash", "nagad", "rocket"]),
  type: z.string().trim().min(1).max(80),
  amount: z.coerce.number().positive().max(500_000),
  account: z.string().trim().min(1).max(100),
  minute: z.coerce.number().int().min(0).max(1440),
});

const baselineTransactionSchema = z.object({
  provider: z.enum(["bkash", "nagad", "rocket"]),
  type: z.string().trim().min(1).max(80),
  amount: z.coerce.number().min(0).max(100_000_000),
  account: z.string().trim().min(1).max(100),
  minute: z.coerce.number().min(0),
  groundTruthLabel: z.preprocess(parseGroundTruthLabel, z.boolean().nullable().optional()),
});

const pseudonymizationKey = process.env.PSEUDONYMIZATION_SECRET || "nirapod-synthetic-demo-only-v1";
const pseudonymize = (value) => `U-${crypto.createHmac("sha256", pseudonymizationKey).update(String(value)).digest("hex").slice(0, 10).toUpperCase()}`;

const normalizeHeader = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const normalizeLabelToken = (value) => String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const FALSE_LABELS = new Set(["0", "false", "no", "n", "na", "n_a", "normal", "normal_negative", "negative", "clear", "none", "not_flagged", "not_anomaly", "no_anomaly", "non_anomaly", "not_required", "not_applicable", "ordinary", "legitimate", "benign", "spaced_repetition_negative", "varied_burst_negative", "legitimate_burst_hard_negative", "hard_negative"]);
const TRUE_LABELS = new Set(["1", "true", "yes", "y", "anomaly", "anomalous", "unusual", "positive", "flagged", "review", "required", "review_required", "requires_review", "cash_pressure", "balance_mismatch", "rapid_repeat", "high_velocity", "high_amount", "off_hours", "rule_aligned_anomaly", "low_count_edge_anomaly", "wide_window_edge_anomaly", "amount_tolerance_edge_anomaly"]);

function resolveColumns(row) {
  const headers = Object.keys(row || {});
  const byNormalizedName = new Map(headers.map((header) => [normalizeHeader(header), header]));
  const resolved = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const matchingAlias = aliases.find((alias) => byNormalizedName.has(normalizeHeader(alias)));
    if (matchingAlias) resolved[field] = byNormalizedName.get(normalizeHeader(matchingAlias));
  }
  const missing = ["provider", "type", "amount", "account", "minute"].filter((field) => !resolved[field]);
  if (missing.length) {
    const error = new Error(`CSV is missing required column${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}.`);
    error.status = 400;
    throw error;
  }
  return resolved;
}

function normalizeProvider(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[^a-z]/g, "");
  return { bkash: "bkash", nagad: "nagad", rocket: "rocket" }[normalized] || normalized;
}

function normalizeTransactionType(value) {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (normalized === "cashin") return "cash-in";
  if (normalized === "cashout") return "cash-out";
  return normalized;
}

function parseAmount(value) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  return Number(text.replace(/(?:bdt|tk)/ig, "").replace(/[,\s$\u09F3]/g, ""));
}

function parseClockMinute(text, allowEmbedded = false) {
  const pattern = allowEmbedded
    ? /(?:^|[T\s])(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:$|\s|Z|[+-]\d{2}:?\d{2})/i
    : /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i;
  const clock = String(text || "").trim().match(pattern);
  if (!clock) return Number.NaN;
  let hours = Number(clock[1]);
  const minutes = Number(clock[2]);
  const seconds = Number(clock[3] || 0);
  const meridiem = String(clock[4] || "").toUpperCase();
  if (meridiem) {
    if (hours < 1 || hours > 12) return Number.NaN;
    if (meridiem === "PM" && hours < 12) hours += 12;
    if (meridiem === "AM" && hours === 12) hours = 0;
  }
  if (hours > 23 || minutes > 59 || seconds > 59) return Number.NaN;
  return hours * 60 + minutes + seconds / 60;
}

function minuteOfDayFromDate(timestamp) {
  if (!Number.isFinite(timestamp)) return Number.NaN;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? Number.NaN : date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function parseMinuteWithinDay(value) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    if (numeric > 1_000_000_000_000) return minuteOfDayFromDate(numeric);
    if (numeric > 1_000_000_000) return minuteOfDayFromDate(numeric * 1000);
    return numeric;
  }
  const clockMinute = parseClockMinute(text, true);
  if (Number.isFinite(clockMinute)) return clockMinute;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? Number.NaN : minuteOfDayFromDate(timestamp);
}

function parseDayOffset(value) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return Number.NaN;
  return Math.max(0, numeric > 0 ? numeric - 1 : numeric) * 1440;
}

function parseCurrentMinute(value) {
  const minute = parseMinuteWithinDay(value);
  if (!Number.isFinite(minute)) return Number.NaN;
  return Math.floor(((minute % 1440) + 1440) % 1440);
}

function parseTimelineMinute(value, dayValue) {
  const text = String(value ?? "").trim();
  if (!text) return Number.NaN;
  const dayOffset = parseDayOffset(dayValue);
  const hasDayOffset = Number.isFinite(dayOffset);
  const numeric = Number(text);
  if (Number.isFinite(numeric)) return hasDayOffset && numeric >= 0 && numeric <= 1440 ? dayOffset + numeric : numeric;
  if (hasDayOffset) {
    const minute = parseMinuteWithinDay(text);
    return Number.isFinite(minute) ? dayOffset + minute : Number.NaN;
  }
  const clockMinute = parseClockMinute(text);
  if (Number.isFinite(clockMinute)) return clockMinute;
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? Number.NaN : timestamp / 60_000;
}

function parseGroundTruthLabel(value) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  if (typeof value === "boolean") return value;
  const normalized = normalizeLabelToken(value);
  if (TRUE_LABELS.has(normalized)) return true;
  if (FALSE_LABELS.has(normalized)) return false;
  return true;
}

function shouldRepairDuplicateImport(existing, nextRecord) {
  if (!existing) return false;
  return Number(nextRecord.validRows || 0) > Number(existing.validRows || 0)
    || Number(nextRecord.invalidRows || 0) < Number(existing.invalidRows || 0);
}

function normalizeBaselineRow(row, columns) {
  return {
    provider: normalizeProvider(row[columns.provider]),
    type: normalizeTransactionType(row[columns.type]),
    amount: parseAmount(row[columns.amount]),
    account: String(row[columns.account] ?? "").trim(),
    minute: parseTimelineMinute(row[columns.minute], columns.day ? row[columns.day] : undefined),
    groundTruthLabel: columns.groundTruthLabel ? parseGroundTruthLabel(row[columns.groundTruthLabel]) : null,
  };
}

function normalizeCurrentRow(row, columns) {
  return {
    provider: normalizeProvider(row[columns.provider]),
    type: normalizeTransactionType(row[columns.type]),
    amount: parseAmount(row[columns.amount]),
    account: String(row[columns.account] ?? "").trim(),
    minute: parseCurrentMinute(row[columns.minute]),
  };
}

function displayCsvRow(row, headers, columns, transaction) {
  const display = {};
  headers.forEach((header) => { display[header] = row[header] ?? ""; });
  display[columns.provider] = transaction.provider;
  display[columns.type] = transaction.type;
  display[columns.amount] = transaction.amount;
  display[columns.account] = transaction.account;
  return display;
}

function summarizeValidationIssues(issues) {
  const grouped = new Map();
  issues.forEach(({ rowNumber, field, message }) => {
    const key = `${field}:${message}`;
    const current = grouped.get(key) || { field, message, count: 0, exampleRows: [] };
    current.count += 1;
    if (current.exampleRows.length < 5) current.exampleRows.push(rowNumber);
    grouped.set(key, current);
  });
  return [...grouped.values()].slice(0, 20);
}

function parseCsvRows(buffer) {
  try { return parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true }); }
  catch { const error = new Error("The CSV could not be parsed."); error.status = 400; throw error; }
}

async function updateSnapshot(input, user) {
  const result = snapshotSchema.safeParse(input);
  if (!result.success) { const error = new Error(result.error.issues[0].message); error.status = 400; throw error; }
  if (user.provider && user.provider !== result.data.provider) { const error = new Error("You cannot update another provider's feed."); error.status = 403; throw error; }
  return storeService.mutate((state) => {
    const provider = state.providers.find((entry) => entry.id === result.data.provider);
    const canUpdateSharedCash = ["agent", "management"].includes(user.role);
    if (!canUpdateSharedCash && result.data.sharedCash !== state.outlet.sharedCash) { const error = new Error("Only the outlet agent or management can update shared physical cash."); error.status = 403; throw error; }
    if (canUpdateSharedCash) state.outlet.sharedCash = result.data.sharedCash;
    provider.balance = result.data.balance;
    provider.feedStatus = result.data.feedStatus;
    provider.updatedMinutesAgo = result.data.updatedMinutesAgo;
    provider.alternateBalance = result.data.alternateBalance === "" || result.data.alternateBalance === undefined ? null : result.data.alternateBalance;
    provider.status = result.data.feedStatus === "healthy" ? "healthy" : "watch";
    state.outlet.lastSync = new Date().toISOString();
    const networkEntry = state.networkOutlets.find((entry) => entry.id === state.outlet.id);
    if (networkEntry) { networkEntry.sharedCash = state.outlet.sharedCash; networkEntry.totalEmoney = state.providers.reduce((sum, entry) => sum + entry.balance, 0); networkEntry.providerBalances ||= {}; networkEntry.providerBalances[provider.id] = provider.balance; }
    state.auditLog.push({ at: state.outlet.lastSync, actor: user.name, action: "feed.snapshot_updated", target: result.data.provider });
    return provider;
  });
}

async function importCsv(buffer, user) {
  const rows = parseCsvRows(buffer);
  if (rows.length < 1 || rows.length > 500) { const error = new Error("CSV files must contain between 1 and 500 rows."); error.status = 400; throw error; }
  const columns = resolveColumns(rows[0]);
  const csvHeaders = Object.keys(rows[0] || {});
  const validated = rows.map((row, index) => {
    const parsed = transactionSchema.safeParse(normalizeCurrentRow(row, columns));
    if (!parsed.success) { const error = new Error(`CSV row ${index + 2}: ${parsed.error.issues[0].message}`); error.status = 400; throw error; }
    if (!authService.canAccessProvider(user, parsed.data.provider)) { const error = new Error(`CSV row ${index + 2} is outside your provider boundary.`); error.status = 403; throw error; }
    const transaction = { ...parsed.data, account: pseudonymize(parsed.data.account), source: "csv-import", dataRole: "current" };
    return { ...transaction, csvHeaders, csvRow: displayCsvRow(row, csvHeaders, columns, transaction) };
  });
  const batch = Date.now();
  const importId = `CUR-${batch}`;
  const importedAt = new Date().toISOString();
  const transactions = validated.map((transaction, index) => ({ ...transaction, id: `IMP-${batch}-${index + 1}`, importId, importedAt }));
  return storeService.addCurrentTransactions(transactions, {
    at: new Date().toISOString(),
    actor: user.name,
    action: "transactions.csv_imported",
    target: `${validated.length} anonymized rows`,
  });
}

async function importBaselineCsv(buffer, fileName, datasetName, user) {
  const processingStartedAt = Date.now();
  const rows = parseCsvRows(buffer);
  if (rows.length < 1 || rows.length > MAX_BASELINE_ROWS) {
    const error = new Error(`Baseline CSV files must contain between 1 and ${MAX_BASELINE_ROWS.toLocaleString()} rows.`);
    error.status = 400;
    throw error;
  }

  const columns = resolveColumns(rows[0]);
  const validationIssues = [];
  const validRows = [];
  rows.forEach((row, index) => {
    const parsed = baselineTransactionSchema.safeParse(normalizeBaselineRow(row, columns));
    if (!parsed.success) {
      parsed.error.issues.forEach((issue) => validationIssues.push({ rowNumber: index + 2, field: String(issue.path[0] || "row"), message: issue.message }));
      return;
    }
    if (!authService.canAccessProvider(user, parsed.data.provider)) {
      const error = new Error(`CSV row ${index + 2} is outside your provider boundary.`);
      error.status = 403;
      throw error;
    }
    validRows.push({ ...parsed.data, account: pseudonymize(parsed.data.account), rowNumber: index + 2 });
  });

  const errorSummary = summarizeValidationIssues(validationIssues);
  if (!validRows.length) {
    const summaryText = errorSummary.slice(0, 3).map((issue) => `${issue.count} row(s) failed ${issue.field}: ${issue.message}`).join("; ");
    const error = new Error(`No valid historical rows were found. Total rows: ${rows.length}; valid: 0; invalid: ${rows.length}. ${summaryText || "Check the required values."}`);
    error.status = 400;
    error.validation = { totalRows: rows.length, validRows: 0, invalidRows: rows.length, errorSummary };
    throw error;
  }

  const fingerprint = crypto.createHash("sha256").update(buffer).digest("hex");
  const duplicate = await storeService.findDatasetImportByFingerprint(fingerprint);
  const importId = duplicate?.importId || `BASE-${fingerprint.slice(0, 12).toUpperCase()}`;
  const importedAt = new Date().toISOString();
  const providers = [...new Set(validRows.map((row) => row.provider))].sort();
  const accountsDetected = new Set(validRows.map((row) => row.account)).size;
  const providerStats = providers.map((provider) => {
    const providerRows = validRows.filter((row) => row.provider === provider);
    return { provider, validRows: providerRows.length, accountsDetected: new Set(providerRows.map((row) => row.account)).size };
  });
  const transactions = validRows.map((row) => ({
    ...row,
    importId,
    dataRole: "baseline",
    source: "baseline-csv",
  }));
  const requestedName = String(datasetName || "").trim();
  const importRecord = {
    importId,
    name: (requestedName || String(fileName || "Historical baseline").trim() || "Historical baseline").slice(0, 120),
    fileName: String(fileName || "baseline.csv").slice(0, 180),
    fingerprint,
    totalRows: rows.length,
    validRows: validRows.length,
    invalidRows: rows.length - validRows.length,
    errorSummary,
    providers,
    providerStats,
    accountsDetected,
    status: "imported",
    baselineStatus: "calculating",
    importedBy: user.name,
    importedAt,
    importProcessingDurationMs: Date.now() - processingStartedAt,
    baselineCalculationDurationMs: null,
    calculatedAt: null,
    validation: columns.groundTruthLabel
      ? { groundTruthAvailable: true, precision: null, recall: null, falsePositiveRate: null, message: "Ground-truth labels were preserved. Metrics remain unavailable until separately labelled current activity is evaluated; baseline rows are not anomaly predictions." }
      : { groundTruthAvailable: false, precision: null, recall: null, falsePositiveRate: null, message: "Precision/recall unavailable because the imported baseline dataset does not contain ground-truth anomaly labels." },
  };
  const repairDuplicate = shouldRepairDuplicateImport(duplicate, importRecord);
  if (duplicate && !repairDuplicate) return { ...duplicate, duplicate: true };

  const claimed = repairDuplicate
    ? await storeService.replaceBaselineImport(transactions, importRecord)
    : await storeService.addBaselineImport(transactions, importRecord);
  if (claimed?.duplicate) return claimed;

  try {
    const baselineRows = await storeService.getBaselineTransactions();
    const calculation = analyticsService.calculateBaselines(baselineRows);
    const calculationDuration = calculation.calculationDurationMs;
    const calculatedAt = calculation.calculatedAt;
    await storeService.replaceBaselines(calculation.baselines);
    const validation = columns.groundTruthLabel
      ? analyticsService.evaluateLabelledTransactions(storeService.getState(), baselineRows, calculation.baselines)
      : importRecord.validation;
    const completed = await storeService.updateDatasetImport(importId, {
      status: "complete",
      baselineStatus: "complete",
      baselineCalculationDurationMs: calculationDuration,
      calculatedAt,
      validation,
    });
    await storeService.mutate((state) => {
      state.auditLog.push({ at: calculatedAt, actor: user.name, action: "baseline.csv_imported", target: `${validRows.length} valid rows (${importId})` });
    });
    return { ...importRecord, ...completed, baselineCount: calculation.baselines.length, duplicate: false, repaired: repairDuplicate };
  } catch (error) {
    await storeService.updateDatasetImport(importId, { status: "failed", baselineStatus: "failed", failureReason: "Baseline calculation did not complete." });
    throw error;
  }
}

async function recalculateBaselines(user) {
  const rows = await storeService.getBaselineTransactions(user.provider ? { provider: user.provider } : {});
  if (!rows.length) { const error = new Error("Import a historical baseline CSV before recalculating."); error.status = 400; throw error; }
  const calculation = analyticsService.calculateBaselines(rows);
  const calculatedAt = calculation.calculatedAt;
  const existingBaselines = storeService.getState().baselines || [];
  const nextBaselines = user.provider
    ? [...existingBaselines.filter((baseline) => baseline.provider !== user.provider), ...calculation.baselines]
    : calculation.baselines;
  await storeService.replaceBaselines(nextBaselines);
  const latestImport = (storeService.getState().datasetImports || [])
    .filter((item) => !user.provider || item.providers?.includes(user.provider))
    .slice()
    .sort((a, b) => new Date(b.importedAt) - new Date(a.importedAt))[0];
  if (latestImport) await storeService.updateDatasetImport(latestImport.importId, {
    status: "complete",
    baselineStatus: "complete",
    baselineCalculationDurationMs: calculation.calculationDurationMs,
    calculatedAt,
    failureReason: null,
  });
  await storeService.mutate((state) => {
    state.auditLog.push({ at: calculatedAt, actor: user.name, action: "baseline.recalculated", target: `${calculation.baselines.length} ${user.provider || "cross-provider"} baseline scopes` });
  });
  return { baselineCount: calculation.baselines.length, calculatedAt, baselineCalculationDurationMs: calculation.calculationDurationMs };
}

module.exports = {
  updateSnapshot,
  importCsv,
  importBaselineCsv,
  recalculateBaselines,
  pseudonymize,
  parseTimelineMinute,
  MAX_BASELINE_ROWS,
};
