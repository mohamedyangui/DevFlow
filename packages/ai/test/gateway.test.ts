import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AuditLog,
  DevflowError,
  ErrorCode,
  type LlmResponse,
  SecretRedactor,
  readAuditLog,
} from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  BudgetTracker,
  FakeProvider,
  type FakeReply,
  LlmGateway,
  type LlmExchange,
  LlmProviderError,
  PriceTable,
  type StructuredCall,
  requestFingerprint,
} from "../src/index.js";

const SECRET = "sk-test-SECRETVALUE-1234567890";

const Answer = z.strictObject({
  summary: z.string().min(1),
  items: z.array(z.string()),
});
type Answer = z.infer<typeof Answer>;

const GOOD = JSON.stringify({ summary: "ok", items: ["a"] });

function call(overrides: Partial<StructuredCall<Answer>> = {}): StructuredCall<Answer> {
  return {
    step: "analysis",
    templateId: "requirements-analysis",
    templateVersion: "1",
    model: "test-model",
    system: "You analyse requirements.",
    user: "Analyse TASK-1.",
    files: ["src/a.ts"],
    schema: Answer,
    schemaName: "analysis",
    maxOutputTokens: 1_000,
    ...overrides,
  };
}

async function setup(
  replies: readonly FakeReply[],
  options: {
    budget?: BudgetTracker;
    timeoutMs?: number;
    random?: () => number;
    maxRepairAttempts?: number;
    prices?: PriceTable;
  } = {},
) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "devflow-gateway-"));
  const redactor = new SecretRedactor({ knownSecrets: [SECRET] });
  const audit = await AuditLog.open(path.join(dir, "audit.jsonl"), { redactor, runId: "RUN-1" });
  const provider = FakeProvider.sequence(replies);
  const sleeps: number[] = [];
  const exchanges: LlmExchange[] = [];
  const budget = options.budget ?? new BudgetTracker();
  const gateway = new LlmGateway({
    provider,
    redactor,
    budget,
    audit,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.prices === undefined ? {} : { prices: options.prices }),
    ...(options.maxRepairAttempts === undefined
      ? {}
      : { maxRepairAttempts: options.maxRepairAttempts }),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: options.random ?? (() => 0.5),
    observer: (exchange) => {
      exchanges.push(exchange);
    },
  });
  return {
    gateway,
    provider,
    budget,
    sleeps,
    exchanges,
    entries: () =>
      readAuditLog(audit.file).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }),
  };
}

function response(overrides: Partial<LlmResponse>): LlmResponse {
  return {
    text: GOOD,
    model: "test-model-2026",
    stopReason: "end_turn",
    usage: { inputTokens: 100, outputTokens: 20 },
    ...overrides,
  };
}

async function failure(promise: Promise<unknown>): Promise<DevflowError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DevflowError);
  return error as DevflowError;
}

describe("LlmGateway: answers", () => {
  it("returns the validated value and audits the call", async () => {
    const { gateway, provider, budget, entries } = await setup([response({})]);
    const result = await gateway.generateStructured(call());

    expect(result).toMatchObject({
      value: { summary: "ok", items: ["a"] },
      model: "test-model-2026",
      calls: 1,
      repaired: false,
      inputTokens: 100,
      outputTokens: 20,
    });
    const request = provider.requests[0];
    if (request === undefined) throw new Error("no request was sent");
    expect(request.responseFormat?.name).toBe("analysis");
    expect(request.responseFormat?.jsonSchema).toMatchObject({ type: "object" });
    expect(result.promptSha256).toBe(requestFingerprint(request));
    expect(budget.usage()).toEqual({
      calls: 1,
      inputTokens: 100,
      outputTokens: 20,
      callsByStep: { analysis: 1 },
      unpricedCalls: 1,
    });

    const [entry] = await entries();
    expect(entry).toMatchObject({
      type: "llm-call",
      runId: "RUN-1",
      provider: "fake",
      model: "test-model-2026",
      templateId: "requirements-analysis",
      templateVersion: "1",
      promptSha256: result.promptSha256,
      files: ["src/a.ts"],
      inputTokens: 100,
      outputTokens: 20,
      costUsd: null,
      outcome: "ok",
      step: "analysis",
      attempts: 1,
    });
    expect(entry?.type === "llm-call" ? entry.durationMs : undefined).toBeGreaterThanOrEqual(0);
  });

  it("accepts JSON wrapped in a code fence or in a sentence", async () => {
    const fenced = await setup(["```json\n" + GOOD + "\n```"]);
    expect((await fenced.gateway.generateStructured(call())).value.summary).toBe("ok");
    const prose = await setup([`Here it is: ${GOOD} Done.`]);
    expect((await prose.gateway.generateStructured(call())).value.summary).toBe("ok");
  });

  it("redacts secrets before the provider sees the prompt and audits each redaction", async () => {
    const { gateway, provider, entries } = await setup([GOOD]);
    await gateway.generateStructured(
      call({ system: "rules", user: `line one\nthe key is ${SECRET} here` }),
    );
    const sent = provider.requests[0]?.messages[0]?.content ?? "";
    expect(sent).not.toContain(SECRET);
    expect(sent).toContain("«REDACTED:known-secret:");
    const redactions = (await entries()).filter((entry) => entry.type === "redaction");
    expect(redactions).toEqual([
      expect.objectContaining({
        context: "llm:requirements-analysis@1",
        detector: "known-secret",
        location: "user:2:12",
      }),
    ]);
  });

  it("asks for one repair when the answer does not match the schema", async () => {
    const { gateway, provider, entries } = await setup([
      JSON.stringify({ summary: "", items: "nope" }),
      GOOD,
    ]);
    const result = await gateway.generateStructured(call());

    expect(result).toMatchObject({ repaired: true, calls: 2 });
    const repair = provider.requests[1];
    expect(repair?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(repair?.messages[2]?.content).toMatch(/does not match the required JSON schema/);
    expect(repair?.messages[2]?.content).toMatch(/- items: /);
    expect(repair?.messages[2]?.content).toMatch(/- summary: /);
    expect((await entries()).filter((entry) => entry.type === "llm-call")).toHaveLength(2);
  });

  it("fails with LLM_OUTPUT_INVALID when the repaired answer is still invalid", async () => {
    const { gateway } = await setup(["not json", "still not json"]);
    const error = await failure(gateway.generateStructured(call()));
    expect(error.code).toBe(ErrorCode.LlmOutputInvalid);
    expect(error.details.issues).toEqual([expect.stringMatching(/not valid JSON/)]);
  });

  it("does not repair when repairs are disabled", async () => {
    const { gateway, provider } = await setup(["not json"], { maxRepairAttempts: 0 });
    const error = await failure(gateway.generateStructured(call()));
    expect(error.code).toBe(ErrorCode.LlmOutputInvalid);
    expect(provider.requests).toHaveLength(1);
  });

  it("treats a refusal as an error and audits it as refused", async () => {
    const { gateway, entries } = await setup([response({ text: "", stopReason: "refusal" })]);
    const error = await failure(gateway.generateStructured(call()));
    expect(error.code).toBe(ErrorCode.LlmRefused);
    expect((await entries())[0]).toMatchObject({ type: "llm-call", outcome: "refused" });
  });

  it("treats a truncated answer as an error", async () => {
    const { gateway } = await setup([
      response({ text: '{"summary": "o', stopReason: "max_tokens" }),
    ]);
    const error = await failure(gateway.generateStructured(call()));
    expect(error.code).toBe(ErrorCode.LlmOutputTruncated);
    expect(error.details.maxOutputTokens).toBe(1_000);
  });

  it("requires a model", async () => {
    const { gateway, provider } = await setup([GOOD]);
    const error = await failure(gateway.generateStructured(call({ model: " " })));
    expect(error.code).toBe(ErrorCode.LlmProviderNotConfigured);
    expect(provider.requests).toHaveLength(0);
  });

  it("reports every exchange to the observer", async () => {
    const { gateway, exchanges } = await setup(["bad", GOOD]);
    await gateway.generateStructured(call());
    expect(exchanges.map((exchange) => [exchange.purpose, exchange.attempt])).toEqual([
      ["initial", 1],
      ["repair", 1],
    ]);
    expect(exchanges[1]?.response?.text).toBe(GOOD);
  });
});

describe("LlmGateway: retries", () => {
  it("retries a rate limit after the delay the provider asked for", async () => {
    const { gateway, sleeps, provider } = await setup([
      new LlmProviderError("rate-limit", "slow down", { status: 429, retryAfterMs: 2_000 }),
      GOOD,
    ]);
    await gateway.generateStructured(call());
    expect(sleeps).toEqual([2_000]);
    expect(provider.requests).toHaveLength(2);
  });

  it("backs off exponentially with jitter and gives up after three attempts", async () => {
    const server = new LlmProviderError("server", "boom", { status: 500, requestId: "req_9" });
    const { gateway, sleeps, entries } = await setup([server, server, server], {
      random: () => 1,
    });
    const error = await failure(gateway.generateStructured(call()));

    expect(sleeps).toEqual([1_000, 2_000]);
    expect(error.code).toBe(ErrorCode.LlmRequestFailed);
    expect(error.message).toMatch(/after 3 attempts: boom/);
    expect(error.details).toMatchObject({
      kind: "server",
      status: 500,
      attempts: 3,
      requestId: "req_9",
    });
    expect(await entries()).toEqual([
      expect.objectContaining({ type: "llm-call", outcome: "error", inputTokens: 0, attempts: 3 }),
    ]);
  });

  it("uses at least half of the backoff ceiling", async () => {
    const network = new LlmProviderError("network", "reset");
    const { gateway, sleeps } = await setup([network, GOOD], { random: () => 0 });
    await gateway.generateStructured(call());
    expect(sleeps).toEqual([500]);
  });

  it("does not retry failures that cannot succeed later", async () => {
    const { gateway, provider } = await setup([
      new LlmProviderError("authentication", "bad key", { status: 401 }),
    ]);
    const error = await failure(gateway.generateStructured(call()));
    expect(error.details.kind).toBe("authentication");
    expect(provider.requests).toHaveLength(1);
  });

  it("does not wait for a retry-after longer than the limit", async () => {
    const { gateway, sleeps } = await setup([
      new LlmProviderError("rate-limit", "later", { status: 429, retryAfterMs: 3_600_000 }),
    ]);
    await failure(gateway.generateStructured(call()));
    expect(sleeps).toEqual([]);
  });

  it("times out a call that does not answer and retries it", async () => {
    let calls = 0;
    const dir = await mkdtemp(path.join(os.tmpdir(), "devflow-gateway-"));
    const redactor = new SecretRedactor();
    const gateway = new LlmGateway({
      provider: new FakeProvider(async (_request, index) => {
        calls = index + 1;
        if (index === 0) await new Promise((resolve) => setTimeout(resolve, 5_000));
        return GOOD;
      }),
      redactor,
      budget: new BudgetTracker(),
      audit: await AuditLog.open(path.join(dir, "audit.jsonl"), { redactor }),
      timeoutMs: 50,
      sleep: () => Promise.resolve(),
    });
    // The fake ignores the abort, so the gateway's own timeout must end the wait.
    const result = await gateway.generateStructured(call());
    expect(result.value.summary).toBe("ok");
    expect(calls).toBe(2);
  });

  it("stops with CANCELLED when the caller aborts", async () => {
    const controller = new AbortController();
    const { gateway, entries } = await setup([
      new LlmProviderError("server", "boom", { status: 500 }),
    ]);
    controller.abort();
    const error = await failure(gateway.generateStructured(call({ signal: controller.signal })));
    expect(error.code).toBe(ErrorCode.Cancelled);
    expect(await entries()).toEqual([]);
  });

  it("passes DevflowErrors from the provider through unchanged", async () => {
    const miss = new DevflowError(ErrorCode.ReplayCassetteMiss, "no recording");
    const { gateway } = await setup([miss]);
    expect(await failure(gateway.generateStructured(call()))).toBe(miss);
  });
});

describe("LlmGateway: budgets", () => {
  it("refuses a call whose estimate exceeds the input budget before calling the provider", async () => {
    const budget = new BudgetTracker({
      maxInputTokens: 10,
      maxOutputTokens: 10_000,
      maxCallsPerStep: 5,
    });
    const { gateway, provider } = await setup([GOOD], { budget });
    const error = await failure(gateway.generateStructured(call()));
    expect(error.code).toBe(ErrorCode.BudgetExceeded);
    expect(error.details).toMatchObject({ limit: "maxInputTokens", step: "analysis", max: 10 });
    expect(provider.requests).toHaveLength(0);
  });

  it("counts the output allowance against the output budget", async () => {
    const budget = new BudgetTracker({
      maxInputTokens: 100_000,
      maxOutputTokens: 999,
      maxCallsPerStep: 5,
    });
    const { gateway } = await setup([GOOD], { budget });
    const error = await failure(gateway.generateStructured(call()));
    expect(error.details).toMatchObject({ limit: "maxOutputTokens", requested: 1_000 });
  });

  it("counts repairs against the step's call budget", async () => {
    const budget = new BudgetTracker({
      maxInputTokens: 100_000,
      maxOutputTokens: 100_000,
      maxCallsPerStep: 1,
    });
    const { gateway } = await setup(["bad", GOOD], { budget });
    const error = await failure(gateway.generateStructured(call()));
    expect(error.code).toBe(ErrorCode.BudgetExceeded);
    expect(error.details).toMatchObject({ limit: "maxCallsPerStep", used: 1 });
  });
});

describe("LlmGateway: cost", () => {
  const prices = new PriceTable({
    "test-model-2026": { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cachedInputUsdPerMTok: 0.3 },
  });

  it("prices each call by the served model and records it in the budget and the audit log", async () => {
    const { gateway, budget, entries } = await setup(
      [response({ usage: { inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 400 } })],
      { prices },
    );
    await gateway.generateStructured(call());
    // 600 uncached x $3 + 400 cached x $0.30 + 200 output x $15, per million tokens.
    const expected = (600 * 3 + 400 * 0.3 + 200 * 15) / 1_000_000;
    expect(budget.usage().costUsd).toBeCloseTo(expected, 12);
    expect(budget.usage().unpricedCalls).toBeUndefined();
    const [entry] = await entries();
    expect(entry).toMatchObject({ type: "llm-call", outcome: "ok" });
    expect((entry as { costUsd: number }).costUsd).toBeCloseTo(expected, 12);
  });

  it("records an unknown cost as null, and does not let it count against the cost budget", async () => {
    const budget = new BudgetTracker({
      maxInputTokens: 600_000,
      maxOutputTokens: 80_000,
      maxCallsPerStep: 12,
      maxCostUsd: 0.000_001,
    });
    const { gateway, entries } = await setup([response({ model: "other-model" })], { budget });
    await gateway.generateStructured(call({ model: "other-model" }));
    expect(budget.usage()).toMatchObject({ calls: 1, unpricedCalls: 1 });
    const [entry] = await entries();
    expect(entry).toMatchObject({ costUsd: null });
  });

  it("refuses a priced call that could exceed the cost budget before sending it", async () => {
    const budget = new BudgetTracker({
      maxInputTokens: 600_000,
      maxOutputTokens: 80_000,
      maxCallsPerStep: 12,
      maxCostUsd: 0.01,
    });
    const { gateway, provider } = await setup([response({})], { budget, prices });
    // The estimate includes the full output allowance: 1000 x $15 per million = $0.015.
    const error = await failure(gateway.generateStructured(call({ model: "test-model-2026" })));
    expect(error.code).toBe(ErrorCode.BudgetExceeded);
    expect(error.details).toMatchObject({ limit: "maxCostUsd" });
    expect(provider.requests).toHaveLength(0);
  });
});
