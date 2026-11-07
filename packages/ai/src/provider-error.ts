/** Why a provider call failed, in provider-neutral terms. */
export type LlmFailureKind =
  | "rate-limit"
  | "overloaded"
  | "server"
  | "network"
  | "timeout"
  | "authentication"
  | "permission"
  | "invalid-request"
  | "not-found"
  | "request-too-large"
  | "other";

const RETRYABLE: ReadonlySet<LlmFailureKind> = new Set([
  "rate-limit",
  "overloaded",
  "server",
  "network",
  "timeout",
]);

/**
 * A failed provider call. Providers translate their SDK's errors into this class so the
 * gateway can decide on retries without knowing any SDK.
 */
export class LlmProviderError extends Error {
  override readonly name = "LlmProviderError";
  readonly kind: LlmFailureKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Delay the provider asked for (`retry-after`), in milliseconds. */
  readonly retryAfterMs: number | undefined;
  readonly requestId: string | undefined;

  constructor(
    kind: LlmFailureKind,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      requestId?: string;
      retryable?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    this.retryable = options.retryable ?? RETRYABLE.has(kind);
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.requestId = options.requestId;
  }
}

/** Failure kind for an HTTP status, following the usual provider conventions. */
export function kindForStatus(status: number): LlmFailureKind {
  if (status === 401) return "authentication";
  if (status === 403) return "permission";
  if (status === 404) return "not-found";
  if (status === 408) return "timeout";
  if (status === 409) return "server";
  if (status === 413) return "request-too-large";
  if (status === 429) return "rate-limit";
  if (status === 529 || status === 503) return "overloaded";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid-request";
  return "other";
}

/**
 * Parses a `retry-after` header: either delta seconds or an HTTP date. Returns undefined
 * when the value is missing or unusable.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (value === null || value === undefined || value.trim() === "") return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}
