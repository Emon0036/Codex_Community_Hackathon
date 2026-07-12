const mongoose = require("mongoose");

const currentTransactionSchema = new mongoose.Schema({
  transactionId: { type: String, required: true, trim: true, unique: true },
  provider: { type: String, required: true, enum: ["bkash", "nagad", "rocket"], lowercase: true, trim: true },
  type: { type: String, required: true, lowercase: true, trim: true, maxlength: 80 },
  amount: { type: Number, required: true, min: 0 },
  account: { type: String, required: true, trim: true, maxlength: 128 },
  minute: { type: Number, required: true, min: 0 },
  dataRole: { type: String, required: true, enum: ["current"], default: "current" },
  importId: { type: String, required: true, trim: true },
  importedAt: { type: Date, required: true, default: Date.now },
  source: { type: String, trim: true, default: "csv-import" },
  csvHeaders: { type: [String], default: [] },
  csvRow: { type: mongoose.Schema.Types.Mixed, default: null },
}, { timestamps: true, versionKey: false });

currentTransactionSchema.index({ importId: 1, minute: 1 });
currentTransactionSchema.index({ provider: 1, minute: 1 });
currentTransactionSchema.index({ dataRole: 1, source: 1, importedAt: -1 });

module.exports = mongoose.models.CurrentTransaction || mongoose.model("CurrentTransaction", currentTransactionSchema);
