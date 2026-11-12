import type * as OpenAiSdk from "openai";
import {
  DevflowError,
  ErrorCode,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "@devflow-ai/core";
import { LlmProviderError, kindForStatus, parseRetryAfter } from "../provider-error.js";
import { dropOmittedNulls, openAiStrictSchema } from "./openai-schema.js";

type SdkModule = typeof OpenAiSdk;
type SdkClient = InstanceType<SdkModule["default"]>;
type CreateParams = OpenAiSdk.OpenAI.Responses.ResponseCreateParamsNonStreaming;
type SdkResponse = OpenAiSdk.OpenAI.Responses.Response;

export interface OpenAiProviderOptions {
  /** Where credentials are read from. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** API endpoint; defaults to `OPENAI_BASE_URL`, then the SDK's default. */
  readonly baseURL?: string;
  /** SDK-level timeout per request, in milliseconds. The gateway enforces its own as well. */
  readonly timeoutMs?: number;
  /** Loads the SDK module. Injected in tests. */
  readonly loadSdk?: () => Promise<SdkModule>;
}

const DEFAULT_SDK_TIMEOUT_MS = 600_000;

/**
 * The OpenAI Responses API behind the `LlmProvider` port (ADR 0010).
 *
 * - The official SDK is imported on first use, so other providers never load it.
 * - The API key comes from `OPENAI_API_KEY` in the environment (with `OPENAI_ORG_ID` and
 *   `OPENAI_PROJECT_ID` when set), never from a file in the repository.
 * - SDK retries are disabled: the gateway owns retries, timeouts and budgets.
 * - Requests are not stored by OpenAI (`store: false`) and sampling parameters are not sent.
 * - Structured output uses strict `json_schema` mode. Strict mode needs every property
 *   required, so optional properties are sent as nullable and the nulls are removed from the
 *   answer again; the gateway validates it with the full Zod schema.
 * - No model id is built in: the model always comes from configuration or the command line.
 */
export class OpenAiProvider implements LlmProvider {
  readonly id = "openai";
  private readonly options: OpenAiProviderOptions;
  private readonly apiKey: string;
  private sdk: Promise<{ module: SdkModule; client: SdkClient }> | undefined;

  constructor(options: OpenAiProviderOptions = {}) {
    this.options = options;
    const apiKey = (options.env ?? process.env).OPENAI_API_KEY?.trim();
    if (apiKey === undefined || apiKey === "") {
      throw new DevflowError(
        ErrorCode.LlmProviderNotConfigured,
        "the openai provider needs OPENAI_API_KEY in the environment",
        { details: { provider: "openai" } },
      );
    }
    this.apiKey = apiKey;
  }

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const { module, client } = await this.load();
    let response: SdkResponse;
    try {
      response = await client.responses.create(toResponseParams(request), {
        signal,
        maxRetries: 0,
        timeout: this.options.timeoutMs ?? DEFAULT_SDK_TIMEOUT_MS,
      });
    } catch (error) {
      throw toOpenAiProviderError(module, error);
    }
    return fromResponse(response, request);
  }

  private load(): Promise<{ module: SdkModule; client: SdkClient }> {
    this.sdk ??= (async () => {
      let module: SdkModule;
      try {
        module = await (this.options.loadSdk ?? (() => import("openai")))();
      } catch (error) {
        throw new DevflowError(
          ErrorCode.LlmProviderNotConfigured,
          "the openai package cannot be loaded",
          { details: { provider: "openai" }, cause: error },
        );
      }
      const env = this.options.env ?? process.env;
      const setting = (value: string | undefined) => {
        const trimmed = value?.trim();
        return trimmed === undefined || trimmed === "" ? undefined : trimmed;
      };
      const baseURL = setting(this.options.baseURL ?? env.OPENAI_BASE_URL);
      const organization = setting(env.OPENAI_ORG_ID);
      const project = setting(env.OPENAI_PROJECT_ID);
      const client = new module.default({
        apiKey: this.apiKey,
        // Explicit nulls stop the SDK from reading these from process.env on its own.
        organization: organization ?? null,
        project: project ?? null,
        ...(baseURL === undefined ? {} : { baseURL }),
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

/** A `json_schema` format name: letters, digits, `_` and `-`, at most 64 characters. */
function formatName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned === "" ? "answer" : cleaned;
}

/** Builds the Responses API parameters for a port request. Exported for tests. */
export function toResponseParams(request: LlmRequest): CreateParams {
  return {
    model: request.model,
    instructions: request.system,
    input: request.messages.map((message) => ({
      type: "message" as const,
      role: message.role,
      content: message.content,
    })),
    max_output_tokens: request.maxOutputTokens,
    store: false,
    ...(request.responseFormat === undefined
      ? {}
      : {
          text: {
            format: {
              type: "json_schema" as const,
              name: formatName(request.responseFormat.name),
              schema: openAiStrictSchema(request.responseFormat.jsonSchema),
              strict: true,
            },
          },
        }),
  };
}

/** Maps a Responses API response to the port's response. Exported for tests. */
export function fromResponse(response: SdkResponse, request?: LlmRequest): LlmResponse {
  let text = "";
  let refused = false;
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const part of item.content) {
      if (part.type === "output_text") text += part.text;
      else refused = true;
    }
  }
  const format = request?.responseFormat;
  if (format !== undefined && text !== "") {
    try {
      const parsed = JSON.parse(text) as unknown;
      text = JSON.stringify(dropOmittedNulls(parsed, format.jsonSchema));
    } catch {
      // Not JSON: the gateway reports it and asks for a repair.
    }
  }
  const usage = response.usage;
  const cacheRead = usage?.input_tokens_details.cached_tokens ?? 0;
  const cacheWrite = usage?.input_tokens_details.cache_write_tokens ?? 0;
  const requestId = (response as SdkResponse & { _request_id?: string | null })._request_id;
  return {
    text,
    model: response.model,
    stopReason: stopReasonOf(response, refused && text === ""),
    usage: {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
      ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
    },
    ...(typeof requestId === "string" && requestId !== "" ? { providerRequestId: requestId } : {}),
  };
}

function stopReasonOf(response: SdkResponse, refused: boolean): LlmResponse["stopReason"] {
  if (refused) return "refusal";
  if (response.status === "completed") return "end_turn";
  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    if (reason === "max_output_tokens") return "max_tokens";
    if (reason === "content_filter") return "refusal";
  }
  return "other";
}

/** Translates an SDK error into a provider-neutral one. Exported for tests. */
export function toOpenAiProviderError(module: SdkModule, error: unknown): unknown {
  // A caller abort is not a provider failure: the gateway turns it into CANCELLED.
  if (error instanceof module.APIUserAbortError) return error;
  if (error instanceof module.APIConnectionTimeoutError) {
    return new LlmProviderError("timeout", "the request to the OpenAI API timed out", {
      cause: error,
    });
  }
  if (error instanceof module.APIConnectionError) {
    return new LlmProviderError("network", "the OpenAI API could not be reached", {
      cause: error,
    });
  }
  if (error instanceof module.APIError && typeof error.status === "number") {
    const status = error.status;
    const headers = error.headers as Headers | undefined;
    const retryAfterMs = parseRetryAfter(headers?.get("retry-after"));
    const requestId = error.requestID ?? undefined;
    const body = error.error as { message?: unknown } | undefined;
    const detail =
      typeof body?.message === "string" && body.message !== "" ? body.message : `HTTP ${status}`;
    return new LlmProviderError(kindForStatus(status), `OpenAI API error ${status}: ${detail}`, {
      status,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      ...(requestId === undefined ? {} : { requestId }),
      cause: error,
    });
  }
  return error;
}
