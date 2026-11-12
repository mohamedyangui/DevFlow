import { FakeProvider, LlmProviderError } from "@devflow-ai/ai";
import { AuditLog, SecretRedactor } from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import {
  OtlpTraceRequest,
  type RunRecord,
  RunStore,
  type RunTrace,
  type RunTraceInput,
  type TraceSpan,
  buildRunTrace,
  readRunTrace,
  startRun,
  toOtlpRequest,
} from "../src/index.js";
import {
  SECRET,
  analysisAnswer,
  isAnalysis,
  planAnswer,
  services,
  settings,
  task,
  workspace,
} from "./helpers.js";

/** Strings that must never appear in an export: prompt, answer, output and secret content. */
const PROMPT_MARKER = "PROMPT-MARKER-7731";
const ANSWER_MARKER = "ANSWER-MARKER-4410";
const OUTPUT_MARKER = "OUTPUT-MARKER-2290";
const ARGUMENT_MARKER = "ARGUMENT-MARKER-5512";
const TITLE = "Paginate the order list for the secret project";

function span(trace: RunTrace, predicate: (span: TraceSpan) => boolean): TraceSpan {
  const found = trace.spans.find(predicate);
  if (found === undefined) throw new Error("no such span");
  return found;
}

/** A scripted plan-goal run whose prompts and answers carry the secret and the markers. */
async function scriptedRun(): Promise<{ root: string; store: RunStore; provider: FakeProvider }> {
  const root = await workspace();
  let failedOnce = false;
  const provider = new FakeProvider((request) => {
    if (isAnalysis(request)) {
      if (!failedOnce) {
        failedOnce = true;
        return new LlmProviderError("rate-limit", "slow down", { retryAfterMs: 1 });
      }
      return analysisAnswer().replace(
        "Add page and size parameters to listOrders.",
        `${ANSWER_MARKER} ${SECRET}`,
      );
    }
    return planAnswer({ summary: `${ANSWER_MARKER} plan` });
  });
  const outcome = await startRun(
    {
      task: task({
        title: TITLE,
        description: `listOrders must return one page. ${PROMPT_MARKER} token=${SECRET}`,
      }),
      taskFile: "tasks/TASK-7.yaml",
      mode: "assist",
      goal: "plan",
      settings: settings({ requirePlanApproval: false }),
    },
    await services(root, provider),
  );
  expect(outcome.status, JSON.stringify(outcome.error)).toBe("completed");
  const store = await RunStore.open(root, outcome.runId);
  // A gate command, as the executor records it: arguments and output paths must not leave.
  const audit = await AuditLog.open(store.path("audit.jsonl"), {
    redactor: new SecretRedactor({ knownSecrets: [SECRET] }),
    runId: store.id,
  });
  await audit.append({
    type: "command",
    commandId: "test-shop",
    argv: ["node_modules/.bin/vitest", "run", ARGUMENT_MARKER, `--token=${SECRET}`],
    cwd: ".",
    decision: "allowed",
    approval: "trust-store",
    invocation: "direct",
    exitCode: 1,
    durationMs: 1200,
    timedOut: false,
    backend: "local",
  });
  await store.writeJson("artifacts/baseline.json", {
    gates: [{ gateId: "unit", commandId: "test-shop", reason: OUTPUT_MARKER }],
  });
  return { root, store, provider };
}

describe("run trace", () => {
  it("has one root span, a span per step and a span per model call and command", async () => {
    const { store } = await scriptedRun();
    const trace = await readRunTrace(store, new SecretRedactor({ knownSecrets: [SECRET] }));

    expect(trace.traceId).toMatch(/^[0-9a-f]{32}$/);
    const roots = trace.spans.filter((item) => item.parentSpanId === undefined);
    expect(roots).toHaveLength(1);
    const root = roots[0];
    expect(root?.name).toBe("devflow assist");
    expect(root?.status.code).toBe("ok");
    expect(root?.attributes).toMatchObject({
      "devflow.run.id": store.id,
      "devflow.run.mode": "assist",
      "devflow.run.goal": "plan",
      "devflow.run.state": "COMPLETED",
      "devflow.task.id": "TASK-7",
      "gen_ai.provider.name": "fake",
      "devflow.gen_ai.calls": 2,
    });

    const steps = trace.spans.filter((item) => item.name.startsWith("step "));
    expect(steps.map((item) => item.attributes["devflow.step.name"])).toEqual([
      "context-loading",
      "requirements-analysis",
      "planning",
    ]);
    for (const step of steps) {
      expect(step.parentSpanId).toBe(root?.spanId);
      expect(step.status.code).toBe("ok");
      expect(step.endMs).toBeGreaterThanOrEqual(step.startMs);
    }

    const calls = trace.spans.filter((item) => item.attributes["gen_ai.operation.name"] === "chat");
    expect(calls).toHaveLength(2);
    const analysisStep = span(
      trace,
      (item) =>
        item.attributes["devflow.step.name"] === "requirements-analysis" &&
        item.name.startsWith("step"),
    );
    const analysisCall = span(
      trace,
      (item) =>
        item.attributes["gen_ai.operation.name"] === "chat" &&
        item.attributes["devflow.step.name"] === "requirements-analysis",
    );
    expect(analysisCall.parentSpanId).toBe(analysisStep.spanId);
    expect(analysisCall.kind).toBe("client");
    expect(analysisCall.name).toBe("chat test-model");
    expect(analysisCall.attributes).toMatchObject({
      "gen_ai.provider.name": "fake",
      "gen_ai.response.model": "test-model",
      "devflow.gen_ai.outcome": "ok",
      "devflow.gen_ai.attempts": 2,
      "devflow.gen_ai.retries": 1,
    });
    expect(analysisCall.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(analysisCall.attributes["gen_ai.usage.output_tokens"]).toBeGreaterThan(0);
    const planningCall = span(
      trace,
      (item) =>
        item.attributes["gen_ai.operation.name"] === "chat" &&
        item.attributes["devflow.step.name"] === "planning",
    );
    expect(planningCall.parentSpanId).toBe(
      span(trace, (item) => item.name === "step planning").spanId,
    );
    expect(planningCall.attributes["devflow.gen_ai.retries"]).toBe(0);

    const command = span(trace, (item) => item.attributes["devflow.command.id"] === "test-shop");
    expect(command.name).toBe("gate test-shop");
    expect(command.attributes).toEqual({
      "devflow.command.id": "test-shop",
      "devflow.command.purpose": "gate",
      "devflow.gate.id": "unit",
      "process.executable.name": "vitest",
      "devflow.command.decision": "allowed",
      "devflow.command.status": "failed",
      "process.exit.code": 1,
      "devflow.command.duration_ms": 1200,
      "devflow.command.timed_out": false,
      "devflow.command.backend": "local",
      "devflow.command.invocation": "direct",
      "devflow.command.approval": "trust-store",
      "error.type": "failed",
    });
    expect(command.endMs - command.startMs).toBe(1200);
    expect(command.status.code).toBe("error");
  });

  it("never exports a prompt, an answer, a title, an argument, an output or a secret", async () => {
    const { store, provider } = await scriptedRun();
    // The markers did reach the model and the run's own files, so their absence is meaningful.
    expect(
      provider.requests.some((request) => JSON.stringify(request).includes(PROMPT_MARKER)),
    ).toBe(true);
    expect(await store.readText("artifacts/analysis.json")).toContain(ANSWER_MARKER);

    // A redactor that knows nothing: the export must not depend on redaction to stay clean.
    const request = toOtlpRequest(await readRunTrace(store, new SecretRedactor()));
    expect(OtlpTraceRequest.safeParse(request).success).toBe(true);
    const exported = JSON.stringify(request);
    for (const forbidden of [
      SECRET,
      PROMPT_MARKER,
      ANSWER_MARKER,
      OUTPUT_MARKER,
      ARGUMENT_MARKER,
      TITLE,
      "listOrders",
      "src/orders.ts",
      "requirements analyst",
    ]) {
      expect(exported).not.toContain(forbidden);
    }

    // Only the attribute names of the allowlist appear.
    const allowed = new Set([
      "service.name",
      "service.version",
      "devflow.run.id",
      "devflow.run.mode",
      "devflow.run.goal",
      "devflow.run.state",
      "devflow.task.id",
      "devflow.workspace.trusted",
      "devflow.gen_ai.calls",
      "devflow.gen_ai.cost.usd",
      "devflow.gen_ai.unpriced_calls",
      "devflow.gen_ai.outcome",
      "devflow.gen_ai.attempts",
      "devflow.gen_ai.retries",
      "devflow.prompt.template.id",
      "devflow.prompt.template.version",
      "devflow.prompt.files.count",
      "devflow.step.name",
      "devflow.step.outcome",
      "devflow.command.id",
      "devflow.command.purpose",
      "devflow.command.decision",
      "devflow.command.status",
      "devflow.command.duration_ms",
      "devflow.command.timed_out",
      "devflow.command.backend",
      "devflow.command.invocation",
      "devflow.command.approval",
      "devflow.command.denial",
      "devflow.gate.id",
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.response.model",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "process.executable.name",
      "process.exit.code",
      "error.type",
    ]);
    const resource = request.resourceSpans[0];
    const keys = [
      ...(resource?.resource.attributes ?? []),
      ...(resource?.scopeSpans[0]?.spans.flatMap((item) => item.attributes) ?? []),
    ].map((attribute) => attribute.key);
    expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
  });

  it("encodes OTLP/JSON: hex ids, nanosecond strings, kinds, status codes", async () => {
    const { store } = await scriptedRun();
    const trace = await readRunTrace(store, new SecretRedactor());
    const request = OtlpTraceRequest.parse(JSON.parse(JSON.stringify(toOtlpRequest(trace))));
    const scope = request.resourceSpans[0]?.scopeSpans[0];
    expect(scope?.scope).toEqual({ name: "devflow", version: "0.0.0-test" });
    expect(request.resourceSpans[0]?.resource.attributes).toContainEqual({
      key: "service.name",
      value: { stringValue: "devflow" },
    });
    const spans = scope?.spans ?? [];
    expect(spans).toHaveLength(trace.spans.length);
    expect(new Set(spans.map((item) => item.traceId))).toEqual(new Set([trace.traceId]));
    const ids = new Set(spans.map((item) => item.spanId));
    expect(ids.size).toBe(spans.length);
    for (const item of spans) {
      if (item.parentSpanId !== undefined) expect(ids.has(item.parentSpanId)).toBe(true);
      expect(BigInt(item.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(item.startTimeUnixNano));
    }
    const call = spans.find((item) => item.kind === 3);
    expect(call?.attributes).toContainEqual({
      key: "devflow.gen_ai.attempts",
      value: { intValue: "2" },
    });
    expect(spans.find((item) => item.parentSpanId === undefined)?.status.code).toBe(1);
    expect(spans.find((item) => item.name === "gate test-shop")?.status.code).toBe(2);
  });

  it("gives the same ids when the same run is exported twice", async () => {
    const { store } = await scriptedRun();
    const first = await readRunTrace(store, new SecretRedactor());
    const second = await readRunTrace(store, new SecretRedactor());
    expect(second).toEqual(first);
  });
});

describe("buildRunTrace", () => {
  const record: RunRecord = {
    schemaVersion: 1,
    id: "2026-11-07T10-00-00Z_TASK-7",
    devflowVersion: "0.6.0",
    mode: "implement",
    goal: "implement",
    state: "FAILED",
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:05:00.000Z",
    finishedAt: "2026-11-07T10:05:00.000Z",
    task: { id: "TASK-7", title: TITLE, file: null, sha256: "a".repeat(64) },
    settings: settings({ provider: "anthropic" }),
    budgetUsage: {
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
      callsByStep: {},
      costUsd: 0,
      unpricedCalls: 0,
    },
    iterations: { analysis: 1, planning: 1 },
    pending: null,
    lastError: {
      code: "LLM_REQUEST_FAILED",
      message: `${ANSWER_MARKER} ${SECRET}`,
      state: "IMPLEMENTATION",
      at: "2026-11-07T10:05:00.000Z",
      resumable: false,
    },
    warnings: [PROMPT_MARKER],
  };

  const input: RunTraceInput = {
    record,
    events: [
      { seq: 0, at: "2026-11-07T10:00:00.000Z", type: "created", state: "TASK_RECEIVED" },
      {
        seq: 1,
        at: "2026-11-07T10:01:00.000Z",
        type: "step-started",
        state: "VERIFICATION",
        step: "verification",
      },
      {
        seq: 2,
        at: "2026-11-07T10:02:00.000Z",
        type: "step-completed",
        state: "IMPLEMENTATION",
        step: "verification",
      },
      {
        seq: 3,
        at: "2026-11-07T10:03:00.000Z",
        type: "step-started",
        state: "IMPLEMENTATION",
        step: "implementation",
      },
      {
        seq: 4,
        at: "2026-11-07T10:05:00.000Z",
        type: "step-failed",
        state: "IMPLEMENTATION",
        detail: `LLM_REQUEST_FAILED: ${ANSWER_MARKER} ${SECRET}`,
      },
    ],
    audit: [
      {
        seq: 0,
        at: "2026-11-07T10:01:30.000Z",
        type: "command",
        commandId: "test",
        argv: ["C:\\tools\\gradlew.bat", "test", ARGUMENT_MARKER],
        cwd: ".",
        decision: "allowed",
        exitCode: 0,
        durationMs: 20_000,
        timedOut: false,
        backend: "container",
      },
      {
        seq: 1,
        at: "2026-11-07T10:01:40.000Z",
        type: "command",
        commandId: "contracts:oasdiff-breaking",
        argv: ["oasdiff", ARGUMENT_MARKER],
        cwd: ".",
        decision: "denied",
        reason: `approval-required: ${OUTPUT_MARKER}`,
      },
      {
        seq: 2,
        at: "2026-11-07T10:04:00.000Z",
        type: "llm-call",
        provider: "anthropic",
        model: `model-${SECRET}`,
        templateId: "implementation",
        templateVersion: "1",
        promptSha256: "b".repeat(64),
        files: ["src/orders.ts"],
        inputTokens: 100,
        outputTokens: 0,
        costUsd: null,
        outcome: "error",
        step: "implementation",
        durationMs: 30_000,
        attempts: 3,
      },
      {
        seq: 3,
        at: "2026-11-07T10:04:10.000Z",
        type: "decision",
        subject: "plan",
        decision: "rejected",
        by: "mohamed",
        feedback: PROMPT_MARKER,
      },
    ],
    gates: new Map([["test", ["unit", "integration"]]]),
  };

  it("parents commands and calls to the step that was running, and reports failures by code", () => {
    const trace = buildRunTrace(input, new SecretRedactor({ knownSecrets: [SECRET] }));
    const verification = span(trace, (item) => item.name === "step verification");
    const implementation = span(trace, (item) => item.name === "step implementation");
    const gate = span(trace, (item) => item.name === "gate test");
    expect(gate.parentSpanId).toBe(verification.spanId);
    expect(gate.startMs).toBe(Date.parse("2026-11-07T10:01:10.000Z"));
    expect(gate.attributes).toMatchObject({
      "devflow.gate.id": "unit,integration",
      "process.executable.name": "gradlew.bat",
      "devflow.command.backend": "container",
      "devflow.command.status": "ok",
    });
    const denied = span(trace, (item) => item.name === "contract-tool contracts:oasdiff-breaking");
    expect(denied.attributes).toMatchObject({
      "devflow.command.status": "denied",
      "devflow.command.denial": "approval-required",
    });
    expect(denied.startMs).toBe(denied.endMs);

    const call = span(trace, (item) => item.kind === "client");
    expect(call.parentSpanId).toBe(implementation.spanId);
    expect(call.attributes["gen_ai.request.model"]).toMatch(
      /^model-«REDACTED:known-secret:[0-9a-f]{4}»$/,
    );
    expect(call.attributes).toMatchObject({
      "devflow.gen_ai.retries": 2,
      "error.type": "error",
    });
    expect(call.status).toEqual({ code: "error", message: "error" });

    expect(implementation.status).toEqual({ code: "error", message: "LLM_REQUEST_FAILED" });
    expect(implementation.attributes["devflow.step.outcome"]).toBe("failed");
    const root = span(trace, (item) => item.parentSpanId === undefined);
    expect(root.status).toEqual({ code: "error", message: "LLM_REQUEST_FAILED" });
    expect(root.endMs - root.startMs).toBe(5 * 60_000);

    const exported = JSON.stringify(toOtlpRequest(trace));
    for (const forbidden of [
      SECRET,
      ANSWER_MARKER,
      PROMPT_MARKER,
      OUTPUT_MARKER,
      ARGUMENT_MARKER,
    ]) {
      expect(exported).not.toContain(forbidden);
    }
    expect(exported).not.toContain("src/orders.ts");
    expect(exported).toContain('"doubleValue":0');
  });

  it("leaves a step that never ended open until the end of the run, without an error", () => {
    const trace = buildRunTrace(
      {
        ...input,
        record: { ...record, state: "IMPLEMENTATION", finishedAt: null, lastError: null },
        events: input.events.slice(0, 4),
      },
      new SecretRedactor(),
    );
    const implementation = span(trace, (item) => item.name === "step implementation");
    expect(implementation.attributes["devflow.step.outcome"]).toBe("incomplete");
    expect(implementation.status).toEqual({ code: "unset" });
    expect(implementation.endMs).toBe(Date.parse("2026-11-07T10:05:00.000Z"));
    expect(span(trace, (item) => item.parentSpanId === undefined).status.code).toBe("unset");
  });
});
