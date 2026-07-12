const mongoose = require("mongoose");

const datasetImportSchema = new mongoose.Schema({
  importId: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true, maxlength: 255 },
  fileName: { type: String, trim: true, maxlength: 255 },
  fingerprint: { type: String, required: true, trim: true, lowercase: true },
  totalRows: { type: Number, required: true, min: 0, default: 0 },
  validRows: { type: Number, required: true, min: 0, default: 0 },
  invalidRows: { type: Number, required: true, min: 0, default: 0 },
  validationErrors: { type: [mongoose.Schema.Types.Mixed], default: [] },
  errorSummary: { type: [mongoose.Schema.Types.Mixed], default: [] },
  providers: { type: [String], default: [] },
  providerStats: { type: [mongoose.Schema.Types.Mixed], default: [] },
  accountCount: { type: Number, min: 0, default: 0 },
  accountsDetected: { type: Number, min: 0, default: 0 },
  status: { type: String, required: true, trim: true, default: "imported" },
  baselineStatus: { type: String, required: true, trim: true, default: "pending" },
  importedBy: { type: String, trim: true, maxlength: 128 },
  importedAt: { type: Date, required: true, default: Date.now },
  baselineCalculatedAt: { type: Date, default: null },
  calculatedAt: { type: Date, default: null },
  importDurationMs: { type: Number, min: 0, default: null },
  baselineDurationMs: { type: Number, min: 0, default: null },
  importProcessingDurationMs: { type: Number, min: 0, default: null },
  baselineCalculationDurationMs: { type: Number, min: 0, default: null },
  validation: { type: mongoose.Schema.Types.Mixed, default: null },
  failureReason: { type: String, trim: true, maxlength: 500, default: null },
}, { timestamps: true, minimize: false, versionKey: false });

datasetImportSchema.index({ importId: 1 }, { unique: true });
datasetImportSchema.index({ fingerprint: 1 }, { unique: true });
datasetImportSchema.index({ importedAt: -1 });

module.exports = mongoose.models.DatasetImport || mongoose.model("DatasetImport", datasetImportSchema);
