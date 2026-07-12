const mongoose = require("mongoose");

const baselineTransactionSchema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ["bkash", "nagad", "rocket"], lowercase: true, trim: true },
  type: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  amount: { type: Number, required: true, min: 0 },
  account: { type: String, required: true, trim: true, maxlength: 128 },
  minute: { type: Number, required: true, min: 0 },
  dataRole: { type: String, required: true, enum: ["baseline"], default: "baseline" },
  importId: { type: String, required: true, trim: true },
  rowNumber: { type: Number, min: 2 },
  source: { type: String, trim: true, default: "baseline-csv" },
  groundTruthLabel: { type: Boolean, default: null },
}, { timestamps: true, versionKey: false });

baselineTransactionSchema.index({ dataRole: 1, provider: 1, minute: 1 });
baselineTransactionSchema.index({ dataRole: 1, provider: 1, account: 1, type: 1, minute: 1 });
baselineTransactionSchema.index({ importId: 1, rowNumber: 1 }, { unique: true });

module.exports = mongoose.models.BaselineTransaction || mongoose.model("BaselineTransaction", baselineTransactionSchema);
