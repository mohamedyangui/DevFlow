import { ErrorCode, ProjectConfig } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROVIDER, resolveRunSettings } from "../src/index.js";

const config = ProjectConfig.parse({
  version: 1,
  ai: {
    provider: "anthropic",
    models: { default: "config-default", planning: "config-planning" },
    prices: {
      "config-default": { inputUsdPerMTok: 1, outputUsdPerMTok: 4 },
      "config-planning": { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
    },
    budgets: { maxInputTokensPerRun: 1_000, maxOutputTokensPerRun: 500, maxCallsPerStep: 2 },
  },
  workflow: {
    requirePlanApproval: false,
    git: { isolation: "branch", branchPrefix: "ai/", commit: "none" },
  },
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
      models: {
        analysis: "config-default",
        planning: "config-planning",
        testDesign: "config-default",
        implementation: "config-default",
        review: "config-default",
      },
      prices: {
        "config-default": { inputUsdPerMTok: 1, outputUsdPerMTok: 4 },
        "config-planning": { inputUsdPerMTok: 2, outputUsdPerMTok: 8 },
      },
      requirePlanApproval: false,
      budgets: { maxInputTokens: 1_000, maxOutputTokens: 500, maxCallsPerStep: 2, maxCostUsd: 5 },
      git: { isolation: "branch", branchPrefix: "ai/", commit: "none" },
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
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain("no price is configured for env-model");
    expect(settings.models).toEqual({
      analysis: "env-model",
      planning: "env-model",
      testDesign: "env-model",
      implementation: "env-model",
      review: "env-model",
    });
    expect(settings.prices).toBeUndefined();
    expect(settings.requirePlanApproval).toBe(true);
    expect(settings.git).toEqual({
      isolation: "branch",
      branchPrefix: "devflow/",
      commit: "per-phase",
    });
    expect(settings.budgets).toEqual({
      maxInputTokens: 600_000,
      maxOutputTokens: 80_000,
      maxCallsPerStep: 12,
      maxCostUsd: 5,
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
    expect(fromEnv.warnings).toEqual([
      "no price is configured for env-model (ai.prices in .devflow/config.yaml), so the cost " +
        "of its calls is unknown and the cost budget of $5 does not limit them",
    ]);
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

  it("routes each step to its own model, and warns about the ones without a price", () => {
    const routed = ProjectConfig.parse({
      version: 1,
      ai: {
        models: { default: "base", testDesign: "tests", review: "reviewer" },
        prices: { base: { inputUsdPerMTok: 1, outputUsdPerMTok: 2 } },
        budgets: { maxCostUsdPerRun: 2.5 },
      },
    });
    const { settings, warnings } = resolveRunSettings({
      config: routed,
      configExists: true,
      configSha256: null,
      trusted: true,
      env: {},
    });
    expect(settings.models).toEqual({
      analysis: "base",
      planning: "base",
      testDesign: "tests",
      implementation: "base",
      review: "reviewer",
    });
    expect(settings.budgets.maxCostUsd).toBe(2.5);
    expect(warnings).toEqual([
      "no price is configured for tests, reviewer (ai.prices in .devflow/config.yaml), so the " +
        "cost of its calls is unknown and the cost budget of $2.5 does not limit them",
    ]);
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

  it("needs no model id or price in agent mode (ADR 0027)", () => {
    const { settings, warnings } = resolveRunSettings({
      config: undefined,
      configExists: false,
      configSha256: null,
      trusted: false,
      env: {},
      overrides: { provider: "agent" },
    });
    expect(warnings).toEqual([]);
    expect(settings.provider).toBe("agent");
    expect(Object.values(settings.models)).toEqual(["agent", "agent", "agent", "agent", "agent"]);
  });
});
