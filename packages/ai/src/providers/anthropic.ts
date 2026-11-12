import type * as AnthropicSdk from "@anthropic-ai/sdk";
import {
  DevflowError,
  ErrorCode,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "@devflow-ai/core";
import { LlmProviderError, kindForStatus, parseRetryAfter } from "../provider-error.js";
import { strictJsonSchema } from "../structured.js";

type SdkModule = typeof AnthropicSdk;
type SdkClient = InstanceType<SdkModule["default"]>;
type CreateParams = AnthropicSdk.Anthropic.MessageCreateParamsNonStreaming;
type SdkMessage = AnthropicSdk.Anthropic.Message;

export interface AnthropicProviderOptions {
  /** Where credentials are read from. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** API endpoint; defaults to `ANTHROPIC_BASE_URL`, then the SDK's default. */
  readonly baseURL?: string;
  /** SDK-level timeout per request, in milliseconds. The gateway enforces its own as well. */
  readonly timeoutMs?: number;
  /** Loads the SDK module. Injected in tests. */
  readonly loadSdk?: () => Promise<SdkModule>;
}

const DEFAULT_SDK_TIMEOUT_MS = 600_000;

/**
 * The Anthropic Messages API behind the `LlmProvider` port (ADR 0010).
 *
 * - The official SDK is imported on first use, so other providers never load it.
 * - The API key comes from `ANTHROPIC_API_KEY` (or a token from `ANTHROPIC_AUTH_TOKEN`) in
 *   the environment, never from a file in the repository.
 * - SDK retries are disabled: the gateway owns retries, timeouts and budgets.
 * - Structured output uses `output_config.format` with a JSON Schema reduced to the subset the
 *   API accepts; the gateway validates the answer with the full Zod schema.
 * - No model id is built in: the model always comes from configuration or the command line.
 */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";
  private readonly options: AnthropicProviderOptions;
  private readonly credentials: { apiKey: string } | { authToken: string };
  private sdk: Promise<{ module: SdkModule; client: SdkClient }> | undefined;

  constructor(options: AnthropicProviderOptions = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    const apiKey = env.ANTHROPIC_API_KEY?.trim();
    const authToken = env.ANTHROPIC_AUTH_TOKEN?.trim();
    if (apiKey !== undefined && apiKey !== "") {
      this.credentials = { apiKey };
    } else if (authToken !== undefined && authToken !== "") {
      this.credentials = { authToken };
    } else {
      throw new DevflowError(
        ErrorCode.LlmProviderNotConfigured,
        "the anthropic provider needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment",
        { details: { provider: "anthropic" } },
      );
    }
  }

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const { module, client } = await this.load();
    let message: SdkMessage;
    try {
      message = await client.messages.create(toCreateParams(request), {
        signal,
        maxRetries: 0,
        timeout: this.options.timeoutMs ?? DEFAULT_SDK_TIMEOUT_MS,
      });
    } catch (error) {
      throw toProviderError(module, error);
    }
    return fromMessage(message);
  }

  private load(): Promise<{ module: SdkModule; client: SdkClient }> {
    this.sdk ??= (async () => {
      let module: SdkModule;
      try {
        module = await (this.options.loadSdk ?? (() => import("@anthropic-ai/sdk")))();
      } catch (error) {
        throw new DevflowError(
          ErrorCode.LlmProviderNotConfigured,
          "the @anthropic-ai/sdk package cannot be loaded",
          { details: { provider: "anthropic" }, cause: error },
        );
      }
      const env = this.options.env ?? process.env;
      const baseURL = this.options.baseURL ?? env.ANTHROPIC_BASE_URL;
      const client = new module.default({
        ...this.credentials,
        ...(baseURL === undefined || baseURL === "" ? {} : { baseURL }),
        maxRetries: 0,
      });
      return { module, client };
    })();
    // A failed load is not cached, so a later call can try again.
    this.sdk.catch(() => {
      this.sdk = undefined;
    });
    return this.sdk;
  }
}

/** Builds the Messages API parameters for a port request. Exported for tests. */
export function toCreateParams(request: LlmRequest): CreateParams {
  // Sampling parameters are not sent: current API versions reject them.
  return {
    model: request.model,
    max_tokens: request.maxOutputTokens,
    system: request.system,
    messages: request.messages.map((message) =>
      message.role === "user"
        ? { role: "user" as const, content: message.content }
        : { role: "assistant" as const, content: message.content },
    ),
    ...(request.responseFormat === undefined
      ? {}
      : {
          output_config: {
            format: {
              type: "json_schema" as const,
              schema: strictJsonSchema(request.responseFormat.jsonSchema),
            },
          },
        }),
  };
}

/** Maps a Messages API response to the port's response. Exported for tests. */
export function fromMessage(message: SdkMessage): LlmResponse {
  const text = message.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
  const usage = message.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const requestId = (message as SdkMessage & { _request_id?: string | null })._request_id;
  return {
    text,
    model: message.model,
    stopReason: stopReasonOf(message.stop_reason),
    usage: {
      inputTokens: usage.input_tokens + cacheRead + cacheWrite,
      outputTokens: usage.output_tokens,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    },
    ...(typeof requestId === "string" && requestId !== "" ? { providerRequestId: requestId } : {}),
  };
}

function stopReasonOf(reason: SdkMessage["stop_reason"]): LlmResponse["stopReason"] {
  switch (reason) {
    case "end_turn":
    case "max_tokens":
    case "refusal":
      return reason;
    case "model_context_window_exceeded":
      return "max_tokens";
    case "stop_sequence":
    case "tool_use":
    case "pause_turn":
    case null:
      return "other";
  }
}

/** Translates an SDK error into a provider-neutral one. Exported for tests. */
export function toProviderError(module: SdkModule, error: unknown): unknown {
  // A caller abort is not a provider failure: the gateway turns it into CANCELLED.
  if (error instanceof module.APIUserAbortError) return error;
  if (error instanceof module.APIConnectionTimeoutError) {
    return new LlmProviderError("timeout", "the request to the Anthropic API timed out", {
      cause: error,
    });
  }
  if (error instanceof module.APIConnectionError) {
    return new LlmProviderError("network", "the Anthropic API could not be reached", {
      cause: error,
    });
  }
  if (error instanceof module.APIError && typeof error.status === "number") {
    const status = error.status;
    const headers = error.headers as Headers | undefined;
    const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
    const requestId = error.requestID ?? undefined;
    const detail = error.apiMessage ?? error.type ?? `HTTP ${status}`;
    return new LlmProviderError(kindForStatus(status), `Anthropic API error ${status}: ${detail}`, {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  return error;
}
