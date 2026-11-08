import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BudgetTracker,
  type LlmExchange,
  LlmGateway,
  type LlmGatewayOptions,
  PriceTable,
  canonicalJson,
  sha256Hex,
} from "@devflow/ai";
import { ContextPack, buildContext } from "@devflow/context";
import {
  AuditLog,
  DevflowError,
  ErrorCode,
  Finding,
  type GateDefinition,
  ImplementationPlan,
  IsoDateTime,
  type LlmProvider,
  type PathGuard,
  type ProjectConfig,
  type SecretRedactor,
  Sha256,
  TaskContract,
  type VerificationRun,
  type WorkflowMode,
  type WorkflowState,
  type WorkspaceModule,
  formatIssuePath,
  isDevflowError,
  isTerminalState,
  lintTask,
} from "@devflow/core";
import { z } from "zod";
import { checkAnalysis, checkPlan } from "./checks.js";
import {
  ANALYSIS_TEMPLATE,
  type ExistingTestFile,
  PLAN_TEMPLATE,
  TEST_DESIGN_TEMPLATE,
  analysisPrompt,
  planPrompt,
  testDesignPrompt,
} from "./prompts.js";
import {
  buildReport,
  renderPlanMarkdown,
  renderReportMarkdown,
  renderTestDesignMarkdown,
} from "./report.js";
import { RunStore } from "./run-store.js";
import {
  AnalysisWire,
  BaselineRun,
  type ClarificationRecord,
  Clarifications,
  type DesignedTest,
  type PlanChecks,
  PlanFeedback,
  PlanWire,
  RequirementsAnalysis,
  type RunBudgets,
  type RunGoal,
  type RunRecord,
  type RunSettings,
  TestApproval,
  TestDesign,
  TestDesignWire,
  TestEvidenceRecord,
  TestFeedback,
  TestFiles,
} from "./schemas.js";
import { DEFAULT_TEST_DESIGN_OUTPUT_TOKENS } from "./settings.js";
import {
  type PlannedTestFile,
  type TestModule,
  baselineEvidence,
  baselineFindings,
  checkTestDesign,
  isTestPath,
  sha256Of,
  testFilesRecord,
  testsHash,
} from "./test-design.js";
import { assertModeImplemented, assertTransition } from "./transitions.js";

/** Step ids, used for budgets (`maxCallsPerStep`), events and logs. */
export const STEP = {
  context: "context-loading",
  analysis: "requirements-analysis",
  planning: "planning",
  testDesign: "test-design",
  verification: "verification",
  review: "review",
} as const;

const ARTIFACT = {
  task: "artifacts/task.contract.json",
  context: "artifacts/context.json",
  analysis: "artifacts/analysis.json",
  clarifications: "artifacts/clarifications.json",
  plan: "artifacts/plan.json",
  planMarkdown: "artifacts/plan.md",
  planChecks: "artifacts/plan-checks.json",
  planFeedback: "artifacts/plan-feedback.json",
  planApproval: "artifacts/plan-approval.json",
  testDesign: "artifacts/test-design.json",
  testDesignMarkdown: "artifacts/test-design.md",
  testDesignChecks: "artifacts/test-design-checks.json",
  testFiles: "artifacts/test-files.json",
  testFeedback: "artifacts/test-feedback.json",
  testApproval: "artifacts/test-approval.json",
  baseline: "artifacts/baseline.json",
  testEvidence: "artifacts/test-evidence.json",
  findings: "artifacts/findings.json",
  commandDenials: "artifacts/command-denials.json",
} as const;

const PlanApproval = z.strictObject({
  schemaVersion: z.literal(1),
  planSha256: Sha256,
  by: z.string().min(1),
  at: IsoDateTime,
});

/** `artifacts/findings.json`: the deterministic findings of the review step. */
const Findings = z.strictObject({ schemaVersion: z.literal(1), findings: z.array(Finding) });

/** `artifacts/command-denials.json`: commands the policy did not let run, with fingerprints. */
const CommandDenials = z.strictObject({
  schemaVersion: z.literal(1),
  denials: z.array(
    z.strictObject({
      gateId: z.string().min(1),
      commandId: z.string().min(1),
      argv: z.array(z.string()),
      cwd: z.string(),
      reason: z.string().min(1),
      message: z.string(),
      fingerprint: z.string().optional(),
    }),
  ),
});
export type CommandDenial = z.infer<typeof CommandDenials>["denials"][number];

/** Errors after which retrying the step cannot help: the run moves to FAILED. */
const TERMINAL_ERRORS: ReadonlySet<string> = new Set([
  ErrorCode.LlmRefused,
  ErrorCode.PlanInvalid,
  ErrorCode.TestDesignInvalid,
  ErrorCode.TestFilesChanged,
]);

/** Existing test files shown to the test designer: at most this many, each at most this size. */
const MAX_EXISTING_TEST_FILES = 8;
const MAX_EXISTING_TEST_FILE_BYTES = 64 * 1024;

/**
 * What test mode needs to write and run tests: the workspace's modules (with their adapters)
 * and a runner that executes gates through the command policy. The caller builds it, because
 * the policy needs the user's trust store and approvals; the run gives it its audit log.
 */
export interface TestRunner {
  readonly modules: readonly WorkspaceModule[];
  /** The workspace's gates: the configured ones, or one test gate per module. */
  gates(): Promise<readonly GateDefinition[]>;
  run(
    gates: readonly GateDefinition[],
    context: {
      readonly audit: AuditLog;
      /** Workspace-relative directory for the command logs. */
      readonly logDir: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<VerificationRun>;
}

export type ProgressEvent =
  | { readonly kind: "state"; readonly state: WorkflowState }
  | { readonly kind: "step"; readonly step: string; readonly phase: "started" | "completed" };

/** What the engine needs from its caller (the CLI or a program using the SDK). */
export interface WorkflowServices {
  /** Path guard of the workspace; its root is the workspace root. */
  readonly guard: PathGuard;
  readonly redactor: SecretRedactor;
  /** The effective project configuration (context, modules, protected paths). */
  readonly config?: ProjectConfig | undefined;
  readonly trusted: boolean;
  readonly devflowVersion: string;
  /** Creates the provider a run's settings name. Called only when a model call is needed. */
  readonly provider: (name: string) => LlmProvider | Promise<LlmProvider>;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: ProgressEvent) => void;
  /**
   * Test mode: the modules and the policy-gated test runner, created when a test step needs
   * them. Without it, test mode stops with `TEST_RUNNER_UNAVAILABLE`.
   */
  readonly testRunner?: () => Promise<TestRunner>;
  /** Gateway tuning (timeouts, retries); injected in tests. */
  readonly gateway?: Pick<
    LlmGatewayOptions,
    "retry" | "timeoutMs" | "sleep" | "random" | "maxRepairAttempts"
  >;
}

export type RunStatus = "completed" | "waiting" | "interrupted" | "failed" | "cancelled";

export interface RunOutcome {
  readonly runId: string;
  readonly mode: WorkflowMode;
  readonly state: WorkflowState;
  readonly status: RunStatus;
  readonly waitingFor?: "plan-approval" | "clarification" | "test-approval";
  /** Blocking questions that still need an answer, when waiting for clarification. */
  readonly questions?: readonly ClarificationRecord[];
  /** Why the run stopped, when it was interrupted or failed. */
  readonly error?: { readonly code: string; readonly message: string };
  /** Workspace-relative paths. */
  readonly runDir: string;
  readonly planPath?: string;
  /** The test design to review, when waiting for test approval. */
  readonly testsPath?: string;
  /** The test files to review, when waiting for test approval. */
  readonly testFiles?: readonly string[];
  /** Commands the policy did not let run, when the run stopped for that reason. */
  readonly denials?: readonly CommandDenial[];
  readonly reportPath?: string;
}

export interface StartRunInput {
  readonly task: TaskContract;
  readonly taskFile: string | null;
  readonly mode: WorkflowMode;
  readonly goal: RunGoal;
  readonly settings: RunSettings;
  readonly warnings?: readonly string[];
}

/** Starts a run and drives it until it finishes or needs a person. */
export async function startRun(
  input: StartRunInput,
  services: WorkflowServices,
): Promise<RunOutcome> {
  assertModeImplemented(input.mode);
  if ((input.mode === "test") !== (input.goal === "test")) {
    throw new DevflowError(
      ErrorCode.InvalidTransition,
      input.mode === "test"
        ? `test mode writes and runs tests; start it with the test goal (devflow test), not ${input.goal}`
        : `the test goal needs test mode, not ${input.mode} mode`,
      { details: { mode: input.mode, goal: input.goal } },
    );
  }
  const task = TaskContract.parse(input.task);
  const errors = lintTask(task).filter((issue) => issue.severity === "error");
  if (errors.length > 0) {
    throw new DevflowError(
      ErrorCode.TaskInvalid,
      `task ${task.id} is invalid: ${errors[0]?.message ?? ""}`,
      {
        details: { taskId: task.id, errors: errors.map((issue) => issue.message) },
      },
    );
  }
  const clock = services.clock ?? (() => new Date());
  const store = await RunStore.create(services.guard.root, task.id, { clock });
  const unlock = await store.lock();
  try {
    const now = clock().toISOString();
    const record: RunRecord = {
      schemaVersion: 1,
      id: store.id,
      devflowVersion: services.devflowVersion,
      mode: input.mode,
      goal: input.goal,
      state: "TASK_RECEIVED",
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
      task: {
        id: task.id,
        title: task.title,
        file: input.taskFile,
        sha256: sha256Hex(canonicalJson(task)),
      },
      settings: input.settings,
      budgetUsage: { calls: 0, inputTokens: 0, outputTokens: 0, callsByStep: {} },
      iterations: { analysis: 0, planning: 0, testDesign: 0 },
      pending: null,
      lastError: null,
      warnings: [...(input.warnings ?? [])],
    };
    await store.writeJson(ARTIFACT.task, task);
    await store.writeJson(ARTIFACT.clarifications, { schemaVersion: 1, questions: [] });
    await store.writeRecord(record);
    await store.appendEvent({
      type: "created",
      state: record.state,
      detail: `${input.mode} mode, goal ${input.goal}`,
    });
    return await new Session(store, record, services).drive();
  } finally {
    await unlock();
  }
}

export interface ResumeOverrides {
  readonly budgets?: Partial<RunBudgets>;
  readonly model?: string;
  readonly provider?: string;
}

/**
 * Continues an interrupted run (budget, provider failure, crash, Ctrl+C) from its current
 * state. Budgets and the model can be changed; a waiting or finished run is returned as is.
 */
export async function resumeRun(
  runId: string,
  services: WorkflowServices,
  overrides: ResumeOverrides = {},
): Promise<RunOutcome> {
  return withSession(runId, services, async (session) => {
    const { record } = session;
    // A finished run, or one waiting for a person, has nothing to resume.
    if (isTerminalState(record.state) || record.pending !== null) return session.outcome();
    const changes: string[] = [];
    if (overrides.budgets !== undefined) {
      const budgets = { ...record.settings.budgets };
      for (const [name, value] of Object.entries(overrides.budgets) as [
        keyof RunBudgets,
        number | undefined,
      ][]) {
        if (value !== undefined && value !== budgets[name]) {
          changes.push(`${name} ${budgets[name]} -> ${value}`);
          budgets[name] = value;
        }
      }
      record.settings = { ...record.settings, budgets };
    }
    if (overrides.model !== undefined && overrides.model.trim() !== "") {
      const model = overrides.model.trim();
      changes.push(`model -> ${model}`);
      record.settings = {
        ...record.settings,
        models: {
          analysis: model,
          planning: model,
          testDesign: model,
          implementation: model,
          review: model,
        },
      };
    }
    if (overrides.provider !== undefined && overrides.provider.trim() !== "") {
      changes.push(`provider -> ${overrides.provider.trim()}`);
      record.settings = { ...record.settings, provider: overrides.provider.trim() };
    }
    session.applyBudgetLimits();
    await session.save();
    await session.store.appendEvent({
      type: "resumed",
      state: record.state,
      detail: changes.length === 0 ? "no setting changed" : changes.join(", "),
    });
    return session.drive();
  });
}

/**
 * Approves the plan a run is waiting on. In assist mode this completes the run; in test mode
 * the tests are designed next.
 */
export async function approvePlan(
  runId: string,
  decision: { by: string; planSha256?: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  return withSession(runId, services, async (session) => {
    const pending = session.expectPlanApproval();
    if (decision.planSha256 !== undefined && decision.planSha256 !== pending.planSha256) {
      throw new DevflowError(
        ErrorCode.RunNotAwaitingInput,
        "the plan awaiting approval is not the one you reviewed (its hash differs); review it again",
        { details: { runId, expected: pending.planSha256, given: decision.planSha256 } },
      );
    }
    await session.verifyPlanUnchanged(pending.planSha256);
    const at = session.now();
    await (
      await session.audit()
    ).append({
      type: "decision",
      subject: "plan",
      decision: "approved",
      by: decision.by,
      reference: pending.planSha256,
    });
    await session.store.writeJson(ARTIFACT.planApproval, {
      schemaVersion: 1,
      planSha256: pending.planSha256,
      by: decision.by,
      at,
    });
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `plan approved by ${decision.by}`,
    });
    session.record.pending = null;
    await session.transition(
      session.record.mode === "test" ? "TEST_DESIGN" : "COMPLETED",
      "plan approved",
    );
    return session.drive();
  });
}

/** Rejects the plan with feedback and plans again. */
export async function rejectPlan(
  runId: string,
  decision: { by: string; feedback: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  const feedback = checkedFeedback(runId, decision.feedback);
  return withSession(runId, services, async (session) => {
    const pending = session.expectPlanApproval();
    await (
      await session.audit()
    ).append({
      type: "decision",
      subject: "plan",
      decision: "rejected",
      by: decision.by,
      reference: pending.planSha256,
      feedback,
    });
    const existing =
      (await session.store.readJsonIfExists(ARTIFACT.planFeedback, PlanFeedback)) ??
      ({ schemaVersion: 1, entries: [] } satisfies PlanFeedback);
    existing.entries.push({
      iteration: session.record.iterations.planning,
      planSha256: pending.planSha256,
      feedback,
      by: decision.by,
      at: session.now(),
    });
    await session.store.writeJson(ARTIFACT.planFeedback, existing);
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `plan rejected by ${decision.by}`,
    });
    session.record.pending = null;
    await session.transition("PLANNING", "plan rejected with feedback");
    return session.drive();
  });
}

/**
 * Approves the test files a test-mode run wrote. Model-written code runs only after a person
 * approved it: the approval is bound to the hash of every written file, and the tests then run
 * against the current code (the red run).
 */
export async function approveTests(
  runId: string,
  decision: { by: string; testsSha256?: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  return withSession(runId, services, async (session) => {
    const pending = session.expectTestApproval();
    if (decision.testsSha256 !== undefined && decision.testsSha256 !== pending.testsSha256) {
      throw new DevflowError(
        ErrorCode.RunNotAwaitingInput,
        "the tests awaiting approval are not the ones you reviewed (their hash differs); review them again",
        { details: { runId, expected: pending.testsSha256, given: decision.testsSha256 } },
      );
    }
    const files = await session.testFiles();
    if (files.testsSha256 !== pending.testsSha256) {
      throw new DevflowError(
        ErrorCode.RunCorrupt,
        `${session.store.workspacePath(ARTIFACT.testFiles)} does not match the tests awaiting approval`,
        { details: { runId } },
      );
    }
    await session.verifyTestFilesUnchanged(files);
    const at = session.now();
    await (
      await session.audit()
    ).append({
      type: "decision",
      subject: "tests",
      decision: "approved",
      by: decision.by,
      reference: pending.testsSha256,
    });
    await session.store.writeJson(ARTIFACT.testApproval, {
      schemaVersion: 1,
      testsSha256: pending.testsSha256,
      by: decision.by,
      at,
    } satisfies TestApproval);
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `tests approved by ${decision.by}`,
    });
    session.record.pending = null;
    await session.transition("VERIFICATION", "tests approved");
    return session.drive();
  });
}

/**
 * Rejects the written tests with feedback: the files are restored to what they were before
 * the run, and the tests are designed again.
 */
export async function rejectTests(
  runId: string,
  decision: { by: string; feedback: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  const feedback = checkedFeedback(runId, decision.feedback);
  return withSession(runId, services, async (session) => {
    const pending = session.expectTestApproval();
    const files = await session.testFiles();
    // A file a person changed while reviewing is never overwritten.
    await session.verifyTestFilesUnchanged(files);
    await (
      await session.audit()
    ).append({
      type: "decision",
      subject: "tests",
      decision: "rejected",
      by: decision.by,
      reference: pending.testsSha256,
      feedback,
    });
    const existing =
      (await session.store.readJsonIfExists(ARTIFACT.testFeedback, TestFeedback)) ??
      ({ schemaVersion: 1, entries: [] } satisfies TestFeedback);
    existing.entries.push({
      iteration: Math.max(1, session.record.iterations.testDesign ?? 0),
      testsSha256: pending.testsSha256,
      feedback,
      by: decision.by,
      at: session.now(),
    });
    await session.store.writeJson(ARTIFACT.testFeedback, existing);
    await session.restoreTestFiles(files);
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `tests rejected by ${decision.by}`,
    });
    session.record.pending = null;
    await session.save();
    return session.drive();
  });
}

/** Why the policy stopped the test commands, and what makes them runnable. */
function denialSummary(denials: VerificationRun["denials"]): string {
  const reasons = new Set<string>();
  for (const denial of denials) {
    switch (denial.reason) {
      case "workspace-untrusted":
        reasons.add(
          "the workspace is not trusted (review it with devflow trust, then resume the run)",
        );
        break;
      case "approval-required":
      case "rejected-by-user":
        reasons.add(
          `${denial.commandId} is not approved (review it, then resume the run with --allow <fingerprint>)`,
        );
        break;
      case "invalid-spec":
      case "invalid-parameter":
      case "cwd-rejected":
      case "executable-rejected":
      case "hard-deny":
        reasons.add(`${denial.commandId} cannot run: ${denial.message}`);
        break;
    }
  }
  return [...reasons].join("; ");
}

function checkedFeedback(runId: string, text: string): string {
  const feedback = text.trim();
  if (feedback === "" || feedback.length > 20_000) {
    throw new DevflowError(
      ErrorCode.DecisionInputInvalid,
      "rejection feedback must be between 1 and 20000 characters",
      { details: { runId } },
    );
  }
  return feedback;
}

/** Records answers to clarification questions; continues once no blocking question is open. */
export async function answerQuestions(
  runId: string,
  decision: { by: string; answers: Readonly<Record<string, string>> },
  services: WorkflowServices,
): Promise<RunOutcome> {
  return withSession(runId, services, async (session) => {
    if (session.record.state !== "CLARIFICATION_REQUIRED") {
      throw notWaiting(session.record, "answers");
    }
    const registry = await session.clarifications();
    const entries = Object.entries(decision.answers);
    if (entries.length === 0) {
      throw new DevflowError(ErrorCode.DecisionInputInvalid, "no answers were given", {
        details: { runId },
      });
    }
    const at = session.now();
    for (const [id, raw] of entries) {
      const question = registry.questions.find((candidate) => candidate.id === id);
      const text = raw.trim();
      if (question === undefined) {
        throw new DevflowError(
          ErrorCode.DecisionInputInvalid,
          `run ${runId} has no question ${id}`,
          {
            details: { runId, questionId: id },
          },
        );
      }
      if (question.answer !== null) {
        throw new DevflowError(
          ErrorCode.DecisionInputInvalid,
          `question ${id} is already answered`,
          {
            details: { runId, questionId: id },
          },
        );
      }
      if (text === "" || text.length > 20_000) {
        throw new DevflowError(
          ErrorCode.DecisionInputInvalid,
          `the answer to ${id} must be between 1 and 20000 characters`,
          { details: { runId, questionId: id } },
        );
      }
      question.answer = { text, by: decision.by, at };
    }
    await session.store.writeJson(ARTIFACT.clarifications, registry);
    const audit = await session.audit();
    for (const [id] of entries) {
      await audit.append({
        type: "decision",
        subject: "clarification",
        decision: "answered",
        by: decision.by,
        reference: id,
      });
    }
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `${entries.map(([id]) => id).join(", ")} answered by ${decision.by}`,
    });
    const open = registry.questions.filter(
      (question) => question.blocking && question.answer === null,
    );
    if (open.length > 0) {
      session.record.pending = {
        kind: "clarification",
        questionIds: open.map((question) => question.id),
      };
      await session.save();
      return session.outcome();
    }
    session.record.pending = null;
    await session.transition("REQUIREMENTS_ANALYSIS", "blocking questions answered");
    return session.drive();
  });
}

/** Cancels a run that has not finished. A report is written for the cancelled run. */
export async function cancelRun(
  runId: string,
  decision: { by: string; reason?: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  return withSession(runId, services, async (session) => {
    if (isTerminalState(session.record.state)) {
      throw new DevflowError(
        ErrorCode.InvalidTransition,
        `run ${runId} is already ${session.record.state}`,
        { details: { runId, state: session.record.state } },
      );
    }
    session.record.pending = null;
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `cancelled by ${decision.by}${decision.reason === undefined ? "" : `: ${decision.reason}`}`,
    });
    await session.transition("CANCELLED", "cancelled by the user");
    return session.drive();
  });
}

export interface RunSummary {
  readonly record: RunRecord;
  readonly outcome: RunOutcome;
}

/** Reads a run without changing it. */
export async function getRun(workspaceRoot: string, runId: string): Promise<RunSummary> {
  const store = await RunStore.open(workspaceRoot, runId);
  const record = await store.readRecord();
  return { record, outcome: await outcomeOf(store, record) };
}

/** All runs of a workspace, oldest first. */
export async function listRuns(workspaceRoot: string): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const id of await RunStore.list(workspaceRoot)) {
    const store = await RunStore.open(workspaceRoot, id);
    records.push(await store.readRecord());
  }
  return records;
}

async function withSession(
  runId: string,
  services: WorkflowServices,
  action: (session: Session) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const store = await RunStore.open(
    services.guard.root,
    runId,
    services.clock === undefined ? {} : { clock: services.clock },
  );
  const unlock = await store.lock();
  try {
    const record = await store.readRecord();
    assertModeImplemented(record.mode);
    return await action(new Session(store, record, services));
  } finally {
    await unlock();
  }
}

function notWaiting(record: RunRecord, what: string): DevflowError {
  return new DevflowError(
    ErrorCode.RunNotAwaitingInput,
    `run ${record.id} is in state ${record.state} and is not waiting for ${what}`,
    { details: { runId: record.id, state: record.state } },
  );
}

async function outcomeOf(store: RunStore, record: RunRecord): Promise<RunOutcome> {
  const base = {
    runId: record.id,
    mode: record.mode,
    state: record.state,
    runDir: store.workspacePath("").replace(/\/$/, ""),
  };
  const report = (await store.exists("report.json"))
    ? { reportPath: store.workspacePath("report.md") }
    : {};
  const error =
    record.lastError === null
      ? {}
      : { error: { code: record.lastError.code, message: record.lastError.message } };
  switch (record.state) {
    case "COMPLETED":
      return { ...base, status: "completed", ...report };
    case "FAILED":
      return { ...base, status: "failed", ...error, ...report };
    case "CANCELLED":
      return { ...base, status: "cancelled", ...report };
    case "CLARIFICATION_REQUIRED": {
      const registry = await store.readJson(ARTIFACT.clarifications, Clarifications);
      return {
        ...base,
        status: "waiting",
        waitingFor: "clarification",
        questions: registry.questions.filter(
          (question) => question.blocking && question.answer === null,
        ),
      };
    }
    case "AWAITING_PLAN_APPROVAL":
      return {
        ...base,
        status: "waiting",
        waitingFor: "plan-approval",
        planPath: store.workspacePath(ARTIFACT.planMarkdown),
      };
    case "TEST_DESIGN":
      if (record.pending?.kind === "test-approval") {
        const files = await store.readJsonIfExists(ARTIFACT.testFiles, TestFiles);
        return {
          ...base,
          status: "waiting",
          waitingFor: "test-approval",
          testsPath: store.workspacePath(ARTIFACT.testDesignMarkdown),
          testFiles: files?.files.map((file) => file.path) ?? [],
        };
      }
      return { ...base, status: "interrupted", ...error };
    case "TASK_RECEIVED":
    case "CONTEXT_LOADING":
    case "REQUIREMENTS_ANALYSIS":
    case "PLANNING":
    case "IMPLEMENTATION":
    case "VERIFICATION":
    case "REVIEW": {
      // A run outside a terminal or waiting state is not being driven: it was interrupted.
      const denials =
        record.lastError?.code === ErrorCode.CommandNotApproved
          ? (await store.readJsonIfExists(ARTIFACT.commandDenials, CommandDenials))?.denials
          : undefined;
      return {
        ...base,
        status: "interrupted",
        ...error,
        ...(denials === undefined ? {} : { denials }),
      };
    }
  }
}

/** One locked pass over a run. */
class Session {
  readonly store: RunStore;
  record: RunRecord;
  private readonly services: WorkflowServices;
  private readonly budget: BudgetTracker;
  private auditLog: AuditLog | undefined;
  private gatewayInstance: LlmGateway | undefined;
  private exchangeSeq: number | undefined;

  constructor(store: RunStore, record: RunRecord, services: WorkflowServices) {
    this.store = store;
    this.record = record;
    this.services = services;
    this.budget = new BudgetTracker(record.settings.budgets, record.budgetUsage);
  }

  now(): string {
    return (this.services.clock?.() ?? new Date()).toISOString();
  }

  applyBudgetLimits(): void {
    this.budget.setLimits(this.record.settings.budgets);
  }

  async save(): Promise<void> {
    this.record.budgetUsage = this.budget.usage();
    this.record.updatedAt = this.now();
    await this.store.writeRecord(this.record);
  }

  async transition(to: WorkflowState, detail: string): Promise<void> {
    const from = this.record.state;
    assertTransition(this.record.mode, from, to);
    this.record.state = to;
    if (isTerminalState(to)) this.record.finishedAt = this.now();
    await this.save();
    await this.store.appendEvent({ type: "transition", state: to, from, detail });
    this.services.onProgress?.({ kind: "state", state: to });
  }

  expectPlanApproval(): { kind: "plan-approval"; planSha256: string } {
    const pending = this.record.pending;
    if (this.record.state !== "AWAITING_PLAN_APPROVAL" || pending?.kind !== "plan-approval") {
      throw notWaiting(this.record, "a plan decision");
    }
    return pending;
  }

  expectTestApproval(): { kind: "test-approval"; testsSha256: string } {
    const pending = this.record.pending;
    if (this.record.state !== "TEST_DESIGN" || pending?.kind !== "test-approval") {
      throw notWaiting(this.record, "a decision on the tests");
    }
    return pending;
  }

  async testFiles(): Promise<TestFiles> {
    return this.store.readJson(ARTIFACT.testFiles, TestFiles);
  }

  /** The current hash of a workspace file, or null when it does not exist. */
  private async currentHash(file: string): Promise<{ absolute: string; sha256: string | null }> {
    const checked = await this.services.guard.check(file, { access: "write", origin: "model" });
    return {
      absolute: checked.absolute,
      sha256: checked.exists ? sha256Of(await readFile(checked.absolute)) : null,
    };
  }

  /** Throws `TEST_FILES_CHANGED` unless every written test file is as DevFlow wrote it. */
  async verifyTestFilesUnchanged(files: TestFiles): Promise<void> {
    for (const file of files.files) {
      const { sha256 } = await this.currentHash(file.path);
      if (sha256 !== file.afterSha256) {
        throw new DevflowError(
          ErrorCode.TestFilesChanged,
          `${file.path} was ${sha256 === null ? "deleted" : "changed"} after DevFlow wrote it; ` +
            "the tests a person approves must be the ones that run. Restore it, or cancel the run",
          { details: { runId: this.record.id, path: file.path } },
        );
      }
    }
  }

  /**
   * Puts the files back as they were before the run wrote them. A file that is already as it
   * was is left alone; a file someone changed since is never overwritten.
   */
  async restoreTestFiles(files: TestFiles): Promise<void> {
    const audit = await this.audit();
    for (const file of [...files.files].reverse()) {
      const { absolute, sha256 } = await this.currentHash(file.path);
      if (sha256 === file.beforeSha256) continue;
      if (sha256 !== file.afterSha256) {
        throw new DevflowError(
          ErrorCode.TestFilesChanged,
          `${file.path} was changed after DevFlow wrote it, so it is not restored; restore or ` +
            "remove it yourself, or cancel the run",
          { details: { runId: this.record.id, path: file.path } },
        );
      }
      if (file.before === null) {
        await unlink(absolute);
      } else {
        await writeFile(absolute, file.before, "utf8");
      }
      await audit.append({
        type: "file-write",
        path: file.path,
        sha256Before: file.afterSha256,
        sha256After: file.beforeSha256,
        planChangeId: null,
      });
    }
    await this.store.writeJson(ARTIFACT.testFiles, {
      schemaVersion: 1,
      testsSha256: testsHash([]),
      files: [],
    } satisfies TestFiles);
  }

  async verifyPlanUnchanged(expected: string): Promise<void> {
    const plan = await this.store.readJson(ARTIFACT.plan, ImplementationPlan);
    if (sha256Hex(canonicalJson(plan)) !== expected) {
      throw new DevflowError(
        ErrorCode.RunCorrupt,
        `${this.store.workspacePath(ARTIFACT.plan)} was modified after it was generated; it cannot be approved`,
        { details: { runId: this.record.id } },
      );
    }
  }

  async audit(): Promise<AuditLog> {
    this.auditLog ??= await AuditLog.open(this.store.path("audit.jsonl"), {
      redactor: this.services.redactor,
      runId: this.record.id,
      ...(this.services.clock === undefined ? {} : { clock: this.services.clock }),
    });
    return this.auditLog;
  }

  async clarifications(): Promise<Clarifications> {
    return this.store.readJson(ARTIFACT.clarifications, Clarifications);
  }

  outcome(): Promise<RunOutcome> {
    return outcomeOf(this.store, this.record);
  }

  /** Runs steps until the run finishes, waits for a person, or a step fails. */
  async drive(): Promise<RunOutcome> {
    for (;;) {
      const state = this.record.state;
      if (isTerminalState(state)) {
        await this.writeReport();
        return this.outcome();
      }
      try {
        switch (state) {
          case "TASK_RECEIVED":
            await this.transition("CONTEXT_LOADING", "run started");
            break;
          case "CONTEXT_LOADING":
            await this.step(STEP.context, () => this.loadContext());
            await this.transition("REQUIREMENTS_ANALYSIS", "context loaded");
            break;
          case "REQUIREMENTS_ANALYSIS": {
            const open = await this.step(STEP.analysis, () => this.analyse());
            if (open.length > 0) {
              this.record.pending = {
                kind: "clarification",
                questionIds: open.map((question) => question.id),
              };
              await this.transition(
                "CLARIFICATION_REQUIRED",
                `${open.length} blocking question(s)`,
              );
              return await this.outcome();
            }
            await this.transition(
              this.record.goal === "analyze" ? "COMPLETED" : "PLANNING",
              "requirements analysed",
            );
            break;
          }
          case "PLANNING": {
            const planSha256 = await this.step(STEP.planning, () => this.plan());
            if (this.record.settings.requirePlanApproval) {
              this.record.pending = { kind: "plan-approval", planSha256 };
              await this.transition("AWAITING_PLAN_APPROVAL", "plan ready for review");
              return await this.outcome();
            }
            await this.transition(
              this.record.mode === "test" ? "TEST_DESIGN" : "COMPLETED",
              "plan ready (approval not required)",
            );
            break;
          }
          case "TEST_DESIGN": {
            if (this.record.pending?.kind === "test-approval") return await this.outcome();
            const testsSha256 = await this.step(STEP.testDesign, () => this.designTests());
            this.record.pending = { kind: "test-approval", testsSha256 };
            await this.save();
            return await this.outcome();
          }
          case "VERIFICATION":
            await this.step(STEP.verification, () => this.runBaseline());
            await this.transition("REVIEW", "tests run against the current code");
            break;
          case "REVIEW":
            await this.step(STEP.review, () => this.review());
            await this.transition("COMPLETED", "red baseline reviewed");
            break;
          // Waiting states stop the drive; terminal states are handled before the switch.
          case "CLARIFICATION_REQUIRED":
          case "AWAITING_PLAN_APPROVAL":
          case "COMPLETED":
          case "FAILED":
          case "CANCELLED":
            return await this.outcome();
          case "IMPLEMENTATION":
            throw new DevflowError(
              ErrorCode.WorkflowModeNotImplemented,
              `the ${state} step is not implemented yet`,
              { details: { state } },
            );
        }
      } catch (error) {
        return this.handleFailure(state, error);
      }
    }
  }

  private async handleFailure(state: WorkflowState, error: unknown): Promise<RunOutcome> {
    const code = isDevflowError(error) ? error.code : "INTERNAL_ERROR";
    const message =
      error instanceof Error ? this.services.redactor.redactText(error.message) : String(error);
    const terminal = isDevflowError(error) && TERMINAL_ERRORS.has(error.code);
    this.record.lastError = { code, message, state, at: this.now(), resumable: !terminal };
    await this.store.appendEvent({ type: "step-failed", state, detail: `${code}: ${message}` });
    if (terminal) {
      this.record.pending = null;
      await this.transition("FAILED", code);
      await this.writeReport();
      return this.outcome();
    }
    await this.save();
    if (!isDevflowError(error)) throw error;
    return this.outcome();
  }

  private async step<T>(id: string, run: () => Promise<T>): Promise<T> {
    await this.store.appendEvent({ type: "step-started", state: this.record.state, step: id });
    this.services.onProgress?.({ kind: "step", step: id, phase: "started" });
    const result = await run();
    this.record.lastError = null;
    await this.save();
    await this.store.appendEvent({ type: "step-completed", state: this.record.state, step: id });
    this.services.onProgress?.({ kind: "step", step: id, phase: "completed" });
    return result;
  }

  private async task(): Promise<TaskContract> {
    return this.store.readJson(ARTIFACT.task, TaskContract);
  }

  private async gateway(): Promise<LlmGateway> {
    if (this.gatewayInstance === undefined) {
      const provider = await this.services.provider(this.record.settings.provider);
      this.gatewayInstance = new LlmGateway({
        provider,
        redactor: this.services.redactor,
        budget: this.budget,
        prices: new PriceTable(this.record.settings.prices ?? {}),
        audit: await this.audit(),
        observer: (exchange) => this.logExchange(exchange),
        ...this.services.gateway,
      });
    }
    return this.gatewayInstance;
  }

  private async logExchange(exchange: LlmExchange): Promise<void> {
    if (this.exchangeSeq === undefined) {
      try {
        this.exchangeSeq = (await readdir(this.store.path("logs/llm"))).length;
      } catch {
        this.exchangeSeq = 0;
      }
    }
    this.exchangeSeq += 1;
    const name = `${String(this.exchangeSeq).padStart(3, "0")}-${exchange.templateId}-${exchange.purpose}-${exchange.attempt}.json`;
    await this.store.writeJson(`logs/llm/${name}`, exchange);
  }

  private signalOption(): { signal?: AbortSignal } {
    return this.services.signal === undefined ? {} : { signal: this.services.signal };
  }

  private async loadContext(): Promise<void> {
    const pack = await buildContext({
      guard: this.services.guard,
      task: await this.task(),
      redactor: this.services.redactor,
      trusted: this.services.trusted,
      ...(this.services.config === undefined ? {} : { config: this.services.config }),
      budgetTokens: this.record.settings.contextBudgetTokens,
      ...this.signalOption(),
    });
    await this.store.writeJson(ARTIFACT.context, pack);
  }

  /** Returns the blocking questions that are still open after this analysis. */
  private async analyse(): Promise<ClarificationRecord[]> {
    const task = await this.task();
    const pack = await this.store.readJson(ARTIFACT.context, ContextPack);
    const registry = await this.clarifications();
    const iteration = this.record.iterations.analysis + 1;
    const taskIssues = lintTask(task).map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      path: formatIssuePath(issue.path),
    }));
    const prompt = analysisPrompt({ task, pack, clarifications: registry.questions, taskIssues });
    const gateway = await this.gateway();
    const result = await gateway.generateStructured({
      step: STEP.analysis,
      templateId: ANALYSIS_TEMPLATE.id,
      templateVersion: ANALYSIS_TEMPLATE.version,
      model: this.record.settings.models.analysis,
      system: prompt.system,
      user: prompt.user,
      files: prompt.files,
      schema: AnalysisWire,
      schemaName: "requirements_analysis",
      maxOutputTokens: this.record.settings.maxOutputTokens.analysis,
      ...this.signalOption(),
    });
    const { analysis, newQuestions } = checkAnalysis({
      wire: result.value,
      task,
      pack,
      iteration,
      previous: registry.questions,
      taskIssues,
    });
    registry.questions.push(...newQuestions);
    await this.store.writeJson(ARTIFACT.analysis, RequirementsAnalysis.parse(analysis));
    await this.store.writeJson(ARTIFACT.clarifications, registry);
    this.record.iterations = { ...this.record.iterations, analysis: iteration };
    return registry.questions.filter((question) => question.blocking && question.answer === null);
  }

  /** Plans, checks the plan (one revision on failed checks) and returns its hash. */
  private async plan(): Promise<string> {
    const task = await this.task();
    const pack = await this.store.readJson(ARTIFACT.context, ContextPack);
    const analysis = await this.store.readJson(ARTIFACT.analysis, RequirementsAnalysis);
    const registry = await this.clarifications();
    const iteration = this.record.iterations.planning + 1;
    const feedback = await this.store.readJsonIfExists(ARTIFACT.planFeedback, PlanFeedback);
    const latest = feedback?.entries.at(-1);
    const previous =
      latest?.iteration === this.record.iterations.planning
        ? {
            plan: await this.store.readJson(ARTIFACT.plan, ImplementationPlan),
            feedback: latest.feedback,
          }
        : undefined;

    const gateway = await this.gateway();
    let failedChecks: PlanChecks["checks"] | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = planPrompt({
        task,
        pack,
        analysis,
        clarifications: registry.questions,
        previous,
        failedChecks,
      });
      const result = await gateway.generateStructured({
        step: STEP.planning,
        templateId: PLAN_TEMPLATE.id,
        templateVersion: PLAN_TEMPLATE.version,
        model: this.record.settings.models.planning,
        system: prompt.system,
        user: prompt.user,
        files: prompt.files,
        schema: PlanWire,
        schemaName: "implementation_plan",
        maxOutputTokens: this.record.settings.maxOutputTokens.planning,
        ...this.signalOption(),
      });
      const { plan, checks } = await checkPlan({
        wire: result.value,
        task,
        pack,
        guard: this.services.guard,
      });
      const errors = checks.filter((check) => check.severity === "error");
      const checksArtifact: PlanChecks = {
        schemaVersion: 1,
        iteration,
        revised: attempt > 1,
        checks,
      };
      if (errors.length === 0) {
        const planSha256 = sha256Hex(canonicalJson(plan));
        await this.store.writeJson(ARTIFACT.plan, plan);
        await this.store.writeText(
          ARTIFACT.planMarkdown,
          renderPlanMarkdown(plan, { task, runId: this.record.id, iteration, checks }),
        );
        await this.store.writeJson(ARTIFACT.planChecks, checksArtifact);
        this.record.iterations = { ...this.record.iterations, planning: iteration };
        return planSha256;
      }
      if (attempt === 2) {
        await this.store.writeJson(ARTIFACT.planChecks, checksArtifact);
        throw new DevflowError(
          ErrorCode.PlanInvalid,
          `the plan still fails ${errors.length} check(s) after a revision: ${errors[0]?.message ?? ""}`,
          { details: { runId: this.record.id, checks: errors.map((check) => check.message) } },
        );
      }
      failedChecks = errors;
    }
    throw new Error("unreachable");
  }

  private testRunnerInstance: Promise<TestRunner> | undefined;

  private testRunner(): Promise<TestRunner> {
    const create = this.services.testRunner;
    if (create === undefined) {
      return Promise.reject(
        new DevflowError(
          ErrorCode.TestRunnerUnavailable,
          "test mode needs the workspace's modules and a command policy to run tests, and none was provided",
          { details: { runId: this.record.id } },
        ),
      );
    }
    this.testRunnerInstance ??= create();
    return this.testRunnerInstance;
  }

  private async testModules(): Promise<TestModule[]> {
    const runner = await this.testRunner();
    const modules = runner.modules
      .filter((module) => module.profile.testRoots.length > 0)
      .map((module) => ({
        profile: module.profile,
        guide: module.adapter.testAuthoringGuide(module.profile),
      }));
    if (modules.length === 0) {
      throw new DevflowError(
        ErrorCode.TestRunnerUnavailable,
        "no module with a test directory was found, so there is nowhere to write tests " +
          "(declare the modules in .devflow/config.yaml)",
        { details: { runId: this.record.id } },
      );
    }
    return modules;
  }

  /** Full content of the test files the model may edit: the plan's targets that exist. */
  private async existingTestFiles(
    plan: ImplementationPlan,
    previous: readonly DesignedTest[],
    modules: readonly TestModule[],
  ): Promise<ExistingTestFile[]> {
    const candidates = [
      ...new Set([
        ...plan.testStrategy.flatMap((entry) =>
          entry.targetFile === undefined ? [] : [entry.targetFile],
        ),
        ...previous.map((test) => test.path),
      ]),
    ].filter((candidate) => modules.some((module) => isTestPath(candidate, module)));
    const files: ExistingTestFile[] = [];
    for (const candidate of candidates) {
      if (files.length >= MAX_EXISTING_TEST_FILES) break;
      try {
        const checked = await this.services.guard.check(candidate, {
          access: "prompt",
          origin: "model",
        });
        if (!checked.exists) continue;
        const buffer = await readFile(checked.absolute);
        if (buffer.length > MAX_EXISTING_TEST_FILE_BYTES) continue;
        files.push({
          path: candidate,
          content: this.services.redactor.redactText(buffer.toString("utf8")),
        });
      } catch (error) {
        if (!isDevflowError(error) && (error as NodeJS.ErrnoException).code === undefined) {
          throw error;
        }
      }
    }
    return files;
  }

  /**
   * Asks the model for tests, checks them (one revision on failed checks), writes them and
   * returns the hash a person approves. Files of an earlier, unapproved design are restored
   * first.
   */
  private async designTests(): Promise<string> {
    const earlier = await this.store.readJsonIfExists(ARTIFACT.testFiles, TestFiles);
    if (earlier !== undefined && earlier.files.length > 0) await this.restoreTestFiles(earlier);
    const task = await this.task();
    const pack = await this.store.readJson(ARTIFACT.context, ContextPack);
    const analysis = await this.store.readJsonIfExists(ARTIFACT.analysis, RequirementsAnalysis);
    const plan = await this.store.readJson(ARTIFACT.plan, ImplementationPlan);
    const registry = await this.clarifications();
    const modules = await this.testModules();
    const done = this.record.iterations.testDesign ?? 0;
    const iteration = done + 1;
    const feedback = await this.store.readJsonIfExists(ARTIFACT.testFeedback, TestFeedback);
    const latest = feedback?.entries.at(-1);
    const previous =
      latest !== undefined && done > 0 && latest.iteration === done
        ? {
            tests: (await this.store.readJson(ARTIFACT.testDesign, TestDesign)).tests,
            feedback: latest.feedback,
          }
        : undefined;
    const existing = await this.existingTestFiles(plan, previous?.tests ?? [], modules);

    const gateway = await this.gateway();
    let failedChecks: PlanChecks["checks"] | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = testDesignPrompt({
        task,
        pack,
        analysis,
        plan,
        clarifications: registry.questions,
        modules,
        existing,
        previous,
        failedChecks,
      });
      const result = await gateway.generateStructured({
        step: STEP.testDesign,
        templateId: TEST_DESIGN_TEMPLATE.id,
        templateVersion: TEST_DESIGN_TEMPLATE.version,
        model: this.record.settings.models.testDesign ?? this.record.settings.models.planning,
        system: prompt.system,
        user: prompt.user,
        files: prompt.files,
        schema: TestDesignWire,
        schemaName: "test_design",
        maxOutputTokens:
          this.record.settings.maxOutputTokens.testDesign ?? DEFAULT_TEST_DESIGN_OUTPUT_TOKENS,
        ...this.signalOption(),
      });
      const { tests, files, checks } = await checkTestDesign({
        wire: result.value,
        task,
        modules,
        guard: this.services.guard,
      });
      const errors = checks.filter((check) => check.severity === "error");
      if (errors.length === 0) {
        const design = TestDesign.parse({
          schemaVersion: 1,
          taskId: task.id,
          iteration,
          summary: result.value.summary,
          tests,
          revised: attempt > 1,
          checks,
        });
        const record = testFilesRecord(files);
        await this.store.writeJson(ARTIFACT.testDesign, design);
        // The record is written first, so that an interrupted write can be restored.
        await this.store.writeJson(ARTIFACT.testFiles, record);
        await this.writeTestFiles(files);
        await this.store.writeText(
          ARTIFACT.testDesignMarkdown,
          renderTestDesignMarkdown(design, { task, runId: this.record.id, files: record }),
        );
        this.record.iterations = { ...this.record.iterations, testDesign: iteration };
        return record.testsSha256;
      }
      if (attempt === 2) {
        await this.store.writeJson(ARTIFACT.testDesignChecks, {
          schemaVersion: 1,
          iteration,
          revised: true,
          checks,
        } satisfies PlanChecks);
        throw new DevflowError(
          ErrorCode.TestDesignInvalid,
          `the tests still fail ${String(errors.length)} check(s) after a revision: ${errors[0]?.message ?? ""}`,
          { details: { runId: this.record.id, checks: errors.map((check) => check.message) } },
        );
      }
      failedChecks = errors;
    }
    throw new Error("unreachable");
  }

  private async writeTestFiles(files: readonly PlannedTestFile[]): Promise<void> {
    const audit = await this.audit();
    for (const file of files) {
      const checked = await this.services.guard.check(file.path, {
        access: "write",
        origin: "model",
      });
      await mkdir(path.dirname(checked.absolute), { recursive: true });
      await writeFile(checked.absolute, file.after, "utf8");
      await audit.append({
        type: "file-write",
        path: file.path,
        sha256Before: file.before === null ? null : sha256Of(file.before),
        sha256After: sha256Of(file.after),
        planChangeId: null,
      });
    }
  }

  /**
   * The red run: the approved tests run against the code before any change, through the
   * command policy. A command the policy does not allow interrupts the run, so that it can be
   * resumed once the command is approved.
   */
  private async runBaseline(): Promise<void> {
    const files = await this.testFiles();
    const approval = await this.store.readJson(ARTIFACT.testApproval, TestApproval);
    if (approval.testsSha256 !== files.testsSha256) {
      throw new DevflowError(
        ErrorCode.RunCorrupt,
        `${this.store.workspacePath(ARTIFACT.testFiles)} does not match the approved tests`,
        { details: { runId: this.record.id } },
      );
    }
    await this.verifyTestFilesUnchanged(files);
    const task = await this.task();
    const design = await this.store.readJson(ARTIFACT.testDesign, TestDesign);
    const runner = await this.testRunner();
    const affected = new Set(design.tests.map((test) => test.module));
    const gates = (await runner.gates()).filter(
      (gate) => gate.use === "test" && affected.has(gate.module),
    );
    const gateOfModule = new Map<string, string>();
    for (const gate of gates) {
      if (!gateOfModule.has(gate.module)) gateOfModule.set(gate.module, gate.id);
    }
    const selected = gates.filter((gate) => gateOfModule.get(gate.module) === gate.id);
    const run =
      selected.length === 0
        ? { gates: [], denials: [] }
        : await runner.run(selected, {
            audit: await this.audit(),
            logDir: this.store.workspacePath("logs/commands"),
            ...this.signalOption(),
          });
    if (this.services.signal?.aborted === true) {
      throw new DevflowError(ErrorCode.Cancelled, "the test run was interrupted", {
        details: { runId: this.record.id },
      });
    }
    if (run.denials.length > 0) {
      await this.store.writeJson(ARTIFACT.commandDenials, {
        schemaVersion: 1,
        denials: run.denials.map((denial) => ({
          gateId: denial.gateId,
          commandId: denial.commandId,
          argv: [...denial.argv],
          cwd: denial.cwd,
          reason: denial.reason,
          message: denial.message,
          ...(denial.fingerprint === undefined ? {} : { fingerprint: denial.fingerprint }),
        })),
      });
      throw new DevflowError(
        ErrorCode.CommandNotApproved,
        `the tests cannot run: ${denialSummary(run.denials)}`,
        { details: { runId: this.record.id } },
      );
    }
    const entries = baselineEvidence({ task, design, gates: run.gates, gateOfModule });
    // The runner's results are validated before they are trusted as evidence.
    await this.store.writeJson(
      ARTIFACT.baseline,
      BaselineRun.parse({
        schemaVersion: 1,
        ranAt: this.now(),
        testsSha256: files.testsSha256,
        gates: [...run.gates],
      }),
    );
    await this.store.writeJson(ARTIFACT.testEvidence, {
      schemaVersion: 1,
      entries,
    } satisfies TestEvidenceRecord);
  }

  /** Deterministic review of the red run. The model review arrives with the review engine. */
  private async review(): Promise<void> {
    const task = await this.task();
    const design = await this.store.readJson(ARTIFACT.testDesign, TestDesign);
    const evidence = await this.store.readJson(ARTIFACT.testEvidence, TestEvidenceRecord);
    const findings = baselineFindings({ task, design, entries: evidence.entries });
    await this.store.writeJson(ARTIFACT.findings, { schemaVersion: 1, findings });
  }

  private async writeReport(): Promise<void> {
    const task = await this.task();
    const analysis = await this.store.readJsonIfExists(ARTIFACT.analysis, RequirementsAnalysis);
    const clarifications = await this.store.readJsonIfExists(
      ARTIFACT.clarifications,
      Clarifications,
    );
    const approval = await this.store.readJsonIfExists(ARTIFACT.planApproval, PlanApproval);
    // The plan belongs in the report only when it is the run's result, not a draft that failed.
    const plan =
      this.record.state === "FAILED" && this.record.lastError?.code === ErrorCode.PlanInvalid
        ? undefined
        : await this.store.readJsonIfExists(ARTIFACT.plan, ImplementationPlan);
    const planApproval = approval === undefined ? undefined : { by: approval.by, at: approval.at };
    const testApproval = await this.store.readJsonIfExists(ARTIFACT.testApproval, TestApproval);
    const testFiles = await this.store.readJsonIfExists(ARTIFACT.testFiles, TestFiles);
    const testDesign = await this.store.readJsonIfExists(ARTIFACT.testDesign, TestDesign);
    const baseline = await this.store.readJsonIfExists(ARTIFACT.baseline, BaselineRun);
    const evidence = await this.store.readJsonIfExists(ARTIFACT.testEvidence, TestEvidenceRecord);
    const findings = await this.store.readJsonIfExists(ARTIFACT.findings, Findings);
    const testsApproval =
      testApproval === undefined || testApproval.testsSha256 !== testFiles?.testsSha256
        ? undefined
        : { by: testApproval.by, at: testApproval.at };
    const report = buildReport({
      record: this.record,
      task,
      analysis,
      clarifications,
      plan,
      planApproval,
      testDesign,
      testFiles,
      testsApproval,
      baseline,
      evidence,
      findings: findings?.findings,
    });
    await this.store.writeJson("report.json", report);
    await this.store.writeText(
      "report.md",
      renderReportMarkdown(report, {
        lastError: this.record.lastError,
        planApproval,
        testsApproval,
        evidence: evidence?.entries,
      }),
    );
  }
}
