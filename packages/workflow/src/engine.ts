import { readdir } from "node:fs/promises";
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
  ImplementationPlan,
  IsoDateTime,
  type LlmProvider,
  type PathGuard,
  type ProjectConfig,
  type SecretRedactor,
  Sha256,
  TaskContract,
  type WorkflowMode,
  type WorkflowState,
  formatIssuePath,
  isDevflowError,
  isTerminalState,
  lintTask,
} from "@devflow/core";
import { z } from "zod";
import { checkAnalysis, checkPlan } from "./checks.js";
import { ANALYSIS_TEMPLATE, PLAN_TEMPLATE, analysisPrompt, planPrompt } from "./prompts.js";
import { buildReport, renderPlanMarkdown, renderReportMarkdown } from "./report.js";
import { RunStore } from "./run-store.js";
import {
  AnalysisWire,
  type ClarificationRecord,
  Clarifications,
  type PlanChecks,
  PlanFeedback,
  PlanWire,
  RequirementsAnalysis,
  type RunBudgets,
  type RunGoal,
  type RunRecord,
  type RunSettings,
} from "./schemas.js";
import { assertModeImplemented, assertTransition } from "./transitions.js";

/** Step ids, used for budgets (`maxCallsPerStep`), events and logs. */
export const STEP = {
  context: "context-loading",
  analysis: "requirements-analysis",
  planning: "planning",
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
} as const;

const PlanApproval = z.strictObject({
  schemaVersion: z.literal(1),
  planSha256: Sha256,
  by: z.string().min(1),
  at: IsoDateTime,
});

/** Errors after which retrying the step cannot help: the run moves to FAILED. */
const TERMINAL_ERRORS: ReadonlySet<string> = new Set([ErrorCode.LlmRefused, ErrorCode.PlanInvalid]);

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
  /** Gateway tuning (timeouts, retries); injected in tests. */
  readonly gateway?: Pick<
    LlmGatewayOptions,
    "retry" | "timeoutMs" | "sleep" | "random" | "maxRepairAttempts"
  >;
}

export type RunStatus = "completed" | "waiting" | "interrupted" | "failed" | "cancelled";

export interface RunOutcome {
  readonly runId: string;
  readonly state: WorkflowState;
  readonly status: RunStatus;
  readonly waitingFor?: "plan-approval" | "clarification";
  /** Blocking questions that still need an answer, when waiting for clarification. */
  readonly questions?: readonly ClarificationRecord[];
  /** Why the run stopped, when it was interrupted or failed. */
  readonly error?: { readonly code: string; readonly message: string };
  /** Workspace-relative paths. */
  readonly runDir: string;
  readonly planPath?: string;
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
      iterations: { analysis: 0, planning: 0 },
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

/** Approves the plan a run is waiting on. In assist mode this completes the run. */
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
    await session.transition("COMPLETED", "plan approved");
    return session.drive();
  });
}

/** Rejects the plan with feedback and plans again. */
export async function rejectPlan(
  runId: string,
  decision: { by: string; feedback: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  const feedback = decision.feedback.trim();
  if (feedback === "" || feedback.length > 20_000) {
    throw new DevflowError(
      ErrorCode.DecisionInputInvalid,
      "rejection feedback must be between 1 and 20000 characters",
      { details: { runId } },
    );
  }
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
    case "TASK_RECEIVED":
    case "CONTEXT_LOADING":
    case "REQUIREMENTS_ANALYSIS":
    case "PLANNING":
    case "TEST_DESIGN":
    case "IMPLEMENTATION":
    case "VERIFICATION":
    case "REVIEW":
      // A run outside a terminal or waiting state is not being driven: it was interrupted.
      return { ...base, status: "interrupted", ...error };
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
            await this.transition("COMPLETED", "plan ready (approval not required)");
            break;
          }
          // Waiting states stop the drive; terminal states are handled before the switch.
          case "CLARIFICATION_REQUIRED":
          case "AWAITING_PLAN_APPROVAL":
          case "COMPLETED":
          case "FAILED":
          case "CANCELLED":
            return await this.outcome();
          case "TEST_DESIGN":
          case "IMPLEMENTATION":
          case "VERIFICATION":
          case "REVIEW":
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
    const report = buildReport({
      record: this.record,
      task,
      analysis,
      clarifications,
      plan,
      planApproval,
    });
    await this.store.writeJson("report.json", report);
    await this.store.writeText(
      "report.md",
      renderReportMarkdown(report, { lastError: this.record.lastError, planApproval }),
    );
  }
}
