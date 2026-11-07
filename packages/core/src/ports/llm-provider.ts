/**
 * The LLM provider port (ADR 0010).
 *
 * Providers work at the wire level: they send a request and return raw text. Structured
 * output is requested with a JSON Schema; validating the response against the domain's Zod
 * schemas, redaction, budgets, retries and auditing are the gateway's job (Phase 2), so every
 * provider gets the same guarantees.
 */
export interface LlmProvider {
  /** e.g. `anthropic`, `openai`, `fake`, `replay`. */
  readonly id: string;
  generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
}

export interface LlmMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface LlmRequest {
  readonly model: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  /** When set, the provider must request JSON output conforming to this schema. */
  readonly responseFormat?: {
    readonly name: string;
    readonly jsonSchema: Readonly<Record<string, unknown>>;
  };
}

export interface LlmTokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}

export interface LlmResponse {
  /** Raw model output. JSON text when `responseFormat` was set. */
  readonly text: string;
  /** The model that actually served the request. */
  readonly model: string;
  readonly stopReason: "end_turn" | "max_tokens" | "refusal" | "other";
  readonly usage: LlmTokenUsage;
  readonly providerRequestId?: string;
}
