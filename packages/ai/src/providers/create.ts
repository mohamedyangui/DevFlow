import { DevflowError, ErrorCode, type LlmProvider } from "@devflow/core";
import { AnthropicProvider } from "./anthropic.js";
import { ReplayProvider } from "./replay.js";

/** Providers that can be selected by name (configuration or `--provider`). */
export const PROVIDER_NAMES = ["anthropic", "openai", "replay"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface CreateProviderOptions {
  readonly name: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Cassette file, required by `replay`. */
  readonly cassette?: string;
}

/** Creates a provider by name. Configuration problems raise `LLM_PROVIDER_NOT_CONFIGURED`. */
export async function createProvider(options: CreateProviderOptions): Promise<LlmProvider> {
  switch (options.name) {
    case "anthropic":
      return new AnthropicProvider({ ...(options.env === undefined ? {} : { env: options.env }) });
    case "replay":
      if (options.cassette === undefined || options.cassette === "") {
        throw new DevflowError(
          ErrorCode.LlmProviderNotConfigured,
          "the replay provider needs a cassette file",
          { details: { provider: "replay" } },
        );
      }
      return ReplayProvider.load(options.cassette);
    case "openai":
      throw new DevflowError(
        ErrorCode.LlmProviderNotConfigured,
        "the openai provider is not implemented yet (planned for Phase 4)",
        { details: { provider: "openai" } },
      );
    default:
      throw new DevflowError(
        ErrorCode.LlmProviderNotConfigured,
        `unknown provider "${options.name}" (expected one of: ${PROVIDER_NAMES.join(", ")})`,
        { details: { provider: options.name } },
      );
  }
}
