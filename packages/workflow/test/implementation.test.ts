import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type GateResult,
  ImplementationPlan,
  PathGuard,
  type TestCaseResult,
  TestEvidence,
  assessTestEvidence,
} from "@devflowai/core";
import { describe, expect, it } from "vitest";
import {
  type EvidenceEntry,
  type ImplementationWire,
  type TestDesign,
  type TestModule,
  afterEvidence,
  assessAfterRun,
  changeFilesRecord,
  changesHash,
  checkImplementation,
  failureSummary,
} from "../src/index.js";
import { task, workspace } from "./helpers.js";

const MODULE: TestModule = {
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
  guide: {
    framework: "vitest",
    testRoot: "src",
    fileNamePattern: "{name}.test.ts",
    acMarker: { style: "title-prefix", example: 'it("AC-1: ...")' },
    notes: [],
  },
} as unknown as TestModule;

const PLAN = ImplementationPlan.parse({
  taskId: "TASK-7",
  summary: "Paginate listOrders.",
  approach: "Slice the array.",
  relevantFiles: [],
  changes: [
    {
      id: "CH-1",
      module: "shop",
      path: "src/orders.ts",
      action: "modify",
      description: "Paginate.",
      satisfies: ["AC-1"],
    },
    {
      id: "CH-2",
      module: "shop",
      path: "src/page.ts",
      action: "create",
      description: "A page helper.",
      satisfies: ["AC-1"],
    },
    {
      id: "CH-3",
      module: "shop",
      path: "src/settings.ts",
      action: "delete",
      description: "No longer needed.",
      satisfies: [],
    },
  ],
  interfaceChanges: [],
  testStrategy: [],
  risks: [],
  regressionWatch: [],
  openQuestions: [],
});

type Change = ImplementationWire["changes"][number];

function change(overrides: Partial<Change>): Change {
  return {
    path: "src/orders.ts",
    action: "modify",
    content: null,
    edits: [{ search: "return orders;", replace: "return orders.slice(0, 10);" }],
    changeId: null,
    description: "Paginate.",
    ...overrides,
  };
}

async function check(changes: Change[], repair = false) {
  const root = await workspace();
  const result = await checkImplementation({
    wire: { summary: "A change.", changes },
    plan: PLAN,
    modules: [MODULE],
    testFiles: new Set(["src/pagination.test.ts"]),
    guard: await PathGuard.create(root),
    repair,
  });
  const codes = result.checks.map((item) => `${item.severity}:${item.code}`);
  return { root, ...result, codes };
}

describe("checkImplementation", () => {
  it("accepts the plan's files and links each change to its plan change", async () => {
    const { files, changes, codes } = await check([
      change({ changeId: "CH-9" }),
      change({
        path: "src/page.ts",
        action: "create",
        content: "export const size = 10;\n",
        edits: [],
      }),
      change({ path: "src/settings.ts", action: "delete", edits: [] }),
    ]);
    expect(codes).toEqual(["warning:change-corrected"]);
    expect(changes.map((item) => `${item.planChangeId} ${item.action} ${item.path}`)).toEqual([
      "CH-1 modify src/orders.ts",
      "CH-2 create src/page.ts",
      "CH-3 delete src/settings.ts",
    ]);
    expect(files[0]?.after).toContain("orders.slice(0, 10)");
    expect(files[1]?.before).toBeNull();
    expect(files[2]?.after).toBeNull();
    const record = changeFilesRecord(files, 1);
    expect(record.files[2]).toMatchObject({ action: "delete", afterSha256: null });
    expect(record.changesSha256).toBe(changesHash(record.files));
  });

  it("rejects test files, files outside the plan, unplanned deletions and unusable edits", async () => {
    const { codes, files } = await check([
      change({ path: "src/pagination.test.ts" }),
      change({ path: "src/orders.test.ts" }),
      change({ path: "src/other.ts", action: "create", content: "x", edits: [] }),
      change({ path: "../outside.ts" }),
      change({ path: "src/page.ts", action: "delete", edits: [] }),
      change({ path: "src/orders.ts", edits: [{ search: "not in the file", replace: "x" }] }),
    ]);
    expect(codes).toEqual([
      "error:test-file",
      "error:test-file",
      "error:out-of-plan",
      "error:invalid-path",
      "error:delete-not-planned",
      "error:edit-not-applicable",
      // A planned file with an error is reported by it; only CH-3 is not attempted.
      "warning:unaddressed-change",
    ]);
    expect(files).toEqual([]);
  });

  it("requires an action that matches the file and a real change", async () => {
    const { codes } = await check([
      change({ action: "create", content: "export {};\n", edits: [] }),
      change({ path: "src/page.ts", action: "modify" }),
    ]);
    expect(codes).toEqual([
      "error:file-exists",
      "error:missing-file",
      "warning:unaddressed-change",
    ]);
    const same = await check(
      [change({ edits: [{ search: "return orders;", replace: "return orders;" }] })],
      true,
    );
    expect(same.codes).toEqual(["error:no-change"]);
    const none = await check([]);
    expect(none.codes).toEqual(["error:no-changes"]);
  });

  it("does not expect a repair to carry out every plan change", async () => {
    const { codes } = await check([change({})], true);
    expect(codes).toEqual([]);
  });

  it("never reads a file outside the workspace", async () => {
    const { root } = await check([change({})]);
    expect(await readFile(path.join(root, "src", "orders.ts"), "utf8")).toContain("return orders;");
  });
});

const DESIGN: TestDesign = {
  schemaVersion: 1,
  taskId: "TASK-7",
  iteration: 1,
  summary: "Tests.",
  tests: [
    {
      id: "T-1",
      acIds: ["AC-1"],
      module: "shop",
      path: "src/pagination.test.ts",
      action: "create",
      description: "Page 2.",
    },
  ],
  revised: false,
  checks: [],
};

function gate(tests: TestCaseResult[], overrides: Partial<GateResult> = {}): GateResult {
  const failed = tests.some((test) => test.status === "failed");
  return {
    gateId: "test-shop",
    commandId: "vitest",
    required: true,
    status: failed ? "failed" : "passed",
    execution: {
      commandId: "vitest",
      argv: ["node", "vitest.mjs"],
      cwd: ".",
      invocation: "direct",
      approval: { via: "allowlist-flag", approvedBy: "mohamed" },
      startedAt: "2026-11-07T10:00:00.000Z",
      durationMs: 10,
      exitCode: failed ? 1 : 0,
      signal: null,
      timedOut: false,
      stdoutPath: "out",
      stderrPath: "err",
      outputTruncated: false,
    },
    tests,
    diagnostics: [],
    evidence: [],
    ...overrides,
  };
}

const AC_TEST: TestCaseResult = {
  id: "src/pagination.test.ts > AC-1: page 2",
  name: "AC-1: page 2",
  file: "src/pagination.test.ts",
  outcome: "passed",
  status: "passed",
  markers: ["AC-1"],
};

function entry(outcome: EvidenceEntry["outcome"], testId: string): EvidenceEntry {
  return {
    acId: "AC-1",
    designedTestId: "T-1",
    testId,
    gateId: "test-shop",
    file: "src/pagination.test.ts",
    outcome,
    evidence: TestEvidence.parse({
      intent: "feature",
      baseline: outcome,
      after: "not_executed",
      ...assessTestEvidence("feature", outcome, "not_executed"),
    }),
  };
}

describe("afterEvidence", () => {
  const gateOfModule = new Map([["shop", "test-shop"]]);

  it("pairs a test with its own baseline result", () => {
    const entries = afterEvidence({
      task: task(),
      design: DESIGN,
      baseline: [entry("assertion_failure", AC_TEST.id)],
      gates: [gate([AC_TEST])],
      gateOfModule,
    });
    expect(entries.map((item) => item.evidence)).toEqual([
      expect.objectContaining({
        baseline: "assertion_failure",
        after: "passed",
        established: true,
      }),
    ]);
  });

  it("never establishes a test that had no baseline result", () => {
    // The test did not compile before the change; after it, it passes.
    const entries = afterEvidence({
      task: task(),
      design: DESIGN,
      baseline: [entry("compile_error", "src/pagination.test.ts")],
      gates: [gate([AC_TEST])],
      gateOfModule,
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ testId: AC_TEST.id, outcome: "compile_error" });
    expect(entries[0]?.evidence).toMatchObject({
      baselineAssessment: "invalid",
      after: "passed",
      established: false,
    });
  });

  it("gives a test that vanished after the change the reason it has no result", () => {
    const entries = afterEvidence({
      task: task(),
      design: DESIGN,
      baseline: [entry("assertion_failure", AC_TEST.id)],
      gates: [gate([], { status: "unverified", reason: "the report could not be read" })],
      gateOfModule,
    });
    expect(entries[0]?.evidence).toMatchObject({
      after: "infrastructure_error",
      afterAssessment: "not_verified",
    });
    expect(entries[0]?.afterMessage).toBe("the report could not be read");
  });
});

describe("assessAfterRun", () => {
  const base = {
    attempt: 1,
    ranAt: "2026-11-07T10:00:00.000Z",
    changesSha256: "a".repeat(64),
    rerun: [],
    maxRepairAttempts: 1,
  };
  const failing = {
    ...AC_TEST,
    outcome: "assertion_failure" as const,
    status: "failed" as const,
    message: "boom",
  };

  it("stops when no gate ran, and when nothing a repair can fix failed", () => {
    expect(assessAfterRun({ ...base, baseline: [], gates: [] })).toMatchObject({
      decision: "stop",
      reason: "no gate ran after the change",
    });
    const denied = gate([], { status: "not_executed", reason: "toolchain missing" });
    const { execution: _execution, ...notRun } = denied;
    expect(assessAfterRun({ ...base, baseline: [], gates: [notRun] })).toMatchObject({
      decision: "stop",
      failedGates: ["test-shop"],
    });
  });

  it("repairs while attempts remain, then stops", () => {
    const gates = [gate([failing])];
    expect(assessAfterRun({ ...base, baseline: gates, gates, rerun: gates }).decision).toBe(
      "repair",
    );
    const last = assessAfterRun({ ...base, attempt: 2, baseline: gates, gates, rerun: gates });
    expect(last.decision).toBe("stop");
    expect(last.stillFailing).toEqual([{ gateId: "test-shop", testId: AC_TEST.id }]);
  });

  it("summarises the failures for the repair, capped", () => {
    const gates = [gate([failing])];
    const after = assessAfterRun({ ...base, baseline: [], gates, rerun: gates });
    expect(failureSummary(after)).toEqual([
      "Gate test-shop (vitest): failed",
      `- test ${AC_TEST.id} (assertion_failure): boom`,
    ]);
    expect(failureSummary(after, 1)).toEqual([
      "Gate test-shop (vitest): failed",
      "(1 more line(s) not shown)",
    ]);
  });
});
