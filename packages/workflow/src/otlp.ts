import { DevflowError, ErrorCode } from "@devflowai/core";
import { z } from "zod";
import { TRACE_SCOPE, type RunTrace, type TraceAttributeValue, type TraceSpan } from "./trace.js";

/**
 * OTLP/JSON encoding of a {@link RunTrace} and an OTLP/HTTP exporter on Node's `fetch`
 * (ADR 0024). No OpenTelemetry package is used: the request is the JSON form of
 * `ExportTraceServiceRequest` (opentelemetry-proto, `trace/v1`), restricted to the fields
 * DevFlow fills. Ids are lowercase hexadecimal strings and times are Unix nanoseconds as
 * decimal strings, as the OTLP/JSON mapping requires.
 */

const AnyValue = z.union([
  z.strictObject({ stringValue: z.string() }),
  z.strictObject({ boolValue: z.boolean() }),
  /** 64-bit integers are strings in OTLP/JSON. */
  z.strictObject({ intValue: z.string().regex(/^-?\d+$/) }),
  z.strictObject({ doubleValue: z.number() }),
]);

const KeyValue = z.strictObject({ key: z.string().min(1), value: AnyValue });

const UnixNano = z.string().regex(/^\d{1,20}$/);

export const OtlpSpan = z.strictObject({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  name: z.string().min(1),
  /** 1 = SPAN_KIND_INTERNAL, 3 = SPAN_KIND_CLIENT. */
  kind: z.union([z.literal(1), z.literal(3)]),
  startTimeUnixNano: UnixNano,
  endTimeUnixNano: UnixNano,
  attributes: z.array(KeyValue),
  /** 0 = STATUS_CODE_UNSET, 1 = STATUS_CODE_OK, 2 = STATUS_CODE_ERROR. */
  status: z.strictObject({
    code: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    message: z.string().optional(),
  }),
});
export type OtlpSpan = z.infer<typeof OtlpSpan>;

/** The subset of `ExportTraceServiceRequest` that DevFlow writes and sends. */
export const OtlpTraceRequest = z.strictObject({
  resourceSpans: z
    .array(
      z.strictObject({
        resource: z.strictObject({ attributes: z.array(KeyValue) }),
        scopeSpans: z
          .array(
            z.strictObject({
              scope: z.strictObject({ name: z.string().min(1), version: z.string().optional() }),
              spans: z.array(OtlpSpan),
            }),
          )
          .length(1),
      }),
    )
    .length(1),
});
export type OtlpTraceRequest = z.infer<typeof OtlpTraceRequest>;

/** Encodes a trace as an OTLP/JSON `ExportTraceServiceRequest`, validated by its schema. */
export function toOtlpRequest(trace: RunTrace): OtlpTraceRequest {
  const version = trace.resource["service.version"];
  return OtlpTraceRequest.parse({
    resourceSpans: [
      {
        resource: { attributes: keyValues(trace.resource) },
        scopeSpans: [
          {
            scope: {
              name: TRACE_SCOPE,
              ...(typeof version === "string" ? { version } : {}),
            },
            spans: trace.spans.map((span) => otlpSpan(trace.traceId, span)),
          },
        ],
      },
    ],
  });
}

function otlpSpan(traceId: string, span: TraceSpan): OtlpSpan {
  return {
    traceId,
    spanId: span.spanId,
    ...(span.parentSpanId === undefined ? {} : { parentSpanId: span.parentSpanId }),
    name: span.name,
    kind: span.kind === "client" ? 3 : 1,
    startTimeUnixNano: unixNano(span.startMs),
    endTimeUnixNano: unixNano(Math.max(span.startMs, span.endMs)),
    attributes: keyValues(span.attributes),
    status: {
      code: span.status.code === "ok" ? 1 : span.status.code === "error" ? 2 : 0,
      ...(span.status.message === undefined ? {} : { message: span.status.message }),
    },
  };
}

function keyValues(
  attributes: Readonly<Record<string, TraceAttributeValue>>,
): z.infer<typeof KeyValue>[] {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: anyValue(key, value) }));
}

/** Integers are `intValue`, except amounts in dollars, which are always `doubleValue`. */
function anyValue(key: string, value: TraceAttributeValue): z.infer<typeof AnyValue> {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value) && !key.endsWith(".usd")) return { intValue: String(value) };
  return { doubleValue: value };
}

function unixNano(ms: number): string {
  return (BigInt(Math.max(0, Math.round(ms))) * 1_000_000n).toString();
}

// ---- OTLP/HTTP --------------------------------------------------------------------------------

/** Where and how to send traces, from the standard `OTEL_EXPORTER_OTLP_*` variables. */
export interface OtlpEndpoint {
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export const DEFAULT_OTLP_TIMEOUT_MS = 10_000;
/** Bodies larger than this are not sent. */
export const DEFAULT_OTLP_MAX_BYTES = 4 * 1024 * 1024;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Resolves the OTLP/HTTP traces endpoint from the user's environment:
 * `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` as given, else `OTEL_EXPORTER_OTLP_ENDPOINT` with
 * `/v1/traces` appended; headers from `OTEL_EXPORTER_OTLP_HEADERS` and
 * `OTEL_EXPORTER_OTLP_TRACES_HEADERS` (`key=value,...`, values URL-encoded); the timeout from
 * `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` or `OTEL_EXPORTER_OTLP_TIMEOUT` (milliseconds).
 *
 * @throws DevflowError `TRACE_EXPORT_REFUSED` when no endpoint is set, when it is not `https`
 * outside localhost, when it carries credentials, or when a header or the timeout is malformed.
 */
export function resolveOtlpEndpoint(
  env: Readonly<Record<string, string | undefined>>,
): OtlpEndpoint {
  const tracesEndpoint = nonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
  const baseEndpoint = nonEmpty(env.OTEL_EXPORTER_OTLP_ENDPOINT);
  const raw =
    tracesEndpoint ??
    (baseEndpoint === undefined ? undefined : `${baseEndpoint.replace(/\/+$/, "")}/v1/traces`);
  if (raw === undefined) {
    throw refused(
      "no OTLP endpoint is set: set OTEL_EXPORTER_OTLP_TRACES_ENDPOINT or OTEL_EXPORTER_OTLP_ENDPOINT",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw refused("the OTLP endpoint is not a valid URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw refused(
      "the OTLP endpoint must not contain credentials; pass them in OTEL_EXPORTER_OTLP_HEADERS",
    );
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw refused(
      `the OTLP endpoint ${describeEndpoint(url)} must use https (plain http is accepted for localhost only)`,
    );
  }
  return {
    url,
    headers: {
      ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS, "OTEL_EXPORTER_OTLP_HEADERS"),
      ...parseHeaders(env.OTEL_EXPORTER_OTLP_TRACES_HEADERS, "OTEL_EXPORTER_OTLP_TRACES_HEADERS"),
    },
    timeoutMs: parseTimeout(
      nonEmpty(env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT) ?? nonEmpty(env.OTEL_EXPORTER_OTLP_TIMEOUT),
    ),
  };
}

/** The endpoint for messages: origin and path, never the query (it may hold a key). */
export function describeEndpoint(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,256}$/;
const FORBIDDEN_HEADERS = new Set(["content-type", "content-length", "host", "transfer-encoding"]);

function parseHeaders(value: string | undefined, variable: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (value === undefined || value.trim() === "") return headers;
  for (const part of value.split(",")) {
    if (part.trim() === "") continue;
    const separator = part.indexOf("=");
    const name = part.slice(0, separator).trim();
    let decoded: string;
    try {
      decoded = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      throw refused(`${variable} has a value that is not URL-encoded correctly`);
    }
    // The header's value is never put in a message: it is often a credential.
    if (separator <= 0 || !HEADER_NAME.test(name) || /[\r\n\0]/.test(decoded)) {
      throw refused(`${variable} must be a list of key=value pairs separated by commas`);
    }
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw refused(`${variable} must not set the ${name} header`);
    }
    headers[name] = decoded;
  }
  return headers;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_OTLP_TIMEOUT_MS;
  const parsed = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw refused("the OTLP timeout must be a positive number of milliseconds");
  }
  return Math.min(parsed, 120_000);
}

export interface SendOtlpOptions {
  /** Default: the global `fetch`. */
  readonly fetch?: typeof fetch;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
}

export interface OtlpSendResult {
  /** The endpoint, without its query. */
  readonly endpoint: string;
  readonly status: number;
  readonly spans: number;
  /** Spans the collector reported as rejected (`partialSuccess`). */
  readonly rejectedSpans: number;
}

/**
 * POSTs an OTLP/JSON trace request. Redirects are refused (the data must not go anywhere the
 * user did not name). The response body is read only for `partialSuccess`, up to 64 KiB.
 *
 * @throws DevflowError `TRACE_EXPORT_FAILED` for a body over the size cap, a timeout, a
 * network failure or a non-2xx status. The messages never contain header values.
 */
export async function sendOtlpTrace(
  request: OtlpTraceRequest,
  endpoint: OtlpEndpoint,
  options: SendOtlpOptions = {},
): Promise<OtlpSendResult> {
  const where = describeEndpoint(endpoint.url);
  const body = JSON.stringify(request);
  const bytes = Buffer.byteLength(body, "utf8");
  const maxBytes = options.maxBytes ?? DEFAULT_OTLP_MAX_BYTES;
  if (bytes > maxBytes) {
    throw failed(
      `the trace is ${String(bytes)} bytes, more than the ${String(maxBytes)} bytes DevFlow sends; it was not sent to ${where}`,
    );
  }
  const timeout = AbortSignal.timeout(endpoint.timeoutMs);
  const signal =
    options.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
  let response: Response;
  try {
    response = await (options.fetch ?? globalThis.fetch)(endpoint.url, {
      method: "POST",
      headers: { ...endpoint.headers, "content-type": "application/json" },
      body,
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (timeout.aborted) {
      throw failed(`${where} did not answer within ${String(endpoint.timeoutMs)} ms`);
    }
    const reason = error instanceof Error ? error.name : "error";
    throw failed(`the trace could not be sent to ${where} (${reason})`);
  }
  let text = "";
  try {
    text = (await response.text()).slice(0, 65_536);
  } catch {
    // The status is what matters; an unreadable body is ignored.
  }
  if (!response.ok) {
    throw failed(`${where} answered HTTP ${String(response.status)}`);
  }
  const spans = request.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0;
  return { endpoint: where, status: response.status, spans, rejectedSpans: rejectedSpans(text) };
}

const PartialSuccess = z.object({
  partialSuccess: z
    .object({ rejectedSpans: z.union([z.string(), z.number()]).optional() })
    .optional(),
});

function rejectedSpans(text: string): number {
  if (text.trim() === "") return 0;
  try {
    const parsed = PartialSuccess.safeParse(JSON.parse(text));
    const value = parsed.success ? parsed.data.partialSuccess?.rejectedSpans : undefined;
    const count = Number(value ?? 0);
    return Number.isSafeInteger(count) && count > 0 ? count : 0;
  } catch {
    return 0;
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function refused(message: string): DevflowError {
  return new DevflowError(ErrorCode.TraceExportRefused, message);
}

function failed(message: string): DevflowError {
  return new DevflowError(ErrorCode.TraceExportFailed, message);
}
