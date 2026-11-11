import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
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
  type ContractDiff,
  type ContractToolset,
  compareContract,
  contractImpact,
  contractKindOf,
} from "@devflow/contracts";
import {
  AuditLog,
  DevflowError,
  ErrorCode,
  Finding,
  type GateDefinition,
  type GateOutcome,
  type GitWorkspace,
  ImplementationPlan,
  IsoDateTime,
  type LlmProvider,
  PathGuard,
  type ProjectConfig,
  type SecretRedactor,
  Sha256,
  TaskContract,
  type VerificationRun,
  cutPatch,
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
import { consumerRepository, consumerSources } from "./impact.js";
import {
  type PlannedChangeFile,
  afterEvidence,
  afterFindings,
  assessAfterRun,
  changeFilesRecord,
  checkImplementation,
  failureSummary,
} from "./implementation.js";
import {
  ANALYSIS_TEMPLATE,
  type ExistingTestFile,
  IMPLEMENTATION_TEMPLATE,
  PLAN_TEMPLATE,
  PROBE_TEMPLATE,
  REVIEW_TEMPLATE,
  TEST_DESIGN_TEMPLATE,
  analysisPrompt,
  implementationPrompt,
  planPrompt,
  probePrompt,
  reviewPrompt,
  testDesignPrompt,
} from "./prompts.js";
import {
  aiFindings,
  looksLikeTestPath,
  patchLines,
  reviewFindings,
  untrackedSection,
  withholdSections,
} from "./review.js";
import {
  buildReport,
  renderImplementationMarkdown,
  renderPlanMarkdown,
  renderReportMarkdown,
  renderTestDesignMarkdown,
} from "./report.js";
import { RunStore } from "./run-store.js";
import {
  PROBE_WORKTREE,
  checkProbe,
  classifyProbe,
  moduleOfFile,
  probeCandidates,
  probeSha256,
  probedFinding,
} from "./probes.js";
import {
  AfterRun,
  AnalysisWire,
  BaselineRun,
  ChangeApproval,
  ChangeFeedback,
  ChangeFiles,
  ChangedFiles,
  type ClarificationRecord,
  Clarifications,
  type DesignedTest,
  type GitIsolationRecord,
  ImplementationRecord,
  ImplementationWire,
  type PlanChecks,
  PlanFeedback,
  PlanWire,
  type ProbeRecord,
  ProbeWire,
  ProbesRecord,
  RequirementsAnalysis,
  ReviewContracts,
  ReviewDiff,
  ReviewGates,
  type ReviewPullRequest,
  ReviewRecord,
  ReviewWire,
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
import {
  DEFAULT_GIT_SETTINGS,
  DEFAULT_IMPLEMENTATION_OUTPUT_TOKENS,
  DEFAULT_MAX_REPAIR_ATTEMPTS,
  DEFAULT_REVIEW_OUTPUT_TOKENS,
  DEFAULT_TEST_DESIGN_OUTPUT_TOKENS,
} from "./settings.js";
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
  implementation: "implementation",
  verification: "verification",
  review: "review",
  probes: "evidence-probes",
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
  baselineEvidence: "artifacts/baseline-evidence.json",
  implementation: "artifacts/implementation.json",
  implementationMarkdown: "artifacts/implementation.md",
  implementationChecks: "artifacts/implementation-checks.json",
  changeFiles: "artifacts/change-files.json",
  changedFiles: "artifacts/changed-files.json",
  changeApproval: "artifacts/change-approval.json",
  changeFeedback: "artifacts/change-feedback.json",
  after: "artifacts/after.json",
  reviewDiff: "artifacts/review-diff.json",
  reviewPatch: "artifacts/review-diff.patch",
  reviewGates: "artifacts/review-gates.json",
  reviewContracts: "artifacts/review-contracts.json",
  review: "artifacts/review.json",
  probes: "artifacts/probes.json",
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
  ErrorCode.ImplementationInvalid,
  ErrorCode.ImplementationFilesChanged,
  ErrorCode.ReviewNoChanges,
]);

/** Review mode: the patch kept for the review, and the part of it that goes into the prompt. */
const MAX_REVIEW_PATCH_BYTES = 1024 * 1024;
const MAX_REVIEW_PROMPT_PATCH_BYTES = 192 * 1024;
/** Evidence-seeking review: the part of the patch that goes into each probe prompt. */
const MAX_PROBE_PROMPT_PATCH_BYTES = 64 * 1024;
/** Untracked files larger than this are listed but not shown. */
const MAX_UNTRACKED_FILE_BYTES = 256 * 1024;
/** Review mode: contract files larger than this are not compared. */
const MAX_CONTRACT_FILE_BYTES = 4 * 1024 * 1024;
/** Review mode: at most this many changed contract files are compared. */
const MAX_REVIEW_CONTRACTS = 50;

/** Existing test files shown to the test designer: at most this many, each at most this size. */
const MAX_EXISTING_TEST_FILES = 8;
const MAX_EXISTING_TEST_FILE_BYTES = 64 * 1024;

/** Files of the plan shown to the implementer: at most this many, each at most this size. */
const MAX_SOURCE_FILES = 12;
const MAX_SOURCE_FILE_PROMPT_BYTES = 128 * 1024;

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
  /**
   * Evidence-seeking review (ADR 0025): runs only the tests a filter selects (the adapter's
   * test command that takes a filter), for a module whose files are under `root`, a
   * workspace-relative copy of the workspace, through the command policy. Without it, review
   * mode cannot run probes.
   */
  runProbe?(
    request: {
      readonly root: string;
      readonly module: string;
      readonly filter: string;
      /** The probe file, workspace-relative, for the adapter's `testSelection`. */
      readonly testFile?: string;
    },
    context: {
      readonly audit: AuditLog;
      readonly logDir: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<GateOutcome>;
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
  /**
   * Test and implement mode: DevFlow's own git operations (ADR 0012). With it, a run needs a
   * clean working tree and keeps its changes on a branch of its own, committed when a person
   * approves them. Without it, or outside a repository, the changes stay uncommitted in the
   * working tree and the report says so.
   */
  readonly git?: GitWorkspace;
  /**
   * Review mode: the probe, command policy and executor that let `oasdiff` and `buf` decide
   * contract compatibility (ADR 0021). Without it, or when the tools are missing or not
   * approved, the built-in rules decide.
   */
  readonly contractTools?: (context: {
    readonly audit: AuditLog;
    /** Workspace-relative directory for the command logs. */
    readonly logDir: string;
    readonly signal?: AbortSignal;
  }) => Promise<ContractToolset>;
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
  readonly waitingFor?: "plan-approval" | "clarification" | "test-approval" | "change-approval";
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
  /** The implementation to review, when waiting for change approval. */
  readonly changesPath?: string;
  /** The changed files to review, when waiting for change approval. */
  readonly changedFiles?: readonly string[];
  /** Commands the policy did not let run, when the run stopped for that reason. */
  readonly denials?: readonly CommandDenial[];
  readonly reportPath?: string;
  /** The run's own branch, when it keeps its changes on one (ADR 0012). */
  readonly branch?: string;
}

export interface StartRunInput {
  readonly task: TaskContract;
  readonly taskFile: string | null;
  readonly mode: WorkflowMode;
  readonly goal: RunGoal;
  readonly settings: RunSettings;
  readonly warnings?: readonly string[];
  /** Review mode: the reference the local change is compared with (default `HEAD`). */
  readonly review?: {
    readonly base: string;
    /**
     * A pull request under review: its head must be the checked-out commit and the working tree
     * clean, so that exactly the pull request is reviewed.
     */
    readonly pullRequest?: ReviewPullRequest;
    /** Why the gates must not run on this change (they are then reported as not run). */
    readonly skipGates?: string;
    /** `--seek-evidence`: probe the model's findings with tests, at most this many (ADR 0025). */
    readonly seekEvidence?: { readonly maxProbes: number };
  };
}

/** Starts a run and drives it until it finishes or needs a person. */
export async function startRun(
  input: StartRunInput,
  services: WorkflowServices,
): Promise<RunOutcome> {
  assertModeImplemented(input.mode);
  for (const mode of ["test", "implement", "review"] as const) {
    if ((input.mode === mode) !== (input.goal === mode)) {
      throw new DevflowError(
        ErrorCode.InvalidTransition,
        input.mode === mode
          ? `${mode} mode runs to its end; start it with the ${mode} goal (devflow ${mode}), not ${input.goal}`
          : `the ${input.goal} goal needs ${input.goal} mode, not ${input.mode} mode`,
        { details: { mode: input.mode, goal: input.goal } },
      );
    }
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
  if (writesCode(input.mode)) await checkGitBeforeStart(input.settings, services);
  const review = input.mode === "review" ? await reviewBase(input, services) : undefined;
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
      ...(review === undefined ? {} : { review }),
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
      writesCode(session.record.mode) ? "TEST_DESIGN" : "COMPLETED",
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
    await session.assertOnBranch();
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
    await session.commitPhase(
      "tests",
      Math.max(1, session.record.iterations.testDesign ?? 0),
      files.files.map((file) => file.path),
      decision.by,
    );
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

/**
 * Approves the code an implement-mode run wrote. Like tests, model-written code runs only after
 * a person approved it: the approval is bound to the hash of every written file, and the gates
 * then run on the changed code.
 */
export async function approveChanges(
  runId: string,
  decision: { by: string; changesSha256?: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  return withSession(runId, services, async (session) => {
    const pending = session.expectChangeApproval();
    if (decision.changesSha256 !== undefined && decision.changesSha256 !== pending.changesSha256) {
      throw new DevflowError(
        ErrorCode.RunNotAwaitingInput,
        "the changes awaiting approval are not the ones you reviewed (their hash differs); review them again",
        { details: { runId, expected: pending.changesSha256, given: decision.changesSha256 } },
      );
    }
    const files = await session.changeFiles();
    if (files.changesSha256 !== pending.changesSha256) {
      throw new DevflowError(
        ErrorCode.RunCorrupt,
        `${session.store.workspacePath(ARTIFACT.changeFiles)} does not match the changes awaiting approval`,
        { details: { runId } },
      );
    }
    await session.verifyWrittenFilesUnchanged();
    await session.assertOnBranch();
    await (
      await session.audit()
    ).append({
      type: "decision",
      subject: "changes",
      decision: "approved",
      by: decision.by,
      reference: pending.changesSha256,
    });
    await session.store.writeJson(ARTIFACT.changeApproval, {
      schemaVersion: 1,
      iteration: files.iteration,
      changesSha256: pending.changesSha256,
      by: decision.by,
      at: session.now(),
    } satisfies ChangeApproval);
    await session.commitPhase(
      (session.record.iterations.verification ?? 0) > 0 ? "repair" : "implementation",
      files.iteration,
      files.files.map((file) => file.path),
      decision.by,
    );
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `changes approved by ${decision.by}`,
    });
    session.record.pending = null;
    await session.transition("VERIFICATION", "changes approved");
    return session.drive();
  });
}

/**
 * Rejects the code an implement-mode run wrote: its files are restored to what they were before
 * this implementation, and the code is written again with the feedback.
 */
export async function rejectChanges(
  runId: string,
  decision: { by: string; feedback: string },
  services: WorkflowServices,
): Promise<RunOutcome> {
  const feedback = checkedFeedback(runId, decision.feedback);
  return withSession(runId, services, async (session) => {
    const pending = session.expectChangeApproval();
    const files = await session.changeFiles();
    await session.verifyWrittenFilesUnchanged();
    await (
      await session.audit()
    ).append({
      type: "decision",
      subject: "changes",
      decision: "rejected",
      by: decision.by,
      reference: pending.changesSha256,
      feedback,
    });
    const existing =
      (await session.store.readJsonIfExists(ARTIFACT.changeFeedback, ChangeFeedback)) ??
      ({ schemaVersion: 1, entries: [] } satisfies ChangeFeedback);
    existing.entries.push({
      iteration: files.iteration,
      changesSha256: pending.changesSha256,
      feedback,
      by: decision.by,
      at: session.now(),
    });
    await session.store.writeJson(ARTIFACT.changeFeedback, existing);
    await session.restoreChangeFiles(files);
    await session.store.appendEvent({
      type: "decision",
      state: session.record.state,
      detail: `changes rejected by ${decision.by}`,
    });
    session.record.pending = null;
    await session.save();
    return session.drive();
  });
}

/** Modes that write files into the workspace: tests, then (implement mode) code. */
function writesCode(mode: WorkflowMode): boolean {
  return mode === "test" || mode === "implement";
}

/**
 * Before a run that will change files starts: the configured isolation must exist, and the
 * working tree must be clean, so that DevFlow's changes never mix with uncommitted ones.
 */
async function checkGitBeforeStart(
  settings: RunSettings,
  services: WorkflowServices,
): Promise<void> {
  const git = settings.git ?? DEFAULT_GIT_SETTINGS;
  if (git.isolation === "worktree") {
    throw new DevflowError(
      ErrorCode.GitIsolationUnsupported,
      "workflow.git.isolation: worktree is not implemented yet; use branch (the default)",
      { details: { isolation: git.isolation } },
    );
  }
  if (services.git === undefined) return;
  const inspection = await services.git.inspect();
  if (inspection.kind === "repository" && inspection.changes.length > 0) {
    throw treeNotClean(inspection.changes);
  }
}

/**
 * Review mode: the commit the local change is compared with (the merge base of the reference
 * and HEAD), checked before a run is created: a repository, and something to review.
 */
async function reviewBase(
  input: StartRunInput,
  services: WorkflowServices,
): Promise<NonNullable<RunRecord["review"]>> {
  const base = input.review?.base ?? "HEAD";
  const pullRequest = input.review?.pullRequest;
  const git = services.git;
  if (git === undefined) {
    throw new DevflowError(ErrorCode.GitFailed, "review mode needs git to read the local change");
  }
  const inspection = await git.inspect();
  if (inspection.kind === "unavailable") {
    throw new DevflowError(
      ErrorCode.GitFailed,
      `review mode needs a git repository with a commit: ${inspection.reason}`,
    );
  }
  if (pullRequest !== undefined) {
    const label = `${pullRequest.repository}#${String(pullRequest.number)}`;
    if (inspection.head !== pullRequest.headCommit) {
      throw new DevflowError(
        ErrorCode.ReviewPullRequestNotCheckedOut,
        `the checked-out commit ${inspection.head.slice(0, 12)} is not the head of ${label} ` +
          `(${pullRequest.headCommit.slice(0, 12)}); check it out first, for example ` +
          `\`git fetch origin pull/${String(pullRequest.number)}/head\` and ` +
          "`git checkout --detach FETCH_HEAD`",
        { details: { pullRequest: label, head: inspection.head } },
      );
    }
    if (inspection.changes.length > 0) throw treeNotClean(inspection.changes);
  }
  let baseCommit: string;
  try {
    baseCommit = await git.mergeBase(base);
  } catch (error) {
    if (pullRequest === undefined || !isDevflowError(error)) throw error;
    throw new DevflowError(
      ErrorCode.GitFailed,
      `the base of the pull request (${base.slice(0, 12)}) is not in this repository; fetch ` +
        "its base branch first, for example `git fetch origin <base branch>`",
      { details: { base }, cause: error },
    );
  }
  const diff = await git.diff(baseCommit, { maxPatchBytes: 0 });
  if (diff.files.length === 0) {
    throw new DevflowError(
      ErrorCode.ReviewNoChanges,
      `there is no change since ${base} to review (outside .devflow/)`,
      { details: { base, baseCommit } },
    );
  }
  const skipGates = input.review?.skipGates;
  const seekEvidence = input.review?.seekEvidence;
  return {
    base,
    baseCommit,
    ...(pullRequest === undefined ? {} : { pullRequest }),
    ...(skipGates === undefined ? {} : { gatesSkipped: skipGates }),
    ...(seekEvidence === undefined ? {} : { seekEvidence: { maxProbes: seekEvidence.maxProbes } }),
  };
}

function treeNotClean(changes: readonly string[]): DevflowError {
  const shown = changes.slice(0, 5).join(", ");
  const more = changes.length > 5 ? ` and ${String(changes.length - 5)} more` : "";
  return new DevflowError(
    ErrorCode.GitTreeNotClean,
    `the working tree has uncommitted changes (${shown}${more}); commit or stash them first, ` +
      "so that DevFlow's changes stay apart from yours",
    { details: { changes: changes.slice(0, 50) } },
  );
}

/** The first line of a DevFlow commit, and its body. */
function commitMessage(input: {
  taskId: string;
  title: string;
  runId: string;
  phase: "tests" | "implementation" | "repair";
  repair: number;
  by: string;
}): { subject: string; message: string } {
  const what =
    input.phase === "tests"
      ? "add tests"
      : input.phase === "implementation"
        ? "implement the change"
        : `repair ${String(input.repair)}`;
  const subject = `DevFlow ${input.taskId}: ${what}`;
  const title = input.title.replace(/\s+/g, " ").trim();
  return {
    subject,
    message: `${subject}\n\n${title}\n\nRun ${input.runId}, approved by ${input.by.replace(/\s+/g, " ")}.`,
  };
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
    ...(record.git?.status === "branch" ? { branch: record.git.branch } : {}),
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
    case "IMPLEMENTATION":
      if (record.pending?.kind === "change-approval") {
        const files = await store.readJsonIfExists(ARTIFACT.changeFiles, ChangeFiles);
        return {
          ...base,
          status: "waiting",
          waitingFor: "change-approval",
          changesPath: store.workspacePath(ARTIFACT.implementationMarkdown),
          changedFiles: files?.files.map((file) => file.path) ?? [],
        };
      }
      return { ...base, status: "interrupted", ...error };
    case "TASK_RECEIVED":
    case "CONTEXT_LOADING":
    case "REQUIREMENTS_ANALYSIS":
    case "PLANNING":
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

  /**
   * Gives the run its own branch before it writes the first file (ADR 0012): the working tree
   * must still be clean. Outside a repository, or without git, the changes stay in the working
   * tree, and the report says why.
   */
  private async isolate(): Promise<void> {
    if (this.record.git !== undefined) return;
    const settings = this.record.settings.git ?? DEFAULT_GIT_SETTINGS;
    const git = this.services.git;
    let isolation: GitIsolationRecord;
    if (git === undefined) {
      isolation = { status: "none", reason: "the run was started without git" };
    } else {
      const inspection = await git.inspect();
      if (inspection.kind === "unavailable") {
        isolation = { status: "none", reason: inspection.reason };
      } else {
        if (inspection.changes.length > 0) throw treeNotClean(inspection.changes);
        const branch = await git.freeBranchName(`${settings.branchPrefix}${this.record.task.id}`);
        await git.createBranch(branch);
        isolation = {
          status: "branch",
          branch,
          baseBranch: inspection.branch,
          baseCommit: inspection.head,
          commit: settings.commit,
          commits: [],
          warnings: [],
        };
      }
    }
    this.record.git = isolation;
    await this.save();
    await this.store.appendEvent({
      type: "git",
      state: this.record.state,
      detail:
        isolation.status === "branch"
          ? `created and checked out ${isolation.branch} at ${isolation.baseCommit.slice(0, 12)}`
          : `no branch: ${isolation.reason}`,
    });
  }

  /** Refuses to write, run or commit when the run's branch is no longer checked out. */
  async assertOnBranch(): Promise<void> {
    const isolation = this.record.git;
    if (isolation?.status !== "branch") return;
    const git = this.services.git;
    if (git === undefined) {
      throw new DevflowError(
        ErrorCode.GitFailed,
        `this run keeps its changes on ${isolation.branch}, but it was resumed without git`,
        { details: { branch: isolation.branch } },
      );
    }
    const current = await git.currentBranch();
    if (current !== isolation.branch) {
      throw new DevflowError(
        ErrorCode.GitBranchChanged,
        `the run's branch ${isolation.branch} is not checked out (` +
          (current === null ? "HEAD is detached" : `${current} is`) +
          `); check it out again (git switch ${isolation.branch}) and retry`,
        { details: { expected: isolation.branch, current } },
      );
    }
  }

  /**
   * Commits what a person just approved on the run's branch. A commit that fails does not stop
   * the run: the files stay uncommitted on the branch, and the report asks for a look.
   */
  async commitPhase(
    phase: "tests" | "implementation" | "repair",
    iteration: number,
    paths: readonly string[],
    by: string,
  ): Promise<void> {
    const isolation = this.record.git;
    const git = this.services.git;
    if (isolation?.status !== "branch" || isolation.commit !== "per-phase" || git === undefined) {
      return;
    }
    const { subject, message } = commitMessage({
      taskId: this.record.task.id,
      title: this.record.task.title,
      runId: this.record.id,
      phase,
      repair: this.record.iterations.verification ?? 0,
      by,
    });
    let detail: string;
    try {
      const sha = await git.commit(paths, message);
      isolation.commits.push({ phase, iteration, sha, subject, at: this.now() });
      detail = `committed ${phase} ${String(iteration)} as ${sha.slice(0, 12)}`;
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      const reason = this.services.redactor.redactText(error.message);
      isolation.warnings.push(
        `The approved ${phase === "tests" ? "tests were" : `${phase} was`} not committed (${reason}); ` +
          `commit or review these files on ${isolation.branch}: ${paths.join(", ")}.`,
      );
      detail = `${phase} ${String(iteration)} not committed: ${reason}`;
    }
    await this.save();
    await this.store.appendEvent({ type: "git", state: this.record.state, detail });
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

  expectChangeApproval(): { kind: "change-approval"; changesSha256: string } {
    const pending = this.record.pending;
    if (this.record.state !== "IMPLEMENTATION" || pending?.kind !== "change-approval") {
      throw notWaiting(this.record, "a decision on the changes");
    }
    return pending;
  }

  async testFiles(): Promise<TestFiles> {
    return this.store.readJson(ARTIFACT.testFiles, TestFiles);
  }

  async changeFiles(): Promise<ChangeFiles> {
    return this.store.readJson(ARTIFACT.changeFiles, ChangeFiles);
  }

  private async changedFiles(): Promise<ChangedFiles> {
    return (
      (await this.store.readJsonIfExists(ARTIFACT.changedFiles, ChangedFiles)) ?? {
        schemaVersion: 1,
        files: [],
      }
    );
  }

  /**
   * Throws unless the approved tests and every production file the run changed are as DevFlow
   * left them: what a person approves, and what runs, is what DevFlow wrote.
   */
  async verifyWrittenFilesUnchanged(): Promise<void> {
    await this.verifyTestFilesUnchanged(await this.testFiles());
    for (const file of (await this.changedFiles()).files) {
      const { sha256 } = await this.currentHash(file.path);
      if (sha256 !== file.currentSha256) {
        throw new DevflowError(
          ErrorCode.ImplementationFilesChanged,
          `${file.path} was ${sha256 === null ? "deleted" : "changed"} after DevFlow wrote it; ` +
            "the code a person approves must be the code that runs. Restore it, or cancel the run",
          { details: { runId: this.record.id, path: file.path } },
        );
      }
    }
  }

  /** Puts back the files of an implementation that was rejected. */
  async restoreChangeFiles(files: ChangeFiles): Promise<void> {
    await this.restoreFiles(files.files, ErrorCode.ImplementationFilesChanged);
    const changed = await this.changedFiles();
    for (const file of files.files) {
      const entry = changed.files.find((candidate) => candidate.path === file.path);
      if (entry !== undefined) entry.currentSha256 = file.beforeSha256;
    }
    changed.files = changed.files.filter((entry) => entry.currentSha256 !== entry.originalSha256);
    await this.store.writeJson(ARTIFACT.changedFiles, changed);
    await this.store.writeJson(ARTIFACT.changeFiles, {
      ...files,
      changesSha256: testsHash([]),
      files: [],
    } satisfies ChangeFiles);
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
    await this.restoreFiles(files.files, ErrorCode.TestFilesChanged);
    await this.store.writeJson(ARTIFACT.testFiles, {
      schemaVersion: 1,
      testsSha256: testsHash([]),
      files: [],
    } satisfies TestFiles);
  }

  private async restoreFiles(
    files: readonly {
      path: string;
      before: string | null;
      beforeSha256: string | null;
      afterSha256: string | null;
      planChangeId?: string;
    }[],
    code: typeof ErrorCode.TestFilesChanged | typeof ErrorCode.ImplementationFilesChanged,
  ): Promise<void> {
    await this.assertOnBranch();
    const audit = await this.audit();
    for (const file of [...files].reverse()) {
      const { absolute, sha256 } = await this.currentHash(file.path);
      if (sha256 === file.beforeSha256) continue;
      if (sha256 !== file.afterSha256) {
        throw new DevflowError(
          code,
          `${file.path} was changed after DevFlow wrote it, so it is not restored; restore or ` +
            "remove it yourself, or cancel the run",
          { details: { runId: this.record.id, path: file.path } },
        );
      }
      if (file.before === null) {
        await unlink(absolute);
      } else {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, file.before, "utf8");
      }
      await audit.append({
        type: "file-write",
        path: file.path,
        sha256Before: file.afterSha256,
        sha256After: file.beforeSha256,
        planChangeId: file.planChangeId ?? null,
      });
    }
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
              this.record.goal === "analyze"
                ? "COMPLETED"
                : this.record.mode === "review"
                  ? "VERIFICATION"
                  : "PLANNING",
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
              writesCode(this.record.mode) ? "TEST_DESIGN" : "COMPLETED",
              "plan ready (approval not required)",
            );
            break;
          }
          case "TEST_DESIGN": {
            if (this.record.pending?.kind === "test-approval") return await this.outcome();
            await this.isolate();
            const testsSha256 = await this.step(STEP.testDesign, () => this.designTests());
            this.record.pending = { kind: "test-approval", testsSha256 };
            await this.save();
            return await this.outcome();
          }
          case "VERIFICATION":
            if (this.record.mode === "review") {
              await this.step(STEP.verification, () => this.reviewSnapshot());
              await this.transition("REVIEW", "gates run on the change");
            } else if (this.record.mode !== "implement") {
              await this.step(STEP.verification, () => this.runBaseline());
              await this.transition("REVIEW", "tests run against the current code");
            } else if ((this.record.iterations.implementation ?? 0) === 0) {
              await this.step(STEP.verification, () => this.runBaseline());
              await this.transition(
                "IMPLEMENTATION",
                "gates run against the code before the change",
              );
            } else {
              const after = await this.step(STEP.verification, () => this.runAfter());
              await this.transition(
                after.decision === "repair" ? "IMPLEMENTATION" : "REVIEW",
                `verified after the change: ${after.reason}`,
              );
            }
            break;
          case "IMPLEMENTATION": {
            if (this.record.pending?.kind === "change-approval") return await this.outcome();
            const changesSha256 = await this.step(STEP.implementation, () => this.implement());
            this.record.pending = { kind: "change-approval", changesSha256 };
            await this.save();
            return await this.outcome();
          }
          case "REVIEW":
            if (this.record.mode === "review") {
              // A resumed run does not ask the model again for a review it already has.
              if (!(await this.store.exists(ARTIFACT.review))) {
                await this.step(STEP.review, () => this.reviewChange());
              }
              if (this.record.review?.seekEvidence !== undefined) {
                await this.step(STEP.probes, () => this.seekEvidence());
              }
            } else {
              await this.step(STEP.review, () => this.review());
            }
            await this.transition(
              "COMPLETED",
              this.record.mode === "test" ? "red baseline reviewed" : "change reviewed",
            );
            break;
          // Waiting states stop the drive; terminal states are handled before the switch.
          case "CLARIFICATION_REQUIRED":
          case "AWAITING_PLAN_APPROVAL":
          case "COMPLETED":
          case "FAILED":
          case "CANCELLED":
            return await this.outcome();
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
    return this.promptFiles(candidates, MAX_EXISTING_TEST_FILES, MAX_EXISTING_TEST_FILE_BYTES);
  }

  /**
   * The full, redacted content of workspace files for a prompt: files the path guard lets a
   * model see, that exist and are small enough; at most `max` of them.
   */
  private async promptFiles(
    candidates: readonly string[],
    max: number,
    maxBytes: number,
  ): Promise<ExistingTestFile[]> {
    const files: ExistingTestFile[] = [];
    for (const candidate of new Set(candidates)) {
      if (files.length >= max) break;
      try {
        const checked = await this.services.guard.check(candidate, {
          access: "prompt",
          origin: "model",
        });
        if (!checked.exists) continue;
        const buffer = await readFile(checked.absolute);
        if (buffer.length > maxBytes) continue;
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
    await this.assertOnBranch();
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
    await this.assertOnBranch();
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
    const all = await runner.gates();
    const gateOfModule = testGateOfModule(all, design);
    // Test mode runs the tests only; implement mode runs every gate, to compare the change with.
    const selected =
      this.record.mode === "implement"
        ? [...all]
        : all.filter((gate) => gateOfModule.get(gate.module) === gate.id);
    const run = await this.runGatesChecked(runner, selected, "logs/commands");
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
    const evidence = { schemaVersion: 1, entries } satisfies TestEvidenceRecord;
    await this.store.writeJson(ARTIFACT.testEvidence, evidence);
    if (this.record.mode === "implement") {
      await this.store.writeJson(ARTIFACT.baselineEvidence, evidence);
    }
  }

  /**
   * Runs gates through the runner (and so the command policy). A command the policy does not
   * allow interrupts the run, so that it can be resumed once the command is approved.
   */
  private async runGatesChecked(
    runner: TestRunner,
    gates: readonly GateDefinition[],
    logDir: string,
  ): Promise<VerificationRun> {
    const run =
      gates.length === 0
        ? { gates: [], denials: [] }
        : await runner.run(gates, {
            audit: await this.audit(),
            logDir: this.store.workspacePath(logDir),
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
    return run;
  }

  /**
   * Asks the model for the code change (a repair after a failed verification), checks it (one
   * revision on failed checks), writes it and returns the hash a person approves.
   */
  private async implement(): Promise<string> {
    const task = await this.task();
    const pack = await this.store.readJson(ARTIFACT.context, ContextPack);
    const analysis = await this.store.readJsonIfExists(ARTIFACT.analysis, RequirementsAnalysis);
    const plan = await this.store.readJson(ARTIFACT.plan, ImplementationPlan);
    const registry = await this.clarifications();
    const design = await this.store.readJson(ARTIFACT.testDesign, TestDesign);
    const tests = await this.testFiles();
    const modules = await this.testModules();
    await this.verifyWrittenFilesUnchanged();
    const done = this.record.iterations.implementation ?? 0;
    const iteration = done + 1;
    const after =
      (this.record.iterations.verification ?? 0) > 0
        ? await this.store.readJson(ARTIFACT.after, AfterRun)
        : undefined;
    const repair =
      after?.decision === "repair"
        ? { attempt: after.attempt, failures: failureSummary(after) }
        : undefined;
    const feedback = await this.store.readJsonIfExists(ARTIFACT.changeFeedback, ChangeFeedback);
    const latest = feedback?.entries.at(-1);
    const previous =
      latest !== undefined && done > 0 && latest.iteration === done
        ? {
            changes: (await this.store.readJson(ARTIFACT.implementation, ImplementationRecord))
              .changes,
            feedback: latest.feedback,
          }
        : undefined;
    const testPaths = new Set(tests.files.map((file) => file.path));
    const testFiles = await this.promptFiles(
      [...testPaths],
      MAX_EXISTING_TEST_FILES,
      MAX_EXISTING_TEST_FILE_BYTES,
    );
    const sources = await this.promptFiles(
      plan.changes.map((change) => change.path).filter((file) => !testPaths.has(file)),
      MAX_SOURCE_FILES,
      MAX_SOURCE_FILE_PROMPT_BYTES,
    );

    const gateway = await this.gateway();
    let failedChecks: PlanChecks["checks"] | undefined;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const prompt = implementationPrompt({
        task,
        pack,
        analysis,
        plan,
        clarifications: registry.questions,
        tests: design.tests,
        testFiles,
        sources,
        repair,
        previous,
        failedChecks,
      });
      const result = await gateway.generateStructured({
        step: STEP.implementation,
        templateId: IMPLEMENTATION_TEMPLATE.id,
        templateVersion: IMPLEMENTATION_TEMPLATE.version,
        model: this.record.settings.models.implementation ?? this.record.settings.models.planning,
        system: prompt.system,
        user: prompt.user,
        files: prompt.files,
        schema: ImplementationWire,
        schemaName: "implementation",
        maxOutputTokens:
          this.record.settings.maxOutputTokens.implementation ??
          DEFAULT_IMPLEMENTATION_OUTPUT_TOKENS,
        ...this.signalOption(),
      });
      const { changes, files, checks } = await checkImplementation({
        wire: result.value,
        plan,
        modules,
        testFiles: testPaths,
        guard: this.services.guard,
        repair: repair !== undefined,
      });
      const errors = checks.filter((check) => check.severity === "error");
      if (errors.length === 0) {
        const implementation = ImplementationRecord.parse({
          schemaVersion: 1,
          taskId: task.id,
          iteration,
          repair: repair !== undefined,
          summary: result.value.summary,
          changes,
          revised: attempt > 1,
          checks,
        });
        const record = ChangeFiles.parse(changeFilesRecord(files, iteration));
        await this.store.writeJson(ARTIFACT.implementation, implementation);
        // The record is written first, so that an interrupted write can be restored.
        await this.store.writeJson(ARTIFACT.changeFiles, record);
        await this.writeChangeFiles(files);
        await this.store.writeText(
          ARTIFACT.implementationMarkdown,
          renderImplementationMarkdown(implementation, {
            task,
            runId: this.record.id,
            files: record,
            failures: repair?.failures,
          }),
        );
        this.record.iterations = { ...this.record.iterations, implementation: iteration };
        return record.changesSha256;
      }
      if (attempt === 2) {
        await this.store.writeJson(ARTIFACT.implementationChecks, {
          schemaVersion: 1,
          iteration,
          revised: true,
          checks,
        } satisfies PlanChecks);
        throw new DevflowError(
          ErrorCode.ImplementationInvalid,
          `the implementation still fails ${String(errors.length)} check(s) after a revision: ${errors[0]?.message ?? ""}`,
          { details: { runId: this.record.id, checks: errors.map((check) => check.message) } },
        );
      }
      failedChecks = errors;
    }
    throw new Error("unreachable");
  }

  /**
   * Writes the implementation's files. Each file's content is checked against what the change
   * was computed from just before it is written, so an edit made meanwhile is never overwritten.
   */
  private async writeChangeFiles(files: readonly PlannedChangeFile[]): Promise<void> {
    await this.assertOnBranch();
    const audit = await this.audit();
    const changed = await this.changedFiles();
    for (const file of files) {
      const { absolute, sha256: current } = await this.currentHash(file.path);
      const before = file.before === null ? null : sha256Of(file.before);
      if (current !== before) {
        throw new DevflowError(
          ErrorCode.ImplementationFilesChanged,
          `${file.path} changed while the implementation was being written; nothing more was written`,
          { details: { runId: this.record.id, path: file.path } },
        );
      }
      if (file.after === null) {
        await unlink(absolute);
      } else {
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, file.after, "utf8");
      }
      const after = file.after === null ? null : sha256Of(file.after);
      await audit.append({
        type: "file-write",
        path: file.path,
        sha256Before: before,
        sha256After: after,
        planChangeId: file.planChangeId,
      });
      const entry = changed.files.find((candidate) => candidate.path === file.path);
      if (entry === undefined) {
        changed.files.push({
          path: file.path,
          planChangeId: file.planChangeId,
          originalSha256: before,
          currentSha256: after,
        });
      } else {
        entry.currentSha256 = after;
      }
      changed.files = changed.files.filter(
        (candidate) => candidate.currentSha256 !== candidate.originalSha256,
      );
      await this.store.writeJson(ARTIFACT.changedFiles, changed);
    }
  }

  /**
   * The verification after an approved change (the green run): every gate, the failed ones a
   * second time, compared with the baseline. Decides whether a repair follows.
   */
  private async runAfter(): Promise<AfterRun> {
    await this.assertOnBranch();
    const files = await this.changeFiles();
    const approval = await this.store.readJson(ARTIFACT.changeApproval, ChangeApproval);
    if (approval.changesSha256 !== files.changesSha256 || approval.iteration !== files.iteration) {
      throw new DevflowError(
        ErrorCode.RunCorrupt,
        `${this.store.workspacePath(ARTIFACT.changeFiles)} does not match the approved changes`,
        { details: { runId: this.record.id } },
      );
    }
    await this.verifyWrittenFilesUnchanged();
    const task = await this.task();
    const design = await this.store.readJson(ARTIFACT.testDesign, TestDesign);
    const baseline = await this.store.readJson(ARTIFACT.baseline, BaselineRun);
    const baselineEntries = await this.store.readJson(
      ARTIFACT.baselineEvidence,
      TestEvidenceRecord,
    );
    const runner = await this.testRunner();
    const all = await runner.gates();
    const attempt = (this.record.iterations.verification ?? 0) + 1;
    const run = await this.runGatesChecked(runner, all, `logs/commands/after-${String(attempt)}`);
    const failed = all.filter((gate) =>
      run.gates.some((result) => result.gateId === gate.id && result.status === "failed"),
    );
    const rerun =
      failed.length === 0
        ? []
        : (
            await this.runGatesChecked(
              runner,
              failed,
              `logs/commands/after-${String(attempt)}-rerun`,
            )
          ).gates;
    const after = AfterRun.parse(
      assessAfterRun({
        attempt,
        ranAt: this.now(),
        changesSha256: files.changesSha256,
        baseline: baseline.gates,
        gates: run.gates,
        rerun,
        maxRepairAttempts: this.record.settings.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
      }),
    );
    const entries = afterEvidence({
      task,
      design,
      baseline: baselineEntries.entries,
      gates: run.gates,
      gateOfModule: testGateOfModule(all, design),
    });
    await this.store.writeJson(`artifacts/verification-${String(attempt)}.json`, after);
    await this.store.writeJson(ARTIFACT.after, after);
    await this.store.writeJson(ARTIFACT.testEvidence, {
      schemaVersion: 1,
      entries,
    } satisfies TestEvidenceRecord);
    this.record.iterations = { ...this.record.iterations, verification: attempt };
    return after;
  }

  /**
   * Deterministic review: the red run's findings and, in implement mode, those of the
   * verification after the change. The model review arrives with the review engine.
   */
  private async review(): Promise<void> {
    const task = await this.task();
    const design = await this.store.readJson(ARTIFACT.testDesign, TestDesign);
    const implement = this.record.mode === "implement";
    const baselineEntries = await this.store.readJson(
      implement ? ARTIFACT.baselineEvidence : ARTIFACT.testEvidence,
      TestEvidenceRecord,
    );
    const findings: Omit<Finding, "id">[] = baselineFindings({
      task,
      design,
      entries: baselineEntries.entries,
    }).map(({ id: _id, ...finding }) => finding);
    if (implement) {
      const after = await this.store.readJson(ARTIFACT.after, AfterRun);
      const evidence = await this.store.readJson(ARTIFACT.testEvidence, TestEvidenceRecord);
      const baseline = await this.store.readJson(ARTIFACT.baseline, BaselineRun);
      findings.push(
        ...afterFindings({ entries: evidence.entries, after, baselineGates: baseline.gates }),
      );
    }
    await this.store.writeJson(
      ARTIFACT.findings,
      Findings.parse({
        schemaVersion: 1,
        findings: findings.map((finding, index) => ({ ...finding, id: `F-${String(index + 1)}` })),
      }),
    );
  }

  /**
   * Review mode: takes the local change as it is now (the diff since the base, untracked text
   * files included), records what the deterministic checks need, and runs every gate once on
   * it through the command policy.
   */
  private async reviewSnapshot(): Promise<void> {
    const review = this.record.review;
    const git = this.services.git;
    if (review === undefined || git === undefined) {
      throw new DevflowError(ErrorCode.GitFailed, "this review run was resumed without git", {
        details: { runId: this.record.id },
      });
    }
    const raw = await git.diff(review.baseCommit, { maxPatchBytes: MAX_REVIEW_PATCH_BYTES });
    if (raw.files.length === 0) {
      throw new DevflowError(
        ErrorCode.ReviewNoChanges,
        `there is no change since ${review.base} to review any more`,
        { details: { runId: this.record.id } },
      );
    }
    const { guard, redactor } = this.services;
    let patch = raw.patch;
    let truncated = raw.patchTruncated;
    for (const file of raw.files) {
      if (file.tracked) continue;
      const content = await this.untrackedText(file.path);
      if (content === undefined) continue;
      const section = untrackedSection(file.path, content);
      if (Buffer.byteLength(patch) + Buffer.byteLength(section) > MAX_REVIEW_PATCH_BYTES) {
        truncated = true;
        continue;
      }
      patch += section;
    }
    // Secrets are looked for in every added line, before anything is withheld or redacted.
    const secrets = patchLines(patch)
      .added.filter((line) => redactor.redactText(line.text) !== line.text)
      .map(({ path: file, line }) => ({ path: file, line }));
    const protectedFiles: { path: string; reason: string }[] = [];
    const withheld: string[] = [];
    for (const file of raw.files) {
      const write = await rejection(guard, file.path, "write", "model");
      if (write?.reason === "protected") {
        protectedFiles.push({ path: file.path, reason: write.message });
      }
      if ((await rejection(guard, file.path, "prompt", "internal")) !== undefined) {
        withheld.push(file.path);
      }
    }
    const shown = redactor.redactText(withholdSections(patch, new Set(withheld)));
    await this.store.writeText(ARTIFACT.reviewPatch, shown);
    await this.store.writeJson(
      ARTIFACT.reviewDiff,
      ReviewDiff.parse({
        schemaVersion: 1,
        base: review.base,
        baseCommit: raw.base,
        headCommit: raw.head,
        takenAt: this.now(),
        files: raw.files.map((file) => ({ ...file, test: looksLikeTestPath(file.path) })),
        patchSha256: sha256Of(shown),
        patchTruncated: truncated,
        secrets,
        protected: protectedFiles,
        withheld,
      }),
    );
    await this.reviewContracts(raw.base, raw.files, review.gatesSkipped === undefined);

    if (review.gatesSkipped !== undefined) {
      await this.store.writeJson(
        ARTIFACT.reviewGates,
        ReviewGates.parse({
          schemaVersion: 1,
          ranAt: this.now(),
          gates: [],
          skipped: review.gatesSkipped,
        }),
      );
      return;
    }
    const runner = await this.testRunner();
    const gates = await runner.gates();
    const run = await this.runGatesChecked(runner, [...gates], "logs/commands");
    await this.store.writeJson(
      ARTIFACT.reviewGates,
      ReviewGates.parse({ schemaVersion: 1, ranAt: this.now(), gates: [...run.gates] }),
    );
  }

  /**
   * Review mode: compares every changed contract file (OpenAPI, Protobuf) at the base commit
   * and in the working tree (ADR 0021). `oasdiff` or `buf` decide when they are installed and
   * the command policy lets them run (never when the gates are skipped, for example on a pull
   * request DevFlow must not run tools for); the built-in rules decide otherwise.
   */
  private async reviewContracts(
    baseCommit: string,
    files: readonly { path: string; change: string; binary: boolean }[],
    toolsAllowed: boolean,
  ): Promise<void> {
    const git = this.services.git;
    const contracts: ContractDiff[] = [];
    const versions: { file: string; base: string | null; head: string | null }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let toolset: ContractToolset | undefined;
    for (const file of files) {
      if (file.binary || !/\.(proto|ya?ml|json)$/i.test(file.path)) continue;
      const head = file.change === "deleted" ? null : await this.contractText(file.path);
      if (head === undefined) {
        if (contractKindOf(file.path) !== null) {
          skipped.push({ path: file.path, reason: "the working tree file cannot be read" });
        }
        continue;
      }
      let base: string | null = null;
      if (file.change !== "added") {
        if (git?.show === undefined) {
          if (contractKindOf(file.path, head) !== null) {
            skipped.push({
              path: file.path,
              reason: "the base version cannot be read without git",
            });
          }
          continue;
        }
        base = await git.show(baseCommit, file.path);
      }
      const kind = contractKindOf(file.path, base, head);
      if (kind === null) continue;
      if (contracts.length >= MAX_REVIEW_CONTRACTS) {
        skipped.push({
          path: file.path,
          reason: `only the first ${String(MAX_REVIEW_CONTRACTS)} contract files are compared`,
        });
        continue;
      }
      if ((base?.length ?? 0) > MAX_CONTRACT_FILE_BYTES) {
        skipped.push({ path: file.path, reason: "the base version is too large" });
        continue;
      }
      let tools: Parameters<typeof compareContract>[1];
      if (toolsAllowed && base !== null && head !== null && this.services.contractTools) {
        const copy = `contracts/base/${file.path}`;
        await this.store.writeText(copy, base);
        toolset ??= await this.services.contractTools({
          audit: await this.audit(),
          logDir: this.store.workspacePath("logs/contracts"),
          ...this.signalOption(),
        });
        tools = { toolset, basePath: this.store.workspacePath(copy), headPath: file.path };
      }
      contracts.push(await compareContract({ file: file.path, kind, base, head }, tools));
      versions.push({ file: file.path, base, head });
    }
    if (contracts.length === 0 && skipped.length === 0) return;
    // The consumers of each breaking change, in the working tree (ADR 0022).
    let impact: Partial<ReviewContracts> = {};
    if (contracts.some((diff) => diff.summary.breaking > 0)) {
      const sources = await consumerSources(this.services.guard, this.services.config);
      impact = {
        impact: contractImpact(contracts, consumerRepository(sources.files, versions)),
        impactNotes: sources.notes,
      };
    }
    await this.store.writeJson(
      ARTIFACT.reviewContracts,
      ReviewContracts.parse({
        schemaVersion: 1,
        checkedAt: this.now(),
        contracts,
        skipped,
        ...impact,
      }),
    );
  }

  /** A working-tree contract file's text, or undefined when it cannot be read. */
  private async contractText(file: string): Promise<string | undefined> {
    try {
      const checked = await this.services.guard.check(file, { access: "read", origin: "internal" });
      const content = await readFile(checked.absolute);
      if (content.length > MAX_CONTRACT_FILE_BYTES || content.includes(0)) return undefined;
      return content.toString("utf8");
    } catch (error) {
      if (isDevflowError(error)) return undefined;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "EACCES") return undefined;
      throw error;
    }
  }

  /** The text of an untracked file for the review, or undefined when it cannot be shown. */
  private async untrackedText(file: string): Promise<string | undefined> {
    try {
      const checked = await this.services.guard.check(file, {
        access: "prompt",
        origin: "internal",
      });
      const content = await readFile(checked.absolute);
      if (content.length > MAX_UNTRACKED_FILE_BYTES || content.includes(0)) return undefined;
      return content.toString("utf8");
    } catch (error) {
      if (isDevflowError(error)) return undefined;
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EISDIR" || code === "EACCES") return undefined;
      throw error;
    }
  }

  /**
   * Review mode: the deterministic checks of the change, then the model's review. The model's
   * findings stay unverified.
   */
  private async reviewChange(): Promise<void> {
    const task = await this.task();
    const pack = await this.store.readJson(ARTIFACT.context, ContextPack);
    const analysis = await this.store.readJsonIfExists(ARTIFACT.analysis, RequirementsAnalysis);
    const registry = await this.clarifications();
    const diff = await this.store.readJson(ARTIFACT.reviewDiff, ReviewDiff);
    const patch = await this.store.readText(ARTIFACT.reviewPatch);
    if (sha256Of(patch) !== diff.patchSha256) {
      throw new DevflowError(
        ErrorCode.RunCorrupt,
        `${this.store.workspacePath(ARTIFACT.reviewPatch)} does not match the reviewed diff`,
        { details: { runId: this.record.id } },
      );
    }
    const { gates, skipped } = await this.store.readJson(ARTIFACT.reviewGates, ReviewGates);
    const contracts = await this.store.readJsonIfExists(ARTIFACT.reviewContracts, ReviewContracts);
    const deterministic = reviewFindings({
      task,
      diff,
      patch,
      gates,
      contracts,
      ...(skipped === undefined ? {} : { gatesSkipped: skipped }),
    });
    const cut = cutPatch(patch, false, MAX_REVIEW_PROMPT_PATCH_BYTES);
    const prompt = reviewPrompt({
      task,
      pack,
      analysis,
      clarifications: registry.questions,
      diff,
      patch: cut.patch,
      patchCut: cut.truncated,
      gates,
      deterministic: deterministic.map((finding) => finding.title),
    });
    const gateway = await this.gateway();
    const result = await gateway.generateStructured({
      step: STEP.review,
      templateId: REVIEW_TEMPLATE.id,
      templateVersion: REVIEW_TEMPLATE.version,
      model: this.record.settings.models.review ?? this.record.settings.models.analysis,
      system: prompt.system,
      user: prompt.user,
      files: prompt.files,
      schema: ReviewWire,
      schemaName: "review",
      maxOutputTokens: this.record.settings.maxOutputTokens.review ?? DEFAULT_REVIEW_OUTPUT_TOKENS,
      ...this.signalOption(),
    });
    const redact = (text: string) => this.services.redactor.redactText(text);
    const ai = aiFindings(result.value, { diff, task });
    const findings = [
      ...deterministic,
      ...ai.findings.map((finding) => ({
        ...finding,
        title: redact(finding.title),
        recommendation: redact(finding.recommendation),
        evidence: finding.evidence.map((item) => ({
          ...item,
          description: redact(item.description),
        })),
      })),
    ];
    await this.store.writeJson(
      ARTIFACT.findings,
      Findings.parse({
        schemaVersion: 1,
        findings: findings.map((finding, index) => ({ ...finding, id: `F-${String(index + 1)}` })),
      }),
    );
    await this.store.writeJson(
      ARTIFACT.review,
      ReviewRecord.parse({
        schemaVersion: 1,
        summary: redact(result.value.summary),
        deterministicFindings: deterministic.length,
        aiFindings: ai.findings.length,
        dropped: ai.dropped,
      }),
    );
  }

  /**
   * Review mode with `--seek-evidence` (ADR 0025): for each selected AI finding, one model call
   * proposes a test that fails if the suspected defect is real; it is checked, written into a
   * git worktree of the reviewed state (never the working tree), run alone through the
   * command policy, and classified by rules. Only an assertion failure of that test confirms
   * the finding. Every probe and its outcome go to `artifacts/probes.json`.
   */
  private async seekEvidence(): Promise<void> {
    const settings = this.record.review?.seekEvidence;
    if (settings === undefined || (await this.store.exists(ARTIFACT.probes))) return;
    const { findings } = await this.store.readJson(ARTIFACT.findings, Findings);
    const { selected, notProbed } = probeCandidates(findings, settings.maxProbes);
    const write = async (probes: readonly ProbeRecord[], skipped?: string): Promise<void> => {
      const byId = new Map(probes.map((probe) => [probe.findingId, probe]));
      await this.store.writeJson(
        ARTIFACT.findings,
        Findings.parse({
          schemaVersion: 1,
          findings: findings.map((finding) => {
            const probe = byId.get(finding.id);
            return probe === undefined ? finding : probedFinding(finding, probe);
          }),
        }),
      );
      await this.store.writeJson(
        ARTIFACT.probes,
        ProbesRecord.parse({
          schemaVersion: 1,
          ranAt: this.now(),
          maxProbes: settings.maxProbes,
          ...(skipped === undefined ? {} : { skipped }),
          notProbed,
          probes,
        }),
      );
    };
    if (selected.length === 0) {
      await write([], "no AI finding of severity medium or higher with a location to probe");
      return;
    }
    const unavailable = await this.probesUnavailable();
    if (unavailable !== undefined) {
      await write([], unavailable);
      return;
    }
    const runner = await this.testRunner();
    let modules: TestModule[];
    try {
      modules = await this.testModules();
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      await write([], error.message);
      return;
    }
    const diff = await this.store.readJson(ARTIFACT.reviewDiff, ReviewDiff);
    // The probes run on the reviewed state: HEAD and the changed files must not have moved.
    const current = await this.services.git?.diff(diff.baseCommit, { maxPatchBytes: 0 });
    const shape = (files: readonly { path: string; change: string }[]) =>
      files.map((file) => `${file.change} ${file.path}`).join("\n");
    if (current?.head !== diff.headCommit || shape(current.files) !== shape(diff.files)) {
      await write(
        [],
        "the working tree changed since the review took its snapshot, so the probes would not " +
          "test the reviewed code; review again",
      );
      return;
    }
    const task = await this.task();
    const patch = await this.store.readText(ARTIFACT.reviewPatch);
    const cut = cutPatch(patch, false, MAX_PROBE_PROMPT_PATCH_BYTES);
    const reviewed = new Set(diff.files.map((file) => file.path));
    const probes: ProbeRecord[] = [];
    for (const finding of selected) {
      if (this.services.signal?.aborted === true) {
        throw new DevflowError(ErrorCode.Cancelled, "the probes were interrupted", {
          details: { runId: this.record.id },
        });
      }
      probes.push(await this.probe(finding, { task, modules, diff, cut, reviewed, runner }));
    }
    await write(probes);
  }

  /** Why no probe can run in this review, or undefined when they can. */
  private async probesUnavailable(): Promise<string | undefined> {
    const review = this.record.review;
    if (review?.gatesSkipped !== undefined) {
      return `the code under review is not run (${review.gatesSkipped}), so no probe ran`;
    }
    if (!this.services.trusted) {
      return "the workspace is not trusted: probes run tests, like gates (review it with devflow trust)";
    }
    const git = this.services.git;
    if (git?.addWorktree === undefined || git.removeWorktree === undefined) {
      return "git worktrees are not available, so the probes cannot run apart from the working tree";
    }
    if (this.services.testRunner === undefined) {
      return "no test runner was provided, so no probe ran";
    }
    if ((await this.testRunner()).runProbe === undefined) {
      return "the test runner cannot run a single test, so no probe ran";
    }
    return undefined;
  }

  /** One probe: the model's test, its checks, its run in a worktree, its classification. */
  private async probe(
    finding: Finding,
    context: {
      readonly task: TaskContract;
      readonly modules: readonly TestModule[];
      readonly diff: ReviewDiff;
      readonly cut: { readonly patch: string; readonly truncated: boolean };
      readonly reviewed: ReadonlySet<string>;
      readonly runner: TestRunner;
    },
  ): Promise<ProbeRecord> {
    const findingId = finding.id;
    const file = finding.location?.path ?? "";
    const module = moduleOfFile(file, context.modules);
    if (module === undefined) {
      return {
        findingId,
        outcome: "refused",
        reason: `${file} is in no module with a test directory, so no probe can be written for it`,
      };
    }
    const examples = context.diff.files
      .filter((entry) => entry.test && entry.change !== "deleted" && entry.path !== file)
      .filter((entry) => moduleOfFile(entry.path, [module]) !== undefined)
      .map((entry) => entry.path);
    const files = await this.promptFiles([file, ...examples], 3, MAX_EXISTING_TEST_FILE_BYTES);
    const prompt = probePrompt({
      task: context.task,
      finding,
      module,
      files,
      patch: context.cut.patch,
      patchCut: context.diff.patchTruncated || context.cut.truncated,
    });
    let wire: ProbeWire;
    try {
      const gateway = await this.gateway();
      const result = await gateway.generateStructured({
        step: STEP.probes,
        templateId: PROBE_TEMPLATE.id,
        templateVersion: PROBE_TEMPLATE.version,
        model: this.record.settings.models.testDesign ?? this.record.settings.models.planning,
        system: prompt.system,
        user: prompt.user,
        files: prompt.files,
        schema: ProbeWire,
        schemaName: "evidence_probe",
        maxOutputTokens:
          this.record.settings.maxOutputTokens.testDesign ?? DEFAULT_TEST_DESIGN_OUTPUT_TOKENS,
        ...this.signalOption(),
      });
      wire = result.value;
    } catch (error) {
      if (!isDevflowError(error) || error.code === ErrorCode.Cancelled) throw error;
      return {
        findingId,
        outcome: "inconclusive",
        reason: `the model call for the probe failed: ${this.services.redactor.redactText(error.message)} [${error.code}]`,
      };
    }
    const check = await checkProbe(wire, {
      module,
      guard: this.services.guard,
      redactor: this.services.redactor,
      reviewed: context.reviewed,
    });
    if (!check.ok) {
      return {
        findingId,
        outcome: check.outcome,
        reason: check.reason,
        ...(check.path === undefined ? {} : { testFile: check.path }),
        ...(check.testName === undefined ? {} : { testName: check.testName }),
      };
    }
    const artifact = `artifacts/probes/${findingId}/${check.path}`;
    // A copy a person can keep; it is never committed and never in the working tree.
    await this.store.writeText(artifact, check.content);
    const base = {
      findingId,
      testFile: check.path,
      testName: check.testName,
      sha256: probeSha256(check.content),
      artifact: this.store.workspacePath(artifact),
    };
    const { ran, removed } = await this.inProbeWorktree(context.diff, (copy) =>
      this.runProbeIn(copy, context.runner, module, check),
    );
    const leftOver = removed
      ? ""
      : `; the worktree ${PROBE_WORKTREE} could not be removed: remove it with git worktree remove --force ${PROBE_WORKTREE}`;
    if (ran.kind !== "ran") {
      return {
        ...base,
        outcome: ran.kind,
        reason: `${ran.reason}${leftOver}`,
        ...(ran.created ? { worktreeRemoved: removed } : {}),
      };
    }
    const { result, denial } = ran.outcome;
    const classified = classifyProbe({
      gate: result,
      denial,
      probeFile: `${PROBE_WORKTREE}/${check.path}`,
      testName: check.testName,
    });
    const execution = result.execution;
    return {
      ...base,
      outcome: classified.outcome,
      reason: `${classified.reason}${leftOver}`,
      commandId: result.commandId,
      ...(execution === undefined
        ? {}
        : { argv: [...execution.argv], exitCode: execution.exitCode }),
      ...(classified.testId === undefined ? {} : { testId: classified.testId }),
      ...(classified.message === undefined ? {} : { message: classified.message }),
      ...(denial?.fingerprint === undefined ? {} : { fingerprint: denial.fingerprint }),
      worktreeRemoved: removed,
    };
  }

  /**
   * Runs `work` in a git worktree of the reviewed state at {@link PROBE_WORKTREE}: HEAD, then
   * the changed and untracked files of the working tree copied over and the deleted ones
   * removed. The worktree is removed afterwards, whatever happened.
   */
  private async inProbeWorktree(
    diff: ReviewDiff,
    work: (copy: PathGuard) => Promise<ProbeRun>,
  ): Promise<{ ran: ProbeRun; removed: boolean }> {
    const git = this.services.git;
    if (git?.addWorktree === undefined || git.removeWorktree === undefined) {
      return {
        ran: { kind: "inconclusive", reason: "git worktrees are not available", created: false },
        removed: true,
      };
    }
    const directory = path.join(this.services.guard.root, ...PROBE_WORKTREE.split("/"));
    if (await pathExists(directory)) {
      return {
        ran: {
          kind: "inconclusive",
          reason:
            `${PROBE_WORKTREE} already exists (another review is probing, or one was ` +
            `interrupted); if no DevFlow process is running, remove it with ` +
            `git worktree remove --force ${PROBE_WORKTREE}`,
          created: false,
        },
        removed: true,
      };
    }
    await mkdir(path.dirname(directory), { recursive: true });
    try {
      await git.addWorktree(directory, diff.headCommit);
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      const removed = await this.removeProbeWorktree(git, directory);
      return {
        ran: {
          kind: "inconclusive",
          reason: `the worktree could not be created: ${error.message}`,
          created: !removed,
        },
        removed,
      };
    }
    let ran: ProbeRun;
    try {
      const copy = await PathGuard.create(directory);
      await this.copyReviewedState(diff, copy);
      ran = await work(copy);
    } catch (error) {
      if (!isDevflowError(error) || error.code === ErrorCode.Cancelled) {
        // The worktree never stays behind, not even on a cancellation.
        await this.removeProbeWorktree(git, directory);
        throw error;
      }
      ran = {
        kind: "inconclusive",
        reason: `the probe could not run: ${this.services.redactor.redactText(error.message)}`,
        created: true,
      };
    }
    return { ran, removed: await this.removeProbeWorktree(git, directory) };
  }

  /** Removes the probe worktree; true when its directory is gone. */
  private async removeProbeWorktree(git: GitWorkspace, directory: string): Promise<boolean> {
    try {
      await git.removeWorktree?.(directory);
    } catch (error) {
      if (!isDevflowError(error)) throw error;
    }
    return !(await pathExists(directory));
  }

  /**
   * Makes the worktree (checked out at HEAD) the reviewed state: the changed and untracked
   * files of the working tree are copied over, the deleted ones removed. Nothing in the working
   * tree is written.
   */
  private async copyReviewedState(diff: ReviewDiff, copy: PathGuard): Promise<void> {
    for (const file of diff.files) {
      const target = await copy.check(file.path, { access: "write", origin: "internal" });
      if (file.change === "deleted") {
        if (target.exists) await unlink(target.absolute);
        continue;
      }
      const source = await this.services.guard.check(file.path, {
        access: "read",
        origin: "internal",
      });
      if (!source.exists) continue;
      await mkdir(path.dirname(target.absolute), { recursive: true });
      await writeFile(target.absolute, await readFile(source.absolute));
    }
  }

  /** Writes the probe into the worktree as a new file and runs only its test. */
  private async runProbeIn(
    copy: PathGuard,
    runner: TestRunner,
    module: TestModule,
    probe: { readonly path: string; readonly testName: string; readonly content: string },
  ): Promise<ProbeRun> {
    if (runner.runProbe === undefined) {
      return {
        kind: "inconclusive",
        reason: "the test runner cannot run a single test",
        created: true,
      };
    }
    const target = await copy.check(probe.path, { access: "write", origin: "model" });
    if (target.exists) {
      return {
        kind: "refused",
        reason: `${probe.path} exists in the reviewed state: a probe only adds a file`,
        created: true,
      };
    }
    await mkdir(path.dirname(target.absolute), { recursive: true });
    await writeFile(target.absolute, probe.content, { encoding: "utf8", flag: "wx" });
    const audit = await this.audit();
    await audit.append({
      type: "file-write",
      path: `${PROBE_WORKTREE}/${probe.path}`,
      sha256Before: null,
      sha256After: probeSha256(probe.content),
      planChangeId: null,
    });
    const outcome = await runner.runProbe(
      {
        root: PROBE_WORKTREE,
        module: module.profile.moduleId,
        filter: probe.testName,
        testFile: probe.path,
      },
      {
        audit,
        logDir: this.store.workspacePath(`logs/probes/${probe.path.replace(/[^\w.-]+/g, "_")}`),
        ...this.signalOption(),
      },
    );
    return { kind: "ran", outcome };
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
    const implementation = await this.store.readJsonIfExists(
      ARTIFACT.implementation,
      ImplementationRecord,
    );
    const changedFiles = await this.store.readJsonIfExists(ARTIFACT.changedFiles, ChangedFiles);
    const changeFiles = await this.store.readJsonIfExists(ARTIFACT.changeFiles, ChangeFiles);
    const changeApproval = await this.store.readJsonIfExists(
      ARTIFACT.changeApproval,
      ChangeApproval,
    );
    const after = await this.store.readJsonIfExists(ARTIFACT.after, AfterRun);
    const reviewDiff = await this.store.readJsonIfExists(ARTIFACT.reviewDiff, ReviewDiff);
    const reviewGates = await this.store.readJsonIfExists(ARTIFACT.reviewGates, ReviewGates);
    const reviewRecord = await this.store.readJsonIfExists(ARTIFACT.review, ReviewRecord);
    const reviewContracts = await this.store.readJsonIfExists(
      ARTIFACT.reviewContracts,
      ReviewContracts,
    );
    const probes = await this.store.readJsonIfExists(ARTIFACT.probes, ProbesRecord);
    // Files of the latest implementation that no person approved (the run ended waiting).
    const unapprovedChanges =
      changeFiles === undefined ||
      changeFiles.files.length === 0 ||
      (changeApproval?.changesSha256 === changeFiles.changesSha256 &&
        changeApproval.iteration === changeFiles.iteration)
        ? []
        : changeFiles.files.map((file) => file.path);
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
      implementation,
      changedFiles,
      unapprovedChanges,
      after,
      reviewDiff,
      reviewGates,
      reviewRecord,
      reviewContracts,
      probes,
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

/** How a probe's run in its worktree ended, before its classification (ADR 0025). */
type ProbeRun =
  | { readonly kind: "ran"; readonly outcome: GateOutcome }
  | {
      readonly kind: "refused" | "inconclusive";
      readonly reason: string;
      /** Whether a worktree was created (and so had to be removed). */
      readonly created: boolean;
    };

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Why the path guard refuses a path for an access, or undefined when it allows it. */
async function rejection(
  guard: PathGuard,
  file: string,
  access: "write" | "prompt",
  origin: "model" | "internal",
): Promise<{ reason: unknown; message: string } | undefined> {
  try {
    await guard.check(file, { access, origin });
    return undefined;
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    return { reason: error.details.reason, message: error.message };
  }
}

/** The gate that runs each affected module's tests: its first test gate. */
function testGateOfModule(
  gates: readonly GateDefinition[],
  design: TestDesign,
): Map<string, string> {
  const affected = new Set(design.tests.map((test) => test.module));
  const gateOfModule = new Map<string, string>();
  for (const gate of gates) {
    if (gate.use !== "test" || !affected.has(gate.module)) continue;
    if (!gateOfModule.has(gate.module)) gateOfModule.set(gate.module, gate.id);
  }
  return gateOfModule;
}
