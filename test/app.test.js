process.env.NODE_ENV = "test";
process.env.OPENAI_API_KEY = "";
process.env.SESSION_SECRET = "test-only-session-secret-at-least-32-chars";
process.env.PSEUDONYMIZATION_SECRET = "test-only-pseudonymization-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const request = require("supertest");
const app = require("../app");
const storeService = require("../services/storeService");
const analytics = require("../services/analyticsService");

const destinations = { agent: "/", operations: "/cases", risk_reviewer: "/alerts", management: "/network" };
const visiblePages = {
  agent: ["/", "/alerts", "/cases", "/methodology"],
  operations: ["/", "/alerts", "/cases", "/network", "/simulation", "/methodology"],
  risk_reviewer: ["/alerts", "/cases", "/methodology"],
  management: ["/", "/network", "/methodology"],
};

function csrfFrom(html) {
  const match = html.match(/name="csrf-token" content="([^"]+)"/);
  assert.ok(match, "CSRF meta token should be rendered");
  return match[1];
}

function navigationPaths(html) {
  return [...html.matchAll(/<a class="nav-link[^"]*" href="([^"]+)"/g)].map((match) => match[1]);
}

async function enterDemo(role) {
  const agent = request.agent(app);
  const page = await agent.get("/demo").expect(200);
  const token = csrfFrom(page.text);
  await agent.post("/demo/role").type("form").send({ _csrf: token, role }).expect(302).expect("location", destinations[role]);
  return agent;
}

test("health is public while operational routes require a selected demo role", async () => {
  await request(app).get("/api/health").expect(200).expect((res) => { assert.equal(res.body.mode, "simulation"); assert.equal(res.body.ai.configured, false); });
  await request(app).get("/").expect(302).expect("location", "/demo");
  await request(app).get("/api/alerts").expect(401).expect((res) => assert.match(res.body.error, /demo role/i));
  await request(app).get("/login").expect(302).expect("location", "/demo");
});

test("demo entry offers role selection without credential fields", async () => {
  const agent = request.agent(app);
  const page = await agent.get("/demo").expect(200);
  assert.match(page.text, /Choose a demo role/);
  for (const role of Object.keys(destinations)) assert.match(page.text, new RegExp(`value="${role}"`));
  assert.doesNotMatch(page.text, /name="(?:email|password|phone|pin|otp|nid)"|type="password"/i);
  assert.doesNotMatch(page.text, /Demo (?:Agent|Operations Team|Risk Reviewer|Management)/);
  assert.match(page.text, /Demo environment · Synthetic data only · No real financial action/);

  const token = csrfFrom(page.text);
  await agent.post("/demo/role").type("form").send({ _csrf: token, role: "administrator" }).expect(400).expect(/available demo roles/);
  await agent.get("/").expect(302).expect("location", "/demo");
});

test("demo entry and role switching are CSRF protected", async () => {
  await request(app).post("/demo/role").type("form").send({ role: "agent" }).expect(403);
  const agent = await enterDemo("agent");
  const overview = await agent.get("/").expect(200).expect(/Active role: Agent/);
  const token = csrfFrom(overview.text);
  await agent.post("/demo/role").type("form").send({ _csrf: token, role: "management" }).expect(302).expect("location", "/network");
  const network = await agent.get("/network").expect(200).expect(/Active role: Management/);
  await agent.post("/demo/exit").type("form").send({ _csrf: csrfFrom(network.text) }).expect(302).expect("location", "/demo");
  await agent.get("/").expect(302).expect("location", "/demo");
});

test("each role receives only its configured stakeholder navigation", async () => {
  for (const [role, paths] of Object.entries(visiblePages)) {
    const agent = await enterDemo(role);
    const page = await agent.get(destinations[role]).expect(200);
    assert.deepEqual(navigationPaths(page.text), paths);
    assert.doesNotMatch(page.text, /Demo (?:Agent|Operations Team|Risk Reviewer|Management)/);
    assert.doesNotMatch(page.text, />Data feeds</);
    assert.match(page.text, /class="btn btn-soft simulation-data-link" href="\/data#baseline-dataset"/);
  }
});

test("direct stakeholder page access redirects to the selected role default", async () => {
  for (const [role, path, destination] of [
    ["agent", "/network", "/"],
    ["agent", "/simulation", "/"],
    ["risk_reviewer", "/", "/alerts"],
    ["risk_reviewer", "/network", "/alerts"],
    ["management", "/alerts", "/network"],
    ["management", "/cases", "/network"],
  ]) {
    const agent = await enterDemo(role);
    await agent.get(path).expect(302).expect("location", destination);
  }

  const management = await enterDemo("management");
  await management.get("/Cases").set("Accept", "application/json").expect(302).expect("location", "/network");
});

test("role switching keeps an allowed page and redirects a disallowed page", async () => {
  const allowedAgent = await enterDemo("operations");
  const alerts = await allowedAgent.get("/alerts").expect(200);
  await allowedAgent.post("/demo/role").type("form").send({ _csrf: csrfFrom(alerts.text), role: "agent", currentPath: "/alerts" }).expect(302).expect("location", "/alerts");

  const redirectedAgent = await enterDemo("operations");
  const network = await redirectedAgent.get("/network").expect(200);
  await redirectedAgent.post("/demo/role").type("form").send({ _csrf: csrfFrom(network.text), role: "risk_reviewer", currentPath: "/network" }).expect(302).expect("location", "/alerts");

  const safeAgent = await enterDemo("agent");
  const overview = await safeAgent.get("/").expect(200);
  await safeAgent.post("/demo/role").type("form").send({ _csrf: csrfFrom(overview.text), role: "management", currentPath: "//example.invalid" }).expect(302).expect("location", "/network");
});

test("CSRF and role rules block agent case changes", async () => {
  const agent = await enterDemo("agent");
  await agent.post("/cases/CASE-2407/status").type("form").send({ status: "escalated" }).expect(403);
  const cases = await agent.get("/cases").expect(200); const token = csrfFrom(cases.text);
  await agent.post("/cases/CASE-2407/status").type("form").send({ _csrf: token, status: "escalated" }).expect(403);
});

test("operations demo role remains provider scoped", async () => {
  const agent = await enterDemo("operations");
  await agent.get("/api/dashboard").expect(200).expect((res) => {
    assert.deepEqual(res.body.providers.map((provider) => provider.id), ["nagad"]);
    assert.ok(res.body.alerts.every((alert) => alert.provider === "nagad"));
    assert.equal(res.body.summary.totalEmoney, res.body.providers[0].balance);
  });
});

test("overview renders a complete operational shell without stale placeholders", async () => {
  const agent = await enterDemo("agent");
  await agent.get("/").expect(200)
    .expect(/id="providerRunwayChart"/)
    .expect(/id="cashRunwayChart"/)
    .expect(/id="dashboard-data"/)
    .expect(/Signals needing attention/)
    .expect((res) => {
      assert.doesNotMatch(res.text, /Hour null|undefined|NaN/);
      assert.match(res.text, /dashboard-signal-grid|dashboard-empty-state/);
      const dataMatch = res.text.match(/<script id="dashboard-data" type="application\/json" nonce="[^"]+">([^<]+)<\/script>/);
      assert.ok(dataMatch, "dashboard chart data should be embedded as JSON");
      const data = JSON.parse(dataMatch[1]);
      assert.deepEqual(data.labels, ["Now", "+1h", "+2h", "+3h", "+4h", "+5h", "+6h"]);
      assert.ok(data.cash.values.length === 7);
      assert.ok(data.providers.length >= 1);
      assert.ok(data.providers.every((provider) => provider.values.length === 7));
    });
});

test("scenario lab renders the comparison shell and returns scoped comparisons", async () => {
  const agent = await enterDemo("operations");
  const page = await agent.get("/simulation").expect(200)
    .expect(/Scenario Lab/)
    .expect(/id="scenarioSummary"/)
    .expect(/id="scenarioComparisonChart"/)
    .expect(/id="scenarioComparisonBody"/)
    .expect(/href="\/methodology#decision-flow"/)
    .expect((res) => assert.doesNotMatch(res.text, /simulationResults/));
  const token = csrfFrom(page.text);

  await agent.post("/api/simulate")
    .set("x-csrf-token", token)
    .send({ demandMultiplier: "1.5", missingProvider: "nagad" })
    .expect(200)
    .expect((res) => {
      const rows = res.body.comparison.rows;
      assert.equal(res.body.advisoryOnly, true);
      assert.deepEqual(rows.map((row) => row.id), ["shared", "nagad"]);
      assert.deepEqual(res.body.comparison.chartData.labels, rows.map((row) => row.name));
      assert.equal(rows.find((row) => row.id === "nagad").scenario.feedState, "missing");
      assert.equal(res.body.data.length, rows.length);
    });

  await agent.get("/methodology").expect(200).expect(/id="decision-flow"/);
});

test("risk reviewer maps to existing risk capabilities", async () => {
  const agent = await enterDemo("risk_reviewer");
  await agent.get("/api/audit").expect(200);
  await agent.get("/alerts").expect(200).expect(/Risk Reviewer/).expect((res) => assert.doesNotMatch(res.text, />Data feeds</));
  await agent.get("/data").expect(200).expect(/Baseline Dataset/).expect((res) => {
    assert.doesNotMatch(res.text, /action="\/data\/snapshot"|action="\/data\/transactions"/);
  });
});

test("all primary views and self-hosted assets render under the CSP", async () => {
  const agent = await enterDemo("management");
  for (const route of ["/", "/methodology", "/network", "/data"]) await agent.get(route).expect(200);
  await request(app).get("/css/style.css").expect(200);
  await agent.get("/").expect(200).expect((res) => { assert.match(res.headers["content-security-policy"], /script-src 'self'/); assert.doesNotMatch(res.text, /cdn\.tailwindcss|cdn\.jsdelivr|cdnjs/); });
});

test("operations can complete the guided provider case workflow", async () => {
  const agent = await enterDemo("operations"); const alertsPage = await agent.get("/alerts"); const token = csrfFrom(alertsPage.text);
  await agent.post("/alerts/ALT-NAGAD-LIQ/cases").type("form").send({ _csrf: token }).expect(302);
  const item = storeService.getState().cases.find((entry) => entry.alertId === "ALT-NAGAD-LIQ");
  assert.ok(item); assert.equal(item.owner, null); assert.equal(item.status, "open");
  await agent.post(`/cases/${item.id}/assign`).type("form").send({ _csrf: token, ownerId: "usr-ops" }).expect(302);
  assert.equal(item.owner, "Farhana Islam");
  await agent.post(`/cases/${item.id}/status`).type("form").send({ _csrf: token, status: "acknowledged" }).expect(302);
  await agent.post(`/cases/${item.id}/notes`).type("form").send({ _csrf: token, note: "Demand confirmed with the simulated outlet." }).expect(302);
  await agent.post(`/cases/${item.id}/status`).type("form").send({ _csrf: token, status: "escalated" }).expect(302);
  await agent.post(`/cases/${item.id}/status`).type("form").send({ _csrf: token, status: "resolved" }).expect(302);
  assert.equal(item.status, "resolved"); assert.ok(item.resolvedAt); assert.ok(item.history.every((event) => event.actor));
  assert.equal(analytics.getAlertById("ALT-NAGAD-LIQ").status, "resolved");
});

test("validated CSV import pseudonymizes labels and conflicting feeds require evidence", async () => {
  const agent = await enterDemo("management"); const dataPage = await agent.get("/data").expect(200).expect(/<title>Simulation Data · Nirapod Ops<\/title>/); const token = csrfFrom(dataPage.text);
  const before = storeService.getState().transactions.length;
  await agent.post("/data/transactions").field("_csrf", token).attach("transactions", path.join(__dirname, "..", "sample-data", "transactions.csv")).expect(302);
  const imported = storeService.getState().transactions.slice(before);
  assert.equal(imported.length, 7); assert.ok(imported.every((row) => /^U-[A-F0-9]{10}$/.test(row.account))); assert.ok(imported.every((row) => !row.account.includes("SYN-")));
  const hackathonCsv = Buffer.from([
    "transaction_id,timestamp,day,agent_id,provider,area,transaction_type,amount,status,opening_provider_balance,closing_provider_balance,opening_physical_cash,closing_physical_cash,event_flag,case_status,heuristic_score,confidence,review_required",
    "TX-HACK-1,2026-07-11 09:15:30,1,SYN-Y200,nagad,Sylhet,send_money,\"1,250\",completed,100000,98750,45000,46250,normal,open,12,0.8,false",
  ].join("\n"));
  await agent.post("/data/transactions").field("_csrf", token).attach("transactions", hackathonCsv, "hackathon-current.csv").expect(302);
  const hackathon = storeService.getState().transactions.at(-1);
  assert.equal(hackathon.provider, "nagad");
  assert.equal(hackathon.type, "send-money");
  assert.equal(hackathon.amount, 1250);
  assert.equal(hackathon.minute, 555);
  assert.deepEqual(hackathon.csvHeaders, ["transaction_id", "timestamp", "day", "agent_id", "provider", "area", "transaction_type", "amount", "status", "opening_provider_balance", "closing_provider_balance", "opening_physical_cash", "closing_physical_cash", "event_flag", "case_status", "heuristic_score", "confidence", "review_required"]);
  assert.equal(hackathon.csvRow.agent_id, hackathon.account);
  const aliasCsv = Buffer.from("provider_name,transaction_type,value,agent,time\nbkash,bill-payment,1200,SYN-X100,09:15\n");
  await agent.post("/data/transactions").field("_csrf", token).attach("transactions", aliasCsv, "custom-current.csv").expect(302);
  const custom = storeService.getState().transactions.at(-1);
  assert.equal(custom.type, "bill-payment");
  assert.equal(custom.minute, 555);
  await agent.get("/data").expect(200).expect(/Accepted headers match the historical dataset format/).expect(/Show current data/).expect((res) => {
    assert.doesNotMatch(res.text, /bill-payment/);
    assert.doesNotMatch(res.text, /Dataset CUR-/);
  });
  await agent.get("/data?showCurrent=1").expect(200).expect(/transaction_type/).expect(/bill-payment/).expect(/Dataset CUR-/).expect((res) => {
    assert.doesNotMatch(res.text, /SYN-X100/);
  });
  await agent.post("/data/snapshot").type("form").send({ _csrf: token, sharedCash: 245000, provider: "rocket", balance: 126500, feedStatus: "conflicting", alternateBalance: "", updatedMinutesAgo: 2 }).expect(400);
});

test("AI briefing endpoint degrades safely without a configured key", async () => {
  const agent = await enterDemo("risk_reviewer"); const page = await agent.get("/alerts"); const token = csrfFrom(page.text);
  await agent.post("/api/alerts/ALT-NAGAD-01/explain").set("x-csrf-token", token).send({}).expect(200).expect((res) => {
    assert.equal(res.body.data.mode, "fallback"); assert.match(res.body.data.safeNextStep, /Do not .*move funds across providers/i); assert.equal(res.body.data.nextStepSource, "deterministic");
  });
});

test("unknown role-scoped API routes return a safe 404", async () => {
  const agent = await enterDemo("management");
  await agent.get("/api/not-real").expect(404).expect((res) => assert.equal(res.body.status, 404));
});

test("historical baseline upload is deduplicated and drives current-versus-baseline alert evidence", async () => {
  const reviewer = await enterDemo("risk_reviewer");
  const dataPage = await reviewer.get("/data").expect(200).expect(/Baseline Dataset/);
  const token = csrfFrom(dataPage.text);
  const baselineRows = Array.from({ length: 50 }, (_, index) => `nagad,cash-out,${1000 + (index % 5) * 10},SYN-HISTORY,${index * 20}`);
  const baselineCsv = Buffer.from([
    "provider,type,amount,account,minute",
    ...baselineRows,
    "nagad,cash-out,not-a-number,SYN-INVALID,990",
  ].join("\n"));

  await reviewer.post("/data/baseline")
    .field("_csrf", token)
    .field("datasetName", "Nagad historical baseline")
    .attach("baselineFile", baselineCsv, "nagad-baseline.csv")
    .expect(302)
    .expect("location", /baseline-dataset$/);

  const latest = storeService.getState().datasetImports[0];
  assert.equal(latest.validRows, 50);
  assert.equal(latest.invalidRows, 1);
  assert.equal(latest.baselineStatus, "complete");
  assert.ok(storeService.getState().baselines.some((item) => item.scopeType === "provider_account_type" && item.baselineConfidence === "HIGH"));
  await reviewer.get("/data").expect(200).expect(/Show all historical data/);
  await reviewer.get("/data?showHistorical=1").expect(200).expect(/All Historical Data/).expect(/50 rows/).expect(/nagad/);

  const historicalCount = (await storeService.getBaselineTransactions()).length;
  await reviewer.post("/data/baseline")
    .field("_csrf", token)
    .field("datasetName", "Duplicate name")
    .attach("baselineFile", baselineCsv, "renamed-baseline.csv")
    .expect(302);
  assert.equal(storeService.getState().datasetImports.length, 1);
  assert.equal((await storeService.getBaselineTransactions()).length, historicalCount);

  const currentCsv = Buffer.from([
    "provider,type,amount,account,minute",
    ...[1200, 1202, 1204, 1206, 1208].map((minute) => `nagad,cash-out,5000,SYN-HISTORY,${minute}`),
  ].join("\n"));
  const ingestAgent = await enterDemo("agent");
  const ingestPage = await ingestAgent.get("/data").expect(200);
  await ingestAgent.post("/data/transactions").field("_csrf", csrfFrom(ingestPage.text)).attach("transactions", currentCsv, "current.csv").expect(302);

  await reviewer.get("/alerts").expect(200)
    .expect(/Current behavior vs Historical baseline/)
    .expect(/Advisory risk score: \d+\/100/)
    .expect(/TRANSACTION VELOCITY/)
    .expect((res) => assert.doesNotMatch(res.text, /\d+% fraud probability/i));
  await reviewer.get("/api/baselines").expect(200).expect((res) => {
    assert.equal(res.body.data[0].provider, "nagad");
    assert.equal(res.body.latestImport.validRows, 50);
    assert.ok(res.body.metrics.explanationCoverage !== null);
  });
  await reviewer.post("/data/baseline/recalculate").type("form").send({ _csrf: token }).expect(302);
});
