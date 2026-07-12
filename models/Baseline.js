const mongoose = require("mongoose");

const baselineSchema = new mongoose.Schema({
  scopeType: { type: String, required: true, enum: ["provider", "provider_type", "provider_account", "provider_account_type"] },
  scopeKey: { type: String, required: true, trim: true },
  provider: { type: String, required: true, enum: ["bkash", "nagad", "rocket"], lowercase: true, trim: true },
  account: { type: String, default: null, trim: true },
  transactionType: { type: String, default: null, trim: true, maxlength: 80 },
  sampleSize: { type: Number, required: true, min: 0 },
  avgAmount: { type: Number, default: null },
  medianAmount: { type: Number, default: null },
  amountStdDev: { type: Number, default: null },
  p5Amount: { type: Number, default: null },
  p05Amount: { type: Number, default: null },
  p95Amount: { type: Number, default: null },
  avgTimeGapMinutes: { type: Number, default: null },
  medianTimeGapMinutes: { type: Number, default: null },
  p05TimeGapMinutes: { type: Number, default: null },
  normalWindowMinutes: { type: Number, min: 1, default: null },
  observationWindowMinutes: { type: Number, min: 1, default: null },
  windowCount: { type: Number, min: 0, default: null },
  avgTransactionsPerWindow: { type: Number, default: null },
  medianTransactionsPerWindow: { type: Number, default: null },
  p95TransactionsPerWindow: { type: Number, default: null },
  maxTransactionsPerWindow: { type: Number, default: null },
  avgAmountPerWindow: { type: Number, default: null },
  p95AmountPerWindow: { type: Number, default: null },
  cashInCount: { type: Number, min: 0, default: 0 },
  cashOutCount: { type: Number, min: 0, default: 0 },
  cashInOutRatio: { type: Number, default: null },
  totalCashInAmount: { type: Number, min: 0, default: 0 },
  totalCashOutAmount: { type: Number, min: 0, default: 0 },
  dominantTransactionType: { type: String, default: null, trim: true, maxlength: 80 },
  nearIdenticalAmountRate: { type: Number, min: 0, max: 1, default: null },
  repeatedNearIdenticalRate: { type: Number, min: 0, max: 1, default: null },
  p95RepeatedRatePerWindow: { type: Number, min: 0, max: 1, default: null },
  baselineConfidence: { type: String, required: true, enum: ["LOW", "MEDIUM", "HIGH"], default: "LOW" },
  importIds: { type: [String], default: [] },
  calculatedAt: { type: Date, required: true, default: Date.now },
}, { timestamps: true, minimize: false, strict: false, versionKey: false });

baselineSchema.index({ scopeKey: 1 }, { unique: true });
baselineSchema.index({ provider: 1, account: 1, transactionType: 1, scopeType: 1 });

module.exports = mongoose.models.Baseline || mongoose.model("Baseline", baselineSchema);
