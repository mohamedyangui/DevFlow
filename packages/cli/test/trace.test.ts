import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { FakeProvider, type FakeReply } from "@devflow/ai";
import { OtlpTraceRequest } from "@devflow/workflow";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/** `--trace`, `DEVFLOW_TRACE_EXPORT` and `devflow trace` (ADR 0024). */

const SECRET = "sk-test-TRACESECRETVALUE-0123456789";
const DESCRIPTION_MARKER = "DESCRIPTION-MARKER-6604";

const TASK_YAML = `schemaVersion: 1
id: TASK-7
title: Paginate the order list
description: listOrders must return one page of orders. ${DESCRIPTION_MARKER}
requirements:
  functional:
    - id: FR-1
      text: listOrders accepts page and size
acceptanceCriteria:
  - id: AC-1
    statement: Page 2 with size 10 returns orders 11 to 20
    covers: [FR-1]
testing:
  levels: [unit]
`;

const REPO: Readonly<Record<string, string>> = {
  "package.json": '{ "name": "shop", "type": "module" }\n',
  "src/orders.ts": "export function listOrders(orders: unknown[]) {\n  return orders;\n}\n",
  "src/settings.ts": `export const apiKey = "${SECRET}";\n`,
  "tasks/TASK-7.yaml": TASK_YAML,
};

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-trace-")));
  for (const [relative, content] of Object.entries(REPO)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

const ANALYSIS = JSON.stringify({
  summary: "Add page and size parameters to listOrders.",
  requirementNotes: [{ id: "FR-1", interpretation: "Slice by page and size.", concerns: [] }],
  questions: [],
  assumptions: [],
  risks: [],
  edgeCases: [],
  contradictions: [],
  dependencies: [],
  affectedFiles: [{ path: "src/orders.ts", reason: "Defines listOrders." }],
});

const PLAN = JSON.stringify({
  summary: "Paginate listOrders.",
  approach: "Slice the array.",
  relevantFiles: [{ path: "src/orders.ts", reason: "Defines listOrders." }],
  changes: [
    {
      module: null,
      path: "src/orders.ts",
      action: "modify",
      description: "Change it.",
      satisfies: ["FR-1", "AC-1"],
    },
  ],
  interfaceChanges: [],
  testStrategy: [
    {
      acId: "AC-1",
      level: "unit",
      intent: "feature",
      approach: "Call listOrders.",
      targetFile: "src/orders.test.ts",
    },
  ],
  risks: [],
  regressionWatch: [],
  openQuestions: [],
});

function model(): FakeProvider {
  return new FakeProvider((request): FakeReply =>
    request.system.includes("requirements analyst") ? ANALYSIS : PLAN,
  );
}

interface Result {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(cwd: string, args: string[], env: Record<string, string> = {}): Promise<Result> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: {
      write: (chunk) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk) => {
        stderr += chunk;
      },
    },
    cwd,
    env: {
      DEVFLOW_HOME: `${cwd}-home`,
      DEVFLOW_USER: "mohamed",
      ANTHROPIC_API_KEY: SECRET,
      ...env,
    },
    createProvider: () => Promise.resolve(model()),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

function json(result: Result): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

const servers: { close(): void }[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function receiver(status = 200): Promise<{ url: string; bodies: string[] }> {
  const bodies: string[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push({
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  });
  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, bodies };
}

const ANALYZE = ["analyze", "--task", "tasks/TASK-7.yaml", "--model", "test-model", "--json"];

function expectClean(text: string): void {
  for (const forbidden of [SECRET, DESCRIPTION_MARKER, "Paginate the order list", "listOrders"]) {
    expect(text).not.toContain(forbidden);
  }
}

describe("trace export after a run", () => {
  it("is off by default", async () => {
    const root = await workspace();
    const result = await cli(root, ANALYZE);
    expect(result.code).toBe(ExitCode.Success);
    const runId = String(json(result).runId);
    expect(json(result).trace).toBeUndefined();
    expect(await readdir(path.join(root, ".devflow", "runs", runId))).not.toContain(
      "trace.otlp.json",
    );
  });

  it("--trace file writes trace.otlp.json in the run directory, metadata only", async () => {
    const root = await workspace();
    const result = await cli(root, [...ANALYZE, "--trace", "file"]);
    expect(result.code, result.stdout + result.stderr).toBe(ExitCode.Success);
    const output = json(result);
    const runId = String(output.runId);
    expect(output.trace).toMatchObject({
      file: `.devflow/runs/${runId}/trace.otlp.json`,
      warnings: [],
    });
    const text = await readFile(
      path.join(root, ".devflow", "runs", runId, "trace.otlp.json"),
      "utf8",
    );
    const request = OtlpTraceRequest.parse(JSON.parse(text));
    const spans = request.resourceSpans[0]?.scopeSpans[0]?.spans ?? [];
    expect(spans.map((span) => span.name)).toEqual([
      "devflow assist",
      "step context-loading",
      "step requirements-analysis",
      "chat test-model",
    ]);
    expectClean(text);
  });

  it("DEVFLOW_TRACE_EXPORT=otlp sends the trace to the user's endpoint", async () => {
    const root = await workspace();
    const { url, bodies } = await receiver();
    const result = await cli(root, ANALYZE, {
      DEVFLOW_TRACE_EXPORT: "otlp",
      OTEL_EXPORTER_OTLP_ENDPOINT: url,
    });
    expect(result.code, result.stdout + result.stderr).toBe(ExitCode.Success);
    expect(json(result).trace).toMatchObject({
      sent: { endpoint: `${url}/v1/traces`, status: 200 },
      warnings: [],
    });
    expect(bodies).toHaveLength(1);
    OtlpTraceRequest.parse(JSON.parse(bodies[0] ?? ""));
    expectClean(bodies[0] ?? "");
  });

  it("a failed send is a warning: the run still succeeds", async () => {
    const root = await workspace();
    const { url } = await receiver(500);
    const result = await cli(root, [...ANALYZE.slice(0, -1), "--trace", "otlp"], {
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${url}/v1/traces`,
    });
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain("State:  COMPLETED");
    expect(result.stdout).toContain(
      `Trace warning: the trace was not sent: ${url}/v1/traces answered HTTP 500`,
    );
  });

  it("refuses a plain-http remote endpoint before the run starts", async () => {
    const root = await workspace();
    const result = await cli(root, [...ANALYZE, "--trace", "otlp"], {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example.com:4318",
    });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(json(result).error).toMatchObject({ code: "TRACE_EXPORT_REFUSED" });
    await expect(readdir(path.join(root, ".devflow", "runs"))).rejects.toThrow();
  });

  it("waits for the run to finish: plan, then approve", async () => {
    const root = await workspace();
    const plan = await cli(
      root,
      ["plan", "--task", "tasks/TASK-7.yaml", "--model", "test-model", "--json"],
      { DEVFLOW_TRACE_EXPORT: "file" },
    );
    expect(plan.code).toBe(ExitCode.WaitingForInput);
    const runId = String(json(plan).runId);
    expect(json(plan).trace).toMatchObject({
      pending: expect.stringContaining("AWAITING_PLAN_APPROVAL") as unknown,
    });
    const approve = await cli(root, ["approve", runId, "--json"], { DEVFLOW_TRACE_EXPORT: "file" });
    expect(approve.code, approve.stdout).toBe(ExitCode.Success);
    expect(json(approve).trace).toMatchObject({ file: `.devflow/runs/${runId}/trace.otlp.json` });
  });
});

describe("devflow trace", () => {
  it("exports a finished run to the run directory, a file or an OTLP endpoint", async () => {
    const root = await workspace();
    const runId = String(json(await cli(root, ANALYZE)).runId);

    const plain = await cli(root, ["trace", runId]);
    expect(plain.code, plain.stderr).toBe(ExitCode.Success);
    expect(plain.stdout).toContain(`span(s) to .devflow/runs/${runId}/trace.otlp.json`);

    const output = await cli(root, ["trace", runId, "--output", "out/trace.json", "--json"]);
    expect(output.code).toBe(ExitCode.Success);
    expect(json(output)).toMatchObject({ file: path.join(root, "out", "trace.json"), spans: 4 });
    const text = await readFile(path.join(root, "out", "trace.json"), "utf8");
    expect(text).toBe(
      await readFile(path.join(root, ".devflow", "runs", runId, "trace.otlp.json"), "utf8"),
    );

    const { url, bodies } = await receiver();
    const sent = await cli(root, ["trace", runId, "--otlp"], { OTEL_EXPORTER_OTLP_ENDPOINT: url });
    expect(sent.code, sent.stderr).toBe(ExitCode.Success);
    expect(sent.stdout).toBe(`Sent 4 span(s) to ${url}/v1/traces\n`);
    expect(JSON.parse(bodies[0] ?? "")).toEqual(JSON.parse(text));
  });

  it("fails when the endpoint is refused or the send fails", async () => {
    const root = await workspace();
    const runId = String(json(await cli(root, ANALYZE)).runId);
    const refused = await cli(root, ["trace", runId, "--otlp"]);
    expect(refused.code).toBe(ExitCode.UsageError);
    expect(refused.stderr).toContain("TRACE_EXPORT_REFUSED");
    const { url } = await receiver(503);
    const failed = await cli(root, ["trace", runId, "--otlp"], {
      OTEL_EXPORTER_OTLP_ENDPOINT: url,
    });
    expect(failed.code).toBe(ExitCode.Failure);
    expect(failed.stderr).toContain("answered HTTP 503");
    const unknown = await cli(root, ["trace", "2026-11-07T10-00-00Z_NOPE"]);
    expect(unknown.code).toBe(ExitCode.UsageError);
  });
});
