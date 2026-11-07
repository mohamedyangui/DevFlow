import { ErrorCode, ProjectConfig } from "@devflow/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER, resolveRunSettings } from "../src/index.js";

const config = ProjectConfig.parse({
  version: 1,
  ai: {
    provider: "anthropic",
    models: { default: "config-default", planning: "config-planning" },
    budgets: { maxInputTokensPerRun: 1_000, maxOutputTokensPerRun: 500, maxCallsPerStep: 2 },
  },
  workflow: { requirePlanApproval: false },
});

describe("run settings", () => {
  it("uses the configuration of a trusted workspace", () => {
    const { settings, warnings } = resolveRunSettings({
      config,
      configExists: true,
      configSha256: "a".repeat(64),
      trusted: true,
      env: { DEVFLOW_MODEL: "env-model" },
    });
    expect(warnings).toEqual([]);
    expect(settings).toMatchObject({
      provider: "anthropic",
      models: { analysis: "config-default", planning: "config-planning" },
      requirePlanApproval: false,
      budgets: { maxInputTokens: 1_000, maxOutputTokens: 500, maxCallsPerStep: 2 },
      workspaceTrusted: true,
      configSha256: "a".repeat(64),
    });
  });

  it("ignores the ai and workflow settings of an untrusted workspace", () => {
    const { settings, warnings } = resolveRunSettings({
      config,
      configExists: true,
      configSha256: "a".repeat(64),
      trusted: false,
      env: { DEVFLOW_MODEL: "env-model" },
    });
    expect(warnings).toHaveLength(1);
    expect(settings.models).toEqual({ analysis: "env-model", planning: "env-model" });
    expect(settings.requirePlanApproval).toBe(true);
    expect(settings.budgets).toEqual({
      maxInputTokens: 600_000,
      maxOutputTokens: 80_000,
      maxCallsPerStep: 12,
    });
    expect(settings.workspaceTrusted).toBe(false);
  });

  it("lets the command line win", () => {
    const { settings } = resolveRunSettings({
      config,
      configExists: true,
      configSha256: null,
      trusted: true,
      env: { DEVFLOW_MODEL: "env-model", DEVFLOW_PROVIDER: "openai" },
      overrides: {
        provider: "replay",
        model: " cli-model ",
        requirePlanApproval: true,
        budgets: { maxCallsPerStep: 5 },
        contextBudgetTokens: 1234,
      },
    });
    expect(settings).toMatchObject({
      provider: "replay",
      models: { analysis: "cli-model", planning: "cli-model" },
      requirePlanApproval: true,
      budgets: { maxInputTokens: 1_000, maxOutputTokens: 500, maxCallsPerStep: 5 },
      contextBudgetTokens: 1234,
    });
  });

  it("falls back to the environment, then to the default provider", () => {
    const fromEnv = resolveRunSettings({
      config: undefined,
      configExists: false,
      configSha256: null,
      trusted: false,
      env: { DEVFLOW_MODEL: "env-model", DEVFLOW_PROVIDER: "replay" },
    });
    expect(fromEnv.warnings).toEqual([]);
    expect(fromEnv.settings.provider).toBe("replay");
    const defaults = resolveRunSettings({
      config: undefined,
      configExists: false,
      configSha256: null,
      trusted: false,
      env: { DEVFLOW_MODEL: "env-model", DEVFLOW_PROVIDER: "  " },
    });
    expect(defaults.settings.provider).toBe(DEFAULT_PROVIDER);
  });

  it("has no default model", () => {
    expect(() =>
      resolveRunSettings({
        config: undefined,
        configExists: false,
        configSha256: null,
        trusted: true,
        env: { DEVFLOW_MODEL: "" },
      }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.LlmProviderNotConfigured }));
  });
});
