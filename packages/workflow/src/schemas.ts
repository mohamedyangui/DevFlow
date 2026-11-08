import {
  ClarificationQuestion,
  IsoDateTime,
  RepoPath,
  Risk,
  Sha256,
  TaskId,
  TestIntent,
  TestLevel,
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

/** What the run was started for: `devflow analyze` stops after analysis, `devflow plan` plans. */
export const RunGoal = z.enum(["analyze", "plan"]);
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
  budgets: RunBudgets,
  contextBudgetTokens: z.int().positive(),
  maxOutputTokens: z.strictObject({ analysis: z.int().positive(), planning: z.int().positive() }),
  workspaceTrusted: z.boolean(),
  configSha256: Sha256.nullable(),
});
export type RunSettings = z.infer<typeof RunSettings>;

export const PendingInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plan-approval"), planSha256: Sha256 }),
  z.strictObject({ kind: z.literal("clarification"), questionIds: z.array(z.string()).min(1) }),
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
  }),
  pending: PendingInput.nullable(),
  lastError: RunError.nullable(),
  warnings: z.array(z.string()),
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
