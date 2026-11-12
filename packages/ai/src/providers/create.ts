import { DevflowError, ErrorCode, type LlmProvider } from "@devflow-ai/core";
import { AgentProvider } from "./agent.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiProvider } from "./openai.js";
import { ReplayProvider } from "./replay.js";

/** Providers that can be selected by name (configuration or `--provider`). */
export const PROVIDER_NAMES = ["anthropic", "openai", "replay", "agent"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface CreateProviderOptions {
  readonly name: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Cassette file, required by `replay`. */
  readonly cassette?: string;
  /** Where `agent` keeps requests and answers: `<workspace>/.devflow/agent` (ADR 0027). */
  readonly agentDirectory?: string;
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
    case "agent":
      if (options.agentDirectory === undefined || options.agentDirectory === "") {
        throw new DevflowError(
          ErrorCode.LlmProviderNotConfigured,
          "the agent provider needs the workspace's .devflow/agent directory",
          { details: { provider: "agent" } },
        );
      }
      return new AgentProvider({ directory: options.agentDirectory });
    case "openai":
      return new OpenAiProvider({ ...(options.env === undefined ? {} : { env: options.env }) });
    default:
      throw new DevflowError(
        ErrorCode.LlmProviderNotConfigured,
        `unknown provider "${options.name}" (expected one of: ${PROVIDER_NAMES.join(", ")})`,
        { details: { provider: options.name } },
      );
  }
}
