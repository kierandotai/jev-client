import { test } from "node:test";
import assert from "node:assert/strict";
import { JevClient, noul, choice, score } from "../src/client.ts";
import {
  MockProvider,
  OpenRouterProvider,
  VercelGatewayProvider,
  normalize,
} from "../src/providers.ts";
import { escalateIfUnsure } from "../src/helpers.ts";
import { estimateCostUsd, JevError } from "../src/types.ts";

const mockClient = () => new JevClient({ provider: new MockProvider() });

test("mock provider returns correctly shaped answers for all three primitives", async () => {
  const res = await mockClient().decide("The server is on fire and customers are furious", {
    urgent: noul("Is this urgent?", { true: "fire, outage, furious customers" }),
    dept: choice("Which team?", { infra: "server fire outage", sales: "pricing quotes" }),
    sev: score("Severity?", ["fine", "bad", "server on fire"]),
  });

  assert.equal(res.answers.urgent.type, "noul");
  assert.ok(res.answers.urgent.noul > 0 && res.answers.urgent.noul < 1);

  assert.equal(res.answers.dept.type, "choice");
  assert.equal(res.answers.dept.choice, "infra");
  const probSum = Object.values(res.answers.dept.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(probSum - 1) < 0.01, `probabilities sum to ${probSum}`);

  assert.equal(res.answers.sev.type, "score");
  assert.ok(res.answers.sev.score >= 0 && res.answers.sev.score <= 2);
  assert.equal(Object.keys(res.answers.sev.legend).length, 3);

  assert.equal(res.provider, "mock");
  assert.ok(res.estimated_cost_usd > 0);
});

test("score builder rejects fewer than 2 levels", () => {
  assert.throws(() => score("bad rubric", ["only one"]));
});

test("cost estimation matches $0.042 per million input tokens", () => {
  assert.equal(estimateCostUsd({ input_tokens: 1_000_000 }), 0.042);
  assert.equal(estimateCostUsd({ input_tokens: 0 }), 0);
});

test("normalize prefers API-reported cost over the estimate", () => {
  const withCost = normalize(
    { model: "m", answers: {}, usage: { input_tokens: 100, output_tokens: 0, cost_usd: 0.5 } },
    "openrouter",
  );
  assert.equal(withCost.estimated_cost_usd, 0.5);
  const without = normalize(
    { model: "m", answers: {}, usage: { input_tokens: 1_000_000, output_tokens: 0 } },
    "typesafe",
  );
  assert.equal(without.estimated_cost_usd, 0.042);
});

test("escalateIfUnsure gates on confidence", () => {
  const confident = { type: "choice" as const, choice: "a", probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 };
  const shaky = { ...confident, confidence: 0.4 };
  assert.deepEqual(escalateIfUnsure(confident), { decided: true, value: "a" });
  assert.deepEqual(escalateIfUnsure(shaky), { decided: false, reason: "low_confidence" });
});

test("provider resolution: explicit mock, and named provider without key throws", () => {
  const c = new JevClient({ provider: "mock" });
  assert.equal(c.provider.name, "mock");
  assert.equal(c.model, "mock-jev");
  const noKeys = { openrouterApiKey: undefined, typesafeApiKey: undefined };
  delete process.env.OPENROUTER_API_KEY;
  assert.throws(() => new JevClient({ provider: "openrouter", ...noKeys }), /OPENROUTER_API_KEY/);
});

test("retryable statuses classified correctly on JevError", () => {
  assert.ok(new JevError("x", 429, "p").retryable);
  assert.ok(new JevError("x", 529, "p").retryable);
  assert.ok(new JevError("x", 503, "p").retryable);
  assert.ok(!new JevError("x", 422, "p").retryable);
  assert.ok(!new JevError("x", 401, "p").retryable);
});

test("openrouter provider retries 429 then succeeds (stubbed fetch)", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls === 1) {
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
    return Response.json({
      model: "typesafe/jev-1.13",
      answers: { q: { type: "noul", noul: 0.8 } },
      usage: { input_tokens: 42, output_tokens: 3 },
    });
  }) as typeof fetch;
  try {
    const provider = new OpenRouterProvider("test-key");
    const raw = await provider.decide({ model: "typesafe/jev-1.13", state: "s", questions: { q: noul("?") } });
    assert.equal(calls, 2);
    assert.equal(raw.usage.input_tokens, 42);
  } finally {
    globalThis.fetch = original;
  }
});

test("vercel gateway provider translates dialect both directions (stubbed fetch)", async () => {
  const original = globalThis.fetch;
  let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
  globalThis.fetch = (async (url: unknown, init: unknown) => {
    const i = init as { headers: Record<string, string>; body: string };
    captured = { url: String(url), headers: i.headers, body: JSON.parse(i.body) };
    return Response.json({
      answers: {
        urgent: { type: "boolean", probability: 0.85 },
        dept: { type: "choice", choice: "billing", probabilities: { billing: 1, technical: 0 } },
        anger: { type: "score", score: 2, probabilities: { "0": 0, "1": 0, "2": 1 } },
      },
      usage: { inputTokens: 392, outputTokens: 61 },
      providerMetadata: { typesafe: { confidence: { dept: 1, anger: 0.9 } } },
    });
  }) as typeof fetch;
  try {
    const provider = new VercelGatewayProvider("test-key");
    const raw = await provider.decide({
      model: "typesafe-ai/jev",
      state: "s",
      questions: {
        urgent: noul("urgent?"),
        dept: choice("team?", { billing: "money", technical: "bugs" }),
        anger: score("angry?", ["calm", "annoyed", "furious"]),
      },
    });
    const c = captured!;
    assert.match(c.url, /\/v4\/ai\/evaluation-model$/);
    assert.equal(c.headers["ai-model-id"], "typesafe-ai/jev");
    assert.equal(c.headers["ai-gateway-protocol-version"], "0.0.1");
    const wire = c.body as { questions: Record<string, { type: string }> };
    assert.equal(wire.questions.urgent.type, "boolean");
    assert.equal(wire.questions.dept.type, "choice");

    assert.deepEqual(raw.answers.urgent, { type: "noul", noul: 0.85 });
    const dept = raw.answers.dept;
    assert.equal(dept.type === "choice" && dept.choice, "billing");
    assert.equal(dept.type === "choice" && dept.confidence, 1);
    const anger = raw.answers.anger;
    assert.equal(anger.type === "score" && anger.score, 2);
    assert.equal(anger.type === "score" && anger.confidence, 0.9);
    assert.deepEqual(anger.type === "score" ? anger.legend : {}, {
      "0": "calm",
      "1": "annoyed",
      "2": "furious",
    });
    assert.equal(raw.usage.input_tokens, 392);
  } finally {
    globalThis.fetch = original;
  }
});

test("auto provider resolution prefers gateway key, and explicit vercel-gateway works", () => {
  const prev = { gw: process.env.AI_GATEWAY_API_KEY, or: process.env.OPENROUTER_API_KEY };
  try {
    process.env.AI_GATEWAY_API_KEY = "gw-test";
    process.env.OPENROUTER_API_KEY = "or-test";
    assert.equal(new JevClient({}).provider.name, "vercel-gateway");
    delete process.env.AI_GATEWAY_API_KEY;
    assert.equal(new JevClient({}).provider.name, "openrouter");
    assert.equal(
      new JevClient({ provider: "vercel-gateway", gatewayApiKey: "x" }).provider.name,
      "vercel-gateway",
    );
  } finally {
    if (prev.gw === undefined) delete process.env.AI_GATEWAY_API_KEY;
    else process.env.AI_GATEWAY_API_KEY = prev.gw;
    if (prev.or === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prev.or;
  }
});
