import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/** `devflow agent show` and `devflow agent answer` (ADR 0027), in a terminal. */

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

async function workspace(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-agent-cli-")));
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

async function devflow(
  root: string,
  args: string[],
): Promise<{ code: ExitCode; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: {
      write: (text) => {
        stderr += text;
      },
    },
    cwd: root,
    env: { DEVFLOW_HOME: `${root}-home`, DEVFLOW_USER: "mohamed", NO_COLOR: "1" },
    createProvider: () => Promise.reject(new Error("agent mode asked another provider")),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

describe("devflow agent (ADR 0027)", { timeout: 30_000 }, () => {
  it("shows the request, refuses wrong answers and continues the run with a good one", async () => {
    const root = await workspace();
    const started = await devflow(root, [
      "analyze",
      "--task",
      "tasks/TASK-7.yaml",
      "--provider",
      "agent",
    ]);
    expect(started.code).toBe(ExitCode.WaitingForInput);
    expect(started.stdout).toContain("devflow agent show");
    expect(started.stdout).not.toContain("API key");

    const listed = JSON.parse((await devflow(root, ["status", "--json"])).stdout) as {
      runs: { id: string }[];
    };
    const runId = listed.runs[0]?.id ?? "";
    const shown = await devflow(root, ["agent", "show", runId]);
    expect(shown.code).toBe(ExitCode.Success);
    expect(shown.stdout).toContain("## JSON schema");
    expect(shown.stdout).toContain("TASK-7");
    const json = JSON.parse((await devflow(root, ["agent", "show", runId, "--json"])).stdout) as {
      requestId: string;
      format: string;
    };
    expect(json.requestId).toMatch(/^[0-9a-f]{64}$/);

    const wrongId = await devflow(root, [
      "agent",
      "answer",
      runId,
      "--request",
      "f".repeat(64),
      "--text",
      ANALYSIS,
      "--json",
    ]);
    expect(wrongId.code).not.toBe(ExitCode.Success);
    expect(wrongId.stdout).toContain("AGENT_ANSWER_INVALID");

    const both = await devflow(root, [
      "agent",
      "answer",
      runId,
      "--request",
      json.requestId,
      "--text",
      ANALYSIS,
      "--file",
      "answer.json",
      "--json",
    ]);
    expect(both.stdout).toContain("give exactly one of --file or --text");

    const prose = await devflow(root, [
      "agent",
      "answer",
      runId,
      "--request",
      json.requestId,
      "--text",
      "Here is the analysis.",
      "--json",
    ]);
    expect(prose.stdout).toContain("must be JSON matching");

    await writeFile(path.join(root, "answer.json"), ANALYSIS);
    const answered = await devflow(root, [
      "agent",
      "answer",
      runId,
      "--request",
      json.requestId,
      "--file",
      "answer.json",
      "--json",
    ]);
    expect(answered.code).toBe(ExitCode.Success);
    expect(JSON.parse(answered.stdout)).toMatchObject({ runId, status: "completed" });

    const late = await devflow(root, ["agent", "show", runId, "--json"]);
    expect(late.stdout).toContain("RUN_NOT_AWAITING_INPUT");
  });
});
