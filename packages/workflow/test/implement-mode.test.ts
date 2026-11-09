import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FakeProvider, type FakeReply } from "@devflow/ai";
import {
  EngineeringReport,
  ErrorCode,
  type GateDefinition,
  type GateResult,
  type LlmRequest,
  type TestCaseResult,
  type VerificationRun,
  type WorkspaceModule,
  readAuditLog,
} from "@devflow/core";
import { describe, expect, it } from "vitest";
import {
  AfterRun,
  ChangedFiles,
  RunStore,
  type TestRunner,
  TestEvidenceRecord,
  approveChanges,
  approvePlan,
  approveTests,
  getRun,
  rejectChanges,
  startRun,
} from "../src/index.js";
import {
  REPO,
  analysisAnswer,
  isAnalysis,
  planAnswer,
  services,
  settings,
  task,
  userText,
  workspace,
} from "./helpers.js";

const TEST_FILE = "src/pagination.test.ts";
const SOURCE = "src/orders.ts";

const TEST_CONTENT = [
  'import { describe, expect, it } from "vitest";',
  'import { listOrders } from "./orders";',
  "",
  'describe("listOrders", () => {',
  '  it("AC-1: page 2 with size 10 returns orders 11 to 20", () => {',
  "    const orders = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), total: 1 }));",
  "    expect(listOrders(orders, 2, 10).map((o) => o.id)).toHaveLength(10);",
  "  });",
  "});",
  "",
].join("\n");

const OLD_BODY = "export function listOrders(orders: Order[]): Order[] {\n  return orders;\n}";
const NEW_BODY =
  "export function listOrders(orders: Order[], page = 1, size = orders.length): Order[] {\n" +
  "  return orders.slice((page - 1) * size, page * size);\n}";

function testAnswer(): string {
  return JSON.stringify({
    summary: "A feature test for pagination.",
    tests: [
      {
        acIds: ["AC-1"],
        module: null,
        path: TEST_FILE,
        action: "create",
        content: TEST_CONTENT,
        edits: [],
        description: "Checks the second page.",
      },
    ],
  });
}

interface WireChange {
  path?: string;
  action?: "create" | "modify" | "delete";
  content?: string | null;
  edits?: { search: string; replace: string }[];
  changeId?: string | null;
}

function implementationAnswer(
  changes: WireChange[] = [{}],
  summary = "Paginate listOrders.",
): string {
  return JSON.stringify({
    summary,
    changes: changes.map((change) => ({
      path: change.path ?? SOURCE,
      action: change.action ?? "modify",
      content: change.content === undefined ? null : change.content,
      edits: change.edits ?? [{ search: OLD_BODY, replace: NEW_BODY }],
      changeId: change.changeId === undefined ? "CH-1" : change.changeId,
      description: "Slice the orders to one page.",
    })),
  });
}

const isTestDesign = (request: LlmRequest) => request.system.includes("test engineer");
const isImplementation = (request: LlmRequest) => request.system.includes("implementer");

/** Answers each step from its own queue; the last reply of a queue repeats. */
function model(implementations: FakeReply[] = [implementationAnswer()]) {
  const queue = [...implementations];
  const requests: LlmRequest[] = [];
  const provider = new FakeProvider((request) => {
    if (isAnalysis(request)) return analysisAnswer();
    if (isTestDesign(request)) return testAnswer();
    if (!isImplementation(request)) return planAnswer();
    requests.push(request);
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply === undefined) throw new Error("no scripted reply");
    return reply;
  });
  return { provider, requests };
}

const MODULE = {
  profile: {
    moduleId: "shop",
    adapterId: "javascript",
    root: ".",
    languages: [],
    frameworks: [],
    testFrameworks: [],
    qualityTools: [],
    sourceRoots: ["src"],
    testRoots: ["src"],
    contracts: [],
  },
  adapter: {
    testAuthoringGuide: () => ({
      framework: "vitest",
      testRoot: "src",
      fileNamePattern: "{name}.test.ts",
      acMarker: { style: "title-prefix", example: 'it("AC-1: ...")' },
      notes: [],
    }),
  },
  candidate: {},
} as unknown as WorkspaceModule;

const TEST_GATE: GateDefinition = { id: "test-shop", module: "shop", use: "test", required: true };
const LINT_GATE: GateDefinition = { id: "lint-shop", module: "shop", use: "lint", required: true };

const AC_TEST = `${TEST_FILE} > listOrders > AC-1: page 2 with size 10 returns orders 11 to 20`;
const OLD_TEST = "src/orders.test.ts > listOrders > returns every order";

type Outcome = "passed" | "assertion_failure";

function test(id: string, file: string, outcome: Outcome, markers: string[] = []): TestCaseResult {
  return {
    id,
    name: id.slice(id.lastIndexOf("> ") + 2),
    file,
    outcome,
    status: outcome === "passed" ? "passed" : "failed",
    markers,
    ...(outcome === "passed" ? {} : { message: `${id} failed: expected 10 to be 2` }),
  };
}

function gate(
  id: string,
  tests: TestCaseResult[],
  failed = tests.some((t) => t.status === "failed"),
): GateResult {
  return {
    gateId: id,
    commandId: id === "test-shop" ? "vitest" : "eslint",
    required: true,
    status: failed ? "failed" : "passed",
    execution: {
      commandId: id === "test-shop" ? "vitest" : "eslint",
      argv: ["node", "tool.mjs"],
      cwd: ".",
      invocation: "direct",
      approval: { via: "allowlist-flag", approvedBy: "mohamed" },
      startedAt: "2026-11-07T10:00:00.000Z",
      durationMs: 1200,
      exitCode: failed ? 1 : 0,
      signal: null,
      timedOut: false,
      stdoutPath: ".devflow/runs/x/logs/commands/tool.out",
      stderrPath: ".devflow/runs/x/logs/commands/tool.err",
      outputTruncated: false,
    },
    tests,
    diagnostics: [],
    evidence: [],
  };
}

/** One gate run: the AC-1 test and an older test, with their outcomes. */
function run(
  ac: Outcome,
  old: Outcome = "passed",
  lintFailed = false,
): (ids: string[]) => VerificationRun {
  return (ids) => ({
    gates: [
      gate("test-shop", [
        test(AC_TEST, TEST_FILE, ac, ["AC-1"]),
        test(OLD_TEST, "src/orders.test.ts", old),
      ]),
      gate("lint-shop", [], lintFailed),
    ].filter((result) => ids.includes(result.gateId)),
    denials: [],
  });
}

/** A runner that answers each run from a queue and records what it ran and what was on disk. */
function fakeRunner(root: string, runs: ((ids: string[]) => VerificationRun)[]) {
  const calls: { gates: string[]; source: string; logDir: string }[] = [];
  const queue = [...runs];
  const runner: TestRunner = {
    modules: [MODULE],
    gates: () => Promise.resolve([TEST_GATE, LINT_GATE]),
    run: async (gates, context) => {
      const ids = gates.map((g) => g.id);
      calls.push({
        gates: ids,
        source: await readFile(path.join(root, "src", "orders.ts"), "utf8"),
        logDir: context.logDir,
      });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error("no scripted run");
      return next(ids);
    },
  };
  return { runner, calls };
}

async function startImplement(
  root: string,
  provider: FakeProvider,
  runner: TestRunner,
  overrides: Parameters<typeof settings>[0] = {},
) {
  const svc = await services(root, provider, { testRunner: () => Promise.resolve(runner) });
  const outcome = await startRun(
    {
      task: task(),
      taskFile: "tasks/TASK-7.yaml",
      mode: "implement",
      goal: "implement",
      settings: settings({ maxRepairAttempts: 2, ...overrides }),
    },
    svc,
  );
  const store = await RunStore.open(root, outcome.runId);
  return { svc, outcome, store };
}

/** Starts a run and approves the plan and the tests: it then waits for the first change. */
async function toChange(
  root: string,
  provider: FakeProvider,
  runner: TestRunner,
  overrides: Parameters<typeof settings>[0] = {},
) {
  const started = await startImplement(root, provider, runner, overrides);
  await approvePlan(started.outcome.runId, { by: "mohamed" }, started.svc);
  const waiting = await approveTests(started.outcome.runId, { by: "mohamed" }, started.svc);
  return { ...started, waiting, runId: started.outcome.runId };
}

function promptAt(requests: readonly LlmRequest[], index: number): string {
  const request = requests[index];
  if (request === undefined) throw new Error(`no implementation request ${String(index)}`);
  return userText(request);
}

const source = (root: string) => readFile(path.join(root, "src", "orders.ts"), "utf8");

async function reportOf(store: RunStore): Promise<EngineeringReport> {
  return EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
}

describe("implement mode", () => {
  it("runs the red baseline, waits for the change, verifies it green and reports it verified", async () => {
    const root = await workspace();
    const { provider, requests } = model();
    const { runner, calls } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { svc, waiting, runId, store } = await toChange(root, provider, runner);

    expect(waiting).toMatchObject({
      mode: "implement",
      state: "IMPLEMENTATION",
      status: "waiting",
      waitingFor: "change-approval",
      changedFiles: [SOURCE],
      changesPath: `.devflow/runs/${runId}/artifacts/implementation.md`,
    });
    // The baseline ran every gate against the code before the change.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gates).toEqual(["test-shop", "lint-shop"]);
    expect(calls[0]?.source).toBe(REPO[SOURCE]);
    // Written, but not run: model-written code runs only after a person approved it.
    expect(await source(root)).toContain("orders.slice(");
    const md = await store.readText("artifacts/implementation.md");
    expect(md).toContain(`**CH-1** modify \`${SOURCE}\``);
    expect(md).toContain("it has not run");
    // The prompt has the file to change and the approved test, read only.
    const prompt = promptAt(requests, 0);
    expect(prompt).toContain(`### ${SOURCE}`);
    expect(prompt).toContain("## Approved test files (read only)");
    expect(prompt).toContain("AC-1: page 2 with size 10");

    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done).toMatchObject({ state: "COMPLETED", status: "completed" });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.source).toContain("orders.slice(");
    expect(calls[1]?.logDir).toBe(`.devflow/runs/${runId}/logs/commands/after-1`);

    const after = AfterRun.parse(JSON.parse(await store.readText("artifacts/after.json")));
    expect(after).toMatchObject({ attempt: 1, decision: "passed", regressions: [], flaky: [] });
    const evidence = TestEvidenceRecord.parse(
      JSON.parse(await store.readText("artifacts/test-evidence.json")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]?.evidence).toMatchObject({
      baseline: "assertion_failure",
      after: "passed",
      established: true,
    });

    const report = await reportOf(store);
    expect(report.verdict).toBe("verified");
    expect(report.acceptanceMatrix.find((row) => row.acId === "AC-1")?.status).toBe("verified");
    expect(report.filesChanged).toEqual([
      { path: TEST_FILE, change: "added" },
      { path: SOURCE, change: "modified", planChangeId: "CH-1" },
    ]);
    expect(report.gates.map((g) => `${g.gateId}:${g.status}`)).toEqual([
      "test-shop:passed",
      "lint-shop:passed",
    ]);
    const markdown = await store.readText("report.md");
    expect(markdown).toContain("## Test evidence (red/green)");
    expect(markdown).toContain("| assertion_failure (expected) | passed (passed) | yes |");
    expect(markdown).toContain("nothing was committed or pushed");

    const audit = await readAuditLog(store.path("audit.jsonl"));
    expect(audit).toContainEqual(
      expect.objectContaining({ type: "decision", subject: "changes", decision: "approved" }),
    );
    expect(audit).toContainEqual(
      expect.objectContaining({ type: "file-write", path: SOURCE, planChangeId: "CH-1" }),
    );
    const changed = ChangedFiles.parse(
      JSON.parse(await store.readText("artifacts/changed-files.json")),
    );
    expect(changed.files.map((file) => file.path)).toEqual([SOURCE]);
  });

  it("repairs a failed verification with the failures, then verifies the repair", async () => {
    const root = await workspace();
    const repaired = NEW_BODY.replace("page * size", "page * size /* repaired */");
    const { provider, requests } = model([
      implementationAnswer(),
      implementationAnswer(
        [{ edits: [{ search: NEW_BODY, replace: repaired }] }],
        "Fix the slice.",
      ),
    ]);
    const { runner, calls } = fakeRunner(root, [
      run("assertion_failure"),
      run("assertion_failure"),
      run("assertion_failure"),
      run("passed"),
    ]);
    const { svc, runId, store } = await toChange(root, provider, runner);
    const repair = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(repair).toMatchObject({ state: "IMPLEMENTATION", waitingFor: "change-approval" });
    // The failed gate ran a second time before the repair was asked for.
    expect(calls.map((call) => call.gates.join(","))).toEqual([
      "test-shop,lint-shop",
      "test-shop,lint-shop",
      "test-shop",
    ]);
    const first = AfterRun.parse(JSON.parse(await store.readText("artifacts/verification-1.json")));
    expect(first).toMatchObject({ decision: "repair", failedGates: ["test-shop"] });
    const prompt = promptAt(requests, 1);
    expect(prompt).toContain("## Repair 1: the verification after your previous change failed");
    expect(prompt).toContain("expected 10 to be 2");
    expect(await store.readText("artifacts/implementation.md")).toContain("(a repair)");

    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done.status).toBe("completed");
    expect(await source(root)).toContain("/* repaired */");
    const report = await reportOf(store);
    expect(report.verdict).toBe("verified");
    expect((await getRun(root, runId)).record.iterations).toMatchObject({
      implementation: 2,
      verification: 2,
    });
  });

  it("stops when the repairs are used up and reports the failure", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure")]);
    const { svc, runId, store } = await toChange(root, provider, runner, { maxRepairAttempts: 0 });
    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done.status).toBe("completed");
    const after = AfterRun.parse(JSON.parse(await store.readText("artifacts/after.json")));
    expect(after.decision).toBe("stop");
    expect(after.reason).toContain("repair attempt(s) are used up");
    const report = await reportOf(store);
    expect(report.verdict).toBe("failed_verification");
    expect(report.acceptanceMatrix.find((row) => row.acId === "AC-1")?.status).toBe("failed");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        category: "requirement",
        severity: "high",
        verification: "confirmed",
        title: expect.stringContaining("AC-1") as string,
      }),
    );
  });

  it("reports a test that passed before the change and fails after it as a regression", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner } = fakeRunner(root, [
      run("assertion_failure", "passed"),
      run("passed", "assertion_failure"),
    ]);
    const { svc, runId, store } = await toChange(root, provider, runner, { maxRepairAttempts: 0 });
    await approveChanges(runId, { by: "mohamed" }, svc);
    const after = AfterRun.parse(JSON.parse(await store.readText("artifacts/after.json")));
    expect(after.regressions).toEqual([{ gateId: "test-shop", testId: OLD_TEST }]);
    const report = await reportOf(store);
    expect(report.verdict).toBe("failed_verification");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        category: "regression",
        severity: "high",
        verification: "confirmed",
        title: `Regression: ${OLD_TEST} passed before the change and fails after it`,
      }),
    );
  });

  it("marks a test that fails and then passes as flaky, never as a regression", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner } = fakeRunner(root, [
      run("assertion_failure"),
      run("passed", "assertion_failure"),
      run("passed", "passed"),
    ]);
    const { svc, runId, store } = await toChange(root, provider, runner);
    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    // A flaky failure is not repaired: a repair cannot fix a test that passes when rerun.
    expect(done.status).toBe("completed");
    const after = AfterRun.parse(JSON.parse(await store.readText("artifacts/after.json")));
    expect(after).toMatchObject({
      decision: "stop",
      regressions: [],
      flaky: [{ gateId: "test-shop", testId: OLD_TEST }],
    });
    const report = await reportOf(store);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ category: "regression", verification: "unverified" }),
    );
    expect(report.findings.some((finding) => finding.title.startsWith("Regression:"))).toBe(false);
  });

  it("restores the files of a rejected change and writes it again with the feedback", async () => {
    const root = await workspace();
    const { provider, requests } = model();
    const { runner, calls } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { svc, runId, store } = await toChange(root, provider, runner);
    const again = await rejectChanges(
      runId,
      { by: "mohamed", feedback: "Keep the old signature working." },
      svc,
    );
    expect(again).toMatchObject({ state: "IMPLEMENTATION", waitingFor: "change-approval" });
    expect(calls).toHaveLength(1);
    const prompt = promptAt(requests, 1);
    expect(prompt).toContain("## Previous implementation, rejected by the reviewer");
    expect(prompt).toContain("Keep the old signature working.");
    // The second implementation was computed from the restored file.
    expect(prompt).toContain(OLD_BODY);
    const audit = await readAuditLog(store.path("audit.jsonl"));
    expect(audit).toContainEqual(
      expect.objectContaining({ type: "decision", subject: "changes", decision: "rejected" }),
    );
    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done.status).toBe("completed");
    expect((await reportOf(store)).verdict).toBe("verified");
  });

  it("refuses changes outside the plan or to the tests, then fails after one revision", async () => {
    const root = await workspace();
    const bad = implementationAnswer([
      { path: "src/settings.ts", content: null },
      { path: TEST_FILE, edits: [{ search: "toHaveLength(10)", replace: "toBeDefined()" }] },
    ]);
    const { provider, requests } = model([bad, bad]);
    const { runner } = fakeRunner(root, [run("assertion_failure")]);
    const { waiting, runId, store } = await toChange(root, provider, runner);
    expect(waiting).toMatchObject({
      state: "FAILED",
      status: "failed",
      error: { code: ErrorCode.ImplementationInvalid },
    });
    expect(requests).toHaveLength(2);
    expect(promptAt(requests, 1)).toContain('"src/settings.ts" is not a file of the approved plan');
    expect(promptAt(requests, 1)).toContain(`"${TEST_FILE}" is a test file`);
    // Nothing was written: the test stays as approved and the code as it was.
    expect(await readFile(path.join(root, ...TEST_FILE.split("/")), "utf8")).toBe(TEST_CONTENT);
    expect(await source(root)).toBe(REPO[SOURCE]);
    const checks = JSON.parse(await store.readText("artifacts/implementation-checks.json")) as {
      checks: { code: string; severity: string }[];
    };
    expect(checks.checks.map((check) => `${check.severity}:${check.code}`)).toEqual([
      "error:out-of-plan",
      "error:test-file",
      "warning:unaddressed-change",
    ]);
    expect((await getRun(root, runId)).record.lastError?.resumable).toBe(false);
  });

  it("refuses to approve a change that was edited after DevFlow wrote it", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner, calls } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { svc, runId } = await toChange(root, provider, runner);
    await writeFile(path.join(root, "src", "orders.ts"), "export const tampered = true;\n");
    await expect(approveChanges(runId, { by: "mohamed" }, svc)).rejects.toMatchObject({
      code: ErrorCode.ImplementationFilesChanged,
    });
    expect(calls).toHaveLength(1);
  });

  it("needs the implement goal", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("passed")]);
    const svc = await services(root, provider, { testRunner: () => Promise.resolve(runner) });
    await expect(
      startRun(
        { task: task(), taskFile: null, mode: "implement", goal: "plan", settings: settings() },
        svc,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidTransition });
  });
});
