const analyticsService = require("./analyticsService");
const authService = require("./authService");
const defaultState = require("../data/demoData");

const HORIZON_HOURS = 6;
const SEVERITY_RANK = Object.freeze({ healthy: 0, watch: 1, high: 2, critical: 3 });
const LOCAL_EVENTS = Object.freeze({
  none: { label: "No local event", description: "No local event pressure" },
  market_day: { label: "Market day", description: "Market-day cash movement pressure" },
  festival_payout: { label: "Festival payout", description: "Festival payout and shopping pressure" },
  weather_disruption: { label: "Weather disruption", description: "Weather-disrupted access pressure" },
});
const AGENT_AVAILABILITY = Object.freeze({
  normal: { label: "Normal staffing", serviceCapacityPercent: 100, supportRequired: false },
  limited: { label: "Limited agent coverage", serviceCapacityPercent: 72, supportRequired: true },
  unavailable: { label: "Agent unavailable", serviceCapacityPercent: 38, supportRequired: true },
});
const FEED_RULES = Object.freeze({
  healthy: {
    confidenceCap: 1,
    requiresReview: false,
    fallbackBehavior: "Use the current provider balance and the standard forecast.",
  },
  delayed: {
    confidenceCap: 0.46,
    requiresReview: true,
    fallbackBehavior: "Use the last known balance with capped confidence; verify freshness before acting.",
  },
  conflicting: {
    confidenceCap: 0.5,
    requiresReview: true,
    fallbackBehavior: "Retain the primary balance with capped confidence; a human must reconcile the sources.",
  },
  missing: {
    confidenceCap: 0.42,
    requiresReview: true,
    fallbackBehavior: "Use the last known balance with low confidence and do not take automatic action.",
  },
});

const round = (value, precision = 2) => Number(Number(value || 0).toFixed(precision));
const last = (values = []) => values.length ? Number(values[values.length - 1]) : 0;
const normalizedShortageHour = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
  ? Number(value)
  : null;

function normalizeMultiplier(value) {
  const parsed = Number(value) || 1;
  return Math.min(3, Math.max(0.5, parsed));
}

function normalizeProviderDemandMultiplier(value) {
  const parsed = Number(value) || 1;
  return Math.min(3, Math.max(1, parsed));
}

function normalizeProviderDemandProvider(value, snapshot) {
  const candidate = String(value || "all");
  if (candidate === "all") return "all";
  return (snapshot.providers || []).some((provider) => provider.id === candidate) ? candidate : "all";
}

function normalizeLocalEvent(value) {
  const candidate = String(value || "none");
  return LOCAL_EVENTS[candidate] ? candidate : "none";
}

function normalizeAgentAvailability(value) {
  const candidate = String(value || "normal");
  return AGENT_AVAILABILITY[candidate] ? candidate : "normal";
}

function buildScenarioInput(input, snapshot) {
  const demandMultiplier = normalizeMultiplier(input.demandMultiplier);
  const providerDemandProvider = normalizeProviderDemandProvider(input.providerDemandProvider, snapshot);
  const providerDemandMultiplier = normalizeProviderDemandMultiplier(input.providerDemandMultiplier);
  const localEvent = normalizeLocalEvent(input.localEvent);
  const agentAvailability = normalizeAgentAvailability(input.agentAvailability);
  return {
    demandMultiplier,
    missingProvider: input.missingProvider,
    providerDemandProvider,
    providerDemandMultiplier,
    localEvent,
    agentAvailability,
  };
}

function normalizeFeedState(feedStatus, isMissing = false) {
  if (isMissing) return "missing";
  if (feedStatus === "late" || feedStatus === "delayed") return "delayed";
  if (feedStatus === "conflicting") return "conflicting";
  return "healthy";
}

function deriveLiquiditySeverity(result) {
  const shortageHour = normalizedShortageHour(result.shortageHour);
  if (shortageHour !== null && shortageHour <= 2) return "critical";
  if (shortageHour !== null && shortageHour <= 4) return "high";
  if (shortageHour !== null && shortageHour <= HORIZON_HOURS) return "watch";

  const initialBalance = Math.max(0, Number(result.balance) || 0);
  const closingBalance = Math.max(0, last(result.projection));
  if (closingBalance <= initialBalance * 0.15) return "watch";
  return "healthy";
}

function applyFeedReview(liquiditySeverity, feedState) {
  if (!FEED_RULES[feedState]?.requiresReview) return liquiditySeverity;
  return SEVERITY_RANK[liquiditySeverity] < SEVERITY_RANK.watch ? "watch" : liquiditySeverity;
}

function runwayLabel(shortageHour) {
  const normalized = normalizedShortageHour(shortageHour);
  return normalized !== null
    ? `Shortage in ${normalized}h`
    : `Beyond ${HORIZON_HOURS}h`;
}

function buildOutcome(result, feedState) {
  const rule = FEED_RULES[feedState] || FEED_RULES.healthy;
  const rawConfidence = Number(result.confidence) || 0;
  const confidence = round(Math.min(rawConfidence, rule.confidenceCap));
  const liquiditySeverity = deriveLiquiditySeverity(result);
  const shortageHour = normalizedShortageHour(result.shortageHour);
  const projection = (result.projection || []).map(Number);
  const rawProjection = (result.rawProjection || result.projection || []).map(Number);
  const unservedDemand = Math.max(0, Number(result.unservedDemand) || 0);
  const serviceCapacityPercent = Number.isFinite(Number(result.serviceCapacityPercent)) ? Number(result.serviceCapacityPercent) : 100;
  const availabilityState = normalizeAgentAvailability(result.agentAvailability);
  const availabilityRule = AGENT_AVAILABILITY[availabilityState];
  const operationalReview = unservedDemand > 0 || availabilityRule.supportRequired;
  let severity = applyFeedReview(liquiditySeverity, feedState);
  if (operationalReview && SEVERITY_RANK[severity] < SEVERITY_RANK.watch) severity = "watch";
  if (availabilityState === "unavailable" && SEVERITY_RANK[severity] < SEVERITY_RANK.high) severity = "high";
  const operationalFallback = operationalReview
    ? `${availabilityRule.label}; coordinate confirmed support before assuming demand can be served.`
    : null;

  return {
    closingBalance: Math.max(0, last(projection)),
    rawClosingBalance: last(rawProjection),
    shortageHour,
    runwayLabel: runwayLabel(shortageHour),
    heuristicConfidence: confidence,
    confidencePercent: Math.round(confidence * 100),
    liquiditySeverity,
    severity,
    feedState,
    requiresReview: rule.requiresReview || operationalReview,
    confidenceCap: rule.confidenceCap,
    fallbackBehavior: result.fallback || operationalFallback || rule.fallbackBehavior,
    serviceCapacityPercent,
    unservedDemand,
    availabilityState,
    localEvent: normalizeLocalEvent(result.localEvent),
    projection,
    rawProjection,
  };
}

function percentChange(baseline, scenario) {
  if (baseline === 0) return scenario === 0 ? 0 : null;
  return round(((scenario - baseline) / Math.abs(baseline)) * 100, 1);
}

function compareDirection(baseline, scenario) {
  const severityDifference = SEVERITY_RANK[scenario.severity] - SEVERITY_RANK[baseline.severity];
  if (severityDifference > 0) return "worsened";
  if (severityDifference < 0) return "improved";
  if (scenario.shortageHour !== baseline.shortageHour) {
    const baselineRunway = baseline.shortageHour || HORIZON_HOURS + 1;
    const scenarioRunway = scenario.shortageHour || HORIZON_HOURS + 1;
    if (scenarioRunway < baselineRunway) return "worsened";
    if (scenarioRunway > baselineRunway) return "improved";
  }
  if (scenario.closingBalance < baseline.closingBalance) return "worsened";
  if (scenario.closingBalance > baseline.closingBalance) return "improved";
  return "unchanged";
}

function buildChanges(baseline, scenario) {
  const baselineRunway = baseline.shortageHour || HORIZON_HOURS + 1;
  const scenarioRunway = scenario.shortageHour || HORIZON_HOURS + 1;
  return {
    closingBalance: scenario.closingBalance - baseline.closingBalance,
    closingBalancePercent: percentChange(baseline.closingBalance, scenario.closingBalance),
    rawClosingBalance: scenario.rawClosingBalance - baseline.rawClosingBalance,
    shortageHour: baseline.shortageHour !== null && scenario.shortageHour !== null
      ? scenario.shortageHour - baseline.shortageHour
      : null,
    runwayHours: scenarioRunway - baselineRunway,
    confidence: round(scenario.heuristicConfidence - baseline.heuristicConfidence),
    confidencePercentagePoints: Math.round((scenario.heuristicConfidence - baseline.heuristicConfidence) * 100),
    serviceCapacityPercentagePoints: Math.round((scenario.serviceCapacityPercent || 100) - (baseline.serviceCapacityPercent || 100)),
    unservedDemand: Math.round((scenario.unservedDemand || 0) - (baseline.unservedDemand || 0)),
    severityChanged: baseline.severity !== scenario.severity,
    direction: compareDirection(baseline, scenario),
  };
}

function buildChartData(rows, multiplier) {
  return {
    labels: rows.map((row) => row.name),
    datasets: [
      {
        label: "Baseline closing balance",
        data: rows.map((row) => row.baseline.closingBalance),
        comparison: "baseline",
        backgroundColor: "#9CD9DE",
      },
      {
        label: `Scenario closing balance (${multiplier}x demand)`,
        data: rows.map((row) => row.scenario.closingBalance),
        comparison: "scenario",
        backgroundColor: "#5B93B0",
      },
    ],
  };
}

function buildProjectionChartData(rows) {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    labels: ["Now", "+1h", "+2h", "+3h", "+4h", "+5h", "+6h"],
    datasets: [
      {
        label: "Baseline",
        data: [row.initialBalance, ...row.baseline.projection],
        comparison: "baseline",
        borderColor: "#9CD9DE",
      },
      {
        label: "Scenario",
        data: [row.initialBalance, ...row.scenario.projection],
        comparison: "scenario",
        borderColor: "#5B93B0",
      },
    ],
  }));
}

function findProvider(snapshot, id) {
  return (snapshot.providers || []).find((provider) => provider.id === id) || null;
}

function buildResponsibleStakeholder(rowId, rowName, snapshot) {
  const openCase = (snapshot.cases || []).find((item) => item.provider === rowId && item.status !== "resolved" && item.owner);
  const managementOwner = authService.users.find((user) => user.role === "management");
  const riskOwner = authService.users.find((user) => user.role === "risk");
  const operationsOwner = authService.users.find((user) => user.role === "operations" && (!user.provider || user.provider === rowId));

  if (rowId === "shared") {
    return {
      receiver: "Shared Cash Coordination",
      accountableOwner: openCase?.owner || managementOwner?.name || "Management duty owner",
      ownerSource: openCase ? "Open case owner" : "Default coordination owner",
      escalationPath: `${managementOwner?.demoLabel || "Management"} -> ${riskOwner?.demoLabel || "Risk reviewer"}`,
      decisionBoundary: "Coordinate authorized cash support only; provider e-money ledgers stay separate.",
    };
  }

  const provider = findProvider(snapshot, rowId);
  const providerLabel = provider?.name || rowName || rowId;
  return {
    receiver: `${providerLabel} Sylhet Operations`,
    accountableOwner: openCase?.owner || operationsOwner?.name || `${providerLabel} operations duty owner`,
    ownerSource: openCase ? "Open case owner" : operationsOwner ? "Demo operations owner" : "Provider operations desk",
    escalationPath: `${providerLabel} Operations -> Risk reviewer -> Management`,
    decisionBoundary: `${providerLabel} support remains provider-specific; no cross-provider conversion is implied.`,
  };
}

function distanceKm(from, to) {
  if (!Array.isArray(from) || !Array.isArray(to) || from.length < 2 || to.length < 2) return null;
  const [lat1, lon1] = from.map(Number);
  const [lat2, lon2] = to.map(Number);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return null;
  const radians = (degree) => degree * Math.PI / 180;
  const earthRadiusKm = 6371;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return round(earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)), 1);
}

function pressureRank(pressure) {
  return { healthy: 0, watch: 1, high: 2 }[pressure] ?? 3;
}

function supportValueFor(rowId, outlet) {
  if (rowId === "shared") return Number(outlet.sharedCash) || 0;
  return Number(outlet.providerBalances?.[rowId]) || 0;
}

function buildNearbySupportOptions(rows, snapshot) {
  const outlets = snapshot.networkOutlets || [];
  const origin = outlets.find((outlet) => outlet.id === snapshot.outlet?.id) || outlets[0];
  if (!origin) return [];
  const candidateRows = rows.filter((row) => (
    row.id === "shared"
    || row.changes.direction === "worsened"
    || row.scenario.requiresReview
    || row.scenario.shortageHour !== null
  ));
  const options = [];
  candidateRows.forEach((row) => {
    outlets.filter((outlet) => outlet.id !== origin.id).forEach((outlet) => {
      const supportValue = supportValueFor(row.id, outlet);
      if (supportValue <= 0) return;
      const distance = distanceKm(origin.coordinates, outlet.coordinates);
      const sameArea = outlet.area === origin.area;
      const pressure = outlet.pressure || "unknown";
      options.push({
        rowId: row.id,
        rowName: row.name,
        outletId: outlet.id,
        outletName: outlet.name,
        area: outlet.area,
        pressure,
        readiness: pressure === "healthy" ? "ready" : pressure === "watch" ? "review" : "strained",
        distanceKm: distance,
        sameArea,
        supportType: row.id === "shared" ? "cash-staging" : "provider-ledger",
        supportValue,
        reason: `${sameArea ? "Same area" : outlet.area}; visible ${row.id === "shared" ? "cash" : row.name} reserve ${supportValue.toLocaleString()}.`,
        boundary: row.id === "shared"
          ? "Cash support must be authorized and documented."
          : `${row.name} support only; no balance conversion across providers.`,
        sortKey: [
          pressureRank(pressure),
          sameArea ? 0 : 1,
          distance === null ? 99 : distance,
          -supportValue / 1000000,
        ],
      });
    });
  });
  return options
    .sort((left, right) => {
      for (let index = 0; index < left.sortKey.length; index += 1) {
        if (left.sortKey[index] !== right.sortKey[index]) return left.sortKey[index] - right.sortKey[index];
      }
      return left.outletName.localeCompare(right.outletName);
    })
    .slice(0, 6)
    .map(({ sortKey, ...option }) => option);
}

function plural(count, singular, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function buildCoordination(rows, inputSummary, snapshot) {
  const supportOptions = buildNearbySupportOptions(rows, snapshot);
  const reviewRows = rows.filter((row) => row.scenario.requiresReview || row.changes.direction === "worsened");
  const scenarioChecks = [
    `${inputSummary.providerDemandName} demand focus at ${inputSummary.providerDemandMultiplier}x.`,
    inputSummary.localEvent === "none" ? "No local event pressure selected." : `${inputSummary.localEventLabel} included.`,
    `${inputSummary.agentAvailabilityLabel}; service capacity ${inputSummary.serviceCapacityPercent}%.`,
    inputSummary.missingProviderName ? `${inputSummary.missingProviderName} feed unavailable; confidence is capped.` : "All configured feeds retained.",
  ];
  return {
    supportNeeded: reviewRows.length > 0,
    reviewLedgerCount: reviewRows.length,
    supportOptions,
    scenarioChecks,
    flashMessage: `Scenario complete: ${plural(reviewRows.length, "ledger")} need review; ${supportOptions.length ? plural(supportOptions.length, "nearby support option") : "no nearby support option"} discovered. No state was changed.`,
  };
}

function compareScenarios(input = {}, candidateState) {
  const scenarioInput = input && typeof input === "object" ? { ...input } : {};
  const snapshot = candidateState || defaultState;
  const baselineResults = analyticsService.simulate({ demandMultiplier: 1 }, candidateState);
  const normalizedInput = buildScenarioInput(scenarioInput, snapshot);
  const scenarioResults = analyticsService.simulate(normalizedInput, candidateState);
  const scenarioById = new Map(scenarioResults.map((result) => [result.id, result]));
  const providerById = new Map((snapshot.providers || []).map((provider) => [provider.id, provider]));
  const validIds = new Set(baselineResults.map((result) => result.id));
  const missingProvider = validIds.has(String(normalizedInput.missingProvider || ""))
    && normalizedInput.missingProvider !== "shared"
    ? String(normalizedInput.missingProvider)
    : null;
  const multiplier = normalizedInput.demandMultiplier;

  const rows = baselineResults.map((baselineResult) => {
    const scenarioResult = scenarioById.get(baselineResult.id) || baselineResult;
    const provider = providerById.get(baselineResult.id);
    const baselineFeedState = baselineResult.id === "shared"
      ? "healthy"
      : normalizeFeedState(provider?.feedStatus);
    const scenarioFeedState = baselineResult.id === missingProvider
      ? "missing"
      : baselineFeedState;
    const baseline = buildOutcome(baselineResult, baselineFeedState);
    const scenario = buildOutcome(scenarioResult, scenarioFeedState);

    return {
      id: baselineResult.id,
      name: baselineResult.name,
      initialBalance: Number(baselineResult.balance) || 0,
      baseline,
      scenario,
      changes: buildChanges(baseline, scenario),
      stakeholder: buildResponsibleStakeholder(baselineResult.id, baselineResult.name, snapshot),
    };
  });

  const missingProviderName = missingProvider
    ? rows.find((row) => row.id === missingProvider)?.name || missingProvider
    : null;
  const providerDemandProvider = normalizedInput.providerDemandProvider;
  const providerDemandName = providerDemandProvider === "all"
    ? "All providers"
    : providerById.get(providerDemandProvider)?.name || providerDemandProvider;
  const localEventMeta = LOCAL_EVENTS[normalizedInput.localEvent] || LOCAL_EVENTS.none;
  const availabilityMeta = AGENT_AVAILABILITY[normalizedInput.agentAvailability] || AGENT_AVAILABILITY.normal;
  const inputSummary = {
    demandMultiplier: multiplier,
    demandChangePercent: round((multiplier - 1) * 100, 1),
    missingProvider,
    missingProviderName,
    providerDemandProvider,
    providerDemandName,
    providerDemandMultiplier: normalizedInput.providerDemandMultiplier,
    providerDemandChangePercent: round((normalizedInput.providerDemandMultiplier - 1) * 100, 1),
    localEvent: normalizedInput.localEvent,
    localEventLabel: localEventMeta.label,
    localEventDescription: localEventMeta.description,
    agentAvailability: normalizedInput.agentAvailability,
    agentAvailabilityLabel: availabilityMeta.label,
    serviceCapacityPercent: availabilityMeta.serviceCapacityPercent,
    horizonHours: HORIZON_HOURS,
    description: `${multiplier}x base demand; ${providerDemandName} focus at ${normalizedInput.providerDemandMultiplier}x; ${localEventMeta.label}; ${availabilityMeta.label}${missingProviderName ? `; ${missingProviderName} feed unavailable` : "; all configured feeds retained"}.`,
  };
  const coordination = buildCoordination(rows, inputSummary, snapshot);

  return {
    inputSummary,
    rows,
    chartData: buildChartData(rows, multiplier),
    projectionChartData: buildProjectionChartData(rows),
    coordination,
  };
}

module.exports = {
  compareScenarios,
  compareScenario: compareScenarios,
  deriveLiquiditySeverity,
  normalizeFeedState,
  FEED_RULES,
};
