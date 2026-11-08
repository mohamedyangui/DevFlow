import {
  type AuditLog,
  DevflowError,
  ErrorCode,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type SecretRedactor,
  isDevflowError,
} from "@devflow/core";
import type { z } from "zod";
import type { BudgetTracker } from "./budget.js";
import type { PriceTable } from "./prices.js";
import { canonicalJson, requestFingerprint } from "./hash.js";
import { LlmProviderError } from "./provider-error.js";
import { describeIssues, extractJson, jsonSchemaFor } from "./structured.js";

export interface RetryOptions {
  /** Total attempts for one call, the first included. */
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** A `retry-after` longer than this fails the call instead of waiting. */
  readonly maxRetryAfterMs: number;
}

export const DEFAULT_RETRY: RetryOptions = Object.freeze({
  attempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 60_000,
});

/** One provider exchange, reported to the observer (the workflow writes it to `logs/`). */
export interface LlmExchange {
  readonly step: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly purpose: "initial" | "repair";
  readonly attempt: number;
  readonly promptSha256: string;
  readonly request: LlmRequest;
  readonly response?: LlmResponse;
  readonly error?: { readonly kind: string; readonly message: string };
}

export interface LlmGatewayOptions {
  readonly provider: LlmProvider;
  readonly redactor: SecretRedactor;
  readonly budget: BudgetTracker;
  /** Prices for cost budgets and audit records. Without one, costs are unknown (null). */
  readonly prices?: PriceTable;
  /** Receives llm-call and redaction entries. */
  readonly audit?: AuditLog;
  readonly retry?: Partial<RetryOptions>;
  /** Per provider call. Default 5 minutes. */
  readonly timeoutMs?: number;
  /** Repair requests after an invalid answer. Default 1 (ADR 0006). */
  readonly maxRepairAttempts?: number;
  readonly observer?: (exchange: LlmExchange) => void | Promise<void>;
  /** Injected in tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface StructuredCall<T> {
  /** Workflow step the call belongs to; budgets count calls per step. */
  readonly step: string;
  readonly templateId: string;
  readonly templateVersion: string;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  /** Repository files whose content is in the prompt (recorded in the audit log). */
  readonly files: readonly string[];
  readonly schema: z.ZodType<T>;
  /** Name of the output format sent to the provider, e.g. `requirements_analysis`. */
  readonly schemaName: string;
  readonly maxOutputTokens: number;
  readonly signal?: AbortSignal;
}

export interface StructuredResult<T> {
  readonly value: T;
  /** The model that served the final answer. */
  readonly model: string;
  /** Provider calls made, repairs included (transport retries are not counted). */
  readonly calls: number;
  readonly repaired: boolean;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Fingerprint of the first request (see {@link requestFingerprint}). */
  readonly promptSha256: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * The single path from DevFlow to a model provider (ADR 0010).
 *
 * For every call it: redacts the prompt and audits each redaction; checks the budget with an
 * estimate before spending anything; calls the provider with a timeout and retries transient
 * failures with exponential backoff and jitter, honouring `retry-after`; records usage;
 * parses the answer as JSON and validates it with the step's Zod schema, asking for one
 * repair when it does not match; and writes an llm-call audit entry per provider call.
 * A refusal, a truncated answer or an answer that stays invalid is an error, never a value.
 */
export class LlmGateway {
  private readonly options: LlmGatewayOptions;
  private readonly retry: RetryOptions;

  constructor(options: LlmGatewayOptions) {
    this.options = options;
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    if (!Number.isInteger(this.retry.attempts) || this.retry.attempts < 1) {
      throw new RangeError("retry.attempts must be a positive integer");
    }
  }

  get providerId(): string {
    return this.options.provider.id;
  }

  async generateStructured<T>(call: StructuredCall<T>): Promise<StructuredResult<T>> {
    if (call.model.trim() === "") {
      throw new DevflowError(
        ErrorCode.LlmProviderNotConfigured,
        "no model is configured for this step",
        { details: { step: call.step, templateId: call.templateId } },
      );
    }
    const context = `llm:${call.templateId}@${call.templateVersion}`;
    const system = await this.redact(call.system, context, "system");
    const user = await this.redact(call.user, context, "user");
    const responseFormat = { name: call.schemaName, jsonSchema: jsonSchemaFor(call.schema) };
    const maxRepairs = this.options.maxRepairAttempts ?? 1;

    const messages: LlmMessage[] = [{ role: "user", content: user }];
    let calls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let firstFingerprint: string | undefined;

    for (let repair = 0; ; repair += 1) {
      const request: LlmRequest = {
        model: call.model,
        system,
        messages: [...messages],
        maxOutputTokens: call.maxOutputTokens,
        responseFormat,
      };
      const purpose = repair === 0 ? "initial" : "repair";
      const response = await this.send(call, request, purpose);
      firstFingerprint ??= response.fingerprint;
      calls += 1;
      inputTokens += response.value.usage.inputTokens;
      outputTokens += response.value.usage.outputTokens;

      const outcome = this.interpret(call, response.value);
      if (outcome.ok) {
        return {
          value: outcome.value,
          model: response.value.model,
          calls,
          repaired: repair > 0,
          inputTokens,
          outputTokens,
          promptSha256: firstFingerprint,
        };
      }
      if (repair >= maxRepairs) {
        throw new DevflowError(
          ErrorCode.LlmOutputInvalid,
          `the model's answer for ${call.templateId} did not match the expected schema` +
            (maxRepairs > 0 ? ` after ${maxRepairs} repair attempt(s)` : ""),
          { details: { step: call.step, templateId: call.templateId, issues: outcome.issues } },
        );
      }
      // The repair turn quotes only our own validation messages; the previous answer goes
      // back as the assistant turn it was.
      const repairText = await this.redact(
        [
          "Your previous answer cannot be used because it does not match the required JSON schema:",
          ...outcome.issues.map((issue) => `- ${issue}`),
          "Answer again with only the corrected JSON object.",
        ].join("\n"),
        context,
        "repair",
      );
      const previous = await this.redact(response.value.text, context, "previous-answer");
      messages.push(
        { role: "assistant", content: previous },
        { role: "user", content: repairText },
      );
    }
  }

  private interpret<T>(
    call: StructuredCall<T>,
    response: LlmResponse,
  ): { ok: true; value: T } | { ok: false; issues: string[] } {
    if (response.stopReason === "refusal") {
      throw new DevflowError(
        ErrorCode.LlmRefused,
        `the model declined the ${call.templateId} request`,
        {
          details: { step: call.step, templateId: call.templateId, model: response.model },
        },
      );
    }
    if (response.stopReason === "max_tokens") {
      throw new DevflowError(
        ErrorCode.LlmOutputTruncated,
        `the model's answer for ${call.templateId} was cut off at ${call.maxOutputTokens} output tokens`,
        {
          details: {
            step: call.step,
            templateId: call.templateId,
            maxOutputTokens: call.maxOutputTokens,
          },
        },
      );
    }
    const json = extractJson(response.text);
    if (!json.ok) return { ok: false, issues: [json.error] };
    const parsed = call.schema.safeParse(json.value);
    if (!parsed.success) return { ok: false, issues: describeIssues(parsed.error) };
    return { ok: true, value: parsed.data };
  }

  /** One logical provider call: budget check, retries, usage and audit. */
  private async send<T>(
    call: StructuredCall<T>,
    request: LlmRequest,
    purpose: "initial" | "repair",
  ): Promise<{ value: LlmResponse; fingerprint: string }> {
    const fingerprint = requestFingerprint(request);
    const estimate = {
      inputTokens: estimateInputTokens(request),
      outputTokens: request.maxOutputTokens,
    };
    this.options.budget.check(call.step, {
      ...estimate,
      costUsd: this.options.prices?.cost(estimate, request.model),
    });

    const signal = call.signal ?? new AbortController().signal;
    for (let attempt = 1; ; attempt += 1) {
      throwIfCancelled(signal);
      try {
        const response = await this.attempt(request, signal);
        this.options.budget.record(call.step, response.usage, this.costOf(request, response));
        await this.observe({ call, purpose, attempt, fingerprint, request, response });
        await this.auditCall(call, request, fingerprint, response, auditOutcome(response));
        return { value: response, fingerprint };
      } catch (error) {
        if (signal.aborted) {
          await this.auditCall(call, request, fingerprint, undefined, "error");
          throw cancelled(error);
        }
        const failure = error instanceof LlmProviderError ? error : undefined;
        await this.observe({
          call,
          purpose,
          attempt,
          fingerprint,
          request,
          error: {
            kind: failure?.kind ?? (isDevflowError(error) ? error.code : "other"),
            message: this.options.redactor.redactText(errorMessage(error)),
          },
        });
        const delay = failure === undefined ? undefined : this.retryDelay(failure, attempt);
        if (delay === undefined) {
          await this.auditCall(call, request, fingerprint, undefined, "error");
          throw this.finalError(call, error, attempt);
        }
        await (this.options.sleep ?? abortableSleep)(delay, signal).catch((sleepError: unknown) => {
          throw cancelled(sleepError);
        });
      }
    }
  }

  private async attempt(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort();
    }, timeoutMs);
    const combined = AbortSignal.any([signal, timeout.signal]);
    // Race the abort as well, so a provider that ignores its signal cannot hang the run.
    const stop = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(combined.reason as Error);
      };
      if (combined.aborted) onAbort();
      else combined.addEventListener("abort", onAbort, { once: true });
    });
    const pending = this.options.provider.generate(request, combined);
    pending.catch(() => undefined);
    stop.catch(() => undefined);
    try {
      return await Promise.race([pending, stop]);
    } catch (error) {
      if (timeout.signal.aborted && !signal.aborted) {
        throw new LlmProviderError("timeout", `no answer within ${timeoutMs} ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Milliseconds to wait before the next attempt, or undefined to give up. */
  private retryDelay(error: LlmProviderError, attempt: number): number | undefined {
    if (!error.retryable || attempt >= this.retry.attempts) return undefined;
    if (error.retryAfterMs !== undefined) {
      return error.retryAfterMs > this.retry.maxRetryAfterMs ? undefined : error.retryAfterMs;
    }
    const ceiling = Math.min(this.retry.maxDelayMs, this.retry.baseDelayMs * 2 ** (attempt - 1));
    const random = this.options.random ?? Math.random;
    return Math.round(ceiling / 2 + random() * (ceiling / 2));
  }

  private finalError<T>(call: StructuredCall<T>, error: unknown, attempts: number): Error {
    if (isDevflowError(error)) return error;
    const failure = error instanceof LlmProviderError ? error : undefined;
    const reason = this.options.redactor.redactText(errorMessage(error));
    return new DevflowError(
      ErrorCode.LlmRequestFailed,
      `${this.options.provider.id} request for ${call.templateId} failed` +
        (attempts > 1 ? ` after ${attempts} attempts` : "") +
        `: ${reason}`,
      {
        details: {
          provider: this.options.provider.id,
          step: call.step,
          templateId: call.templateId,
          kind: failure?.kind ?? "other",
          attempts,
          ...(failure?.status === undefined ? {} : { status: failure.status }),
          ...(failure?.requestId === undefined ? {} : { requestId: failure.requestId }),
        },
        cause: error,
      },
    );
  }

  private async redact(text: string, context: string, part: string): Promise<string> {
    const result = this.options.redactor.redact(text);
    for (const redaction of result.redactions) {
      await this.options.audit?.append({
        type: "redaction",
        context,
        detector: redaction.detector,
        location: `${part}:${redaction.line}:${redaction.column}`,
      });
    }
    return result.text;
  }

  private async auditCall<T>(
    call: StructuredCall<T>,
    request: LlmRequest,
    fingerprint: string,
    response: LlmResponse | undefined,
    outcome: "ok" | "error" | "refused",
  ): Promise<void> {
    await this.options.audit?.append({
      type: "llm-call",
      provider: this.options.provider.id,
      model: response?.model ?? request.model,
      templateId: call.templateId,
      templateVersion: call.templateVersion,
      promptSha256: fingerprint,
      files: [...call.files],
      inputTokens: response?.usage.inputTokens ?? 0,
      outputTokens: response?.usage.outputTokens ?? 0,
      costUsd: response === undefined ? null : (this.costOf(request, response) ?? null),
      outcome,
    });
  }

  /** The cost of a call, priced by the served model, else the requested one. */
  private costOf(request: LlmRequest, response: LlmResponse): number | undefined {
    return this.options.prices?.cost(response.usage, response.model, request.model);
  }

  private async observe<T>(input: {
    call: StructuredCall<T>;
    purpose: "initial" | "repair";
    attempt: number;
    fingerprint: string;
    request: LlmRequest;
    response?: LlmResponse;
    error?: { kind: string; message: string };
  }): Promise<void> {
    if (this.options.observer === undefined) return;
    await this.options.observer({
      step: input.call.step,
      templateId: input.call.templateId,
      templateVersion: input.call.templateVersion,
      purpose: input.purpose,
      attempt: input.attempt,
      promptSha256: input.fingerprint,
      request: input.request,
      ...(input.response === undefined ? {} : { response: input.response }),
      ...(input.error === undefined ? {} : { error: input.error }),
    });
  }
}

/** Input tokens of a request, estimated as characters / 4 (system, messages and schema). */
export function estimateInputTokens(request: LlmRequest): number {
  let chars = request.system.length;
  for (const message of request.messages) chars += message.content.length;
  if (request.responseFormat !== undefined) {
    chars += canonicalJson(request.responseFormat.jsonSchema).length;
  }
  return Math.ceil(chars / 4);
}

function auditOutcome(response: LlmResponse): "ok" | "refused" {
  return response.stopReason === "refusal" ? "refused" : "ok";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cancelled(cause: unknown): DevflowError {
  return new DevflowError(ErrorCode.Cancelled, "the model call was cancelled", { cause });
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw cancelled(signal.reason);
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
