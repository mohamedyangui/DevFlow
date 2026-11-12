import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevflowError, ErrorCode, type LlmRequest, SecretRedactor } from "@devflow/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AGENT_INSTRUCTIONS,
  AGENT_MODEL,
  AgentProvider,
  BudgetTracker,
  LlmGateway,
  MAX_AGENT_ANSWER_CHARS,
  agentPromptFile,
  agentRequestIdIn,
  createProvider,
  readAgentRequest,
  renderAgentPrompt,
  requestFingerprint,
  writeAgentAnswer,
} from "../src/index.js";

const CLOCK = () => new Date("2026-11-12T10:00:00.000Z");

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: AGENT_MODEL,
    system: "You analyse requirements.",
    messages: [{ role: "user", content: "Analyse TASK-1." }],
    maxOutputTokens: 1_000,
    temperature: 0,
    responseFormat: {
      name: "analysis",
      jsonSchema: { type: "object", properties: { summary: { type: "string" } } },
    },
    ...overrides,
  };
}

async function directory(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "devflow-agent-"));
}

async function waitingError(promise: Promise<unknown>): Promise<DevflowError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DevflowError);
  return error as DevflowError;
}

describe("AgentProvider (ADR 0027)", () => {
  it("saves an unanswered request and waits for the agent, naming the request", async () => {
    const dir = await directory();
    const provider = new AgentProvider({ directory: dir, clock: CLOCK });
    const sent = request();
    const error = await waitingError(provider.generate(sent, new AbortController().signal));
    const id = requestFingerprint(sent);
    expect(error.code).toBe(ErrorCode.AgentInputRequired);
    expect(agentRequestIdIn(error.message)).toBe(id);
    expect(error.details).toEqual({ requestId: id, format: "analysis" });
    expect((await readdir(dir)).sort()).toEqual([`${id}.prompt.md`, `${id}.request.json`]);
    expect(await readAgentRequest(dir, id)).toEqual({
      schemaVersion: 1,
      id,
      createdAt: "2026-11-12T10:00:00.000Z",
      request: sent,
    });
  });

  it("writes the prompt as plain text too, for agents that read it in parts", async () => {
    const dir = await directory();
    const sent = request();
    await waitingError(
      new AgentProvider({ directory: dir }).generate(sent, new AbortController().signal),
    );
    const id = requestFingerprint(sent);
    const prompt = await readFile(agentPromptFile(dir, id), "utf8");
    expect(prompt).toContain(`# DevFlow model request ${id}`);
    expect(prompt).toContain(AGENT_INSTRUCTIONS);
    expect(prompt).toContain("## System\n\nYou analyse requirements.");
    expect(prompt).toContain("## user\n\nAnalyse TASK-1.");
    expect(prompt).toContain("## JSON schema (analysis)");
    const saved = await readAgentRequest(dir, id);
    if (saved === undefined) throw new Error("not saved");
    expect(prompt).toBe(renderAgentPrompt(saved));
  });

  it("serves a stored answer, marked stored, with no tokens", async () => {
    const dir = await directory();
    const provider = new AgentProvider({ directory: dir, clock: CLOCK });
    const sent = request();
    const id = requestFingerprint(sent);
    await waitingError(provider.generate(sent, new AbortController().signal));
    await writeAgentAnswer(dir, id, '{"summary":"ok"}', CLOCK);
    expect(await provider.generate(sent, new AbortController().signal)).toEqual({
      text: '{"summary":"ok"}',
      model: AGENT_MODEL,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
      stored: true,
    });
    const answer = JSON.parse(await readFile(path.join(dir, `${id}.answer.json`), "utf8")) as {
      answeredAt: string;
    };
    expect(answer.answeredAt).toBe("2026-11-12T10:00:00.000Z");
  });

  it("keeps a request without a schema optional fields out of the saved request", async () => {
    const dir = await directory();
    const provider = new AgentProvider({ directory: dir });
    const { temperature: _temperature, responseFormat: _format, ...plain } = request();
    const id = requestFingerprint(plain);
    await waitingError(provider.generate(plain, new AbortController().signal));
    const saved = await readAgentRequest(dir, id);
    expect(saved?.request).toEqual(plain);
    expect(saved?.request).not.toHaveProperty("temperature");
    // Text is enough when the request asks for no JSON.
    await writeAgentAnswer(dir, id, "A plain answer.");
    expect((await provider.generate(plain, new AbortController().signal)).text).toBe(
      "A plain answer.",
    );
  });

  it("stops at once when the call is aborted", async () => {
    const dir = await directory();
    const controller = new AbortController();
    controller.abort();
    await expect(
      new AgentProvider({ directory: dir }).generate(request(), controller.signal),
    ).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("writeAgentAnswer", () => {
  async function waiting(): Promise<{ dir: string; id: string }> {
    const dir = await directory();
    const sent = request();
    await waitingError(
      new AgentProvider({ directory: dir }).generate(sent, new AbortController().signal),
    );
    return { dir, id: requestFingerprint(sent) };
  }

  async function invalid(promise: Promise<unknown>): Promise<string> {
    const error = await waitingError(promise);
    expect(error.code).toBe(ErrorCode.AgentAnswerInvalid);
    return error.message;
  }

  it("refuses an answer to a request that was never saved", async () => {
    const { dir } = await waiting();
    expect(await invalid(writeAgentAnswer(dir, "a".repeat(64), "{}"))).toContain(
      "no saved model request",
    );
    expect(await invalid(writeAgentAnswer(dir, "../escape", "{}"))).toContain(
      "no saved model request",
    );
  });

  it("refuses an empty, an oversized or a non-JSON answer to a JSON request", async () => {
    const { dir, id } = await waiting();
    expect(await invalid(writeAgentAnswer(dir, id, "  "))).toContain("between 1 and");
    expect(
      await invalid(writeAgentAnswer(dir, id, "x".repeat(MAX_AGENT_ANSWER_CHARS + 1))),
    ).toContain("between 1 and");
    expect(await invalid(writeAgentAnswer(dir, id, "Sure! Here it is: {"))).toContain(
      "must be JSON matching the analysis schema",
    );
    expect((await readdir(dir)).sort()).toEqual([`${id}.prompt.md`, `${id}.request.json`]);
  });

  it("refuses a saved request that was tampered with", async () => {
    const { dir, id } = await waiting();
    await writeFile(path.join(dir, `${id}.request.json`), '{"schemaVersion":1,"id":"other"}');
    expect(await invalid(writeAgentAnswer(dir, id, "{}"))).toContain("unreadable");
  });

  it("finds the request id only in a waiting message", () => {
    const id = "0123456789abcdef".repeat(4);
    expect(agentRequestIdIn(`waiting for the coding agent to answer model request ${id}`)).toBe(id);
    expect(agentRequestIdIn("the model failed")).toBeUndefined();
  });
});

describe("the gateway with stored answers", () => {
  it("counts only new model calls against the budget", async () => {
    const dir = await directory();
    const budget = new BudgetTracker();
    const gateway = new LlmGateway({
      provider: new AgentProvider({ directory: dir }),
      redactor: new SecretRedactor({ knownSecrets: [] }),
      budget,
    });
    const call = {
      step: "analysis",
      templateId: "requirements-analysis",
      templateVersion: "1",
      model: AGENT_MODEL,
      system: "You analyse requirements.",
      user: "Analyse TASK-1.",
      files: [],
      schema: z.strictObject({ summary: z.string() }),
      schemaName: "analysis",
      maxOutputTokens: 1_000,
    };
    const error = await waitingError(gateway.generateStructured(call));
    expect(error.code).toBe(ErrorCode.AgentInputRequired);
    const id = agentRequestIdIn(error.message);
    if (id === undefined) throw new Error("no request id");
    await writeAgentAnswer(dir, id, '{"summary":"ok"}');
    const result = await gateway.generateStructured(call);
    expect(result.value).toEqual({ summary: "ok" });
    expect(budget.usage()).toMatchObject({ calls: 0, inputTokens: 0, outputTokens: 0 });
  });
});

describe("createProvider agent", () => {
  it("needs the workspace's agent directory", async () => {
    const error = await waitingError(createProvider({ name: "agent" }));
    expect(error.code).toBe(ErrorCode.LlmProviderNotConfigured);
    const dir = await directory();
    expect((await createProvider({ name: "agent", agentDirectory: dir })).id).toBe("agent");
  });
});
