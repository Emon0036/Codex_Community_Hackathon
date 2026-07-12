const test = require("node:test");
const assert = require("node:assert/strict");
const { createAIExplanationService } = require("../services/aiExplanationService");

const alert = {
  id: "ALT-NAGAD-01",
  provider: "nagad",
  type: "behavior",
  severity: "high",
  title: "Repeated near-identical cash-out pattern requires review",
  explanation: "Five similar transactions appeared in a short window.",
  evidence: ["5 repeated amounts", "3 anonymized accounts", "17-minute window"],
  confidence: 0.86,
  status: "acknowledged",
};

const parsedExplanation = {
  english: "A repeated transaction pattern was observed and requires human review.",
  bangla: "একই ধরনের লেনদেনের একটি পুনরাবৃত্ত ধরণ দেখা গেছে এবং মানুষের পর্যালোচনা প্রয়োজন।",
  operatorBrief: "Review the repeated-pattern evidence with Nagad operations.",
  caveats: ["This signal does not establish fraud or intent."],
  safeNextStep: "Ask the authorized Nagad operations team to verify the recorded pattern.",
};

test("missing API key returns a deterministic fallback without constructing a client", async () => {
  const service = createAIExplanationService({ apiKey: "" });

  const first = await service.explainAlert(alert);
  const second = await service.explainAlert(alert);

  assert.equal(service.isConfigured(), false);
  assert.deepEqual(first, second);
  assert.equal(first.mode, "fallback");
  assert.match(first.safeNextStep, /Do not move funds across providers/i);
  assert.equal(service.getStatus().mode, "fallback");
});

test("uses Responses API structured parsing and forwards only allowlisted alert data", async () => {
  let capturedBody;
  let capturedOptions;
  const client = {
    responses: {
      parse: async (body, options) => {
        capturedBody = body;
        capturedOptions = options;
        return { output_parsed: parsedExplanation };
      },
    },
  };
  const service = createAIExplanationService({
    apiKey: "server-test-key",
    client,
    model: "test-model",
  });

  const result = await service.explainAlert({
    ...alert,
    customerName: "Private Person",
    accountNumber: "1234567890123456",
    contact: "private@example.com",
  });

  assert.equal(result.mode, "ai");
  assert.equal(result.english, parsedExplanation.english);
  assert.match(result.safeNextStep, /Do not move funds across providers/i);
  assert.equal(result.nextStepSource, "deterministic");
  assert.equal(capturedBody.model, "test-model");
  assert.equal(capturedBody.store, false);
  assert.equal(capturedBody.text.format.type, "json_schema");
  assert.equal(capturedOptions.timeout, 10_000);
  assert.equal(capturedOptions.maxRetries, 1);

  const sent = capturedBody.input.map((message) => message.content).join("\n");
  assert.doesNotMatch(sent, /Private Person|1234567890123456|private@example\.com|server-test-key/);
  assert.match(sent, /Never determine, allege, or imply fraud/i);
  assert.match(sent, /Never recommend cross-provider transfers/i);
});

test("API and schema failures safely degrade instead of throwing", async (t) => {
  await t.test("API error", async () => {
    const service = createAIExplanationService({
      client: { responses: { parse: async () => { throw new Error("network unavailable"); } } },
    });

    const result = await service.explainAlert(alert);
    assert.equal(result.mode, "fallback");
    assert.equal(service.getStatus().mode, "fallback");
  });

  await t.test("invalid parsed output", async () => {
    const service = createAIExplanationService({
      client: { responses: { parse: async () => ({ output_parsed: { english: "incomplete" } }) } },
    });

    await assert.doesNotReject(() => service.explainAlert(alert));
    assert.equal((await service.explainAlert(alert)).mode, "fallback");
  });
});

test("status exposes safe configuration metadata and the required default model", () => {
  const service = createAIExplanationService({ apiKey: "server-test-key", client: { responses: {} } });
  const status = service.getStatus();

  assert.deepEqual(status, {
    configured: true,
    mode: "ai",
    model: "gpt-5.4-mini",
    timeoutMs: 10_000,
    maxRetries: 1,
  });
  assert.doesNotMatch(JSON.stringify(status), /server-test-key/);
});

test("well-formed but unsafe model language is rejected by the policy gate", async () => {
  const service = createAIExplanationService({
    client: { responses: { parse: async () => ({ output_parsed: {
      english: "This customer is fraudulent and guilty.",
      bangla: "মানব পর্যালোচনা করুন।",
      operatorBrief: "Confirmed wrongdoing.",
      caveats: ["The schema is valid."],
      safeNextStep: "Transfer the balance and block the account.",
    } }) } },
  });
  const result = await service.explainAlert(alert);
  assert.equal(result.mode, "fallback");
  assert.equal(result.nextStepSource, "deterministic");
});
