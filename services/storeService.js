const mongoose = require("mongoose");
const dns = require("dns");
const seedState = require("../data/demoData");

const STATE_KEY = "nirapod-ops-demo-v3";
const BASELINE_STATE_KEYS = ["baselineTransactions", "datasetImports", "baselines"];
let persistenceMode = "memory";
let initialized = false;
let writeQueue = Promise.resolve();

const clone = (value) => JSON.parse(JSON.stringify(value));
const isUsableState = (value) => Boolean(value && value.outlet && Array.isArray(value.providers) && value.providers.length >= 2 && value.cashInDemand && value.cashOutDemand && Array.isArray(value.transactions) && Array.isArray(value.cases));

function ensureBaselineState() {
  if (!Array.isArray(seedState.baselineTransactions)) seedState.baselineTransactions = [];
  if (!Array.isArray(seedState.datasetImports)) seedState.datasetImports = [];
  if (!Array.isArray(seedState.baselines)) seedState.baselines = [];
}

function operationalStateSnapshot() {
  const snapshot = clone(seedState);
  BASELINE_STATE_KEYS.forEach((key) => delete snapshot[key]);
  return snapshot;
}

function replaceLiveState(nextState) {
  Object.keys(seedState).forEach((key) => delete seedState[key]);
  Object.assign(seedState, clone(nextState));
  ensureBaselineState();
}

function queueWrite(operation) {
  const queued = writeQueue.catch(() => undefined).then(operation);
  writeQueue = queued.catch(() => undefined);
  return queued;
}

function datasetImportQuery(identifier) {
  if (identifier && typeof identifier === "object") {
    if (identifier._id) return { _id: identifier._id };
    if (identifier.id) return { _id: identifier.id };
    if (identifier.importId) return { importId: String(identifier.importId) };
    if (identifier.fingerprint) return { fingerprint: String(identifier.fingerprint).toLowerCase() };
  }
  const value = String(identifier || "");
  const choices = [{ importId: value }, { fingerprint: value.toLowerCase() }];
  if (mongoose.Types.ObjectId.isValid(value)) choices.unshift({ _id: value });
  return { $or: choices };
}

function findMemoryDatasetImport(identifier) {
  const value = typeof identifier === "object"
    ? String(identifier._id || identifier.id || identifier.importId || identifier.fingerprint || "")
    : String(identifier || "");
  return seedState.datasetImports.find((entry) => String(entry._id || entry.id || "") === value
    || String(entry.importId || "") === value
    || String(entry.fingerprint || "").toLowerCase() === value.toLowerCase());
}

function normalizeBaseline(baseline) {
  const normalized = clone(baseline);
  delete normalized._id;
  delete normalized.id;
  delete normalized.__v;
  normalized.account = normalized.account || null;
  normalized.transactionType = normalized.transactionType || null;
  normalized.scopeKey ||= `${normalized.scopeType}|${normalized.provider}|${normalized.account || "*"}|${normalized.transactionType || "*"}`;
  return normalized;
}

function currentTransactionDocument(transaction) {
  const document = clone(transaction);
  document.transactionId = String(document.transactionId || document.id);
  delete document.id;
  delete document._id;
  delete document.__v;
  return document;
}

function currentTransactionState(document) {
  const transaction = clone(document);
  transaction.id = String(transaction.transactionId || transaction.id);
  delete transaction.transactionId;
  delete transaction._id;
  delete transaction.createdAt;
  delete transaction.updatedAt;
  return transaction;
}

function mergeCurrentTransactions(transactions) {
  const byId = new Map(seedState.transactions.map((transaction) => [String(transaction.id), transaction]));
  transactions.forEach((transaction) => byId.set(String(transaction.id), transaction));
  seedState.transactions = [...byId.values()].sort((left, right) => Number(left.minute) - Number(right.minute) || String(left.id).localeCompare(String(right.id)));
}

function isSrvDnsFailure(error) {
  return /querySrv/.test(error?.message || "") && ["ECONNREFUSED", "ETIMEOUT", "ESERVFAIL", "ENOTFOUND"].includes(error?.code);
}

function mongoDnsServers() {
  return (process.env.MONGODB_DNS_SERVERS || "1.1.1.1,8.8.8.8")
    .split(",")
    .map((server) => server.trim())
    .filter(Boolean);
}

async function connectToMongo(uri, options) {
  try {
    return await mongoose.connect(uri, options);
  } catch (error) {
    if (!uri.startsWith("mongodb+srv://") || !isSrvDnsFailure(error)) throw error;
    dns.setServers(mongoDnsServers());
    return mongoose.connect(uri, options);
  }
}

ensureBaselineState();

async function initialize() {
  if (initialized) return { mode: persistenceMode };
  initialized = true;
  const uri = process.env.ATLAS_DB || process.env.MONGODB_URI;
  if (!uri || process.env.NODE_ENV === "test") return { mode: persistenceMode };
  try {
    await connectToMongo(uri, {
      dbName: process.env.MONGODB_DB_NAME || "nirapod_ops",
      serverSelectionTimeoutMS: 6000,
      maxPoolSize: 5,
    });
    const AppState = require("../models/AppState");
    const DatasetImport = require("../models/DatasetImport");
    const Baseline = require("../models/Baseline");
    const CurrentTransaction = require("../models/CurrentTransaction");
    const saved = await AppState.findOne({ key: STATE_KEY }).lean();
    if (isUsableState(saved?.data)) replaceLiveState(saved.data);
    else await AppState.updateOne({ key: STATE_KEY }, { $set: { data: operationalStateSnapshot() } }, { upsert: true });
    const savedCurrentTransactions = seedState.transactions.filter((transaction) => transaction.source === "csv-import" && transaction.dataRole !== "baseline" && transaction.id);
    if (savedCurrentTransactions.length) {
      await CurrentTransaction.bulkWrite(savedCurrentTransactions.map((transaction) => ({
        updateOne: {
          filter: { transactionId: String(transaction.id) },
          update: { $set: currentTransactionDocument(transaction) },
          upsert: true,
        },
      })), { ordered: false });
    }
    const [datasetImports, baselines] = await Promise.all([
      DatasetImport.find({}).sort({ importedAt: -1, createdAt: -1 }).lean(),
      Baseline.find({}).sort({ scopeKey: 1 }).lean(),
    ]);
    const currentTransactions = await CurrentTransaction.find({ dataRole: "current" }).sort({ importedAt: 1, minute: 1, transactionId: 1 }).lean();
    mergeCurrentTransactions(currentTransactions.map(currentTransactionState));
    seedState.datasetImports = clone(datasetImports);
    seedState.baselines = clone(baselines);
    seedState.baselineTransactions = [];
    persistenceMode = "mongodb";
  } catch (error) {
    persistenceMode = "memory-fallback";
    console.warn(`Database unavailable; using safe in-memory fallback (${error.name}).`);
  }
  return { mode: persistenceMode };
}

function getState() {
  return seedState;
}

async function persist() {
  if (persistenceMode !== "mongodb") return;
  const AppState = require("../models/AppState");
  await AppState.updateOne({ key: STATE_KEY }, { $set: { data: operationalStateSnapshot() } }, { upsert: true });
}

async function mutate(mutator) {
  let result;
  await queueWrite(async () => {
    const before = clone(seedState);
    try {
      result = await mutator(seedState);
      await persist();
    } catch (error) {
      replaceLiveState(before);
      throw error;
    }
  });
  return result;
}

async function addCurrentTransactions(transactions, auditEntry) {
  if (!Array.isArray(transactions)) throw new TypeError("Current transactions must be an array.");
  return queueWrite(async () => {
    if (persistenceMode === "mongodb") {
      const CurrentTransaction = require("../models/CurrentTransaction");
      if (transactions.length) await CurrentTransaction.insertMany(transactions.map(currentTransactionDocument), { ordered: true });
    }
    seedState.transactions.push(...clone(transactions));
    if (auditEntry) seedState.auditLog.push(clone(auditEntry));
    await persist();
    return { imported: transactions.length };
  });
}

async function findDatasetImportByFingerprint(fingerprint) {
  ensureBaselineState();
  const normalized = String(fingerprint || "").toLowerCase();
  if (!normalized) return null;
  if (persistenceMode === "mongodb") {
    const DatasetImport = require("../models/DatasetImport");
    const record = await DatasetImport.findOne({ fingerprint: normalized }).lean();
    return record ? clone(record) : null;
  }
  const record = seedState.datasetImports.find((entry) => String(entry.fingerprint || "").toLowerCase() === normalized);
  return record ? clone(record) : null;
}

async function addBaselineImport(firstArgument, secondArgument = []) {
  const transactions = Array.isArray(firstArgument) ? firstArgument : secondArgument;
  const importRecord = Array.isArray(firstArgument) ? secondArgument : firstArgument;
  if (!importRecord || typeof importRecord !== "object" || !importRecord.fingerprint) throw new TypeError("A baseline import fingerprint is required.");
  if (!Array.isArray(transactions)) throw new TypeError("Baseline transactions must be an array.");
  ensureBaselineState();
  return queueWrite(async () => {
    if (persistenceMode === "mongodb") {
      const DatasetImport = require("../models/DatasetImport");
      const BaselineTransaction = require("../models/BaselineTransaction");
      const normalizedFingerprint = String(importRecord.fingerprint).toLowerCase();
      const importId = String(importRecord.importId || new mongoose.Types.ObjectId());
      let created;
      try {
        created = await DatasetImport.create({ ...clone(importRecord), importId, fingerprint: normalizedFingerprint });
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await DatasetImport.findOne({ fingerprint: normalizedFingerprint }).lean();
        if (!existing) throw error;
        if (!seedState.datasetImports.some((entry) => String(entry._id) === String(existing._id))) seedState.datasetImports.unshift(clone(existing));
        return { ...clone(existing), duplicate: true };
      }
      const plainImport = clone(created.toObject());
      try {
        if (transactions.length) await BaselineTransaction.insertMany(transactions.map((transaction) => ({ ...clone(transaction), dataRole: "baseline", importId })), { ordered: true });
      } catch (error) {
        await DatasetImport.deleteOne({ _id: created._id });
        await BaselineTransaction.deleteMany({ importId });
        throw error;
      }
      seedState.datasetImports.unshift(plainImport);
      return clone(plainImport);
    }

    const normalizedFingerprint = String(importRecord.fingerprint).toLowerCase();
    const existing = seedState.datasetImports.find((entry) => String(entry.fingerprint || "").toLowerCase() === normalizedFingerprint);
    if (existing) return { ...clone(existing), duplicate: true };
    const documentId = String(importRecord._id || importRecord.id || new mongoose.Types.ObjectId());
    const importId = String(importRecord.importId || documentId);
    const storedImport = { ...clone(importRecord), _id: documentId, importId, fingerprint: normalizedFingerprint };
    const storedTransactions = transactions.map((transaction) => ({ ...clone(transaction), dataRole: "baseline", importId }));
    seedState.datasetImports.unshift(storedImport);
    seedState.baselineTransactions.push(...storedTransactions);
    return clone(storedImport);
  });
}

async function replaceBaselineImport(transactions, importRecord) {
  if (!importRecord || typeof importRecord !== "object" || !importRecord.fingerprint) throw new TypeError("A baseline import fingerprint is required.");
  if (!Array.isArray(transactions)) throw new TypeError("Baseline transactions must be an array.");
  ensureBaselineState();
  return queueWrite(async () => {
    const normalizedFingerprint = String(importRecord.fingerprint).toLowerCase();
    if (persistenceMode === "mongodb") {
      const DatasetImport = require("../models/DatasetImport");
      const BaselineTransaction = require("../models/BaselineTransaction");
      const existing = await DatasetImport.findOne({ fingerprint: normalizedFingerprint }).lean();
      const importId = String(importRecord.importId || existing?.importId || new mongoose.Types.ObjectId());
      const safeImport = { ...clone(importRecord), importId, fingerprint: normalizedFingerprint };
      delete safeImport._id;
      delete safeImport.id;
      delete safeImport.__v;
      const updated = await DatasetImport.findOneAndUpdate(
        { fingerprint: normalizedFingerprint },
        { $set: safeImport },
        { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
      ).lean();
      await BaselineTransaction.deleteMany({ importId });
      if (transactions.length) await BaselineTransaction.insertMany(transactions.map((transaction) => ({ ...clone(transaction), dataRole: "baseline", importId })), { ordered: true });
      const index = seedState.datasetImports.findIndex((entry) => String(entry._id) === String(updated._id) || entry.fingerprint === updated.fingerprint);
      if (index >= 0) seedState.datasetImports[index] = clone(updated);
      else seedState.datasetImports.unshift(clone(updated));
      return clone(updated);
    }

    const existingIndex = seedState.datasetImports.findIndex((entry) => String(entry.fingerprint || "").toLowerCase() === normalizedFingerprint);
    const existing = existingIndex >= 0 ? seedState.datasetImports[existingIndex] : null;
    const documentId = String(existing?._id || importRecord._id || importRecord.id || new mongoose.Types.ObjectId());
    const importId = String(importRecord.importId || existing?.importId || documentId);
    const storedImport = { ...clone(existing || {}), ...clone(importRecord), _id: documentId, importId, fingerprint: normalizedFingerprint };
    seedState.datasetImports = [
      storedImport,
      ...seedState.datasetImports.filter((entry, index) => index !== existingIndex && String(entry.fingerprint || "").toLowerCase() !== normalizedFingerprint),
    ];
    seedState.baselineTransactions = seedState.baselineTransactions.filter((transaction) => String(transaction.importId) !== importId);
    seedState.baselineTransactions.push(...transactions.map((transaction) => ({ ...clone(transaction), dataRole: "baseline", importId })));
    return clone(storedImport);
  });
}

async function getBaselineTransactions(filters = {}) {
  ensureBaselineState();
  const query = { dataRole: "baseline" };
  for (const key of ["provider", "account", "importId"]) {
    if (filters[key] !== undefined) query[key] = Array.isArray(filters[key]) ? { $in: filters[key] } : filters[key];
  }
  const transactionType = filters.type === undefined ? filters.transactionType : filters.type;
  if (transactionType !== undefined) query.type = Array.isArray(transactionType) ? { $in: transactionType } : transactionType;
  if (persistenceMode === "mongodb") {
    const BaselineTransaction = require("../models/BaselineTransaction");
    return clone(await BaselineTransaction.find(query).sort({ importId: 1, minute: 1, _id: 1 }).lean());
  }
  const matches = seedState.baselineTransactions.filter((transaction) => {
    const matchesFilter = (key, expected) => expected === undefined || (Array.isArray(expected) ? expected.includes(transaction[key]) : transaction[key] === expected);
    return transaction.dataRole === "baseline"
      && matchesFilter("provider", filters.provider)
      && matchesFilter("account", filters.account)
      && matchesFilter("importId", filters.importId)
      && matchesFilter("type", transactionType);
  });
  return clone(matches.sort((left, right) => String(left.importId).localeCompare(String(right.importId)) || Number(left.minute) - Number(right.minute)));
}

async function replaceBaselines(baselines) {
  if (!Array.isArray(baselines)) throw new TypeError("Baselines must be an array.");
  const normalized = baselines.map(normalizeBaseline);
  ensureBaselineState();
  return queueWrite(async () => {
    if (persistenceMode === "mongodb") {
      const Baseline = require("../models/Baseline");
      if (normalized.length) {
        await Baseline.bulkWrite(normalized.map((baseline) => ({
          updateOne: { filter: { scopeKey: baseline.scopeKey }, update: { $set: baseline }, upsert: true },
        })), { ordered: false });
        await Baseline.deleteMany({ scopeKey: { $nin: normalized.map((baseline) => baseline.scopeKey) } });
      } else await Baseline.deleteMany({});
      seedState.baselines = clone(await Baseline.find({}).sort({ scopeKey: 1 }).lean());
    } else seedState.baselines = clone(normalized);
    return clone(seedState.baselines);
  });
}

async function updateDatasetImport(identifier, updates) {
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new TypeError("Dataset import updates must be an object.");
  ensureBaselineState();
  const safeUpdates = clone(updates);
  delete safeUpdates._id;
  delete safeUpdates.id;
  delete safeUpdates.fingerprint;
  return queueWrite(async () => {
    if (persistenceMode === "mongodb") {
      const DatasetImport = require("../models/DatasetImport");
      const updated = await DatasetImport.findOneAndUpdate(datasetImportQuery(identifier), { $set: safeUpdates }, { new: true, runValidators: true }).lean();
      if (!updated) return null;
      const index = seedState.datasetImports.findIndex((entry) => String(entry._id) === String(updated._id) || entry.fingerprint === updated.fingerprint);
      if (index >= 0) seedState.datasetImports[index] = clone(updated);
      else seedState.datasetImports.unshift(clone(updated));
      return clone(updated);
    }
    const record = findMemoryDatasetImport(identifier);
    if (!record) return null;
    Object.assign(record, safeUpdates, { updatedAt: new Date().toISOString() });
    return clone(record);
  });
}

function getStatus() {
  return { mode: persistenceMode, connected: mongoose.connection.readyState === 1 };
}

async function close() {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  initialized = false;
  persistenceMode = "memory";
}

module.exports = {
  initialize,
  getState,
  mutate,
  getStatus,
  close,
  addCurrentTransactions,
  findDatasetImportByFingerprint,
  addBaselineImport,
  replaceBaselineImport,
  getBaselineTransactions,
  replaceBaselines,
  updateDatasetImport,
};
