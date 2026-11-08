import { z } from "zod";
import { CommandPurpose } from "./command.js";
import { ModuleId, RepoGlob, RepoPath } from "./primitives.js";

/**
 * Project configuration: `.devflow/config.yaml` (docs/specs/project-config.md).
 *
 * This file lives in the repository and is therefore untrusted until the user trusts it with
 * `devflow trust` (Phase 2). It can describe gates and restrict behaviour, but it cannot grant
 * itself permissions: there are deliberately no fields for API keys, environment pass-through,
 * extra allowed commands or network access. Strict objects reject unknown keys such as
 * `apiKey`.
 */

const ModelId = z.string().min(1).max(200);

const UsdPerMTok = z.number().nonnegative().max(10_000);

/** What a model costs, in US dollars per million tokens (no built-in price list, ADR 0010). */
const ModelPrice = z.strictObject({
  inputUsdPerMTok: UsdPerMTok,
  outputUsdPerMTok: UsdPerMTok,
  cachedInputUsdPerMTok: UsdPerMTok.optional(),
  cacheWriteUsdPerMTok: UsdPerMTok.optional(),
});

export const ProjectConfig = z
  .strictObject({
    $schema: z.string().optional(),
    version: z.literal(1),
    project: z.strictObject({ name: z.string().min(1).max(200).optional() }).default({}),
    modules: z
      .array(
        z.strictObject({
          id: ModuleId,
          path: RepoPath,
          adapter: z.string().regex(/^[a-z][a-z0-9-]*$/),
        }),
      )
      .optional()
      .meta({ description: "Optional. Modules are auto-detected when omitted." }),
    ai: z
      .strictObject({
        provider: z.enum(["anthropic", "openai"]).optional(),
        models: z
          .strictObject({
            default: ModelId.optional(),
            analysis: ModelId.optional(),
            planning: ModelId.optional(),
            testDesign: ModelId.optional(),
            implementation: ModelId.optional(),
            review: ModelId.optional(),
          })
          .default({}),
        prices: z
          .record(ModelId, ModelPrice)
          .default({})
          .meta({
            description:
              "Prices by model id, in US dollars per million tokens. Costs and the cost budget are counted only for models listed here.",
          }),
        budgets: z
          .strictObject({
            maxCostUsdPerRun: z.number().positive().max(1000).default(5),
            maxInputTokensPerRun: z.int().positive().default(600_000),
            maxOutputTokensPerRun: z.int().positive().default(80_000),
            maxCallsPerStep: z.int().positive().max(100).default(12),
          })
          .default({
            maxCostUsdPerRun: 5,
            maxInputTokensPerRun: 600_000,
            maxOutputTokensPerRun: 80_000,
            maxCallsPerStep: 12,
          }),
      })
      .optional()
      .meta({ description: "API keys are read from environment variables only, never from files." }),
    workflow: z
      .strictObject({
        requirePlanApproval: z.boolean().default(true),
        maxRepairAttempts: z.int().min(0).max(5).default(2),
        git: z
          .strictObject({
            isolation: z.enum(["branch", "worktree"]).default("branch"),
            branchPrefix: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,40}$/)
              .default("devflow/"),
            commit: z.enum(["per-phase", "none"]).default("per-phase"),
          })
          .default({ isolation: "branch", branchPrefix: "devflow/", commit: "per-phase" }),
      })
      .default({
        requirePlanApproval: true,
        maxRepairAttempts: 2,
        git: { isolation: "branch", branchPrefix: "devflow/", commit: "per-phase" },
      }),
    verification: z
      .strictObject({
        baseline: z.enum(["auto", "always", "never"]).default("auto"),
        gates: z
          .array(
            z.strictObject({
              id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
              module: ModuleId,
              use: CommandPurpose.meta({
                description: "Selects the adapter-provided command for this purpose.",
              }),
              required: z.boolean().default(true),
            }),
          )
          .default([]),
      })
      .default({ baseline: "auto", gates: [] }),
    context: z
      .strictObject({
        include: z.array(RepoGlob).default([]),
        exclude: z.array(RepoGlob).default([]),
        maxFileBytes: z.int().positive().max(5_242_880).default(524_288),
      })
      .default({ include: [], exclude: [], maxFileBytes: 524_288 }),
    security: z
      .strictObject({
        additionalProtectedPaths: z
          .array(RepoGlob)
          .default([])
          .meta({ description: "Extra paths DevFlow must never modify. Can only add restrictions." }),
      })
      .default({ additionalProtectedPaths: [] }),
  })
  .superRefine((config, ctx) => {
    const ids = new Set<string>();
    config.verification.gates.forEach((gate, index) => {
      if (ids.has(gate.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["verification", "gates", index, "id"],
          message: `duplicate gate id "${gate.id}"`,
        });
      }
      ids.add(gate.id);
    });
    const moduleIds = new Set<string>();
    config.modules?.forEach((module, index) => {
      if (moduleIds.has(module.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["modules", index, "id"],
          message: `duplicate module id "${module.id}"`,
        });
      }
      moduleIds.add(module.id);
    });
  })
  .meta({ title: "DevFlow project configuration" });
export type ProjectConfig = z.infer<typeof ProjectConfig>;
export type ProjectConfigInput = z.input<typeof ProjectConfig>;
