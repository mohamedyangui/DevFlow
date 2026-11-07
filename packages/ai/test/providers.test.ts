import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { DevflowError, ErrorCode, type LlmRequest, SecretRedactor } from "@devflow/core";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AnthropicProvider,
  BudgetTracker,
  FakeProvider,
  LlmGateway,
  LlmProviderError,
  ReplayProvider,
  createProvider,
  requestFingerprint,
  toCreateParams,
} from "../src/index.js";

const never = new AbortController().signal;

function request(user: string, overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "test-model",
    system: "system text",
    messages: [{ role: "user", content: user }],
    maxOutputTokens: 500,
    ...overrides,
  };
}

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "devflow-providers-"));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (reason: unknown) => reason,
  );
}

describe("FakeProvider", () => {
  it("replies in order and records requests", async () => {
    const fake = FakeProvider.sequence(["one", "two"]);
    expect((await fake.generate(request("a"), never)).text).toBe("one");
    const second = await fake.generate(request("b"), never);
    expect(second).toMatchObject({ text: "two", model: "test-model", stopReason: "end_turn" });
    expect(second.usage.outputTokens).toBe(1);
    expect(fake.requests.map((r) => r.messages[0]?.content)).toEqual(["a", "b"]);
    await expect(fake.generate(request("c"), never)).rejects.toThrow(
      /no scripted reply for call 3/,
    );
  });
});

describe("ReplayProvider", () => {
  it("records a delegate's answers and replays them by request", async () => {
    const file = path.join(await tempDir(), "nested", "cassette.json");
    const recorder = ReplayProvider.record(
      file,
      FakeProvider.sequence(["first", "second", "again"]),
    );
    await recorder.generate(request("a"), never);
    await recorder.generate(request("b"), never);
    await recorder.generate(request("a"), never);
    expect(recorder.interactions).toBe(3);

    const cassette = JSON.parse(await readFile(file, "utf8")) as {
      recordedWith: string;
      interactions: { key: string }[];
    };
    expect(cassette.recordedWith).toBe("fake");
    expect(cassette.interactions[0]?.key).toBe(requestFingerprint(request("a")));

    const replay = await ReplayProvider.load(file);
    expect((await replay.generate(request("b"), never)).text).toBe("second");
    expect((await replay.generate(request("a"), never)).text).toBe("first");
    expect((await replay.generate(request("a"), never)).text).toBe("again");
    const exhausted = await rejection(replay.generate(request("a"), never));
    expect(exhausted).toMatchObject({ code: ErrorCode.ReplayCassetteMiss });
    expect((exhausted as Error).message).toMatch(/all were used/);
  });

  it("fails with REPLAY_CASSETTE_MISS for an unknown request instead of calling out", async () => {
    const file = path.join(await tempDir(), "cassette.json");
    const recorder = ReplayProvider.record(file, FakeProvider.sequence(["x"]));
    await recorder.generate(request("known"), never);
    const replay = await ReplayProvider.load(file);
    const error = await rejection(replay.generate(request("unknown"), never));
    expect(error).toBeInstanceOf(DevflowError);
    expect(error).toMatchObject({
      code: ErrorCode.ReplayCassetteMiss,
      details: { recorded: 1, key: requestFingerprint(request("unknown")) },
    });
  });

  it("keys on every part of the request", () => {
    const base = request("a");
    const keys = new Set([
      requestFingerprint(base),
      requestFingerprint({ ...base, model: "other" }),
      requestFingerprint({ ...base, system: "other" }),
      requestFingerprint({ ...base, maxOutputTokens: 501 }),
      requestFingerprint({ ...base, responseFormat: { name: "x", jsonSchema: {} } }),
    ]);
    expect(keys.size).toBe(5);
    // Key order inside objects does not matter.
    expect(
      requestFingerprint({
        maxOutputTokens: 500,
        messages: base.messages,
        system: base.system,
        model: base.model,
      }),
    ).toBe(requestFingerprint(base));
  });

  it("rejects missing, malformed and invalid cassettes", async () => {
    const dir = await tempDir();
    await expect(ReplayProvider.load(path.join(dir, "missing.json"))).rejects.toMatchObject({
      code: ErrorCode.ReplayCassetteInvalid,
    });
    await writeFile(path.join(dir, "bad.json"), "{", "utf8");
    await expect(ReplayProvider.load(path.join(dir, "bad.json"))).rejects.toMatchObject({
      code: ErrorCode.ReplayCassetteInvalid,
    });
    await writeFile(path.join(dir, "wrong.json"), '{"schemaVersion": 2}', "utf8");
    await expect(ReplayProvider.load(path.join(dir, "wrong.json"))).rejects.toMatchObject({
      code: ErrorCode.ReplayCassetteInvalid,
    });
  });
});

describe("createProvider", () => {
  it("creates providers by name and explains configuration problems", async () => {
    await expect(createProvider({ name: "anthropic", env: {} })).rejects.toMatchObject({
      code: ErrorCode.LlmProviderNotConfigured,
      message: expect.stringMatching(/ANTHROPIC_API_KEY/) as unknown,
    });
    expect((await createProvider({ name: "anthropic", env: { ANTHROPIC_API_KEY: "k" } })).id).toBe(
      "anthropic",
    );
    await expect(createProvider({ name: "openai" })).rejects.toMatchObject({
      message: expect.stringMatching(/Phase 4/) as unknown,
    });
    await expect(createProvider({ name: "replay" })).rejects.toMatchObject({
      code: ErrorCode.LlmProviderNotConfigured,
    });
    await expect(createProvider({ name: "mystery" })).rejects.toMatchObject({
      message: expect.stringMatching(/unknown provider "mystery"/) as unknown,
    });
  });
});

interface Captured {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown>;
}

type Handler = (captured: Captured, response: ServerResponse) => void;

const servers: { close: () => void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A local stand-in for the Messages API endpoint. */
async function fakeApi(handler: Handler): Promise<{ baseURL: string; requests: Captured[] }> {
  const requests: Captured[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const captured: Captured = {
        method: incoming.method,
        url: incoming.url,
        headers: incoming.headers,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
      };
      requests.push(captured);
      handler(captured, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({ close: () => server.close() });
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, requests };
}

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json", ...headers });
  response.end(JSON.stringify(body));
}

function message(text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "served-model",
    content: [
      { type: "thinking", thinking: "", signature: "sig" },
      { type: "text", text, citations: null },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: null,
    },
    ...overrides,
  };
}

function apiError(type: string, text: string): Record<string, unknown> {
  return { type: "error", error: { type, message: text }, request_id: "req_err" };
}

describe("AnthropicProvider", () => {
  const env = { ANTHROPIC_API_KEY: "test-key-not-real" };

  it("needs a credential from the environment", () => {
    expect(() => new AnthropicProvider({ env: {} })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => new AnthropicProvider({ env: { ANTHROPIC_AUTH_TOKEN: "t" } })).not.toThrow();
  });

  it("builds Messages API parameters without sampling settings", () => {
    const params = toCreateParams(
      request("hi", {
        temperature: 0.2,
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "{}" },
          { role: "user", content: "fix it" },
        ],
        responseFormat: {
          name: "answer",
          jsonSchema: {
            type: "object",
            properties: { title: { type: "string", minLength: 1 } },
            required: ["title"],
          },
        },
      }),
    );
    expect(params).not.toHaveProperty("temperature");
    expect(params).toMatchObject({
      model: "test-model",
      max_tokens: 500,
      system: "system text",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "{}" },
        { role: "user", content: "fix it" },
      ],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { title: { type: "string", description: "(minLength: 1)" } },
          },
        },
      },
    });
  });

  it("sends one request with the key and maps the answer", async () => {
    const api = await fakeApi((_captured, response) => {
      json(response, 200, message('{"title":"x"}'), { "request-id": "req_ok" });
    });
    const provider = new AnthropicProvider({ env, baseURL: api.baseURL });
    const answer = await provider.generate(
      request("hi", { responseFormat: { name: "a", jsonSchema: { type: "object" } } }),
      never,
    );

    expect(answer).toEqual({
      text: '{"title":"x"}',
      model: "served-model",
      stopReason: "end_turn",
      usage: { inputTokens: 13, outputTokens: 5, cacheReadTokens: 3 },
      providerRequestId: "req_ok",
    });
    const [sent] = api.requests;
    expect(sent?.method).toBe("POST");
    expect(sent?.url).toMatch(/^\/v1\/messages/);
    const credential = [sent?.headers["x-api-key"], sent?.headers.authorization].join(" ");
    expect(credential).toContain("test-key-not-real");
    expect(sent?.body).toMatchObject({
      model: "test-model",
      max_tokens: 500,
      output_config: { format: { type: "json_schema" } },
    });
  });

  it("maps stop reasons", async () => {
    const reasons: Record<string, string> = {
      max_tokens: "max_tokens",
      model_context_window_exceeded: "max_tokens",
      refusal: "refusal",
      pause_turn: "other",
    };
    for (const [wire, expected] of Object.entries(reasons)) {
      const api = await fakeApi((_captured, response) => {
        json(response, 200, message("", { stop_reason: wire }));
      });
      const provider = new AnthropicProvider({ env, baseURL: api.baseURL });
      expect((await provider.generate(request("x"), never)).stopReason).toBe(expected);
    }
  });

  it("translates rate limits with retry-after and leaves retrying to the gateway", async () => {
    const api = await fakeApi((_captured, response) => {
      json(response, 429, apiError("rate_limit_error", "slow down"), { "retry-after": "7" });
    });
    const provider = new AnthropicProvider({ env, baseURL: api.baseURL });
    const error = await rejection(provider.generate(request("x"), never));
    expect(error).toBeInstanceOf(LlmProviderError);
    expect(error).toMatchObject({
      kind: "rate-limit",
      retryable: true,
      status: 429,
      retryAfterMs: 7_000,
    });
    expect(api.requests).toHaveLength(1);
  });

  it("classifies overload, server, authentication and bad-request errors", async () => {
    const cases: [number, string, string, boolean][] = [
      [529, "overloaded_error", "overloaded", true],
      [500, "api_error", "server", true],
      [401, "authentication_error", "authentication", false],
      [400, "invalid_request_error", "invalid-request", false],
      [404, "not_found_error", "not-found", false],
    ];
    for (const [status, type, kind, retryable] of cases) {
      const api = await fakeApi((_captured, response) => {
        json(response, status, apiError(type, "nope"));
      });
      const provider = new AnthropicProvider({ env, baseURL: api.baseURL });
      const error = await rejection(provider.generate(request("x"), never));
      expect(error).toMatchObject({ kind, retryable, status });
      expect((error as Error).message).toBe(`Anthropic API error ${status}: nope`);
    }
  });

  it("reports an unreachable endpoint as a network failure", async () => {
    const api = await fakeApi(() => undefined);
    servers.splice(0).forEach((server) => {
      server.close();
    });
    const provider = new AnthropicProvider({ env, baseURL: api.baseURL });
    const error = await rejection(provider.generate(request("x"), never));
    expect(error).toMatchObject({ kind: "network", retryable: true });
  });

  it("lets the gateway turn a caller abort into CANCELLED", async () => {
    const api = await fakeApi(() => undefined); // never answers
    const controller = new AbortController();
    const redactor = new SecretRedactor();
    const gateway = new LlmGateway({
      provider: new AnthropicProvider({ env, baseURL: api.baseURL }),
      redactor,
      budget: new BudgetTracker(),
    });
    const pending = gateway.generateStructured({
      step: "s",
      templateId: "t",
      templateVersion: "1",
      model: "test-model",
      system: "s",
      user: "u",
      files: [],
      schema: z.strictObject({ title: z.string() }),
      schemaName: "answer",
      maxOutputTokens: 100,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort();
    }, 50);
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.Cancelled });
  });

  it("serves a structured call end to end through the gateway", async () => {
    const api = await fakeApi((_captured, response) => {
      json(response, 200, message('{"title":"Paginate orders"}'));
    });
    const gateway = new LlmGateway({
      provider: new AnthropicProvider({ env, baseURL: api.baseURL }),
      redactor: new SecretRedactor(),
      budget: new BudgetTracker(),
    });
    const result = await gateway.generateStructured({
      step: "planning",
      templateId: "plan",
      templateVersion: "1",
      model: "test-model",
      system: "Plan.",
      user: "Task.",
      files: [],
      schema: z.strictObject({ title: z.string().min(1) }),
      schemaName: "plan",
      maxOutputTokens: 64_000,
    });
    expect(result.value).toEqual({ title: "Paginate orders" });
    const schema = (api.requests[0]?.body.output_config as { format: { schema: unknown } }).format
      .schema;
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: { title: { type: "string", description: "(minLength: 1)" } },
    });
  });
});

const liveModel = process.env.DEVFLOW_LIVE_MODEL;
const liveKey = process.env.ANTHROPIC_API_KEY;
const liveReason =
  liveKey === undefined || liveKey === ""
    ? "ANTHROPIC_API_KEY is not set"
    : liveModel === undefined || liveModel === ""
      ? "DEVFLOW_LIVE_MODEL is not set"
      : undefined;

describe.skipIf(liveReason !== undefined)(
  `AnthropicProvider against the live API${liveReason === undefined ? "" : ` (skipped: ${liveReason})`}`,
  () => {
    it("returns a schema-valid answer", async () => {
      const gateway = new LlmGateway({
        provider: new AnthropicProvider(),
        redactor: new SecretRedactor(),
        budget: new BudgetTracker(),
      });
      const result = await gateway.generateStructured({
        step: "live",
        templateId: "live-check",
        templateVersion: "1",
        model: liveModel ?? "",
        system: "Answer with the requested JSON only.",
        user: "Give the capital of France.",
        files: [],
        schema: z.strictObject({ capital: z.string() }),
        schemaName: "capital",
        maxOutputTokens: 2_000,
      });
      expect(result.value.capital.toLowerCase()).toContain("paris");
    }, 120_000);
  },
);
