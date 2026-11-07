import { z } from "zod";
import {
  AcceptanceCriterionId,
  FunctionalRequirementId,
  ModuleId,
  NonFunctionalRequirementId,
  RepoGlob,
  RequirementId,
  TaskId,
} from "./primitives.js";
import { TestIntent, TestLevel } from "./verification.js";

/**
 * Two schemas describe a task (docs/specs/task-contract.md):
 *
 * - `TaskFile`: what people write. It is forgiving: ids are optional, and acceptance
 *   criteria and requirements may be plain strings.
 * - `TaskContract`: the normalized Engineering Task Contract used by every later step.
 *   Every item has an id, and every default is explicit.
 */

const MAX_ITEMS = 200;
const Text = z.string().trim().min(1).max(4000);

export const Priority = z.enum(["must", "should", "could"]);
export type Priority = z.infer<typeof Priority>;

export const NonFunctionalCategory = z.enum([
  "performance",
  "security",
  "reliability",
  "compatibility",
  "usability",
  "accessibility",
  "maintainability",
  "observability",
  "other",
]);
export type NonFunctionalCategory = z.infer<typeof NonFunctionalCategory>;

export const AcceptanceVerification = z
  .enum(["automated", "manual"])
  .meta({ description: "Whether the criterion is expected to be verified by an automated test." });
export type AcceptanceVerification = z.infer<typeof AcceptanceVerification>;

// ---------------------------------------------------------------------------------------------
// Authoring format (TaskFile)
// ---------------------------------------------------------------------------------------------

export const FunctionalRequirementInput = z.union([
  Text,
  z.strictObject({
    id: FunctionalRequirementId.optional(),
    text: Text,
    priority: Priority.optional(),
  }),
]);

export const NonFunctionalRequirementInput = z.union([
  Text,
  z.strictObject({
    id: NonFunctionalRequirementId.optional(),
    text: Text,
    category: NonFunctionalCategory.optional(),
  }),
]);

export const AcceptanceCriterionInput = z.union([
  Text,
  z
    .strictObject({
      id: AcceptanceCriterionId.optional(),
      statement: Text.optional(),
      given: Text.optional(),
      when: Text.optional(),
      then: Text.optional(),
      covers: z.array(RequirementId).max(MAX_ITEMS).optional(),
      verification: AcceptanceVerification.optional(),
      testLevel: TestLevel.optional(),
      testIntent: TestIntent.optional(),
    })
    .refine((ac) => ac.statement !== undefined || ac.then !== undefined, {
      message: 'an acceptance criterion needs a "statement" or a "then" clause',
    }),
]);

export const TaskFile = z
  .strictObject({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1).optional().meta({ description: "Defaults to 1." }),
    id: TaskId,
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).optional(),
    requirements: z
      .strictObject({
        functional: z.array(FunctionalRequirementInput).max(MAX_ITEMS).optional(),
        nonFunctional: z.array(NonFunctionalRequirementInput).max(MAX_ITEMS).optional(),
      })
      .optional(),
    acceptanceCriteria: z.array(AcceptanceCriterionInput).max(MAX_ITEMS).optional(),
    constraints: z.array(Text).max(MAX_ITEMS).optional(),
    scope: z
      .strictObject({
        modules: z.array(ModuleId).max(MAX_ITEMS).optional(),
        include: z.array(RepoGlob).max(MAX_ITEMS).optional(),
        exclude: z.array(RepoGlob).max(MAX_ITEMS).optional(),
      })
      .optional(),
    testing: z
      .strictObject({
        levels: z.array(TestLevel).max(3).optional(),
        testFirst: z.boolean().optional(),
        notes: z.string().max(4000).optional(),
      })
      .optional(),
    definitionOfDone: z.array(Text).max(MAX_ITEMS).optional(),
    metadata: z.record(z.string().min(1).max(100), z.string().max(1000)).optional(),
  })
  .meta({ title: "DevFlow task file", description: "A development task for DevFlow AI." });
export type TaskFile = z.infer<typeof TaskFile>;

// ---------------------------------------------------------------------------------------------
// Normalized Engineering Task Contract
// ---------------------------------------------------------------------------------------------

export const FunctionalRequirement = z.strictObject({
  id: FunctionalRequirementId,
  text: z.string().min(1),
  priority: Priority,
});
export type FunctionalRequirement = z.infer<typeof FunctionalRequirement>;

export const NonFunctionalRequirement = z.strictObject({
  id: NonFunctionalRequirementId,
  text: z.string().min(1),
  category: NonFunctionalCategory,
});
export type NonFunctionalRequirement = z.infer<typeof NonFunctionalRequirement>;

export const AcceptanceCriterion = z.strictObject({
  id: AcceptanceCriterionId,
  statement: z.string().min(1),
  given: z.string().optional(),
  when: z.string().optional(),
  then: z.string().optional(),
  covers: z.array(RequirementId),
  verification: AcceptanceVerification,
  testLevel: TestLevel.optional(),
  testIntent: TestIntent,
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const TaskSourceKind = z.enum(["file", "cli", "github-issue"]);

/**
 * `user`: written by the person running DevFlow. `external`: text from another party (for
 * example a GitHub issue). External text defines the task but is never treated as
 * instructions that change DevFlow's policies (docs/specs/security-model.md).
 */
export const TrustLevel = z.enum(["user", "external"]);

export const TaskSource = z.strictObject({
  kind: TaskSourceKind,
  ref: z.string().min(1).optional(),
  trust: TrustLevel,
});
export type TaskSource = z.infer<typeof TaskSource>;

export const TaskContract = z.strictObject({
  schemaVersion: z.literal(1),
  id: TaskId,
  title: z.string().min(1),
  description: z.string(),
  source: TaskSource,
  requirements: z.strictObject({
    functional: z.array(FunctionalRequirement),
    nonFunctional: z.array(NonFunctionalRequirement),
  }),
  acceptanceCriteria: z.array(AcceptanceCriterion),
  constraints: z.array(z.string()),
  scope: z.strictObject({
    modules: z.array(ModuleId),
    include: z.array(RepoGlob),
    exclude: z.array(RepoGlob),
  }),
  testing: z.strictObject({
    levels: z.array(TestLevel),
    testFirst: z.boolean(),
    notes: z.string().optional(),
  }),
  definitionOfDone: z.array(z.string()),
  metadata: z.record(z.string(), z.string()),
});
export type TaskContract = z.infer<typeof TaskContract>;
