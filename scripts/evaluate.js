#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_SEED,
  runEvaluation,
  formatEvaluationSummary,
} = require("../services/evaluationService");

const DEFAULT_REPORT_PATH = path.join(__dirname, "..", "public", "data", "evaluation-report.json");

function usage() {
  return [
    "Usage: node scripts/evaluate.js [options]",
    "",
    "Options:",
    `  --seed <integer>   Deterministic seed (default: ${DEFAULT_SEED})`,
    "  --json             Print JSON only",
    "  --write [path]     Write JSON (default: public/data/evaluation-report.json)",
    "  --help             Show this message",
  ].join("\n");
}

function parseArguments(argv) {
  const options = { seed: DEFAULT_SEED, jsonOnly: false, writePath: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--json") options.jsonOnly = true;
    else if (argument === "--seed") {
      const value = argv[index + 1];
      if (value === undefined || !Number.isFinite(Number(value))) throw new Error("--seed requires a numeric value");
      options.seed = Number(value);
      index += 1;
    } else if (argument === "--write") {
      const candidate = argv[index + 1];
      if (candidate && !candidate.startsWith("--")) {
        options.writePath = path.resolve(candidate);
        index += 1;
      } else options.writePath = DEFAULT_REPORT_PATH;
    } else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return null;
  }

  const report = runEvaluation({ seed: options.seed });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.writePath) {
    fs.mkdirSync(path.dirname(options.writePath), { recursive: true });
    fs.writeFileSync(options.writePath, json, "utf8");
  }

  if (options.jsonOnly) process.stdout.write(json);
  else {
    process.stdout.write(`${formatEvaluationSummary(report)}\n\nJSON report\n${json}`);
    if (options.writePath) process.stdout.write(`Written to ${options.writePath}\n`);
  }
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Evaluation failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { DEFAULT_REPORT_PATH, parseArguments, main, usage };
