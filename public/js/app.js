(() => {
  "use strict";
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || "";
  const money = (value) => `৳${Number(value || 0).toLocaleString()}`;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const dataNode = document.getElementById("dashboard-data");
  if (dataNode && window.Chart) {
    const data = JSON.parse(dataNode.textContent);
    const styles = getComputedStyle(document.documentElement);
    const chartText = styles.getPropertyValue("--muted").trim() || "#9ab8c4";
    const chartGrid = styles.getPropertyValue("--chart-grid").trim() || "rgba(47,112,139,.12)";
    const tooltipBackground = styles.getPropertyValue("--chart-tooltip").trim() || "#173b49";
    const tooltipText = styles.getPropertyValue("--chart-tooltip-text").trim() || "#f5ffff";
    const formatCompact = (value) => `৳${Math.round(Number(value) / 1000)}k`;
    Chart.defaults.font.family = '"Segoe UI", "Nirmala UI", Arial, sans-serif';
    Chart.defaults.color = chartText;
    const sharedOptions = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      animation: { duration: 550 },
      plugins: {
        legend: { position: "bottom", align: "start", labels: { color: chartText, usePointStyle: true, pointStyleWidth: 9, boxWidth: 8, boxHeight: 8, padding: 18 } },
        tooltip: { backgroundColor: tooltipBackground, borderColor: "rgba(91,147,176,.35)", borderWidth: 1, titleColor: tooltipText, bodyColor: tooltipText, padding: 12, displayColors: true, callbacks: { label: (context) => ` ${context.dataset.label}: ${money(context.parsed.y)}` } },
      },
      scales: {
        x: { ticks: { color: chartText, padding: 8 }, grid: { display: false }, border: { color: chartGrid } },
        y: { ticks: { color: chartText, padding: 8, callback: formatCompact }, grid: { color: chartGrid, drawTicks: false }, border: { display: false }, beginAtZero: true },
      },
    };
    const pointStyles = ["circle", "rectRounded", "triangle"];
    new Chart(document.getElementById("providerRunwayChart"), {
      type: "line",
      data: { labels: data.labels, datasets: data.providers.map((provider, index) => ({ label: provider.name, data: provider.values, borderColor: provider.color, backgroundColor: provider.color, fill: false, tension: 0.28, pointRadius: 3, pointHoverRadius: 6, pointStyle: pointStyles[index % pointStyles.length], borderWidth: 2.5 })) },
      options: sharedOptions,
    });
    new Chart(document.getElementById("cashRunwayChart"), {
      type: "line",
      data: { labels: data.labels, datasets: [{ label: data.cash.name, data: data.cash.values, borderColor: data.cash.color, backgroundColor: "rgba(156,217,222,.16)", fill: true, tension: 0.26, pointRadius: 2.5, pointHoverRadius: 5, borderWidth: 2.5 }] },
      options: { ...sharedOptions, plugins: { ...sharedOptions.plugins, legend: { display: false } }, scales: { ...sharedOptions.scales, x: { ...sharedOptions.scales.x, ticks: { ...sharedOptions.scales.x.ticks, maxRotation: 0, autoSkip: true, maxTicksLimit: 4 } }, y: { ...sharedOptions.scales.y, ticks: { ...sharedOptions.scales.y.ticks, maxTicksLimit: 4 } } } },
    });
  }

  document.querySelectorAll(".filter").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll(".filter").forEach((item) => { item.classList.remove("active"); item.setAttribute("aria-pressed", "false"); });
    button.classList.add("active"); button.setAttribute("aria-pressed", "true");
    document.querySelectorAll(".alert-detail").forEach((card) => { card.hidden = button.dataset.filter !== "all" && card.dataset.provider !== button.dataset.filter; });
  }));

  const simulationForm = document.getElementById("simulationForm");
  const demandRange = document.getElementById("demandMultiplier");
  const demandValue = document.getElementById("demandValue");
  const providerDemandRange = document.getElementById("providerDemandMultiplier");
  const providerDemandValue = document.getElementById("providerDemandValue");
  const scenarioFlash = document.getElementById("scenarioFlash");
  const scenarioSummary = document.getElementById("scenarioSummary");
  const scenarioBody = document.getElementById("scenarioComparisonBody");
  const scenarioCoordination = document.getElementById("scenarioCoordination");
  const scenarioDescription = document.getElementById("scenarioDescription");
  const scenarioCanvas = document.getElementById("scenarioComparisonChart");
  let scenarioChart;
  const signed = (value, suffix = "") => {
    const number = Number(value) || 0;
    if (number === 0) return `0${suffix}`;
    return `${number > 0 ? "+" : ""}${number.toLocaleString()}${suffix}`;
  };
  const tableMessage = (className, text) => {
    const tr = document.createElement("tr");
    const td = element("td", className, text);
    td.colSpan = 4;
    tr.append(td);
    return tr;
  };
  const showScenarioFlash = (message, type = "success") => {
    if (!scenarioFlash) return;
    scenarioFlash.hidden = false;
    scenarioFlash.className = `scenario-flash ${type}`;
    const icon = type === "error" ? "fa-circle-exclamation" : "fa-circle-check";
    scenarioFlash.replaceChildren(element("i", `fa-solid ${icon}`), element("span", "", message));
  };
  const supportValueLabel = (option) => `${option.supportType === "cash-staging" ? "Cash" : option.rowName} ${money(option.supportValue)}`;
  const distanceLabel = (value) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)} km` : "Distance n/a";
  const renderOutcome = (outcome) => {
    const wrapper = element("div", "scenario-outcome");
    wrapper.append(
      element("b", "", money(outcome.closingBalance)),
      element("small", "", `${outcome.runwayLabel} · ${outcome.severity} · ${outcome.confidencePercent}% confidence`),
    );
    if (outcome.serviceCapacityPercent < 100 || outcome.unservedDemand > 0) {
      wrapper.append(element("small", "scenario-review-note", `${outcome.serviceCapacityPercent}% service capacity; ${money(outcome.unservedDemand)} demand may need support`));
    }
    if (outcome.requiresReview) wrapper.append(element("small", "scenario-review-note", outcome.fallbackBehavior));
    return wrapper;
  };
  const renderScenarioSummary = (comparison) => {
    const rows = comparison.rows || [];
    const worsened = rows.filter((row) => row.changes.direction === "worsened").length;
    const review = rows.filter((row) => row.scenario.requiresReview).length;
    const shortages = rows.map((row) => row.scenario.shortageHour).filter((hour) => Number.isFinite(Number(hour))).map(Number);
    const earliest = shortages.length ? `${Math.min(...shortages)}h` : "Beyond horizon";
    const cards = [
      ["Demand change", signed(comparison.inputSummary.demandChangePercent, "%"), comparison.inputSummary.missingProviderName ? `${comparison.inputSummary.missingProviderName} feed missing` : "All feeds retained", "fa-arrow-trend-up"],
      ["Provider focus", `${Number(comparison.inputSummary.providerDemandMultiplier || 1).toFixed(1)}x`, `${comparison.inputSummary.providerDemandName}; ${comparison.inputSummary.localEventLabel}`, "fa-building-columns"],
      ["Service capacity", `${comparison.inputSummary.serviceCapacityPercent || 100}%`, comparison.inputSummary.agentAvailabilityLabel || "Normal staffing", "fa-user-clock"],
      ["Ledgers worsened", `${worsened} / ${rows.length}`, worsened ? "Shorter runway or higher severity" : "No worsening detected", "fa-scale-balanced"],
      ["Earliest shortage", earliest, `${review} human-reviewable scenario${review === 1 ? "" : "s"}`, "fa-hourglass-half"],
    ];
    scenarioSummary.replaceChildren(...cards.map(([label, value, caption, icon]) => {
      const card = element("div", "scenario-stat-card");
      card.append(element("i", `fa-solid ${icon} scenario-stat-icon`), element("span", "eyebrow", label), element("strong", "scenario-stat-value", value), element("small", "scenario-stat-caption", caption));
      return card;
    }));
  };
  const renderScenarioTable = (rows) => {
    scenarioBody.replaceChildren(...rows.map((row) => {
      const tr = document.createElement("tr");
      const ledger = document.createElement("td");
      const ledgerWrap = element("div", "scenario-table-ledger");
      ledgerWrap.append(element("b", "", row.name), element("small", "", `Starting balance ${money(row.initialBalance)}`));
      if (row.stakeholder) ledgerWrap.append(element("small", "scenario-stakeholder-line", `Owner: ${row.stakeholder.accountableOwner}`));
      ledger.append(ledgerWrap);
      const baseline = document.createElement("td"); baseline.append(renderOutcome(row.baseline));
      const scenario = document.createElement("td"); scenario.append(renderOutcome(row.scenario));
      const change = document.createElement("td");
      const changeWrap = element("div", "scenario-change");
      changeWrap.append(
        element("span", `change-pill ${row.changes.direction}`, row.changes.direction),
        element("small", "", `${signed(row.changes.closingBalance)} closing · ${signed(row.changes.runwayHours, "h")} runway · ${signed(row.changes.confidencePercentagePoints, " pts")} confidence`),
      );
      if (row.changes.unservedDemand > 0 || row.changes.serviceCapacityPercentagePoints < 0) {
        changeWrap.append(element("small", "scenario-review-note", `${money(row.changes.unservedDemand)} support demand; ${signed(row.changes.serviceCapacityPercentagePoints, " pts")} capacity`));
      }
      change.append(changeWrap);
      tr.append(ledger, baseline, scenario, change);
      return tr;
    }));
  };
  const renderScenarioCoordination = (comparison) => {
    if (!scenarioCoordination) return;
    const rows = comparison.rows || [];
    const supportOptions = comparison.coordination?.supportOptions || [];
    const checks = comparison.coordination?.scenarioChecks || [];

    const stakeholderPanel = element("div", "scenario-coordination-card");
    stakeholderPanel.append(element("span", "eyebrow", "Responsible stakeholder"), element("h3", "", "Owner path"));
    const stakeholderList = element("div", "scenario-card-list");
    rows.forEach((row) => {
      const stakeholder = row.stakeholder || {};
      const card = element("div", "scenario-owner-card");
      card.append(
        element("strong", "", row.name),
        element("span", "", stakeholder.receiver || "Receiver pending"),
        element("small", "", `Accountable: ${stakeholder.accountableOwner || "Awaiting owner"}`),
        element("small", "", stakeholder.decisionBoundary || "Advisory coordination only."),
      );
      stakeholderList.append(card);
    });
    stakeholderPanel.append(stakeholderList);

    const supportPanel = element("div", "scenario-coordination-card");
    supportPanel.append(element("span", "eyebrow", "Nearby support discovery"), element("h3", "", "Candidate outlets"));
    const supportList = element("div", "scenario-card-list");
    if (supportOptions.length) {
      supportOptions.forEach((option) => {
        const card = element("div", "scenario-support-card");
        const top = element("div", "scenario-support-top");
        top.append(element("strong", "", option.outletName), element("span", `status ${option.pressure === "high" ? "danger" : option.pressure}`, option.readiness));
        card.append(
          top,
          element("span", "", `${option.area}; ${distanceLabel(option.distanceKm)}`),
          element("small", "", `${option.rowName}: ${supportValueLabel(option)}`),
          element("small", "scenario-review-note", option.boundary),
        );
        supportList.append(card);
      });
    } else {
      const empty = element("div", "scenario-owner-card");
      empty.append(element("strong", "", "No candidate outlet"), element("small", "", "Escalate to the responsible stakeholder before assuming support is available."));
      supportList.append(empty);
    }
    supportPanel.append(supportList);

    const checkPanel = element("div", "scenario-coordination-card scenario-check-card");
    checkPanel.append(element("span", "eyebrow", "Scenario checks"), element("h3", "", "What changed"));
    const checkList = document.createElement("ul");
    checkList.className = "scenario-check-list";
    checks.forEach((check) => checkList.append(element("li", "", check)));
    checkPanel.append(checkList);

    scenarioCoordination.replaceChildren(stakeholderPanel, supportPanel, checkPanel);
  };
  const renderScenarioChart = (comparison) => {
    if (!scenarioCanvas || !window.Chart) return;
    const styles = getComputedStyle(document.documentElement);
    const chartText = styles.getPropertyValue("--muted").trim() || "#78919a";
    const chartGrid = styles.getPropertyValue("--chart-grid").trim() || "rgba(47,112,139,.12)";
    const data = {
      labels: comparison.chartData.labels,
      datasets: comparison.chartData.datasets.map((dataset) => ({
        ...dataset,
        borderRadius: 5,
        borderSkipped: false,
        maxBarThickness: 42,
      })),
    };
    if (scenarioChart) {
      scenarioChart.data = data;
      scenarioChart.update();
      return;
    }
    scenarioChart = new Chart(scenarioCanvas, {
      type: "bar",
      data,
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", align: "start", labels: { color: chartText, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
          tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: ${money(context.parsed.y)}` } },
        },
        scales: {
          x: { ticks: { color: chartText }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: chartText, callback: (value) => `৳${Math.round(Number(value) / 1000)}k` }, grid: { color: chartGrid }, border: { display: false } },
        },
      },
    });
  };
  const setScenarioLoading = () => {
    document.getElementById("simState").textContent = "Running";
    document.getElementById("simState").className = "status watch";
    scenarioSummary.replaceChildren(element("div", "summary-placeholder"), element("div", "summary-placeholder"), element("div", "summary-placeholder"));
    scenarioBody.replaceChildren(tableMessage("muted", "Evaluating bounded synthetic scenario..."));
    if (scenarioCoordination) scenarioCoordination.replaceChildren(element("div", "summary-placeholder"), element("div", "summary-placeholder"), element("div", "summary-placeholder"));
  };
  const runScenario = async () => {
    if (!simulationForm || !scenarioSummary || !scenarioBody) return;
    setScenarioLoading();
    const submitButton = simulationForm.querySelector('button[type="submit"]');
    if (submitButton) submitButton.disabled = true;
    try {
      const response = await fetch("/api/simulate", { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: JSON.stringify(Object.fromEntries(new FormData(simulationForm))) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Scenario comparison could not be completed");
      const comparison = payload.comparison;
      scenarioDescription.textContent = comparison.inputSummary.description;
      renderScenarioSummary(comparison);
      renderScenarioTable(comparison.rows);
      renderScenarioChart(comparison);
      renderScenarioCoordination(comparison);
      showScenarioFlash(comparison.coordination?.flashMessage || "Scenario comparison complete. No state was changed.");
      document.getElementById("simState").textContent = "Complete";
      document.getElementById("simState").className = "status resolved";
    } catch (error) {
      document.getElementById("simState").textContent = "Safe fallback";
      document.getElementById("simState").className = "status escalated";
      scenarioSummary.replaceChildren(element("p", "text-danger", `${error.message}. No state was changed.`));
      scenarioBody.replaceChildren(tableMessage("text-danger", "Scenario comparison unavailable. No state was changed."));
      if (scenarioCoordination) scenarioCoordination.replaceChildren(element("p", "text-danger", "Coordination discovery unavailable. No state was changed."));
      showScenarioFlash(`${error.message}. No state was changed.`, "error");
    } finally {
      if (submitButton) submitButton.disabled = false;
    }
  };
  if (demandRange && demandValue) demandRange.addEventListener("input", () => { demandValue.value = `${Number(demandRange.value).toFixed(1)}×`; });
  if (simulationForm) {
    simulationForm.addEventListener("submit", (event) => {
      event.preventDefault();
      runScenario();
    });
    runScenario();
  }

  document.querySelectorAll(".ai-explain").forEach((button) => button.addEventListener("click", async () => {
    const output = document.getElementById(`ai-${button.dataset.alertId}`); output.hidden = false; output.replaceChildren(element("p", "muted", "Creating an evidence-grounded bilingual briefing…")); button.disabled = true;
    try {
      const response = await fetch(`/api/alerts/${encodeURIComponent(button.dataset.alertId)}/explain`, { method: "POST", headers: { "Content-Type": "application/json", "x-csrf-token": csrfToken }, body: "{}" });
      const payload = await response.json(); if (!response.ok) throw new Error(payload.error || "Briefing unavailable");
      const result = payload.data; const heading = element("div", "ai-output-head"); heading.append(element("strong", "", result.mode === "ai" ? "OpenAI-assisted briefing" : "Safe deterministic briefing"), element("span", "status healthy", payload.cached ? "cached" : result.mode));
      const english = element("div"); english.append(element("span", "eyebrow", "English"), element("p", "", result.english));
      const bangla = element("div"); bangla.lang = "bn"; bangla.append(element("span", "eyebrow", "বাংলা"), element("p", "", result.bangla));
      const next = element("div"); next.append(element("span", "eyebrow", "Deterministic safe next step"), element("p", "", result.safeNextStep));
      if (result.banglaNextStep) { const banglaNext = element("p", "", result.banglaNextStep); banglaNext.lang = "bn"; next.append(banglaNext); }
      const caveats = element("ul", "ai-caveats"); result.caveats.forEach((caveat) => caveats.append(element("li", "", caveat)));
      output.replaceChildren(heading, english, bangla, next, caveats);
    } catch (error) { output.replaceChildren(element("p", "text-danger", error.message)); }
    finally { button.disabled = false; }
  }));

  const providerSelect = document.getElementById("provider");
  if (providerSelect) {
    const syncProviderFields = () => {
      const option = providerSelect.selectedOptions[0];
      document.getElementById("balance").value = option.dataset.balance || 0;
      document.getElementById("alternateBalance").value = option.dataset.alt || "";
      document.getElementById("feedStatus").value = option.dataset.status || "healthy";
      document.getElementById("updatedMinutesAgo").value = option.dataset.age || 0;
    };
    providerSelect.addEventListener("change", syncProviderFields); syncProviderFields();
  }

  const areaSelect = document.querySelector(".area-select");
  if (areaSelect) areaSelect.addEventListener("change", () => areaSelect.form.submit());
})();
