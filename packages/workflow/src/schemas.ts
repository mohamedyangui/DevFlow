import {
  AcceptanceCriterionId,
  ClarificationQuestion,
  Contradiction,
  Dependency,
  EdgeCase,
  GateResult,
  GitCommit,
  IsoDateTime,
  ModuleId,
  RepoPath,
  Risk,
  Severity,
  Sha256,
  TaskId,
  TestEvidence,
  TestIntent,
  TestLevel,
  TestOutcome,
  WorkflowMode,
  WorkflowState,
} from "@devflow/core";
import { z } from "zod";

/**
 * Files of a run directory (`.devflow/runs/<id>/`, ADR 0004). Every file is JSON validated
 * by one of these schemas when it is read back, so a hand-edited or truncated file is reported
 * as `RUN_CORRUPT` instead of being trusted.
 */

/** `2026-11-07T10-21-33Z_TASK-142`, with `_2`, `_3`... when two runs start in the same second. */
export const RunId = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z_[A-Za-z0-9][A-Za-z0-9._-]{0,63}(_\d{1,4})?$/,
    "expected a run id such as 2026-11-07T10-21-33Z_TASK-142",
  );
export type RunId = z.infer<typeof RunId>;

/**
 * What the run was started for: `devflow analyze` stops after analysis, `devflow plan` plans,
 * `devflow test` writes tests and records their red baseline (test mode).
 */
export const RunGoal = z.enum(["analyze", "plan", "test", "implement", "review"]);
export type RunGoal = z.infer<typeof RunGoal>;

export const RunBudgets = z.strictObject({
  maxInputTokens: z.int().positive(),
  maxOutputTokens: z.int().positive(),
  maxCallsPerStep: z.int().positive(),
  /** Counts only calls to models with a price (`prices`). Absent in runs before Phase 4. */
  maxCostUsd: z.number().positive().optional(),
});

/** US dollars per million tokens, by model id. */
export const RunPrices = z.record(
  z.string().min(1),
  z.strictObject({
    inputUsdPerMTok: z.number().nonnegative(),
    outputUsdPerMTok: z.number().nonnegative(),
    cachedInputUsdPerMTok: z.number().nonnegative().optional(),
    cacheWriteUsdPerMTok: z.number().nonnegative().optional(),
  }),
);
export type RunPrices = z.infer<typeof RunPrices>;
export type RunBudgets = z.infer<typeof RunBudgets>;

/** The effective settings of a run, fixed when it starts; `resume` can raise budgets. */
export const RunSettings = z.strictObject({
  provider: z.string().min(1),
  /** The model of each step. The Phase 4 steps are absent in runs created before them. */
  models: z.strictObject({
    analysis: z.string().min(1),
    planning: z.string().min(1),
    testDesign: z.string().min(1).optional(),
    implementation: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
  }),
  prices: RunPrices.optional(),
  requirePlanApproval: z.boolean(),
  /** Implement mode: repair attempts after a failed verification. Absent before Phase 4. */
  maxRepairAttempts: z.int().min(0).max(5).optional(),
  budgets: RunBudgets,
  contextBudgetTokens: z.int().positive(),
  maxOutputTokens: z.strictObject({
    analysis: z.int().positive(),
    planning: z.int().positive(),
    /** Absent in runs created before Phase 4. */
    testDesign: z.int().positive().optional(),
    implementation: z.int().positive().optional(),
    review: z.int().positive().optional(),
  }),
  /** Test and implement mode: `workflow.git` (ADR 0012). Absent in runs created before it. */
  git: z
    .strictObject({
      isolation: z.enum(["branch", "worktree"]),
      branchPrefix: z.string().min(1),
      commit: z.enum(["per-phase", "none"]),
    })
    .optional(),
  workspaceTrusted: z.boolean(),
  configSha256: Sha256.nullable(),
});
export type RunSettings = z.infer<typeof RunSettings>;

/** A commit DevFlow made on a run's branch. */
export const GitCommitRecord = z.strictObject({
  phase: z.enum(["tests", "implementation", "repair"]),
  /** The test-design or implementation iteration that was committed. */
  iteration: z.int().positive(),
  sha: GitCommit,
  /** The commit's subject line. */
  subject: z.string().min(1),
  at: IsoDateTime,
});
export type GitCommitRecord = z.infer<typeof GitCommitRecord>;

/**
 * Where a test- or implement-mode run keeps its changes (ADR 0012): on a DevFlow branch, or,
 * when git cannot be used, in the working tree as it is.
 */
export const GitIsolationRecord = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("branch"),
    branch: z.string().min(1),
    /** The branch checked out when the run created its own, or null for a detached HEAD. */
    baseBranch: z.string().min(1).nullable(),
    baseCommit: GitCommit,
    commit: z.enum(["per-phase", "none"]),
    commits: z.array(GitCommitRecord),
    /** Commits that could not be made; their files stay uncommitted on the branch. */
    warnings: z.array(z.string()),
  }),
  z.strictObject({
    status: z.literal("none"),
    /** Why the changes are not on a DevFlow branch. */
    reason: z.string().min(1),
  }),
]);
export type GitIsolationRecord = z.infer<typeof GitIsolationRecord>;

export const PendingInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan-approval"), planSha256: Sha256 }),
  z.strictObject({ kind: z.literal("clarification"), questionIds: z.array(z.string()).min(1) }),
  /** Test mode: the test files written by the model must be reviewed before they run. */
  z.strictObject({ kind: z.literal("test-approval"), testsSha256: Sha256 }),
  /** Implement mode: the code written by the model must be reviewed before it runs. */
  z.strictObject({ kind: z.literal("change-approval"), changesSha256: Sha256 }),
]);
export type PendingInput = z.infer<typeof PendingInput>;

export const RunError = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  /** The state the run was in when the error happened. */
  state: WorkflowState,
  at: IsoDateTime,
  /** True when `devflow resume` can retry the step. */
  resumable: z.boolean(),
});
export type RunError = z.infer<typeof RunError>;

export const BudgetUsageRecord = z.strictObject({
  calls: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  callsByStep: z.record(z.string(), z.int().nonnegative()),
  costUsd: z.number().nonnegative().optional(),
  unpricedCalls: z.int().nonnegative().optional(),
});

/** `run.json`: the run's current state. */
export const RunRecord = z.strictObject({
  schemaVersion: z.literal(1),
  id: RunId,
  devflowVersion: z.string().min(1),
  mode: WorkflowMode,
  goal: RunGoal,
  state: WorkflowState,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
  task: z.strictObject({
    id: TaskId,
    title: z.string().min(1),
    /** The task file as given on the command line, or null for a programmatic task. */
    file: z.string().nullable(),
    sha256: Sha256,
  }),
  settings: RunSettings,
  budgetUsage: BudgetUsageRecord,
  /** How many times each LLM step has produced a result (re-analysis, re-planning). */
  iterations: z.strictObject({
    analysis: z.int().nonnegative(),
    planning: z.int().nonnegative(),
    /** Absent in runs created before Phase 4. */
    testDesign: z.int().nonnegative().optional(),
    /** Implement mode: implementations written (including rejected ones). */
    implementation: z.int().nonnegative().optional(),
    /** Implement mode: verifications run after a change (the first, then one per repair). */
    verification: z.int().nonnegative().optional(),
  }),
  pending: PendingInput.nullable(),
  lastError: RunError.nullable(),
  warnings: z.array(z.string()),
  /** Test and implement mode: set before the first file is written. */
  git: GitIsolationRecord.optional(),
  /** Review mode: what the change is compared with, fixed when the run starts. */
  review: z
    .strictObject({
      /** The reference as given (`--base`). */
      base: z.string().min(1),
      /** The merge base of that reference and HEAD. */
      baseCommit: GitCommit,
    })
    .optional(),
});
export type RunRecord = z.infer<typeof RunRecord>;

/** One line of `events.jsonl`. */
export const RunEvent = z.strictObject({
  seq: z.int().nonnegative(),
  at: IsoDateTime,
  type: z.enum([
    "created",
    "transition",
    "step-started",
    "step-completed",
    "step-failed",
    "decision",
    "resumed",
    "git",
  ]),
  /** The run's state after the event. */
  state: WorkflowState,
  from: WorkflowState.optional(),
  step: z.string().optional(),
  detail: z.string().optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;

export const TaskIssueRecord = z.strictObject({
  severity: z.enum(["error", "warning"]),
  code: z.string().min(1),
  message: z.string(),
  path: z.string(),
});

/** `artifacts/analysis.json`: the latest requirements analysis. */
export const RequirementsAnalysis = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: TaskId,
  iteration: z.int().positive(),
  summary: z.string().min(1),
  /** Deterministic task lint, independent of the model. */
  taskIssues: z.array(TaskIssueRecord),
  requirementNotes: z.array(
    z.strictObject({
      id: z.string().min(1),
      interpretation: z.string().min(1),
      concerns: z.array(z.string()),
    }),
  ),
  /** Questions raised in this iteration (ids continue across iterations). */
  questions: z.array(ClarificationQuestion),
  assumptions: z.array(z.string()),
  risks: z.array(Risk),
  /** Absent in analyses written before Phase 4. */
  edgeCases: z.array(EdgeCase).default([]),
  contradictions: z.array(Contradiction).default([]),
  dependencies: z.array(Dependency).default([]),
  affectedFiles: z.array(z.strictObject({ path: RepoPath, reason: z.string().min(1) })),
  /** What the deterministic checks changed or dropped in the model's answer. */
  checks: z.array(z.string()),
});
export type RequirementsAnalysis = z.infer<typeof RequirementsAnalysis>;

export const ClarificationRecord = ClarificationQuestion.extend({
  askedInIteration: z.int().positive(),
  answer: z
    .strictObject({ text: z.string().min(1).max(20_000), by: z.string().min(1), at: IsoDateTime })
    .nullable(),
});
export type ClarificationRecord = z.infer<typeof ClarificationRecord>;

/** `artifacts/clarifications.json`: every question asked during the run and its answer. */
export const Clarifications = z.strictObject({
  schemaVersion: z.literal(1),
  questions: z.array(ClarificationRecord),
});
export type Clarifications = z.infer<typeof Clarifications>;

export const PlanCheck = z.strictObject({
  severity: z.enum(["error", "warning"]),
  code: z.string().min(1),
  message: z.string().min(1),
  /** Where in the plan, e.g. `changes[2].path`. */
  location: z.string().optional(),
});
export type PlanCheck = z.infer<typeof PlanCheck>;

/** `artifacts/plan-checks.json`: the deterministic checks of the latest plan. */
export const PlanChecks = z.strictObject({
  schemaVersion: z.literal(1),
  iteration: z.int().positive(),
  /** True when the first draft failed a check and the model was asked for a revision. */
  revised: z.boolean(),
  checks: z.array(PlanCheck),
});
export type PlanChecks = z.infer<typeof PlanChecks>;

/** `artifacts/plan-feedback.json`: rejections with the reviewer's feedback. */
export const PlanFeedback = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.strictObject({
      iteration: z.int().positive(),
      planSha256: Sha256,
      feedback: z.string().min(1).max(20_000),
      by: z.string().min(1),
      at: IsoDateTime,
    }),
  ),
});
export type PlanFeedback = z.infer<typeof PlanFeedback>;

/** One test of the test design: a test file the model wrote for acceptance criteria. */
export const DesignedTest = z.strictObject({
  id: z.string().regex(/^T-[1-9][0-9]*$/),
  acIds: z.array(AcceptanceCriterionId).min(1),
  module: ModuleId,
  path: RepoPath,
  action: z.enum(["create", "modify"]),
  description: z.string().min(1),
});
export type DesignedTest = z.infer<typeof DesignedTest>;

/** `artifacts/test-design.json`: the tests of the latest test design, after the checks. */
export const TestDesign = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: TaskId,
  iteration: z.int().positive(),
  summary: z.string().min(1),
  tests: z.array(DesignedTest).min(1),
  /** True when the first draft failed a check and the model was asked for a revision. */
  revised: z.boolean(),
  checks: z.array(PlanCheck),
});
export type TestDesign = z.infer<typeof TestDesign>;

/**
 * `artifacts/test-files.json`: the files the test design wrote, with what they held before, so
 * that a rejection can restore them and approval binds exactly what a person reviewed.
 */
export const TestFiles = z.strictObject({
  schemaVersion: z.literal(1),
  /** Hash of the paths and hashes below; the approval refers to it. */
  testsSha256: Sha256,
  files: z.array(
    z.strictObject({
      path: RepoPath,
      action: z.enum(["create", "modify"]),
      /** The content before the run wrote the file; null when it did not exist. */
      before: z.string().nullable(),
      beforeSha256: Sha256.nullable(),
      afterSha256: Sha256,
    }),
  ),
});
export type TestFiles = z.infer<typeof TestFiles>;

/** `artifacts/test-approval.json` */
export const TestApproval = z.strictObject({
  schemaVersion: z.literal(1),
  testsSha256: Sha256,
  by: z.string().min(1),
  at: IsoDateTime,
});
export type TestApproval = z.infer<typeof TestApproval>;

/** `artifacts/test-feedback.json`: rejections of the written tests with the reviewer's feedback. */
export const TestFeedback = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.strictObject({
      iteration: z.int().positive(),
      testsSha256: Sha256,
      feedback: z.string().min(1).max(20_000),
      by: z.string().min(1),
      at: IsoDateTime,
    }),
  ),
});
export type TestFeedback = z.infer<typeof TestFeedback>;

/** `artifacts/baseline.json`: the test gates run against the code before any change (red run). */
export const BaselineRun = z.strictObject({
  schemaVersion: z.literal(1),
  ranAt: IsoDateTime,
  /** Hash of the approved test files the baseline ran with. */
  testsSha256: Sha256,
  gates: z.array(GateResult),
});
export type BaselineRun = z.infer<typeof BaselineRun>;

/** One acceptance criterion checked by one test (or a designed test without a result). */
export const EvidenceEntry = z.strictObject({
  acId: AcceptanceCriterionId,
  /** The designed test (`T-n`) the result belongs to. */
  designedTestId: z.string().regex(/^T-[1-9][0-9]*$/),
  /** The test result's id, or the designed file when no result was found for it. */
  testId: z.string().min(1),
  /** The gate that ran it; `none` when no gate ran the file. */
  gateId: z.string().min(1),
  file: RepoPath,
  outcome: TestOutcome,
  evidence: TestEvidence,
  /** The failure message, already redacted. */
  message: z.string().max(8000).optional(),
  /** Implement mode: the failure message after the change, already redacted. */
  afterMessage: z.string().max(8000).optional(),
});
export type EvidenceEntry = z.infer<typeof EvidenceEntry>;

/** `artifacts/test-evidence.json`: red/green evidence for each criterion (ADR 0015). */
export const TestEvidenceRecord = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(EvidenceEntry),
});
export type TestEvidenceRecord = z.infer<typeof TestEvidenceRecord>;

// Wire schemas: what the model is asked to return. Every field is required and nullable is
// used instead of optional (architecture proposal section 10); ids are assigned by DevFlow.

const WireRisk = z.strictObject({
  description: z.string().min(1),
  likelihood: z.enum(["low", "medium", "high"]),
  impact: z.enum(["low", "medium", "high"]),
  mitigation: z.string().min(1),
});

const WireQuestion = z.strictObject({
  question: z.string().min(1),
  blocking: z.boolean(),
  relatedIds: z.array(z.string()),
});

export const AnalysisWire = z.strictObject({
  summary: z.string().min(1),
  requirementNotes: z.array(
    z.strictObject({
      id: z.string().min(1),
      interpretation: z.string().min(1),
      concerns: z.array(z.string()),
    }),
  ),
  questions: z.array(WireQuestion),
  assumptions: z.array(z.string()),
  risks: z.array(WireRisk),
  edgeCases: z.array(
    z.strictObject({
      description: z.string().min(1),
      relatedIds: z.array(z.string()),
      coveredBy: z.array(z.string()),
    }),
  ),
  contradictions: z.array(
    z.strictObject({
      ids: z.array(z.string()),
      description: z.string().min(1),
      question: z.string().min(1),
    }),
  ),
  dependencies: z.array(
    z.strictObject({
      kind: z.enum(["requirement", "module", "external", "data"]),
      description: z.string().min(1),
      relatedIds: z.array(z.string()),
    }),
  ),
  affectedFiles: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) })),
});
export type AnalysisWire = z.infer<typeof AnalysisWire>;

export const PlanWire = z.strictObject({
  summary: z.string().min(1),
  approach: z.string().min(1),
  relevantFiles: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) })),
  changes: z.array(
    z.strictObject({
      module: z.string().nullable(),
      path: z.string().min(1),
      action: z.enum(["create", "modify", "delete"]),
      description: z.string().min(1),
      satisfies: z.array(z.string()),
    }),
  ),
  interfaceChanges: z.array(
    z.strictObject({
      kind: z.enum(["http-api", "public-api", "schema", "protobuf", "config"]),
      description: z.string().min(1),
      breaking: z.boolean(),
    }),
  ),
  testStrategy: z.array(
    z.strictObject({
      acId: z.string().min(1),
      level: TestLevel,
      intent: TestIntent,
      approach: z.string().min(1),
      targetFile: z.string().nullable(),
    }),
  ),
  risks: z.array(WireRisk),
  regressionWatch: z.array(z.string()),
  openQuestions: z.array(WireQuestion),
});
export type PlanWire = z.infer<typeof PlanWire>;

/** `artifacts/implementation.json`: the latest implementation, after the checks. */
export const ImplementationRecord = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: TaskId,
  iteration: z.int().positive(),
  /** True when it repairs a failed verification. */
  repair: z.boolean(),
  summary: z.string().min(1),
  changes: z.array(
    z.strictObject({
      path: RepoPath,
      action: z.enum(["create", "modify", "delete"]),
      planChangeId: z.string().regex(/^CH-[1-9][0-9]*$/),
      description: z.string().min(1),
    }),
  ),
  /** True when the first draft failed a check and the model was asked for a revision. */
  revised: z.boolean(),
  checks: z.array(PlanCheck),
});
export type ImplementationRecord = z.infer<typeof ImplementationRecord>;

/**
 * `artifacts/change-files.json`: the files the latest implementation wrote, with what they held
 * before it, so that a rejection can restore them and approval binds what a person reviewed.
 */
export const ChangeFiles = z.strictObject({
  schemaVersion: z.literal(1),
  iteration: z.int().positive(),
  /** Hash of the paths and hashes below; the approval refers to it. */
  changesSha256: Sha256,
  files: z.array(
    z.strictObject({
      path: RepoPath,
      action: z.enum(["create", "modify", "delete"]),
      planChangeId: z.string().regex(/^CH-[1-9][0-9]*$/),
      /** The content before this implementation wrote the file; null when it did not exist. */
      before: z.string().nullable(),
      beforeSha256: Sha256.nullable(),
      /** Null when the file was deleted. */
      afterSha256: Sha256.nullable(),
    }),
  ),
});
export type ChangeFiles = z.infer<typeof ChangeFiles>;

/** `artifacts/changed-files.json`: every production file the run changed, since the start. */
export const ChangedFiles = z.strictObject({
  schemaVersion: z.literal(1),
  files: z.array(
    z.strictObject({
      path: RepoPath,
      planChangeId: z.string().regex(/^CH-[1-9][0-9]*$/),
      /** Null when the file did not exist before the run. */
      originalSha256: Sha256.nullable(),
      /** Null when the run deleted it. */
      currentSha256: Sha256.nullable(),
    }),
  ),
});
export type ChangedFiles = z.infer<typeof ChangedFiles>;

/** `artifacts/change-approval.json` */
export const ChangeApproval = z.strictObject({
  schemaVersion: z.literal(1),
  iteration: z.int().positive(),
  changesSha256: Sha256,
  by: z.string().min(1),
  at: IsoDateTime,
});
export type ChangeApproval = z.infer<typeof ChangeApproval>;

/** `artifacts/change-feedback.json`: rejected implementations with the reviewer's feedback. */
export const ChangeFeedback = z.strictObject({
  schemaVersion: z.literal(1),
  entries: z.array(
    z.strictObject({
      iteration: z.int().positive(),
      changesSha256: Sha256,
      feedback: z.string().min(1).max(20_000),
      by: z.string().min(1),
      at: IsoDateTime,
    }),
  ),
});
export type ChangeFeedback = z.infer<typeof ChangeFeedback>;

const TestRef = z.strictObject({ gateId: z.string().min(1), testId: z.string().min(1) });

/**
 * `artifacts/verification-<n>.json` and `artifacts/after.json` (the latest): the gates run after
 * the n-th approved change, compared with the baseline.
 */
export const AfterRun = z.strictObject({
  schemaVersion: z.literal(1),
  /** 1 for the first verification after the change, then one more per repair. */
  attempt: z.int().positive(),
  ranAt: IsoDateTime,
  changesSha256: Sha256,
  gates: z.array(GateResult),
  /** The failed gates, run a second time to tell flaky tests from failures. */
  rerun: z.array(GateResult),
  /** Tests that failed and then passed when run again. */
  flaky: z.array(TestRef),
  /** Passed before the change, failed after it (and again when rerun). */
  regressions: z.array(TestRef),
  /** Failed before the change and after it: not attributed to the change. */
  stillFailing: z.array(TestRef),
  /** Required gates that did not pass, after the rerun. */
  failedGates: z.array(z.string().min(1)),
  /** What happens next: done, another repair, or the repairs are used up. */
  decision: z.enum(["passed", "repair", "stop"]),
  reason: z.string().min(1),
});
export type AfterRun = z.infer<typeof AfterRun>;

export const TestDesignWire = z.strictObject({
  summary: z.string().min(1),
  tests: z.array(
    z.strictObject({
      acIds: z.array(z.string()),
      module: z.string().nullable(),
      path: z.string().min(1),
      action: z.enum(["create", "modify"]),
      /** The whole file, for `create`; null for `modify`. */
      content: z.string().nullable(),
      /** Exact search and replace edits, for `modify`; empty for `create`. */
      edits: z.array(z.strictObject({ search: z.string(), replace: z.string() })),
      description: z.string().min(1),
    }),
  ),
});
export type TestDesignWire = z.infer<typeof TestDesignWire>;

/** Review mode: one file of the reviewed diff. */
export const ReviewDiffFile = z.strictObject({
  path: z.string().min(1),
  change: z.enum(["added", "modified", "deleted"]),
  additions: z.int().nonnegative().nullable(),
  deletions: z.int().nonnegative().nullable(),
  binary: z.boolean(),
  /** False for a file git does not track yet. */
  tracked: z.boolean(),
  /** Whether the path looks like a test file. */
  test: z.boolean(),
});

/** `artifacts/review-diff.json`: the local diff a review-mode run reviewed. */
export const ReviewDiff = z.strictObject({
  schemaVersion: z.literal(1),
  base: z.string().min(1),
  baseCommit: GitCommit,
  headCommit: GitCommit,
  takenAt: IsoDateTime,
  files: z.array(ReviewDiffFile),
  /** Hash of `artifacts/review-diff.patch` (redacted, without files never sent to a model). */
  patchSha256: Sha256,
  patchTruncated: z.boolean(),
  /** Added lines the secret detector matched (the values are not stored). */
  secrets: z.array(z.strictObject({ path: z.string().min(1), line: z.int().positive() })),
  /** Changed files the path guard protects. */
  protected: z.array(z.strictObject({ path: z.string().min(1), reason: z.string().min(1) })),
  /** Changed files left out of the patch because they are never sent to a model. */
  withheld: z.array(z.string().min(1)),
});
export type ReviewDiff = z.infer<typeof ReviewDiff>;

/** `artifacts/review-gates.json`: the gates, run once on the changed code. */
export const ReviewGates = z.strictObject({
  schemaVersion: z.literal(1),
  ranAt: IsoDateTime,
  gates: z.array(GateResult),
});
export type ReviewGates = z.infer<typeof ReviewGates>;

/** `artifacts/review.json`: the model's review, after its findings were mapped. */
export const ReviewRecord = z.strictObject({
  schemaVersion: z.literal(1),
  /** The model's summary, redacted. Unverified. */
  summary: z.string().min(1),
  deterministicFindings: z.int().nonnegative(),
  aiFindings: z.int().nonnegative(),
  /** Model findings beyond the limit, left out. */
  dropped: z.int().nonnegative(),
});
export type ReviewRecord = z.infer<typeof ReviewRecord>;

/** What the reviewer model returns. */
export const ReviewWire = z.strictObject({
  summary: z.string().min(1),
  findings: z.array(
    z.strictObject({
      title: z.string().min(1).max(200),
      severity: Severity,
      category: z.enum([
        "requirement",
        "regression",
        "test-gap",
        "test-fidelity",
        "convention",
        "security",
        "compatibility",
        "scope",
        "quality",
      ]),
      path: z.string().min(1).nullable(),
      line: z.int().positive().nullable(),
      description: z.string().min(1),
      recommendation: z.string().min(1),
      confidence: z.number().min(0).max(1),
      acIds: z.array(z.string()),
    }),
  ),
});
export type ReviewWire = z.infer<typeof ReviewWire>;

export const ImplementationWire = z.strictObject({
  summary: z.string().min(1),
  changes: z.array(
    z.strictObject({
      path: z.string().min(1),
      action: z.enum(["create", "modify", "delete"]),
      /** The whole file, for `create`; null otherwise. */
      content: z.string().nullable(),
      /** Exact search and replace edits, for `modify`; empty otherwise. */
      edits: z.array(z.strictObject({ search: z.string(), replace: z.string() })),
      /** The plan change (`CH-n`) it carries out; null to let DevFlow find it by path. */
      changeId: z.string().nullable(),
      description: z.string().min(1),
    }),
  ),
});
export type ImplementationWire = z.infer<typeof ImplementationWire>;
