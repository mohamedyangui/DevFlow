import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { DevflowError, ErrorCode, SecretRedactor } from "@devflowai/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  type OtlpEndpoint,
  OtlpTraceRequest,
  RunStore,
  TRACE_FILE,
  buildRunTrace,
  exportRunTrace,
  parseTraceTargets,
  resolveOtlpEndpoint,
  resolveTraceExport,
  sendOtlpTrace,
  startRun,
  toOtlpRequest,
  traceRedactor,
} from "../src/index.js";
import { scripted, services, settings, task, workspace } from "./helpers.js";

interface Received {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** A local OTLP/HTTP receiver. */
async function receiver(
  answer: (request: Received, response: ServerResponse) => void = (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  },
): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      received.push(entry);
      answer(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, received };
}

function smallRequest(): OtlpTraceRequest {
  return toOtlpRequest(
    buildRunTrace(
      {
        record: {
          schemaVersion: 1,
          id: "2026-11-07T10-00-00Z_TASK-7",
          devflowVersion: "0.6.0",
          mode: "assist",
          goal: "analyze",
          state: "COMPLETED",
          createdAt: "2026-11-07T10:00:00.000Z",
          updatedAt: "2026-11-07T10:01:00.000Z",
          finishedAt: "2026-11-07T10:01:00.000Z",
          task: { id: "TASK-7", title: "t", file: null, sha256: "a".repeat(64) },
          settings: settings(),
          budgetUsage: { calls: 0, inputTokens: 0, outputTokens: 0, callsByStep: {} },
          iterations: { analysis: 1, planning: 0 },
          pending: null,
          lastError: null,
          warnings: [],
        },
        events: [],
        audit: [],
        gates: new Map(),
      },
      new SecretRedactor(),
    ),
  );
}

function endpoint(url: string, overrides: Partial<OtlpEndpoint> = {}): OtlpEndpoint {
  return { url: new URL(`${url}/v1/traces`), headers: {}, timeoutMs: 5_000, ...overrides };
}

async function failure(promise: Promise<unknown>): Promise<DevflowError> {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  expect(error).toBeInstanceOf(DevflowError);
  return error as DevflowError;
}

function refusal(run: () => unknown): DevflowError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DevflowError);
    expect((error as DevflowError).code).toBe(ErrorCode.TraceExportRefused);
    return error as DevflowError;
  }
  throw new Error("expected a refusal");
}

describe("resolveOtlpEndpoint", () => {
  it("uses the traces endpoint as given, else appends /v1/traces to the base endpoint", () => {
    expect(
      resolveOtlpEndpoint({
        OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "https://otel.example.com/custom",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://ignored.example.com",
      }).url.href,
    ).toBe("https://otel.example.com/custom");
    const resolved = resolveOtlpEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com:4318/",
    });
    expect(resolved.url.href).toBe("https://otel.example.com:4318/v1/traces");
    expect(resolved.timeoutMs).toBe(10_000);
  });

  it("accepts plain http only for localhost", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: `http://${host}:4318` }).url.protocol,
      ).toBe("http:");
    }
    for (const url of [
      "http://otel.example.com:4318",
      "http://10.0.0.5:4318",
      "http://localhost.example.com",
      "ftp://otel.example.com",
    ]) {
      expect(
        refusal(() => resolveOtlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: url })).message,
      ).toMatch(/must use https/);
    }
  });

  it("refuses a missing endpoint, credentials in the URL and malformed headers or timeouts", () => {
    expect(refusal(() => resolveOtlpEndpoint({})).message).toMatch(/no OTLP endpoint/);
    expect(
      refusal(() =>
        resolveOtlpEndpoint({
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:hunter2pass@otel.example.com",
        }),
      ).message,
    ).not.toContain("hunter2pass");
    const header = refusal(() =>
      resolveOtlpEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization",
      }),
    );
    expect(header.message).toMatch(/key=value/);
    const crlf = refusal(() =>
      resolveOtlpEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
        OTEL_EXPORTER_OTLP_HEADERS: "x-key=abc%0D%0Ainjected-header-value",
      }),
    );
    expect(crlf.message).not.toContain("injected-header-value");
    refusal(() =>
      resolveOtlpEndpoint({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
        OTEL_EXPORTER_OTLP_TIMEOUT: "soon",
      }),
    );
  });

  it("reads URL-encoded headers, the traces headers winning, and the timeout", () => {
    const resolved = resolveOtlpEndpoint({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20abc,x-tenant=one",
      OTEL_EXPORTER_OTLP_TRACES_HEADERS: "x-tenant=two",
      OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: "2500",
    });
    expect(resolved.headers).toEqual({ Authorization: "Bearer abc", "x-tenant": "two" });
    expect(resolved.timeoutMs).toBe(2500);
  });
});

describe("trace export settings", () => {
  it("is off unless the user turns it on; the flag wins over DEVFLOW_TRACE_EXPORT", () => {
    expect(resolveTraceExport(undefined, {})).toBeUndefined();
    expect(resolveTraceExport(undefined, { DEVFLOW_TRACE_EXPORT: "off" })).toBeUndefined();
    expect(resolveTraceExport(undefined, { DEVFLOW_TRACE_EXPORT: "file" })).toEqual({ file: true });
    expect(resolveTraceExport("off", { DEVFLOW_TRACE_EXPORT: "file" })).toBeUndefined();
    const both = resolveTraceExport("file,otlp", {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318",
    });
    expect(both?.file).toBe(true);
    expect(both?.otlp?.url.href).toBe("http://localhost:4318/v1/traces");
    expect(parseTraceTargets(" OTLP , file ", "--trace")).toEqual(["file", "otlp"]);
    refusal(() => parseTraceTargets("stdout", "--trace"));
    refusal(() => resolveTraceExport("otlp", {}));
  });

  it("redacts the OTLP header values as known secrets", () => {
    const plan = resolveTraceExport("otlp", {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.com",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api=plainheadervalue123",
    });
    expect(traceRedactor({}, plan).redactText("plainheadervalue123")).toMatch(/^«REDACTED/);
  });
});

describe("sendOtlpTrace", () => {
  it("POSTs the OTLP/JSON request with the configured headers", async () => {
    const { url, received } = await receiver();
    const request = smallRequest();
    const result = await sendOtlpTrace(
      request,
      endpoint(url, { headers: { Authorization: "Bearer abc" } }),
    );
    expect(result).toEqual({
      endpoint: `${url}/v1/traces`,
      status: 200,
      spans: 1,
      rejectedSpans: 0,
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.url).toBe("/v1/traces");
    expect(received[0]?.headers["content-type"]).toBe("application/json");
    expect(received[0]?.headers.authorization).toBe("Bearer abc");
    expect(OtlpTraceRequest.parse(JSON.parse(received[0]?.body ?? ""))).toEqual(request);
  });

  it("reports spans the collector rejected", async () => {
    const { url } = await receiver((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"partialSuccess":{"rejectedSpans":"1","errorMessage":"no"}}');
    });
    expect((await sendOtlpTrace(smallRequest(), endpoint(url))).rejectedSpans).toBe(1);
  });

  it("fails on an HTTP error, without the header values in the message", async () => {
    const { url } = await receiver((_request, response) => {
      response.writeHead(401);
      response.end("bad token");
    });
    const error = await failure(
      sendOtlpTrace(
        smallRequest(),
        endpoint(url, { headers: { Authorization: "Bearer topsecretheader" } }),
      ),
    );
    expect(error.code).toBe(ErrorCode.TraceExportFailed);
    expect(error.message).toContain("HTTP 401");
    expect(error.message).not.toContain("topsecretheader");
  });

  it("gives up after the timeout", async () => {
    const { url, received } = await receiver(() => {
      // Never answers.
    });
    const started = Date.now();
    const error = await failure(sendOtlpTrace(smallRequest(), endpoint(url, { timeoutMs: 200 })));
    expect(error.code).toBe(ErrorCode.TraceExportFailed);
    expect(error.message).toMatch(/did not answer within 200 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(received).toHaveLength(1);
  });

  it("does not send a body over the size cap", async () => {
    const { url, received } = await receiver();
    const error = await failure(sendOtlpTrace(smallRequest(), endpoint(url), { maxBytes: 100 }));
    expect(error.message).toMatch(/was not sent/);
    expect(received).toHaveLength(0);
  });

  it("does not follow a redirect", async () => {
    const target = await receiver();
    const { url } = await receiver((_request, response) => {
      response.writeHead(307, { location: `${target.url}/v1/traces` });
      response.end();
    });
    const error = await failure(sendOtlpTrace(smallRequest(), endpoint(url)));
    expect(error.code).toBe(ErrorCode.TraceExportFailed);
    expect(target.received).toHaveLength(0);
  });
});

describe("exportRunTrace", () => {
  async function finishedRun(): Promise<RunStore> {
    const root = await workspace();
    const outcome = await startRun(
      {
        task: task(),
        taskFile: "tasks/TASK-7.yaml",
        mode: "assist",
        goal: "analyze",
        settings: settings(),
      },
      await services(root, scripted({})),
    );
    expect(outcome.status).toBe("completed");
    return RunStore.open(root, outcome.runId);
  }

  it("writes the file in the run directory and sends the same request", async () => {
    const store = await finishedRun();
    const { url, received } = await receiver();
    const result = await exportRunTrace(
      store,
      { file: true, otlp: endpoint(url) },
      { redactor: new SecretRedactor() },
    );
    expect(result.warnings).toEqual([]);
    expect(result.file).toBe(store.workspacePath(TRACE_FILE));
    const written = OtlpTraceRequest.parse(JSON.parse(await store.readText(TRACE_FILE)));
    expect(JSON.parse(received[0]?.body ?? "")).toEqual(written);
    expect(result.spans).toBe(written.resourceSpans[0]?.scopeSpans[0]?.spans.length);
  });

  it("turns every failure into a warning", async () => {
    const store = await finishedRun();
    const { url } = await receiver((_request, response) => {
      response.writeHead(503);
      response.end();
    });
    const result = await exportRunTrace(
      store,
      { file: true, otlp: endpoint(url) },
      { redactor: new SecretRedactor() },
    );
    expect(result.file).toBeDefined();
    expect(result.sent).toBeUndefined();
    expect(result.warnings).toEqual([
      `the trace was not sent: ${url}/v1/traces answered HTTP 503 [TRACE_EXPORT_FAILED]`,
    ]);
  });
});
