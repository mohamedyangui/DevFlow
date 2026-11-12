import { AGENT_MODEL, DEFAULT_BUDGET_LIMITS } from "@devflow/ai";
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from "@devflow/context";
import { DevflowError, ErrorCode, type ProjectConfig } from "@devflow/core";
import type { RunBudgets, RunSettings } from "./schemas.js";

export const DEFAULT_PROVIDER = "anthropic";

/** The default of `ai.budgets.maxCostUsdPerRun`. */
export const DEFAULT_MAX_COST_USD = 5;

/** Output token limit of a test-design call: it writes whole test files. */
export const DEFAULT_TEST_DESIGN_OUTPUT_TOKENS = 32_000;

/** Output token limit of an implementation call: it writes whole files or many edits. */
export const DEFAULT_IMPLEMENTATION_OUTPUT_TOKENS = 32_000;

/** The default of `workflow.maxRepairAttempts`. */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

/** The default of `workflow.git` (ADR 0012). */
export const DEFAULT_GIT_SETTINGS: NonNullable<RunSettings["git"]> = Object.freeze({
  isolation: "branch",
  branchPrefix: "devflow/",
  commit: "per-phase",
});

/** Output token limit of a review call: a summary and a list of findings. */
export const DEFAULT_REVIEW_OUTPUT_TOKENS = 8_000;

export const DEFAULT_MAX_OUTPUT_TOKENS = Object.freeze({
  analysis: 8_000,
  planning: 16_000,
  testDesign: DEFAULT_TEST_DESIGN_OUTPUT_TOKENS,
  implementation: DEFAULT_IMPLEMENTATION_OUTPUT_TOKENS,
  review: DEFAULT_REVIEW_OUTPUT_TOKENS,
});

/** Command-line choices; they win over configuration and environment. */
export interface SettingsOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly requirePlanApproval?: boolean;
  readonly maxRepairAttempts?: number;
  readonly budgets?: Partial<RunBudgets>;
  readonly contextBudgetTokens?: number;
}

export interface ResolveSettingsInput {
  /** The project configuration (defaults when there is no file). */
  readonly config: ProjectConfig | undefined;
  readonly configExists: boolean;
  readonly configSha256: string | null;
  /** Whether the user trusts this workspace for exactly this configuration (ADR 0007). */
  readonly trusted: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly overrides?: SettingsOverrides;
}

/**
 * The effective settings of a new run.
 *
 * Precedence: command line, then the project configuration **only when the workspace is
 * trusted**, then `DEVFLOW_PROVIDER` / `DEVFLOW_MODEL`, then defaults. An untrusted
 * configuration cannot choose the provider or model, raise budgets or skip plan approval; its
 * `context`, `modules` and `security` sections still apply because they can only restrict.
 * There is no default model: without one, the run does not start.
 */
export function resolveRunSettings(input: ResolveSettingsInput): {
  settings: RunSettings;
  warnings: string[];
} {
  const warnings: string[] = [];
  const overrides = input.overrides ?? {};
  const ai = input.trusted ? input.config?.ai : undefined;
  const workflow = input.trusted ? input.config?.workflow : undefined;
  if (input.configExists && !input.trusted) {
    warnings.push(
      "this workspace is not trusted, so the ai and workflow settings of .devflow/config.yaml " +
        "are ignored and defaults are used (run `devflow trust` to use them)",
    );
  }

  const provider =
    nonEmpty(overrides.provider) ??
    ai?.provider ??
    nonEmpty(input.env.DEVFLOW_PROVIDER) ??
    DEFAULT_PROVIDER;
  // Agent mode (ADR 0027): the coding agent answers, so no model id is needed.
  const agent = provider === "agent";
  const fallbackModel = nonEmpty(overrides.model) ?? (agent ? AGENT_MODEL : undefined);
  const envModel = nonEmpty(input.env.DEVFLOW_MODEL);
  // Per-step routing: --model, then ai.models.<step>, then ai.models.default, then DEVFLOW_MODEL.
  const modelFor = (step: Exclude<keyof NonNullable<typeof ai>["models"], "default">) =>
    fallbackModel ?? nonEmpty(ai?.models[step]) ?? nonEmpty(ai?.models.default) ?? envModel;
  const analysis = modelFor("analysis");
  const planning = modelFor("planning");
  const testDesign = modelFor("testDesign");
  const implementation = modelFor("implementation");
  const review = modelFor("review");
  if (analysis === undefined || planning === undefined) {
    throw new DevflowError(
      ErrorCode.LlmProviderNotConfigured,
      "no model is configured: pass --model, set DEVFLOW_MODEL, or set ai.models.default in " +
        ".devflow/config.yaml of a trusted workspace",
      { details: { provider } },
    );
  }

  const configured = ai?.budgets;
  const budgets: RunBudgets = {
    maxInputTokens:
      overrides.budgets?.maxInputTokens ??
      configured?.maxInputTokensPerRun ??
      DEFAULT_BUDGET_LIMITS.maxInputTokens,
    maxOutputTokens:
      overrides.budgets?.maxOutputTokens ??
      configured?.maxOutputTokensPerRun ??
      DEFAULT_BUDGET_LIMITS.maxOutputTokens,
    maxCallsPerStep:
      overrides.budgets?.maxCallsPerStep ??
      configured?.maxCallsPerStep ??
      DEFAULT_BUDGET_LIMITS.maxCallsPerStep,
    maxCostUsd:
      overrides.budgets?.maxCostUsd ?? configured?.maxCostUsdPerRun ?? DEFAULT_MAX_COST_USD,
  };

  const prices = ai?.prices ?? {};
  const models = { analysis, planning, testDesign, implementation, review };
  const unpriced = [...new Set(Object.values(models).filter((m) => m !== undefined))].filter(
    (model) => prices[model] === undefined,
  );
  if (unpriced.length > 0 && !agent) {
    warnings.push(
      `no price is configured for ${unpriced.join(", ")} (ai.prices in .devflow/config.yaml), ` +
        `so the cost of its calls is unknown and the cost budget of $${String(budgets.maxCostUsd)} does not limit them`,
    );
  }

  return {
    settings: {
      provider,
      models: {
        analysis,
        planning,
        ...(testDesign === undefined ? {} : { testDesign }),
        ...(implementation === undefined ? {} : { implementation }),
        ...(review === undefined ? {} : { review }),
      },
      ...(Object.keys(prices).length > 0 ? { prices } : {}),
      requirePlanApproval: overrides.requirePlanApproval ?? workflow?.requirePlanApproval ?? true,
      maxRepairAttempts:
        overrides.maxRepairAttempts ?? workflow?.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
      budgets,
      contextBudgetTokens: overrides.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      maxOutputTokens: { ...DEFAULT_MAX_OUTPUT_TOKENS },
      git: { ...(workflow?.git ?? DEFAULT_GIT_SETTINGS) },
      workspaceTrusted: input.trusted,
      configSha256: input.configSha256,
    },
    warnings,
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
