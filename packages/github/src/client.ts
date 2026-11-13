import { DevflowError, ErrorCode, SecretRedactor } from "@devflowai/core";
import type { z } from "zod";

/**
 * A small client for the GitHub REST API, on the `fetch` built into Node (no SDK, ADR 0019).
 *
 * - The token is read by the caller from the environment and sent only to the API origin; it
 *   never appears in an error message, and GitHub's own messages are redacted before use.
 * - Redirects are not followed, so the token cannot be sent to another host.
 * - Every answer has a size limit and a timeout, and is validated against a schema before
 *   DevFlow uses it.
 */
export interface GitHubClientOptions {
  /** A token (`GITHUB_TOKEN` or `GH_TOKEN`). Without one, only public data can be read. */
  readonly token?: string | undefined;
  /** Default: `https://api.github.com`. */
  readonly apiUrl?: string;
  /** Injected in tests; default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Per request. Default: 30 seconds. */
  readonly timeoutMs?: number;
  /** Largest answer read. Default: 8 MiB. */
  readonly maxResponseBytes?: number;
}

export interface GitHubRequest<T> {
  readonly method?: "GET" | "POST" | "PATCH";
  /** The API path, e.g. `/repos/acme/shop/issues/142`; build it with {@link apiPath}. */
  readonly path: string;
  readonly schema: z.ZodType<T>;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

export const DEFAULT_GITHUB_API_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const API_VERSION = "2022-11-28";
const MAX_MESSAGE_CHARS = 200;

/** Joins path segments, each encoded, so a value from a remote or an issue cannot add segments. */
export function apiPath(...segments: readonly (string | number)[]): string {
  return segments.map((segment) => `/${encodeURIComponent(String(segment))}`).join("");
}

export class GitHubClient {
  private readonly token: string | undefined;
  private readonly apiUrl: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly redactor: SecretRedactor;

  constructor(options: GitHubClientOptions = {}) {
    const token = options.token?.trim();
    this.token = token === undefined || token === "" ? undefined : token;
    this.apiUrl = new URL(options.apiUrl ?? DEFAULT_GITHUB_API_URL);
    if (this.apiUrl.protocol !== "https:") {
      throw new DevflowError(
        ErrorCode.GitHubRequestFailed,
        `the GitHub API URL must use https: ${this.apiUrl.origin}`,
      );
    }
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.redactor = new SecretRedactor({
      knownSecrets: this.token === undefined ? [] : [this.token],
    });
  }

  /** Whether requests are authenticated. */
  get authenticated(): boolean {
    return this.token !== undefined;
  }

  async request<T>(request: GitHubRequest<T>): Promise<T> {
    const method = request.method ?? "GET";
    if (!request.path.startsWith("/") || request.path.startsWith("//")) {
      throw new Error(`GitHub API path must be absolute: ${request.path}`);
    }
    const base = this.apiUrl.pathname.replace(/\/+$/, "");
    const url = new URL(`${base}${request.path}`, this.apiUrl.origin);
    const what = `${method} ${url.pathname}`;

    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal =
      request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal]);
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": API_VERSION,
      "User-Agent": "devflow-ai",
    };
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
    if (request.body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        signal,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
      });
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new DevflowError(ErrorCode.Cancelled, `${what} was interrupted`, { cause: error });
      }
      const reason = timeout.aborted
        ? `no answer within ${String(this.timeoutMs / 1000)} s`
        : this.safe((error as Error).message);
      throw this.failure(what, `the request failed (${reason})`, undefined, error);
    }

    const text = await this.readText(response, what);
    if (response.status >= 300 && response.status < 400) {
      throw this.failure(
        what,
        "GitHub answered with a redirect, which DevFlow does not follow (a renamed or moved " +
          "repository: use its current owner/name)",
        response.status,
      );
    }
    if (!response.ok) {
      throw this.failure(what, this.describeError(response, text), response.status);
    }

    let json: unknown;
    try {
      json = text === "" ? null : JSON.parse(text);
    } catch (error) {
      throw this.failure(what, "the answer is not JSON", response.status, error);
    }
    const parsed = request.schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw this.failure(
        what,
        `the answer does not have the expected shape${
          issue === undefined ? "" : ` (${issue.path.join(".") || "(root)"}: ${issue.message})`
        }`,
        response.status,
      );
    }
    return parsed.data;
  }

  private async readText(response: Response, what: string): Promise<string> {
    const declared = Number(response.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > this.maxResponseBytes) {
      await response.body?.cancel();
      throw this.tooLarge(what, response.status);
    }
    if (response.body === null) return "";
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > this.maxResponseBytes) {
        await reader.cancel();
        throw this.tooLarge(what, response.status);
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }

  private describeError(response: Response, text: string): string {
    const message = githubMessage(text);
    const said = message === undefined ? "" : `: ${this.safe(message)}`;
    switch (response.status) {
      case 401:
        return `GitHub rejected the token (401${said})`;
      case 403:
      case 429:
        if (
          response.status === 429 ||
          response.headers.get("x-ratelimit-remaining") === "0" ||
          /rate limit/i.test(message ?? "")
        ) {
          return (
            `the GitHub rate limit was reached (${String(response.status)})` +
            (this.authenticated ? "" : "; set GITHUB_TOKEN for a higher limit")
          );
        }
        return `GitHub refused the request (403${said}); the token may lack a permission`;
      case 404:
        return (
          "not found (404)" +
          (this.authenticated
            ? ": it does not exist or the token cannot see it"
            : ": it does not exist, or it is private and GITHUB_TOKEN is not set")
        );
      default:
        return `GitHub answered ${String(response.status)}${said}`;
    }
  }

  private failure(what: string, reason: string, status?: number, cause?: unknown): DevflowError {
    return new DevflowError(ErrorCode.GitHubRequestFailed, `GitHub ${what}: ${reason}`, {
      details: { request: what, ...(status === undefined ? {} : { status }) },
      ...(cause === undefined ? {} : { cause }),
    });
  }

  private tooLarge(what: string, status: number): DevflowError {
    return this.failure(
      what,
      `the answer is larger than ${String(this.maxResponseBytes)} bytes`,
      status,
    );
  }

  /** Redacts the token and other secrets, and shortens text from GitHub before it is shown. */
  private safe(text: string): string {
    const redacted = this.redactor.redact(text).text.replace(/\s+/g, " ").trim();
    return redacted.length > MAX_MESSAGE_CHARS
      ? `${redacted.slice(0, MAX_MESSAGE_CHARS - 1)}…`
      : redacted;
  }
}

function githubMessage(text: string): string | undefined {
  try {
    const json = JSON.parse(text) as unknown;
    if (typeof json === "object" && json !== null && "message" in json) {
      const message = json.message;
      return typeof message === "string" && message !== "" ? message : undefined;
    }
  } catch {
    // Not JSON: GitHub's message is not shown.
  }
  return undefined;
}
