import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FakeProvider, type FakeReply } from "@devflow-ai/ai";
import {
  EngineeringReport,
  ErrorCode,
  type GateDefinition,
  type GateResult,
  type LlmRequest,
  type VerificationRun,
  type WorkspaceModule,
  readAuditLog,
} from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import {
  RunStore,
  type TestRunner,
  TestEvidenceRecord,
  approvePlan,
  approveTests,
  cancelRun,
  getRun,
  rejectTests,
  resumeRun,
  startRun,
} from "../src/index.js";
import {
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

const TEST_CONTENT = [
  'import { describe, expect, it } from "vitest";',
  'import { listOrders } from "./orders";',
  "",
  'describe("listOrders", () => {',
  '  it("AC-1: page 2 with size 10 returns orders 11 to 20", () => {',
  "    const orders = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), total: 1 }));",
  '    expect(listOrders(orders, 2, 10).map((o) => o.id)).toEqual(["11", "12"]);',
  "  });",
  "});",
  "",
].join("\n");

interface WireTest {
  acIds?: string[];
  path?: string;
  action?: "create" | "modify";
  content?: string | null;
  edits?: { search: string; replace: string }[];
}

function testAnswer(tests: WireTest[] = [{}]): string {
  return JSON.stringify({
    summary: "A feature test for pagination.",
    tests: tests.map((test) => ({
      acIds: test.acIds ?? ["AC-1"],
      module: null,
      path: test.path ?? TEST_FILE,
      action: test.action ?? "create",
      content: test.content === undefined ? TEST_CONTENT : test.content,
      edits: test.edits ?? [],
      description: "Checks the second page.",
    })),
  });
}

function isTestDesign(request: LlmRequest): boolean {
  return request.system.includes("test engineer");
}

/** Answers analysis, planning and test-design calls from three queues. */
function model(tests: FakeReply[] = [testAnswer()]) {
  const queue = [...tests];
  const requests: LlmRequest[] = [];
  const provider = new FakeProvider((request) => {
    if (isAnalysis(request)) return analysisAnswer();
    if (!isTestDesign(request)) return planAnswer();
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

const GATE: GateDefinition = { id: "test-shop", module: "shop", use: "test", required: true };

function gateResult(outcome: "assertion_failure" | "passed"): GateResult {
  return {
    gateId: "test-shop",
    commandId: "vitest",
    required: true,
    status: outcome === "passed" ? "passed" : "failed",
    execution: {
      commandId: "vitest",
      argv: ["npx", "vitest", "run"],
      cwd: ".",
      invocation: "direct",
      approval: { via: "allowlist-flag", approvedBy: "mohamed" },
      startedAt: "2026-11-07T10:00:00.000Z",
      durationMs: 1200,
      exitCode: outcome === "passed" ? 0 : 1,
      signal: null,
      timedOut: false,
      stdoutPath: ".devflow/runs/x/logs/commands/vitest.out",
      stderrPath: ".devflow/runs/x/logs/commands/vitest.err",
      outputTruncated: false,
    },
    tests: [
      {
        id: `${TEST_FILE} > listOrders > AC-1: page 2 with size 10 returns orders 11 to 20`,
        name: "AC-1: page 2 with size 10 returns orders 11 to 20",
        file: TEST_FILE,
        outcome,
        status: outcome === "passed" ? "passed" : "failed",
        markers: ["AC-1"],
        ...(outcome === "passed" ? {} : { message: "expected [ '1', '2' ] to deeply equal" }),
      },
    ],
    diagnostics: [],
    evidence: [],
  };
}

/** A test runner that answers each run from a queue and records what it was asked to run. */
function fakeRunner(root: string, runs: (() => VerificationRun)[]) {
  const calls: { gates: readonly GateDefinition[]; fileExisted: boolean; logDir: string }[] = [];
  const queue = [...runs];
  const runner: TestRunner = {
    modules: [MODULE],
    gates: () => Promise.resolve([GATE, { ...GATE, id: "lint-shop", use: "lint" }]),
    run: async (gates, context) => {
      const fileExisted = await readFile(path.join(root, ...TEST_FILE.split("/"))).then(
        () => true,
        () => false,
      );
      calls.push({ gates, fileExisted, logDir: context.logDir });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === undefined) throw new Error("no scripted run");
      return next();
    },
  };
  return { runner, calls };
}

const RED = (): VerificationRun => ({ gates: [gateResult("assertion_failure")], denials: [] });

async function startTest(
  root: string,
  provider: FakeProvider,
  runner: TestRunner | undefined,
  overrides: Parameters<typeof settings>[0] = {},
) {
  const svc = await services(
    root,
    provider,
    runner === undefined ? {} : { testRunner: () => Promise.resolve(runner) },
  );
  const outcome = await startRun(
    {
      task: task(),
      taskFile: "tasks/TASK-7.yaml",
      mode: "test",
      goal: "test",
      settings: settings(overrides),
    },
    svc,
  );
  return { svc, outcome, store: await RunStore.open(root, outcome.runId) };
}

function promptAt(requests: readonly LlmRequest[], index: number): string {
  const request = requests[index];
  if (request === undefined) throw new Error(`no test-design request ${String(index)}`);
  return userText(request);
}

async function read(root: string, file: string): Promise<string | undefined> {
  return readFile(path.join(root, ...file.split("/")), "utf8").catch(() => undefined);
}

describe("test mode", () => {
  it("writes the tests, waits for approval, runs them red and reports the evidence", async () => {
    const root = await workspace();
    const { provider, requests } = model();
    const { runner, calls } = fakeRunner(root, [RED]);
    const { svc, outcome, store } = await startTest(root, provider, runner);
    expect(outcome).toMatchObject({ mode: "test", status: "waiting", waitingFor: "plan-approval" });

    const waiting = await approvePlan(outcome.runId, { by: "mohamed" }, svc);
    expect(waiting).toMatchObject({
      state: "TEST_DESIGN",
      status: "waiting",
      waitingFor: "test-approval",
      testFiles: [TEST_FILE],
      testsPath: `.devflow/runs/${outcome.runId}/artifacts/test-design.md`,
    });
    // Written, but not run: model-written code runs only after a person approved it.
    expect(await read(root, TEST_FILE)).toBe(TEST_CONTENT);
    expect(calls).toEqual([]);
    const md = await store.readText("artifacts/test-design.md");
    expect(md).toContain(`create \`${TEST_FILE}\` (module shop) for AC-1`);
    expect(md).toContain("they have not run");
    // The prompt gives the module's guide and the approved plan; it never asks for production code.
    const prompt = promptAt(requests, 0);
    expect(prompt).toContain("Criterion marker (title-prefix)");
    expect(prompt).toContain("## Approved plan");
    expect(prompt).toContain("### src/orders.test.ts");

    const record = (await getRun(root, outcome.runId)).record;
    expect(record.pending?.kind).toBe("test-approval");
    expect(record.iterations.testDesign).toBe(1);

    const done = await approveTests(outcome.runId, { by: "mohamed" }, svc);
    expect(done).toMatchObject({ state: "COMPLETED", status: "completed" });
    // Only the test gate of the module the tests belong to, with the file in place.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.gates.map((gate) => gate.id)).toEqual(["test-shop"]);
    expect(calls[0]?.fileExisted).toBe(true);
    expect(calls[0]?.logDir).toBe(`.devflow/runs/${outcome.runId}/logs/commands`);

    const evidence = TestEvidenceRecord.parse(
      JSON.parse(await store.readText("artifacts/test-evidence.json")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]?.evidence).toEqual({
      intent: "feature",
      baseline: "assertion_failure",
      after: "not_executed",
      baselineAssessment: "expected",
      afterAssessment: "not_verified",
      established: false,
    });

    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.verdict).toBe("not_verified");
    expect(report.filesChanged).toEqual([{ path: TEST_FILE, change: "added" }]);
    expect(report.gates.map((gate) => gate.gateId)).toEqual(["test-shop"]);
    expect(report.findings).toEqual([]);
    const [ac1, ac2] = report.acceptanceMatrix;
    expect(ac1).toMatchObject({ acId: "AC-1", status: "unverified" });
    expect(ac1?.tests[0]).toMatchObject({ status: "failed", gateId: "test-shop" });
    expect(ac1?.note).toContain("assertion_failure (expected)");
    expect(ac2?.status).toBe("manual");
    const reportMd = await store.readText("report.md");
    expect(reportMd).toContain("## Test evidence before the change");
    expect(reportMd).toContain("no criterion is verified: the implementation has not run");
    expect(reportMd).toContain("Tests approved by:** mohamed");
    expect(reportMd).toContain("Test mode writes and runs tests only");

    const audit = await readAuditLog(store.path("audit.jsonl"));
    expect(audit.filter((entry) => entry.type === "file-write")).toHaveLength(1);
    expect(
      audit.some(
        (entry) =>
          entry.type === "decision" && entry.subject === "tests" && entry.decision === "approved",
      ),
    ).toBe(true);
    // Production code was not touched.
    expect(await read(root, "src/orders.ts")).toContain("return orders;");
  });

  it("reports a feature test that passes before any change", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner } = fakeRunner(root, [() => ({ gates: [gateResult("passed")], denials: [] })]);
    const { svc, outcome, store } = await startTest(root, provider, runner, {
      requirePlanApproval: false,
    });
    // Without plan approval the tests are designed at once; they still need approval.
    expect(outcome).toMatchObject({ status: "waiting", waitingFor: "test-approval" });
    await approveTests(outcome.runId, { by: "mohamed" }, svc);
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.findings.map((finding) => [finding.category, finding.verification])).toEqual([
      ["test-fidelity", "confirmed"],
    ]);
    expect(report.acceptanceMatrix[0]?.note).toContain("passed (unexpected pass)");
    expect(report.verdict).toBe("not_verified");
  });

  it("restores the files and writes the tests again when they are rejected", async () => {
    const root = await workspace();
    const second = testAnswer([
      {
        path: "src/orders.test.ts",
        action: "modify",
        content: null,
        edits: [
          {
            search: 'import { listOrders } from "./orders";\n',
            replace: `import { listOrders } from "./orders";\nit("AC-1: second page", () => {});\n`,
          },
        ],
      },
    ]);
    const { provider, requests } = model([testAnswer(), second]);
    const { runner } = fakeRunner(root, [RED]);
    const { svc, outcome, store } = await startTest(root, provider, runner, {
      requirePlanApproval: false,
    });
    const first = (await getRun(root, outcome.runId)).record.pending;

    const again = await rejectTests(
      outcome.runId,
      { by: "mohamed", feedback: "Edit the existing test file instead." },
      svc,
    );
    expect(again).toMatchObject({ status: "waiting", testFiles: ["src/orders.test.ts"] });
    expect(await read(root, TEST_FILE)).toBeUndefined();
    expect(await read(root, "src/orders.test.ts")).toContain('it("AC-1: second page"');
    expect(promptAt(requests, 1)).toContain("Edit the existing test file instead.");
    const pending = (await getRun(root, outcome.runId)).record.pending;
    expect(pending).not.toEqual(first);
    expect(JSON.parse(await store.readText("artifacts/test-feedback.json"))).toMatchObject({
      entries: [{ iteration: 1, feedback: "Edit the existing test file instead." }],
    });

    // Cancelling restores nothing: the report tells a person to review the unapproved files.
    await cancelRun(outcome.runId, { by: "mohamed" }, svc);
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.filesChanged).toEqual([{ path: "src/orders.test.ts", change: "modified" }]);
    expect(report.manualChecks.join("\n")).toContain(
      "which no person approved: src/orders.test.ts",
    );
  });

  it("refuses to approve or restore tests changed after they were written", async () => {
    const root = await workspace();
    const { provider } = model();
    const { runner, calls } = fakeRunner(root, [RED]);
    const { svc, outcome } = await startTest(root, provider, runner, {
      requirePlanApproval: false,
    });
    await writeFile(path.join(root, "src", "pagination.test.ts"), "// edited by hand\n");
    await expect(approveTests(outcome.runId, { by: "mohamed" }, svc)).rejects.toMatchObject({
      code: ErrorCode.TestFilesChanged,
    });
    await expect(
      rejectTests(outcome.runId, { by: "mohamed", feedback: "no" }, svc),
    ).rejects.toMatchObject({ code: ErrorCode.TestFilesChanged });
    expect(await read(root, TEST_FILE)).toBe("// edited by hand\n");
    expect(calls).toEqual([]);
    expect((await getRun(root, outcome.runId)).outcome.status).toBe("waiting");
  });

  it("fails without writing anything when the model keeps writing production code", async () => {
    const root = await workspace();
    const production = testAnswer([
      {
        path: "src/orders.ts",
        action: "modify",
        content: null,
        edits: [{ search: "return orders;", replace: "return []; // AC-1" }],
      },
    ]);
    const { provider, requests } = model([production]);
    const { runner } = fakeRunner(root, [RED]);
    const { outcome, store } = await startTest(root, provider, runner, {
      requirePlanApproval: false,
    });
    expect(outcome).toMatchObject({
      state: "FAILED",
      status: "failed",
      error: { code: ErrorCode.TestDesignInvalid },
    });
    expect(requests).toHaveLength(2);
    expect(promptAt(requests, 1)).toContain("failed these deterministic checks");
    expect(await read(root, "src/orders.ts")).toContain("return orders;");
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    expect(report.filesChanged).toEqual([]);
    expect(await store.exists("artifacts/test-design-checks.json")).toBe(true);
  });

  it("stops when a command is not approved and continues once it is", async () => {
    const root = await workspace();
    const { provider } = model();
    const denied = (): VerificationRun => ({
      gates: [
        {
          gateId: "test-shop",
          commandId: "vitest",
          required: true,
          status: "not_executed",
          reason: "the command needs approval",
          tests: [],
          diagnostics: [],
          evidence: [],
        },
      ],
      denials: [
        {
          gateId: "test-shop",
          commandId: "vitest",
          argv: ["npx", "vitest", "run"],
          cwd: ".",
          reason: "approval-required",
          message: "the command needs approval",
          fingerprint: "a".repeat(64),
        },
      ],
    });
    const { runner, calls } = fakeRunner(root, [denied, RED]);
    const { svc, outcome, store } = await startTest(root, provider, runner, {
      requirePlanApproval: false,
    });
    const stopped = await approveTests(outcome.runId, { by: "mohamed" }, svc);
    expect(stopped).toMatchObject({
      state: "VERIFICATION",
      status: "interrupted",
      error: { code: ErrorCode.CommandNotApproved },
      denials: [{ commandId: "vitest", fingerprint: "a".repeat(64) }],
    });
    expect(await store.exists("report.json")).toBe(false);

    const resumed = await resumeRun(outcome.runId, svc);
    expect(resumed).toMatchObject({ state: "COMPLETED", status: "completed" });
    expect(calls).toHaveLength(2);
  });

  it("needs a test runner from its caller", async () => {
    const root = await workspace();
    const { provider } = model();
    const { outcome } = await startTest(root, provider, undefined, {
      requirePlanApproval: false,
    });
    expect(outcome).toMatchObject({
      state: "TEST_DESIGN",
      status: "interrupted",
      error: { code: ErrorCode.TestRunnerUnavailable },
    });
  });

  it("runs only with the test goal", async () => {
    const root = await workspace();
    const { provider } = model();
    const svc = await services(root, provider);
    const input = { task: task(), taskFile: null, settings: settings() };
    await expect(startRun({ ...input, mode: "test", goal: "plan" }, svc)).rejects.toMatchObject({
      code: ErrorCode.InvalidTransition,
    });
    await expect(startRun({ ...input, mode: "assist", goal: "test" }, svc)).rejects.toMatchObject({
      code: ErrorCode.InvalidTransition,
    });
  });
});
