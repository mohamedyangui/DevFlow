import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeProvider } from "@devflow/ai";
import type { LlmRequest } from "@devflow/core";
import { describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/**
 * `devflow test` through the command line, with the real language adapters. The workspace is
 * not trusted, so the command policy refuses to run anything: these tests never execute a
 * command, and check that model-written tests run only after a person approved them.
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

const REPO: Readonly<Record<string, string>> = {
  "package.json": JSON.stringify(
    {
      name: "shop",
      type: "module",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^3.2.0", typescript: "^5.8.0" },
    },
    null,
    2,
  ),
  "src/orders.ts": [
    "export interface Order { id: string; total: number }",
    "",
    "export function listOrders(orders: Order[]): Order[] {",
    "  return orders;",
    "}",
    "",
  ].join("\n"),
  "src/orders.test.ts": [
    'import { expect, it } from "vitest";',
    'import { listOrders } from "./orders";',
    "",
    'it("returns every order", () => {',
    "  expect(listOrders([])).toEqual([]);",
    "});",
    "",
  ].join("\n"),
  "tasks/TASK-7.yaml": TASK_YAML,
  // Stands in for an installed vitest, so that the command passes the executable checks. It
  // never runs: the workspace is not trusted.
  "node_modules/vitest/vitest.mjs": "throw new Error('must not run');\n",
};

const TEST_FILE = "src/pagination.test.ts";
const TEST_CONTENT = [
  'import { expect, it } from "vitest";',
  'import { listOrders } from "./orders";',
  "",
  'it("AC-1: page 2 with size 10 returns orders 11 to 20", () => {',
  "  const orders = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), total: 1 }));",
  "  expect(listOrders(orders, 2, 10)).toHaveLength(10);",
  "});",
  "",
].join("\n");

async function workspace(files: Readonly<Record<string, string>> = REPO): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-test-mode-")));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

function provider(): FakeProvider {
  return new FakeProvider((request: LlmRequest) => {
    if (request.system.includes("requirements analyst")) {
      return JSON.stringify({
        summary: "Add page and size to listOrders.",
        requirementNotes: [],
        questions: [],
        assumptions: [],
        risks: [],
        edgeCases: [],
        contradictions: [],
        dependencies: [],
        affectedFiles: [{ path: "src/orders.ts", reason: "Defines listOrders." }],
      });
    }
    if (request.system.includes("test engineer")) {
      return JSON.stringify({
        summary: "A feature test for the second page.",
        tests: [
          {
            acIds: ["AC-1"],
            module: null,
            path: TEST_FILE,
            action: "create",
            content: TEST_CONTENT,
            edits: [],
            description: "Second page.",
          },
        ],
      });
    }
    if (request.system.includes("implementer")) {
      return JSON.stringify({
        summary: "Slice the orders to one page.",
        changes: [
          {
            path: "src/orders.ts",
            action: "modify",
            content: null,
            edits: [
              {
                search: "export function listOrders(orders: Order[]): Order[] {\n  return orders;",
                replace:
                  "export function listOrders(orders: Order[], page = 1, size = orders.length): Order[] {\n" +
                  "  return orders.slice((page - 1) * size, page * size);",
              },
            ],
            changeId: "CH-1",
            description: "Add page and size.",
          },
        ],
      });
    }
    return JSON.stringify({
      summary: "Paginate listOrders.",
      approach: "Slice the array.",
      relevantFiles: [],
      changes: [
        {
          module: null,
          path: "src/orders.ts",
          action: "modify",
          description: "Add page and size.",
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
          targetFile: TEST_FILE,
        },
      ],
      risks: [],
      regressionWatch: [],
      openQuestions: [],
    });
  });
}

/** `withPath`: the real PATH, so that node is found and the policy decides. */
async function cli(cwd: string, args: string[], withPath = true) {
  let stdout = "";
  let stderr = "";
  const model = provider();
  const io: CliIo = {
    stdout: { write: (chunk) => void (stdout += chunk) },
    stderr: { write: (chunk) => void (stderr += chunk) },
    cwd,
    env: {
      ...(withPath ? process.env : {}),
      DEVFLOW_HOME: `${cwd}-home`,
      DEVFLOW_USER: "mohamed",
    },
    createProvider: () => Promise.resolve(model),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

const TEST = ["test", "--task", "tasks/TASK-7.yaml", "--model", "test-model"];

describe("devflow test", () => {
  it("writes tests for review and runs nothing until the command policy allows it", async () => {
    const root = await workspace();
    const started = await cli(root, [...TEST, "--json"]);
    expect(started.code, started.stdout + started.stderr).toBe(ExitCode.WaitingForInput);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    expect(JSON.parse(started.stdout)).toMatchObject({ mode: "test", waitingFor: "plan-approval" });

    const plan = await cli(root, ["approve", runId, "--json"]);
    expect(plan.code, plan.stdout).toBe(ExitCode.WaitingForInput);
    const waiting = JSON.parse(plan.stdout) as { testFiles: string[]; waitingFor: string };
    expect(waiting).toMatchObject({ waitingFor: "test-approval", testFiles: [TEST_FILE] });
    expect(await readFile(path.join(root, "src", "pagination.test.ts"), "utf8")).toBe(TEST_CONTENT);

    const wrongHash = await cli(root, ["approve", runId, "--tests-sha", "b".repeat(64), "--json"]);
    expect(wrongHash.code).toBe(ExitCode.UsageError);
    const wrongKind = await cli(root, ["approve", runId, "--plan-sha", "b".repeat(64), "--json"]);
    expect(wrongKind.code).toBe(ExitCode.UsageError);

    // The workspace is not trusted: the tests are approved, but the policy does not run them.
    const denied = await cli(root, ["approve", runId]);
    expect(denied.code, denied.stdout + denied.stderr).toBe(ExitCode.PolicyDenied);
    expect(denied.stdout).toContain("COMMAND_NOT_APPROVED");
    expect(denied.stdout).toContain("Review the workspace with devflow trust");
    expect(denied.stdout).toContain(`devflow resume ${runId}`);

    const status = await cli(root, ["status", runId, "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: "VERIFICATION",
      status: "interrupted",
      denials: [{ reason: "workspace-untrusted" }],
    });
    // Still untrusted: resuming stops in the same place.
    const resumed = await cli(root, ["resume", runId, "--json"]);
    expect(resumed.code).toBe(ExitCode.PolicyDenied);
  });

  it("shows the files to review and how to decide", async () => {
    const root = await workspace();
    const started = await cli(root, [...TEST, "--json"]);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    const plan = await cli(root, ["approve", runId]);
    expect(plan.stdout).toContain(`  ${TEST_FILE}`);
    expect(plan.stdout).toContain("they have not run");
    expect(plan.stdout).toContain(`devflow reject ${runId} --feedback`);
    expect(plan.stderr).toContain("Writing the tests...");

    const rejected = await cli(root, [
      "reject",
      runId,
      "--feedback",
      "Use a table test.",
      "--json",
    ]);
    expect(rejected.code, rejected.stdout).toBe(ExitCode.WaitingForInput);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ waitingFor: "test-approval" });
  });

  it("reports tests that could not run as not executed, never as passed or failed", async () => {
    const root = await workspace();
    const started = await cli(root, [...TEST, "--json"], false);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    await cli(root, ["approve", runId, "--json"], false);
    // Without PATH, node is not found: the gate does not run and the run says so.
    const done = await cli(root, ["approve", runId, "--json"], false);
    expect(done.code, done.stdout).toBe(ExitCode.Success);
    const report = JSON.parse(
      await cli(root, ["report", runId, "--json"], false).then((r) => r.stdout),
    ) as {
      verdict: string;
      gates: { status: string; reason: string }[];
      acceptanceMatrix: { status: string; tests: { status: string }[] }[];
      findings: { category: string; title: string }[];
    };
    expect(report.verdict).toBe("not_verified");
    expect(report.gates[0]).toMatchObject({ status: "not_executed" });
    expect(report.gates[0]?.reason).toContain("node was not found");
    expect(report.acceptanceMatrix[0]).toMatchObject({
      status: "not_executed",
      tests: [{ status: "not_executed" }],
    });
    expect(report.findings.map((finding) => finding.category)).toEqual(["test-gap"]);
  });

  it("says why a command cannot run when no approval can fix it", async () => {
    const { "node_modules/vitest/vitest.mjs": _stub, ...uninstalled } = REPO;
    const root = await workspace(uninstalled);
    const started = await cli(root, [...TEST, "--json"]);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    await cli(root, ["approve", runId, "--json"]);
    const stopped = await cli(root, ["approve", runId]);
    expect(stopped.code).toBe(ExitCode.PolicyDenied);
    expect(stopped.stdout).toContain("install the project's dependencies first");
    expect(stopped.stdout).toContain("Fix the cause, then continue:");
    expect(stopped.stdout).not.toContain("--allow");
  });

  it("runs test mode only through devflow test", async () => {
    const root = await workspace();
    const result = await cli(root, ["plan", "--task", "tasks/TASK-7.yaml", "--mode", "test"]);
    expect(result.code).toBe(ExitCode.UsageError);
  });
});

const IMPLEMENT = ["implement", "--task", "tasks/TASK-7.yaml", "--model", "test-model"];

describe("devflow implement", () => {
  it("stops before the baseline when the command policy does not allow the gates", async () => {
    const root = await workspace();
    const started = await cli(root, [...IMPLEMENT, "--json"]);
    expect(started.code, started.stdout + started.stderr).toBe(ExitCode.WaitingForInput);
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    expect(JSON.parse(started.stdout)).toMatchObject({
      mode: "implement",
      waitingFor: "plan-approval",
    });
    await cli(root, ["approve", runId, "--json"]);
    const denied = await cli(root, ["approve", runId]);
    expect(denied.code, denied.stdout + denied.stderr).toBe(ExitCode.PolicyDenied);
    expect(denied.stdout).toContain("Review the workspace with devflow trust");
    // Nothing was implemented: the code is unchanged until the baseline has run.
    expect(await readFile(path.join(root, "src", "orders.ts"), "utf8")).toBe(REPO["src/orders.ts"]);
  });

  it("goes through the change review and reports what did not run as not verified", async () => {
    const root = await workspace();
    // Without PATH, node is not found: no gate runs, before or after the change.
    const started = await cli(
      root,
      ["run", "--task", "tasks/TASK-7.yaml", "--model", "m", "--json"],
      false,
    );
    const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
    await cli(root, ["approve", runId, "--json"], false);
    const change = await cli(root, ["approve", runId], false);
    expect(change.code, change.stdout + change.stderr).toBe(ExitCode.WaitingForInput);
    expect(change.stdout).toContain("Change:");
    expect(change.stdout).toContain("  src/orders.ts");
    expect(change.stdout).toContain("the change has not run");
    expect(change.stderr).toContain("Writing the code change...");
    expect(await readFile(path.join(root, "src", "orders.ts"), "utf8")).toContain("orders.slice(");

    const wrongKind = await cli(root, ["approve", runId, "--tests-sha", "b".repeat(64)], false);
    expect(wrongKind.code).toBe(ExitCode.UsageError);
    expect(wrongKind.stderr).toContain("--tests-sha does not apply");
    const wrongHash = await cli(root, ["approve", runId, "--changes-sha", "b".repeat(64)], false);
    expect(wrongHash.code).toBe(ExitCode.UsageError);

    const done = await cli(root, ["approve", runId, "--json"], false);
    expect(done.code, done.stdout).toBe(ExitCode.Success);
    const report = JSON.parse(
      await cli(root, ["report", runId, "--json"], false).then((r) => r.stdout),
    ) as {
      verdict: string;
      filesChanged: { path: string; change: string }[];
      acceptanceMatrix: { status: string }[];
    };
    expect(report.verdict).toBe("not_verified");
    expect(report.acceptanceMatrix[0]?.status).toBe("not_executed");
    expect(report.filesChanged).toContainEqual(
      expect.objectContaining({ path: "src/orders.ts", change: "modified" }),
    );
  });
});

describe("devflow review", () => {
  it("needs a git repository, and creates no run outside one", async () => {
    const root = await workspace();
    const result = await cli(root, [
      "review",
      "--task",
      "tasks/TASK-7.yaml",
      "--model",
      "test-model",
      "--base",
      "main",
    ]);
    expect(result.code, result.stdout + result.stderr).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("review mode needs a git repository");
    expect(result.stderr).toContain("GIT_FAILED");
    await expect(readFile(path.join(root, ".devflow", "runs"), "utf8")).rejects.toThrow();
  });
});
