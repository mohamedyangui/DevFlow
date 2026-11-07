import { z } from "zod";
import { AcceptanceCriterionId, ModuleId, RepoPath, TaskId } from "./primitives.js";
import { TestIntent, TestLevel } from "./verification.js";

const Level = z.enum(["low", "medium", "high"]);

export const Risk = z.strictObject({
  description: z.string().min(1),
  likelihood: Level,
  impact: Level,
  mitigation: z.string().min(1),
});
export type Risk = z.infer<typeof Risk>;

export const ClarificationQuestion = z.strictObject({
  id: z.string().regex(/^Q-[1-9][0-9]*$/),
  question: z.string().min(1),
  /** Blocking questions stop the workflow in CLARIFICATION_REQUIRED. */
  blocking: z.boolean(),
  /** Requirement or acceptance-criterion ids the question is about. */
  relatedIds: z.array(z.string()),
});
export type ClarificationQuestion = z.infer<typeof ClarificationQuestion>;

export const PlannedChange = z.strictObject({
  id: z.string().regex(/^CH-[1-9][0-9]*$/),
  module: ModuleId,
  path: RepoPath,
  action: z.enum(["create", "modify", "delete"]),
  description: z.string().min(1),
  /** Requirement and acceptance-criterion ids this change helps satisfy. */
  satisfies: z.array(z.string()),
});
export type PlannedChange = z.infer<typeof PlannedChange>;

export const TestStrategyEntry = z.strictObject({
  acId: AcceptanceCriterionId,
  level: TestLevel,
  intent: TestIntent,
  approach: z.string().min(1),
  targetFile: RepoPath.optional(),
});
export type TestStrategyEntry = z.infer<typeof TestStrategyEntry>;

/**
 * A reviewable implementation plan. Checks that need the task or the repository (scope,
 * protected paths, existing files) are performed by the planning step (Phase 2).
 */
export const ImplementationPlan = z
  .strictObject({
    taskId: TaskId,
    summary: z.string().min(1),
    approach: z.string().min(1),
    relevantFiles: z.array(z.strictObject({ path: RepoPath, reason: z.string().min(1) })),
    changes: z.array(PlannedChange),
    interfaceChanges: z.array(
      z.strictObject({
        kind: z.enum(["http-api", "public-api", "schema", "protobuf", "config"]),
        description: z.string().min(1),
        breaking: z.boolean(),
      }),
    ),
    testStrategy: z.array(TestStrategyEntry),
    risks: z.array(Risk),
    regressionWatch: z.array(z.string()),
    openQuestions: z.array(ClarificationQuestion),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    plan.changes.forEach((change, index) => {
      if (seen.has(change.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["changes", index, "id"],
          message: `duplicate change id ${change.id}`,
        });
      }
      seen.add(change.id);
    });
  });
export type ImplementationPlan = z.infer<typeof ImplementationPlan>;
