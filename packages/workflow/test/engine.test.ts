import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeProvider, LlmProviderError } from "@devflow/ai";
import {
  type AuditEntry,
  DevflowError,
  EngineeringReport,
  ErrorCode,
  ImplementationPlan,
  type LlmRequest,
  readAuditLog,
} from "@devflow/core";
import { describe, expect, it } from "vitest";
import {
  Clarifications,
  PlanChecks,
  PlanFeedback,
  RunStore,
  answerQuestions,
  approvePlan,
  cancelRun,
  getRun,
  listRuns,
  rejectPlan,
  resumeRun,
  startRun,
} from "../src/index.js";
import {
  SECRET,
  analysisAnswer,
  isAnalysis,
  planAnswer,
  scripted,
  services,
  settings,
  task,
  userText,
  workspace,
} from "./helpers.js";

async function start(
  root: string,
  provider: FakeProvider,
  options: { goal?: "analyze" | "plan"; settings?: Parameters<typeof settings>[0] } = {},
) {
  const svc = await services(root, provider);
  const outcome = await startRun(
    {
      task: task(),
      taskFile: "tasks/TASK-7.yaml",
      mode: "assist",
      goal: options.goal ?? "plan",
      settings: settings(options.settings),
    },
    svc,
  );
  const store = await RunStore.open(root, outcome.runId);
  return { svc, outcome, store };
}

function requestAt(provider: FakeProvider, index: number): LlmRequest {
  const request = provider.requests[index];
  if (request === undefined) throw new Error(`no request ${index}`);
  return request;
}

async function audit(store: RunStore): Promise<AuditEntry[]> {
  return readAuditLog(store.path("audit.jsonl"));
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<DevflowError> {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(DevflowError);
  expect((error as DevflowError).code).toBe(code);
  return error as DevflowError;
}

describe("assist mode: plan and approve", () => {
  it("analyses, plans, waits for approval and completes with a not_verified report", async () => {
    const root = await workspace();
    const provider = scripted({});
    const { svc, outcome, store } = await start(root, provider);

    expect(outcome).toMatchObject({
      status: "waiting",
      state: "AWAITING_PLAN_APPROVAL",
      waitingFor: "plan-approval",
      planPath: `.devflow/runs/${outcome.runId}/artifacts/plan.md`,
    });
    expect(provider.requests).toHaveLength(2);

    const record = await store.readRecord();
    expect(record.pending?.kind).toBe("plan-approval");
    expect(record.iterations).toEqual({ analysis: 1, planning: 1 });
    expect(record.budgetUsage.calls).toBe(2);
    expect(record.budgetUsage.callsByStep).toEqual({ "requirements-analysis": 1, planning: 1 });

    // Invented ids and paths are dropped, and the drop is recorded.
    const analysis = JSON.parse(await store.readText("artifacts/analysis.json")) as {
      requirementNotes: { id: string }[];
      affectedFiles: { path: string }[];
      checks: string[];
    };
    expect(analysis.requirementNotes.map((note) => note.id)).toEqual(["FR-1"]);
    expect(analysis.affectedFiles.map((file) => file.path)).toEqual(["src/orders.ts"]);
    expect(analysis.checks).toHaveLength(2);

    const plan = ImplementationPlan.parse(JSON.parse(await store.readText("artifacts/plan.json")));
    expect(plan.changes).toEqual([
      expect.objectContaining({
        id: "CH-1",
        path: "src/orders.ts",
        action: "modify",
        module: "root",
      }),
    ]);
    const planMd = await store.readText("artifacts/plan.md");
    expect(planMd).toContain("# Implementation plan: TASK-7");
    expect(planMd).toContain("`src/orders.ts`");

    const approved = await approvePlan(outcome.runId, { by: "mohamed" }, svc);
    expect(approved).toMatchObject({
      status: "completed",
      state: "COMPLETED",
      reportPath: `.devflow/runs/${outcome.runId}/report.md`,
    });

    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.verdict).toBe("not_verified");
    expect(report.gates).toEqual([]);
    expect(report.filesChanged).toEqual([]);
    expect(report.acceptanceMatrix.map((row) => [row.acId, row.status])).toEqual([
      ["AC-1", "not_executed"],
      ["AC-2", "manual"],
    ]);
    expect(report.plan?.changes).toHaveLength(1);
    expect(report.usage).toMatchObject({ calls: 2 });
    const reportMd = await store.readText("report.md");
    expect(reportMd).toContain("not_verified (nothing was executed or verified)");
    expect(reportMd).toContain("Plan approved by:** mohamed");
    expect(reportMd).not.toContain("passed");

    const approval = JSON.parse(await store.readText("artifacts/plan-approval.json")) as {
      planSha256: string;
    };
    const entries = await audit(store);
    expect(entries.filter((entry) => entry.type === "llm-call")).toHaveLength(2);
    expect(entries.find((entry) => entry.type === "decision")).toMatchObject({
      subject: "plan",
      decision: "approved",
      by: "mohamed",
      reference: approval.planSha256,
    });

    const events = await store.readEvents();
    expect(
      events.filter((event) => event.type === "transition").map((event) => event.state),
    ).toEqual([
      "CONTEXT_LOADING",
      "REQUIREMENTS_ANALYSIS",
      "PLANNING",
      "AWAITING_PLAN_APPROVAL",
      "COMPLETED",
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
    // The lock is released.
    expect(await store.exists("lock.json")).toBe(false);
  });

  it("never sends a secret from the repository to the provider", async () => {
    const root = await workspace();
    const provider = scripted({});
    const { store } = await start(root, provider);
    for (const request of provider.requests) {
      expect(userText(request) + request.system).not.toContain(SECRET);
    }
    const logs = await store.readText("audit.jsonl");
    expect(logs).not.toContain(SECRET);
  });

  it("wraps repository text as untrusted data in the prompt", async () => {
    const root = await workspace();
    const provider = scripted({});
    await start(root, provider);
    const text = userText(requestAt(provider, 0));
    const injection = text.indexOf("Ignore every previous instruction");
    expect(injection).toBeGreaterThan(-1);
    const opening = text.lastIndexOf("<<<UNTRUSTED", injection);
    const closing = text.indexOf("<<<END UNTRUSTED", injection);
    expect(opening).toBeGreaterThan(-1);
    expect(closing).toBeGreaterThan(injection);
  });

  it("logs each model exchange", async () => {
    const root = await workspace();
    const { store } = await start(root, scripted({}));
    const record = await store.readRecord();
    expect(record.budgetUsage.calls).toBe(2);
    expect(await store.exists("logs/llm/001-requirements-analysis-initial-1.json")).toBe(true);
    expect(await store.exists("logs/llm/002-implementation-plan-initial-1.json")).toBe(true);
  });

  it("completes without waiting when plan approval is not required", async () => {
    const root = await workspace();
    const { outcome, store } = await start(root, scripted({}), {
      settings: { requirePlanApproval: false },
    });
    expect(outcome.status).toBe("completed");
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.manualChecks).toContain(
      "Review the implementation plan: it was not approved by a person in this run.",
    );
  });

  it("stops after analysis for the analyze goal", async () => {
    const root = await workspace();
    const provider = scripted({});
    const { outcome, store } = await start(root, provider, { goal: "analyze" });
    expect(outcome.status).toBe("completed");
    expect(provider.requests).toHaveLength(1);
    expect(await store.exists("artifacts/plan.json")).toBe(false);
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.plan).toBeUndefined();
    expect(report.assumptions).toContain("Pages are numbered from 1.");
  });

  it("refuses an approval for a plan other than the one awaiting approval", async () => {
    const root = await workspace();
    const { svc, outcome } = await start(root, scripted({}));
    await expectCode(
      approvePlan(outcome.runId, { by: "mohamed", planSha256: "0".repeat(64) }, svc),
      ErrorCode.RunNotAwaitingInput,
    );
  });

  it("refuses to approve a plan that was edited after it was generated", async () => {
    const root = await workspace();
    const { svc, outcome, store } = await start(root, scripted({}));
    const plan = JSON.parse(await store.readText("artifacts/plan.json")) as { summary: string };
    plan.summary = "Also delete the database.";
    await writeFile(store.path("artifacts/plan.json"), JSON.stringify(plan));
    await expectCode(approvePlan(outcome.runId, { by: "mohamed" }, svc), ErrorCode.RunCorrupt);
    expect((await store.readRecord()).state).toBe("AWAITING_PLAN_APPROVAL");
  });
});

describe("assist mode: rejection and re-planning", () => {
  it("plans again with the reviewer's feedback and the previous plan", async () => {
    const root = await workspace();
    const provider = scripted({
      plan: [planAnswer(), planAnswer({ summary: "Paginate listOrders with a default size." })],
    });
    const { svc, outcome, store } = await start(root, provider);
    const first = await store.readRecord();
    const firstSha = first.pending?.kind === "plan-approval" ? first.pending.planSha256 : "";

    const again = await rejectPlan(
      outcome.runId,
      { by: "mohamed", feedback: "Use a default page size of 20." },
      svc,
    );
    expect(again).toMatchObject({ status: "waiting", waitingFor: "plan-approval" });
    expect(provider.requests).toHaveLength(3);
    const replan = userText(requestAt(provider, 2));
    expect(replan).toContain("Previous plan, rejected by the reviewer");
    expect(replan).toContain("Use a default page size of 20.");

    const record = await store.readRecord();
    expect(record.iterations.planning).toBe(2);
    expect(record.pending?.kind === "plan-approval" && record.pending.planSha256).not.toBe(
      firstSha,
    );
    const feedback = PlanFeedback.parse(
      JSON.parse(await store.readText("artifacts/plan-feedback.json")),
    );
    expect(feedback.entries).toEqual([
      expect.objectContaining({ iteration: 1, planSha256: firstSha, by: "mohamed" }),
    ]);
    const entries = await audit(store);
    expect(entries.find((entry) => entry.type === "decision")).toMatchObject({
      decision: "rejected",
      feedback: "Use a default page size of 20.",
    });
    const plan = ImplementationPlan.parse(JSON.parse(await store.readText("artifacts/plan.json")));
    expect(plan.summary).toBe("Paginate listOrders with a default size.");
  });

  it("requires feedback to reject", async () => {
    const root = await workspace();
    const { svc, outcome } = await start(root, scripted({}));
    await expectCode(
      rejectPlan(outcome.runId, { by: "mohamed", feedback: "  " }, svc),
      ErrorCode.DecisionInputInvalid,
    );
  });
});

describe("assist mode: clarification", () => {
  const question = {
    question: "Are pages numbered from 0 or 1?",
    blocking: true,
    relatedIds: ["FR-1", "FR-404"],
  };

  it("waits for answers to blocking questions and analyses again with them", async () => {
    const root = await workspace();
    const provider = scripted({
      analysis: [
        analysisAnswer({ questions: [question] }),
        analysisAnswer({ questions: [question] }),
      ],
    });
    const { svc, outcome, store } = await start(root, provider);
    expect(outcome).toMatchObject({ status: "waiting", waitingFor: "clarification" });
    expect(outcome.questions).toEqual([
      expect.objectContaining({ id: "Q-1", blocking: true, relatedIds: ["FR-1"], answer: null }),
    ]);

    await expectCode(
      answerQuestions(outcome.runId, { by: "mohamed", answers: { "Q-9": "x" } }, svc),
      ErrorCode.DecisionInputInvalid,
    );
    await expectCode(
      approvePlan(outcome.runId, { by: "mohamed" }, svc),
      ErrorCode.RunNotAwaitingInput,
    );

    const next = await answerQuestions(
      outcome.runId,
      { by: "mohamed", answers: { "Q-1": "From 1." } },
      svc,
    );
    expect(next).toMatchObject({ status: "waiting", waitingFor: "plan-approval" });
    const reanalysis = userText(requestAt(provider, 1));
    expect(reanalysis).toContain("Answer from the user: From 1.");

    // The repeated question is not asked again.
    const registry = Clarifications.parse(
      JSON.parse(await store.readText("artifacts/clarifications.json")),
    );
    expect(registry.questions).toHaveLength(1);
    expect(registry.questions[0]?.answer).toMatchObject({ text: "From 1.", by: "mohamed" });
    const record = await store.readRecord();
    expect(record.iterations.analysis).toBe(2);

    await expectCode(
      answerQuestions(outcome.runId, { by: "mohamed", answers: { "Q-1": "Again." } }, svc),
      ErrorCode.RunNotAwaitingInput,
    );
  });

  it("keeps waiting while a blocking question is unanswered", async () => {
    const root = await workspace();
    const provider = scripted({
      analysis: [
        analysisAnswer({
          questions: [question, { question: "Is size capped?", blocking: true, relatedIds: [] }],
        }),
      ],
    });
    const { svc, outcome, store } = await start(root, provider);
    const partial = await answerQuestions(
      outcome.runId,
      { by: "mohamed", answers: { "Q-1": "From 1." } },
      svc,
    );
    expect(partial.status).toBe("waiting");
    expect(partial.questions?.map((q) => q.id)).toEqual(["Q-2"]);
    expect(provider.requests).toHaveLength(1);
    expect((await store.readRecord()).pending).toEqual({
      kind: "clarification",
      questionIds: ["Q-2"],
    });
  });
});

describe("assist mode: failures and resume", () => {
  it("interrupts on a budget limit and resumes with a raised budget", async () => {
    const root = await workspace();
    const provider = scripted({
      plan: [
        planAnswer({
          changes: [
            {
              module: null,
              path: "../outside.ts",
              action: "create",
              description: "x",
              satisfies: [],
            },
          ],
        }),
        planAnswer(),
      ],
    });
    const { svc, outcome, store } = await start(root, provider, {
      settings: {
        budgets: { maxInputTokens: 600_000, maxOutputTokens: 80_000, maxCallsPerStep: 1 },
      },
    });
    expect(outcome).toMatchObject({
      status: "interrupted",
      state: "PLANNING",
      error: { code: ErrorCode.BudgetExceeded },
    });
    const interrupted = await store.readRecord();
    expect(interrupted.lastError).toMatchObject({ code: "BUDGET_EXCEEDED", resumable: true });

    const resumed = await resumeRun(outcome.runId, svc, { budgets: { maxCallsPerStep: 3 } });
    expect(resumed).toMatchObject({ status: "waiting", waitingFor: "plan-approval" });
    const record = await store.readRecord();
    expect(record.settings.budgets.maxCallsPerStep).toBe(3);
    expect(record.lastError).toBeNull();
    const events = await store.readEvents();
    expect(events.find((event) => event.type === "resumed")?.detail).toBe("maxCallsPerStep 1 -> 3");
  });

  it("revises a plan that fails the checks once", async () => {
    const root = await workspace();
    const provider = scripted({
      plan: [
        planAnswer({
          changes: [
            { module: null, path: "src/new.ts", action: "modify", description: "x", satisfies: [] },
          ],
        }),
        planAnswer(),
      ],
    });
    const { outcome, store } = await start(root, provider);
    expect(outcome.status).toBe("waiting");
    expect(userText(requestAt(provider, 2))).toContain("failed these deterministic checks");
    const checks = PlanChecks.parse(JSON.parse(await store.readText("artifacts/plan-checks.json")));
    expect(checks.revised).toBe(true);
  });

  it("fails the run when the revised plan still fails the checks", async () => {
    const root = await workspace();
    const bad = planAnswer({
      changes: [
        {
          module: null,
          path: ".devflow/config.yaml",
          action: "modify",
          description: "x",
          satisfies: [],
        },
      ],
    });
    const { outcome, store } = await start(root, scripted({ plan: [bad, bad] }));
    expect(outcome).toMatchObject({ status: "failed", state: "FAILED" });
    expect(outcome.error?.code).toBe(ErrorCode.PlanInvalid);
    const checks = PlanChecks.parse(JSON.parse(await store.readText("artifacts/plan-checks.json")));
    expect(checks.checks.some((check) => check.code === "path-not-writable")).toBe(true);
    expect(await store.exists("artifacts/plan.json")).toBe(false);
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.run.state).toBe("FAILED");
    expect(report.plan).toBeUndefined();
    expect(await store.readText("report.md")).toContain("Stopped by:** PLAN_INVALID");
  });

  it("fails the run when the model refuses", async () => {
    const root = await workspace();
    const provider = new FakeProvider((request) => ({
      text: "",
      model: request.model,
      stopReason: "refusal",
      usage: { inputTokens: 10, outputTokens: 0 },
    }));
    const { outcome } = await start(root, provider);
    expect(outcome).toMatchObject({ status: "failed", error: { code: ErrorCode.LlmRefused } });
  });

  it("interrupts on a provider failure and resumes from the failed step", async () => {
    const root = await workspace();
    let down = true;
    const provider = new FakeProvider((request) => {
      if (!isAnalysis(request) && down) {
        return new LlmProviderError("server", "internal server error", { status: 500 });
      }
      return isAnalysis(request) ? analysisAnswer() : planAnswer();
    });
    const { svc, outcome, store } = await start(root, provider);
    expect(outcome).toMatchObject({
      status: "interrupted",
      state: "PLANNING",
      error: { code: ErrorCode.LlmRequestFailed },
    });
    expect((await getRun(root, outcome.runId)).outcome.status).toBe("interrupted");

    down = false;
    const resumed = await resumeRun(outcome.runId, svc);
    expect(resumed.status).toBe("waiting");
    // Analysis was not repeated.
    expect(provider.requests.filter(isAnalysis)).toHaveLength(1);
    expect((await store.readRecord()).iterations).toEqual({ analysis: 1, planning: 1 });
  });

  it("is interrupted by the abort signal and resumes later", async () => {
    const root = await workspace();
    const controller = new AbortController();
    const provider = new FakeProvider((request) => {
      if (isAnalysis(request)) {
        controller.abort();
        return new Promise(() => undefined);
      }
      return planAnswer();
    });
    const svc = await services(root, provider, { signal: controller.signal });
    const outcome = await startRun(
      { task: task(), taskFile: null, mode: "assist", goal: "plan", settings: settings() },
      svc,
    );
    expect(outcome).toMatchObject({
      status: "interrupted",
      state: "REQUIREMENTS_ANALYSIS",
      error: { code: ErrorCode.Cancelled },
    });

    const fresh = await services(root, scripted({}));
    const resumed = await resumeRun(outcome.runId, fresh);
    expect(resumed.status).toBe("waiting");
  });

  it("takes over the lock of a process that no longer runs", async () => {
    const root = await workspace();
    let down = true;
    const provider = new FakeProvider((request) =>
      isAnalysis(request)
        ? analysisAnswer()
        : down
          ? new LlmProviderError("server", "unavailable", { status: 503 })
          : planAnswer(),
    );
    const { svc, outcome, store } = await start(root, provider);
    // A crashed process left its lock behind.
    await writeFile(
      store.path("lock.json"),
      JSON.stringify({
        pid: 2 ** 22 + 12_345,
        hostname: os.hostname(),
        acquiredAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    down = false;
    const resumed = await resumeRun(outcome.runId, svc);
    expect(resumed.status).toBe("waiting");
    expect(await store.exists("lock.json")).toBe(false);
  });

  it("refuses a run locked by a live process", async () => {
    const root = await workspace();
    const { svc, outcome, store } = await start(root, scripted({}));
    await writeFile(
      store.path("lock.json"),
      JSON.stringify({
        pid: process.ppid,
        hostname: os.hostname(),
        acquiredAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    await expectCode(approvePlan(outcome.runId, { by: "mohamed" }, svc), ErrorCode.RunLocked);
    await writeFile(
      store.path("lock.json"),
      JSON.stringify({
        pid: 1,
        hostname: "another-machine",
        acquiredAt: "2026-11-07T00:00:00.000Z",
      }),
    );
    await expectCode(approvePlan(outcome.runId, { by: "mohamed" }, svc), ErrorCode.RunLocked);
  });

  it("records a programming error and rethrows it", async () => {
    const root = await workspace();
    const svc = await services(root, scripted({}), {
      provider: () => {
        throw new TypeError("provider factory exploded");
      },
    });
    await expect(
      startRun(
        { task: task(), taskFile: null, mode: "assist", goal: "plan", settings: settings() },
        svc,
      ),
    ).rejects.toThrow("provider factory exploded");
    const [record] = await listRuns(root);
    expect(record?.lastError).toMatchObject({ code: "INTERNAL_ERROR", resumable: true });
    expect(record?.state).toBe("REQUIREMENTS_ANALYSIS");
  });
});

describe("assist mode: cancel, status and refusals", () => {
  it("cancels a waiting run and writes its report", async () => {
    const root = await workspace();
    const { svc, outcome, store } = await start(root, scripted({}));
    const cancelled = await cancelRun(outcome.runId, { by: "mohamed", reason: "not needed" }, svc);
    expect(cancelled).toMatchObject({ status: "cancelled", state: "CANCELLED" });
    expect((await store.readRecord()).finishedAt).not.toBeNull();
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.run.state).toBe("CANCELLED");
    await expectCode(cancelRun(outcome.runId, { by: "mohamed" }, svc), ErrorCode.InvalidTransition);
    // Resuming a finished run changes nothing.
    const events = (await store.readEvents()).length;
    expect((await resumeRun(outcome.runId, svc)).status).toBe("cancelled");
    expect(await store.readEvents()).toHaveLength(events);
  });

  it("lists runs and reads one", async () => {
    const root = await workspace();
    expect(await listRuns(root)).toEqual([]);
    const { outcome } = await start(root, scripted({}));
    await start(root, scripted({}), { goal: "analyze" });
    const runs = await listRuns(root);
    expect(runs.map((run) => run.goal)).toEqual(["plan", "analyze"]);
    const summary = await getRun(root, outcome.runId);
    expect(summary.record.task).toMatchObject({ id: "TASK-7", file: "tasks/TASK-7.yaml" });
    await expectCode(getRun(root, "2026-01-01T00-00-00Z_TASK-0"), ErrorCode.RunNotFound);
    await expectCode(getRun(root, "../../etc"), ErrorCode.RunNotFound);
  });

  it("refuses modes that are not implemented without creating a run", async () => {
    const root = await workspace();
    const svc = await services(root, scripted({}));
    await expectCode(
      startRun(
        { task: task(), taskFile: null, mode: "implement", goal: "plan", settings: settings() },
        svc,
      ),
      ErrorCode.WorkflowModeNotImplemented,
    );
    expect(await listRuns(root)).toEqual([]);
  });

  it("refuses an invalid task", async () => {
    const root = await workspace();
    const svc = await services(root, scripted({}));
    const invalid = task({
      acceptanceCriteria: [
        {
          id: "AC-1",
          statement: "Covers a requirement that does not exist",
          covers: ["FR-404"],
          verification: "automated",
          testIntent: "feature",
        },
      ],
    });
    await expectCode(
      startRun(
        { task: invalid, taskFile: null, mode: "assist", goal: "plan", settings: settings() },
        svc,
      ),
      ErrorCode.TaskInvalid,
    );
    expect(await listRuns(root)).toEqual([]);
  });

  it("detects a corrupted run file", async () => {
    const root = await workspace();
    const { svc, outcome, store } = await start(root, scripted({}));
    await writeFile(store.path("run.json"), "{ not json");
    await expectCode(approvePlan(outcome.runId, { by: "mohamed" }, svc), ErrorCode.RunCorrupt);
    const text = await readFile(path.join(store.dir, "run.json"), "utf8");
    expect(text).toBe("{ not json");
  });
});
