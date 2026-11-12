import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AgentProvider,
  FakeProvider,
  type FakeReply,
  agentRequestIdIn,
  readAgentRequest,
  writeAgentAnswer,
} from "@devflow-ai/ai";
import {
  DevflowError,
  EngineeringReport,
  ErrorCode,
  type GateDefinition,
  type GateResult,
  type GitDiff,
  type GitInspection,
  type GitWorkspace,
  type LlmRequest,
  type TestCaseResult,
  type VerificationRun,
  type WorkspaceModule,
  readAuditLog,
} from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import {
  AfterRun,
  ChangedFiles,
  RunStore,
  type RunOutcome,
  type TestRunner,
  TestEvidenceRecord,
  type WorkflowServices,
  approveChanges,
  approvePlan,
  approveTests,
  getRun,
  rejectChanges,
  rejectTests,
  resumeRun,
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
  extra: Partial<WorkflowServices> = {},
) {
  const svc = await services(root, provider, {
    testRunner: () => Promise.resolve(runner),
    ...extra,
  });
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
  extra: Partial<WorkflowServices> = {},
) {
  const started = await startImplement(root, provider, runner, overrides, extra);
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
    expect(markdown).toMatch(/- \*\*Change approved by:\*\* \S/);

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

const BASE = "b".repeat(40);

/** An in-memory repository: one branch checked out, the uncommitted changes, the commits. */
class FakeGit implements GitWorkspace {
  branch: string | null = "main";
  readonly branches = new Set(["main"]);
  changes: string[] = [];
  readonly commits: { paths: string[]; message: string; branch: string | null }[] = [];
  unavailable: string | undefined;
  failCommits = false;

  inspect(): Promise<GitInspection> {
    if (this.unavailable !== undefined) {
      return Promise.resolve({ kind: "unavailable", reason: this.unavailable });
    }
    return Promise.resolve({
      kind: "repository",
      head: BASE,
      branch: this.branch,
      changes: [...this.changes],
    });
  }

  currentBranch(): Promise<string | null> {
    return Promise.resolve(this.branch);
  }

  freeBranchName(base: string): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      const name = attempt === 1 ? base : `${base}-${String(attempt)}`;
      if (!this.branches.has(name)) return Promise.resolve(name);
    }
  }

  createBranch(name: string): Promise<void> {
    this.branches.add(name);
    this.branch = name;
    return Promise.resolve();
  }

  commit(paths: readonly string[], message: string): Promise<string> {
    if (this.failCommits) {
      return Promise.reject(
        new DevflowError(ErrorCode.GitFailed, "git commit failed: Author identity unknown"),
      );
    }
    this.commits.push({ paths: [...paths], message, branch: this.branch });
    return Promise.resolve(String(this.commits.length).repeat(40).slice(0, 40));
  }

  mergeBase(): Promise<string> {
    return Promise.reject(new Error("implement mode does not review a diff"));
  }

  diff(): Promise<GitDiff> {
    return Promise.reject(new Error("implement mode does not review a diff"));
  }

  remoteUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

describe("implement mode on a git branch (ADR 0012)", () => {
  it("creates the branch after the plan, commits the approved tests and change, and reports them", async () => {
    const root = await workspace();
    const git = new FakeGit();
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const started = await startImplement(root, provider, runner, {}, { git });
    // Nothing is written before the plan is approved, so the branch does not exist yet.
    expect(git.branch).toBe("main");
    expect(started.outcome).not.toHaveProperty("branch");

    const tests = await approvePlan(started.outcome.runId, { by: "mohamed" }, started.svc);
    expect(git.branch).toBe("devflow/TASK-7");
    expect(tests).toMatchObject({ waitingFor: "test-approval", branch: "devflow/TASK-7" });
    expect(git.commits).toEqual([]);

    const change = await approveTests(started.outcome.runId, { by: "mohamed" }, started.svc);
    expect(change).toMatchObject({ waitingFor: "change-approval", branch: "devflow/TASK-7" });
    expect(git.commits).toEqual([
      {
        paths: [TEST_FILE],
        message:
          "DevFlow TASK-7: add tests\n\nPaginate the order list\n\n" +
          `Run ${started.outcome.runId}, approved by mohamed.`,
        branch: "devflow/TASK-7",
      },
    ]);

    const done = await approveChanges(started.outcome.runId, { by: "mohamed" }, started.svc);
    expect(done).toMatchObject({ status: "completed", branch: "devflow/TASK-7" });
    expect(git.commits.map((commit) => [commit.paths, commit.message.split("\n")[0]])).toEqual([
      [[TEST_FILE], "DevFlow TASK-7: add tests"],
      [[SOURCE], "DevFlow TASK-7: implement the change"],
    ]);

    const { record } = await getRun(root, started.outcome.runId);
    expect(record.git).toMatchObject({
      status: "branch",
      branch: "devflow/TASK-7",
      baseBranch: "main",
      baseCommit: BASE,
      commit: "per-phase",
      commits: [
        { phase: "tests", iteration: 1, subject: "DevFlow TASK-7: add tests" },
        { phase: "implementation", iteration: 1, subject: "DevFlow TASK-7: implement the change" },
      ],
      warnings: [],
    });
    const report = await reportOf(started.store);
    expect(report.run).toMatchObject({
      branch: "devflow/TASK-7",
      baseCommit: BASE,
      headCommit: "2".repeat(40),
    });
    expect(report.manualChecks.join("\n")).toContain(
      `git diff ${BASE.slice(0, 12)}..devflow/TASK-7`,
    );
    const markdown = await started.store.readText("report.md");
    expect(markdown).toContain("- **Branch:** `devflow/TASK-7`");
    expect(markdown).toContain(
      "Implement mode committed the approved changes on the local branch devflow/TASK-7; " +
        "nothing was pushed or merged",
    );
  });

  it("commits each approved repair, never a rejected change", async () => {
    const root = await workspace();
    const git = new FakeGit();
    const repaired = NEW_BODY.replace("page * size", "page * size /* repaired */");
    const { provider } = model([
      implementationAnswer(),
      implementationAnswer(),
      implementationAnswer([{ edits: [{ search: NEW_BODY, replace: repaired }] }], "Fix it."),
    ]);
    const { runner } = fakeRunner(root, [
      run("assertion_failure"),
      run("assertion_failure"),
      run("assertion_failure"),
      run("passed"),
    ]);
    const { svc, runId } = await toChange(root, provider, runner, {}, { git });
    await rejectChanges(runId, { by: "mohamed", feedback: "Name the slice." }, svc);
    expect(git.commits).toHaveLength(1);
    const repair = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(repair).toMatchObject({ waitingFor: "change-approval" });
    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done.status).toBe("completed");
    expect(git.commits.map((commit) => commit.message.split("\n")[0])).toEqual([
      "DevFlow TASK-7: add tests",
      "DevFlow TASK-7: implement the change",
      "DevFlow TASK-7: repair 1",
    ]);
    const { record } = await getRun(root, runId);
    expect(record.git?.status === "branch" ? record.git.commits.map((c) => c.phase) : []).toEqual([
      "tests",
      "implementation",
      "repair",
    ]);
  });

  it("refuses to start on a working tree with uncommitted changes, and creates no run", async () => {
    const root = await workspace();
    const git = new FakeGit();
    git.changes = ["src/orders.ts", "notes.txt"];
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("passed")]);
    await expect(startImplement(root, provider, runner, {}, { git })).rejects.toMatchObject({
      code: ErrorCode.GitTreeNotClean,
      message: expect.stringContaining("src/orders.ts, notes.txt") as string,
    });
    await expect(readFile(path.join(root, ".devflow", "runs"), "utf8")).rejects.toThrow();
  });

  it("refuses worktree isolation, which is not implemented", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("passed")]);
    await expect(
      startImplement(
        root,
        provider,
        runner,
        { git: { isolation: "worktree", branchPrefix: "devflow/", commit: "per-phase" } },
        { git: new FakeGit() },
      ),
    ).rejects.toMatchObject({ code: ErrorCode.GitIsolationUnsupported });
  });

  it("stops before writing when the tree changed after the start, and resumes once it is clean", async () => {
    const root = await workspace();
    const git = new FakeGit();
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const started = await startImplement(root, provider, runner, {}, { git });
    git.changes = ["README.md"];
    const stopped = await approvePlan(started.outcome.runId, { by: "mohamed" }, started.svc);
    expect(stopped).toMatchObject({
      state: "TEST_DESIGN",
      status: "interrupted",
      error: { code: ErrorCode.GitTreeNotClean },
    });
    expect(git.branch).toBe("main");
    await expect(readFile(path.join(root, TEST_FILE), "utf8")).rejects.toThrow();

    git.changes = [];
    const resumed = await resumeRun(started.outcome.runId, started.svc);
    expect(resumed).toMatchObject({ waitingFor: "test-approval", branch: "devflow/TASK-7" });
  });

  it("uses a free branch name when the task's branch exists", async () => {
    const root = await workspace();
    const git = new FakeGit();
    git.branches.add("devflow/TASK-7");
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { waiting } = await toChange(root, provider, runner, {}, { git });
    expect(waiting.branch).toBe("devflow/TASK-7-2");
    expect(git.commits[0]?.branch).toBe("devflow/TASK-7-2");
  });

  it("refuses to approve or restore while another branch is checked out", async () => {
    const root = await workspace();
    const git = new FakeGit();
    const { provider } = model();
    const { runner, calls } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const started = await startImplement(root, provider, runner, {}, { git });
    const runId = started.outcome.runId;
    await approvePlan(runId, { by: "mohamed" }, started.svc);
    git.branch = "main";
    await expect(approveTests(runId, { by: "mohamed" }, started.svc)).rejects.toMatchObject({
      code: ErrorCode.GitBranchChanged,
      message: expect.stringContaining("git switch devflow/TASK-7") as string,
    });
    await expect(
      rejectTests(runId, { by: "mohamed", feedback: "Shorter." }, started.svc),
    ).rejects.toMatchObject({ code: ErrorCode.GitBranchChanged });
    expect(git.commits).toEqual([]);
    expect(calls).toEqual([]);
    expect((await getRun(root, runId)).record.pending?.kind).toBe("test-approval");

    git.branch = "devflow/TASK-7";
    const change = await approveTests(runId, { by: "mohamed" }, started.svc);
    expect(change.waitingFor).toBe("change-approval");
  });

  it("goes on when a commit fails, and asks for a look at the uncommitted files", async () => {
    const root = await workspace();
    const git = new FakeGit();
    git.failCommits = true;
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { svc, runId, store } = await toChange(root, provider, runner, {}, { git });
    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done.status).toBe("completed");
    const report = await reportOf(store);
    expect(report.run.headCommit).toBe(BASE);
    expect(report.manualChecks).toContain(
      "The approved tests were not committed (git commit failed: Author identity unknown); " +
        `commit or review these files on devflow/TASK-7: ${TEST_FILE}.`,
    );
    expect(report.manualChecks).toContain(
      "The approved implementation was not committed (git commit failed: Author identity unknown); " +
        `commit or review these files on devflow/TASK-7: ${SOURCE}.`,
    );
    expect(await store.readText("report.md")).toContain("nothing was committed or pushed");
  });

  it("keeps the branch but makes no commit with commit: none", async () => {
    const root = await workspace();
    const git = new FakeGit();
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { svc, runId } = await toChange(
      root,
      provider,
      runner,
      { git: { isolation: "branch", branchPrefix: "df-", commit: "none" } },
      { git },
    );
    await approveChanges(runId, { by: "mohamed" }, svc);
    expect(git.branch).toBe("df-TASK-7");
    expect(git.commits).toEqual([]);
  });

  it("keeps the changes in the working tree outside a repository, and says so", async () => {
    const root = await workspace();
    const git = new FakeGit();
    git.unavailable = "the workspace is not in a git repository (fatal: not a git repository)";
    const { provider } = model();
    const { runner } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const { svc, runId, store, waiting } = await toChange(root, provider, runner, {}, { git });
    expect(waiting).not.toHaveProperty("branch");
    await approveChanges(runId, { by: "mohamed" }, svc);
    expect(git.commits).toEqual([]);
    expect((await getRun(root, runId)).record.git).toEqual({
      status: "none",
      reason: "the workspace is not in a git repository (fatal: not a git repository)",
    });
    const report = await reportOf(store);
    expect(report.run).not.toHaveProperty("branch");
    expect(report.manualChecks).toContain(
      "The changes are not on a DevFlow branch (the workspace is not in a git repository " +
        "(fatal: not a git repository)): they are uncommitted in the working tree.",
    );
  });
});

describe("implement mode in agent mode (ADR 0027)", () => {
  /**
   * Plays the coding agent: while the run waits for an answer, it reads the saved request,
   * lets the scripted model answer it, saves the answer and resumes the run.
   */
  async function asAgent(
    outcome: RunOutcome,
    brain: FakeProvider,
    directory: string,
    svc: WorkflowServices,
    asked: string[],
  ): Promise<RunOutcome> {
    let current = outcome;
    for (let turn = 0; turn < 40; turn += 1) {
      if (current.error?.code !== ErrorCode.AgentInputRequired) return current;
      const id = agentRequestIdIn(current.error.message);
      if (id === undefined) throw new Error("no request id");
      const saved = await readAgentRequest(directory, id);
      if (saved === undefined) throw new Error(`request ${id} not saved`);
      asked.push(id);
      const answer = await brain.generate(saved.request, new AbortController().signal);
      await writeAgentAnswer(directory, id, answer.text);
      current = await resumeRun(current.runId, svc);
    }
    throw new Error("the run kept asking");
  }

  it("runs the whole workflow with the agent as the model: no key, same checks and verdict", async () => {
    const root = await workspace();
    const directory = path.join(root, ".devflow", "agent");
    const agent = new AgentProvider({ directory });
    const brain = model().provider;
    const { runner, calls } = fakeRunner(root, [run("assertion_failure"), run("passed")]);
    const svc = await services(root, brain, {
      provider: () => agent,
      testRunner: () => Promise.resolve(runner),
    });
    const asked: string[] = [];

    const first = await startRun(
      {
        task: task(),
        taskFile: "tasks/TASK-7.yaml",
        mode: "implement",
        goal: "implement",
        settings: settings({ provider: "agent", maxRepairAttempts: 2 }),
      },
      svc,
    );
    // The first model call stops the run: nothing is answered yet.
    expect(first).toMatchObject({ status: "interrupted", error: { code: "AGENT_INPUT_REQUIRED" } });
    const planned = await asAgent(first, brain, directory, svc, asked);
    expect(planned).toMatchObject({ status: "waiting", waitingFor: "plan-approval" });

    const runId = first.runId;
    const tests = await asAgent(
      await approvePlan(runId, { by: "mohamed" }, svc),
      brain,
      directory,
      svc,
      asked,
    );
    expect(tests).toMatchObject({ status: "waiting", waitingFor: "test-approval" });
    const change = await asAgent(
      await approveTests(runId, { by: "mohamed" }, svc),
      brain,
      directory,
      svc,
      asked,
    );
    expect(change).toMatchObject({ status: "waiting", waitingFor: "change-approval" });
    // The red baseline ran before the change was written.
    expect(calls[0]?.source).toBe(REPO[SOURCE]);
    expect(await source(root)).toContain("orders.slice(");

    const done = await approveChanges(runId, { by: "mohamed" }, svc);
    expect(done).toMatchObject({ state: "COMPLETED", status: "completed" });
    const store = await RunStore.open(root, runId);
    const report = await reportOf(store);
    expect(report.verdict).toBe("verified");
    expect(report.acceptanceMatrix.find((row) => row.acId === "AC-1")?.status).toBe("verified");

    // Analysis, plan, test design and implementation: each request asked once, never twice.
    expect(asked.length).toBeGreaterThanOrEqual(4);
    expect(new Set(asked).size).toBe(asked.length);
    // Stored answers are not new model calls: the budget saw no tokens.
    const record = await store.readRecord();
    expect(record.budgetUsage.inputTokens).toBe(0);
    expect(record.budgetUsage.calls).toBe(0);
  });

  it("asks for a repair when the agent's answer does not match the schema", async () => {
    const root = await workspace();
    const directory = path.join(root, ".devflow", "agent");
    const agent = new AgentProvider({ directory });
    const svc = await services(root, model().provider, { provider: () => agent });
    const first = await startRun(
      {
        task: task(),
        taskFile: "tasks/TASK-7.yaml",
        mode: "assist",
        goal: "plan",
        settings: settings({ provider: "agent" }),
      },
      svc,
    );
    const id = agentRequestIdIn(first.error?.message ?? "");
    if (id === undefined) throw new Error("no request");
    await expect(writeAgentAnswer(directory, id, "not json")).rejects.toMatchObject({
      code: "AGENT_ANSWER_INVALID",
    });
    await writeAgentAnswer(directory, id, JSON.stringify({ unexpected: true }));
    const next = await resumeRun(first.runId, svc);
    // The gateway asked again with the problems: a new request for the agent.
    const repairId = agentRequestIdIn(next.error?.message ?? "");
    expect(next.error?.code).toBe("AGENT_INPUT_REQUIRED");
    expect(repairId).toBeDefined();
    expect(repairId).not.toBe(id);
  });
});
