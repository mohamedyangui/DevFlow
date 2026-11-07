import { DEFAULT_BUDGET_LIMITS } from "@devflow/ai";
import { DEFAULT_CONTEXT_BUDGET_TOKENS } from "@devflow/context";
import { DevflowError, ErrorCode, type ProjectConfig } from "@devflow/core";
import type { RunBudgets, RunSettings } from "./schemas.js";

export const DEFAULT_PROVIDER = "anthropic";

export const DEFAULT_MAX_OUTPUT_TOKENS = Object.freeze({ analysis: 8_000, planning: 16_000 });

/** Command-line choices; they win over configuration and environment. */
export interface SettingsOverrides {
  readonly provider?: string;
  readonly model?: string;
  readonly requirePlanApproval?: boolean;
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
  const fallbackModel = nonEmpty(overrides.model) ?? undefined;
  const envModel = nonEmpty(input.env.DEVFLOW_MODEL);
  const analysis =
    fallbackModel ?? nonEmpty(ai?.models.analysis) ?? nonEmpty(ai?.models.default) ?? envModel;
  const planning =
    fallbackModel ?? nonEmpty(ai?.models.planning) ?? nonEmpty(ai?.models.default) ?? envModel;
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
  };

  return {
    settings: {
      provider,
      models: { analysis, planning },
      requirePlanApproval: overrides.requirePlanApproval ?? workflow?.requirePlanApproval ?? true,
      budgets,
      contextBudgetTokens: overrides.contextBudgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS,
      maxOutputTokens: { ...DEFAULT_MAX_OUTPUT_TOKENS },
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
