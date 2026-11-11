import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { FakeProvider, type FakeReply } from "@devflow/ai";
import { DEVFLOW_TOOL_NAMES } from "@devflow/mcp";
import type { LlmRequest } from "@devflow/core";
import { describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/**
 * `devflow mcp` in-process: the real command line behind each tool, a scripted model behind
 * the provider, and an MCP client speaking newline-delimited JSON-RPC to the server's stdin
 * and stdout.
 */

const TASK_YAML = `schemaVersion: 1
id: TASK-7
title: Paginate the order list
description: listOrders must return one page of orders.
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

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-mcp-cli-")));
  const files: Record<string, string> = {
    "package.json": '{ "name": "shop", "type": "module" }\n',
    "src/orders.ts":
      "export function listOrders(orders: unknown[]): unknown[] {\n  return orders;\n}\n",
    "tasks/TASK-7.yaml": TASK_YAML,
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function analysis(questions: { question: string; blocking: boolean; relatedIds: string[] }[] = []) {
  return JSON.stringify({
    summary: "Add page and size parameters to listOrders.",
    requirementNotes: [{ id: "FR-1", interpretation: "Slice by page and size.", concerns: [] }],
    questions,
    assumptions: [],
    risks: [],
    edgeCases: [],
    contradictions: [],
    dependencies: [],
    affectedFiles: [{ path: "src/orders.ts", reason: "Defines listOrders." }],
  });
}

const PLAN = JSON.stringify({
  summary: "Paginate listOrders.",
  approach: "Add optional page and size parameters and slice the array.",
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
      approach: "Call listOrders with 25 orders.",
      targetFile: "src/orders.test.ts",
    },
  ],
  risks: [],
  regressionWatch: [],
  openQuestions: [],
});

function model(analyses: FakeReply[] = [analysis()]): FakeProvider {
  const queue = [...analyses];
  return new FakeProvider((request: LlmRequest) => {
    if (!request.system.includes("requirements analyst")) return PLAN;
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error("no scripted reply");
    return reply;
  });
}

type Json = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

/** An MCP client connected to `devflow mcp` running in-process. */
async function connect(cwd: string, provider: FakeProvider = model()) {
  const stdin = new PassThrough();
  let stdout = "";
  let stderr = "";
  const waiting = new Map<number, (message: Json) => void>();
  const lines: string[] = [];
  const io: CliIo = {
    stdout: {
      write: (text) => {
        stdout += text;
        let newline = stdout.indexOf("\n");
        while (newline >= 0) {
          const line = stdout.slice(0, newline);
          stdout = stdout.slice(newline + 1);
          lines.push(line);
          const message = JSON.parse(line) as Json;
          waiting.get(Number(message.id))?.(message);
          newline = stdout.indexOf("\n");
        }
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    cwd,
    stdin,
    // The real PATH, so that verify finds node; the home and user are the test's own.
    env: { ...process.env, DEVFLOW_HOME: `${cwd}-home`, DEVFLOW_USER: "mohamed", NO_COLOR: "1" },
    createProvider: () => Promise.resolve(provider),
  };
  const exited = runCli(["mcp"], io);
  let next = 1;
  const request = (method: string, params?: Json): Promise<Json> => {
    const id = next++;
    const answer = new Promise<Json>((resolve) => waiting.set(id, resolve));
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
    );
    return answer;
  };
  const call = async (name: string, args: Json): Promise<Json> => {
    const response = await request("tools/call", { name, arguments: args });
    return response.result as Json;
  };
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1" },
  });
  stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const close = async (): Promise<{ code: ExitCode; lines: string[]; stderr: string }> => {
    stdin.end();
    const code = await exited;
    return { code, lines, stderr };
  };
  return { init, request, call, close, io };
}

function structured(result: Json): Json {
  return result.structuredContent as Json;
}

// Each scenario runs several commands; the default 5 s is too tight on a loaded machine.
describe("devflow mcp (in-process)", { timeout: 30_000 }, () => {
  it("initializes as devflow and lists only the reviewed tools", async () => {
    const client = await connect(await workspace());
    expect(client.init.result).toMatchObject({
      protocolVersion: "2025-06-18",
      serverInfo: { name: "devflow", version: "0.0.0" },
      capabilities: { tools: {} },
    });
    const listed = (await client.request("tools/list")).result as { tools: Json[] };
    const names = listed.tools.map((tool) => tool.name);
    expect(names).toEqual([...DEVFLOW_TOOL_NAMES]);
    for (const absent of [
      "devflow_trust",
      "devflow_approve",
      "devflow_reject",
      "devflow_pr_create",
      "devflow_publish",
      "devflow_resume",
    ]) {
      expect(names).not.toContain(absent);
    }
    const closed = await client.close();
    expect(closed.code).toBe(ExitCode.Success);
    expect(closed.stderr).toContain("serving the DevFlow tools on stdio");
  });

  it.each([
    "examples/tasks/add-pagination.task.yaml",
    "examples/tasks/add-pagination.task.md",
    "examples/tasks/export-orders-csv.task.json",
  ])("validates %s", async (file) => {
    const client = await connect(repoRoot);
    const result = await client.call("devflow_task_validate", { path: file });
    expect(result.isError).toBe(false);
    expect(structured(result)).toMatchObject({
      exitCode: 0,
      workspace: repoRoot,
      result: { valid: true, errorCount: 0 },
    });
    await client.close();
  });

  it("reports an invalid task file as a result, a missing one as a tool error", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "bad.yaml"), "schemaVersion: 1\nid: x\n");
    const client = await connect(root);
    const invalid = await client.call("devflow_task_validate", { path: "bad.yaml" });
    expect(invalid.isError).toBe(false);
    expect(structured(invalid)).toMatchObject({ exitCode: 1, result: { valid: false } });
    const missing = await client.call("devflow_task_validate", { path: "missing.yaml" });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing)).toContain("TASK_FILE_NOT_FOUND");
    await client.close();
  });

  it("plans with a scripted model, leaves the approval to the developer, then reports", async () => {
    const root = await workspace();
    const client = await connect(root);
    const planned = await client.call("devflow_plan", {
      workspace: root,
      task: "tasks/TASK-7.yaml",
      provider: "fake",
      model: "test-model",
    });
    expect(planned.isError).toBe(false);
    const outcome = structured(planned);
    expect(outcome).toMatchObject({
      exitCode: ExitCode.WaitingForInput,
      result: { status: "waiting", waitingFor: "plan-approval", state: "AWAITING_PLAN_APPROVAL" },
    });
    const runId = String((outcome.result as Json).runId);
    expect((outcome.nextSteps as string[]).join("\n")).toContain(`devflow approve ${runId}`);
    expect(String((planned.content as Json[])[0]?.text)).toContain("in a terminal");

    const status = await client.call("devflow_status", { run: runId });
    expect(structured(status)).toMatchObject({
      result: { runId, status: "waiting", record: { goal: "plan" } },
    });
    const list = await client.call("devflow_status", {});
    expect(JSON.stringify(structured(list).result)).toContain(runId);

    const early = await client.call("devflow_report", { run: runId });
    expect(structured(early)).toMatchObject({ exitCode: 1, result: { report: null } });

    // The developer approves in a terminal; the MCP server has no tool for it.
    const approved = await runCli(["approve", runId, "--json"], {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      cwd: root,
      env: client.io.env,
    });
    expect(approved).toBe(ExitCode.Success);

    const report = await client.call("devflow_report", { run: runId });
    expect(report.isError).toBe(false);
    expect(structured(report)).toMatchObject({
      exitCode: 0,
      result: { verdict: "not_verified" },
    });

    const closed = await client.close();
    // stdout carried protocol messages only: every line is a JSON-RPC response.
    for (const line of closed.lines) {
      expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    }
    expect(closed.lines.join("\n")).not.toContain("Analysing the requirements...");
  });

  it("relays the developer's answers, recorded as given via MCP", async () => {
    const root = await workspace();
    const client = await connect(
      root,
      model([
        analysis([{ question: "Do pages start at 0 or 1?", blocking: true, relatedIds: ["FR-1"] }]),
        analysis(),
      ]),
    );
    const analysed = await client.call("devflow_analyze", {
      task: "tasks/TASK-7.yaml",
      provider: "fake",
      model: "test-model",
    });
    const outcome = structured(analysed);
    expect(outcome).toMatchObject({
      exitCode: ExitCode.WaitingForInput,
      result: { waitingFor: "clarification" },
    });
    const runId = String((outcome.result as Json).runId);
    const questions = (outcome.result as { questions: { id: string }[] }).questions;
    expect((outcome.nextSteps as string[]).join("\n")).toContain("never answer them yourself");

    const answered = await client.call("devflow_answer", {
      run: runId,
      answers: { [questions[0]?.id ?? "Q-1"]: "Pages start at 1" },
      provider: "fake",
      model: "test-model",
    });
    expect(structured(answered)).toMatchObject({ result: { status: "completed" } });
    await client.close();
    const audit = await readFile(path.join(root, ".devflow", "runs", runId, "audit.jsonl"), "utf8");
    expect(audit).toContain('"by":"mohamed (via MCP)"');
  });

  it("runs no command the developer has not approved, and says how the developer approves it", async () => {
    const root = await workspace();
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        name: "shop",
        type: "module",
        devDependencies: { vitest: "^5.1.0" },
      }),
      "src/orders.test.js": 'import { it } from "vitest";\nit("AC-1: pages", () => {});\n',
      "node_modules/vitest/package.json": JSON.stringify({
        name: "vitest",
        version: "5.1.0",
        type: "module",
        bin: { vitest: "vitest.mjs" },
      }),
      // Would leave a marker if it ever ran.
      "node_modules/vitest/vitest.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync("ran.txt", "ran");\n',
    };
    for (const [relative, content] of Object.entries(files)) {
      const absolute = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    }
    const client = await connect(root);

    const untrusted = structured(await client.call("devflow_verify", {}));
    expect(untrusted).toMatchObject({
      exitCode: ExitCode.PolicyDenied,
      result: { outcome: "denied", denials: [{ reason: "workspace-untrusted" }] },
    });
    expect((untrusted.nextSteps as string[]).join("\n")).toContain("devflow trust");

    // The developer trusts the workspace in a terminal.
    const trusted = await runCli(["trust", "--yes"], {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
      cwd: root,
      env: client.io.env,
    });
    expect(trusted).toBe(ExitCode.Success);

    const unapproved = structured(await client.call("devflow_verify", {}));
    expect(unapproved).toMatchObject({
      exitCode: ExitCode.PolicyDenied,
      result: { outcome: "denied", denials: [{ reason: "approval-required" }] },
    });
    const denials = (unapproved.result as { denials: { fingerprint?: string }[] }).denials;
    const fingerprint = denials[0]?.fingerprint ?? "";
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect((unapproved.nextSteps as string[]).join("\n")).toContain(
      `devflow verify --allow ${fingerprint}`,
    );
    await client.close();
    await expect(readFile(path.join(root, "ran.txt"), "utf8")).rejects.toThrow();
  });
});
