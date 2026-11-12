import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type GateResult,
  type ModuleProfile,
  PathGuard,
  type TestCaseResult,
  type TestOutcome,
} from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import {
  type TestDesign,
  type TestDesignWire,
  type TestModule,
  applyEdits,
  baselineEvidence,
  baselineFindings,
  checkTestDesign,
  hasMarker,
  isTestPath,
  testFilesRecord,
  testsHash,
} from "../src/index.js";
import { task, workspace } from "./helpers.js";

function profile(overrides: Partial<ModuleProfile> = {}): ModuleProfile {
  return {
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
    ...overrides,
  };
}

const JS: TestModule = {
  profile: profile(),
  guide: {
    framework: "vitest",
    testRoot: "src",
    fileNamePattern: "{name}.test.ts",
    acMarker: { style: "title-prefix", example: 'it("AC-1: ...")' },
    notes: [],
  },
};

const JAVA: TestModule = {
  profile: profile({
    moduleId: "api",
    adapterId: "java",
    root: "api",
    sourceRoots: ["api/src/main/java"],
    testRoots: ["api/src/test/java"],
  }),
  guide: {
    framework: "junit5",
    testRoot: "api/src/test/java",
    fileNamePattern: "{name}Test.java",
    acMarker: { style: "method-name-prefix", example: "void ac1_returnsSecondPage()" },
    notes: [],
  },
};

const NEW_TEST = [
  'import { describe, expect, it } from "vitest";',
  'import { listOrders } from "./orders";',
  "",
  'describe("listOrders", () => {',
  '  it("AC-1: page 2 with size 10 returns orders 11 to 20", () => {',
  "    expect(listOrders([], 2, 10)).toEqual([]);",
  "  });",
  "});",
  "",
].join("\n");

function wire(tests: Partial<TestDesignWire["tests"][number]>[]): TestDesignWire {
  return {
    summary: "Tests for pagination.",
    tests: tests.map((test) => ({
      acIds: ["AC-1"],
      module: null,
      path: "src/pagination.test.ts",
      action: "create",
      content: NEW_TEST,
      edits: [],
      description: "Pagination tests.",
      ...test,
    })),
  };
}

async function check(tests: Partial<TestDesignWire["tests"][number]>[]) {
  const root = await workspace();
  return checkTestDesign({
    wire: wire(tests),
    task: task(),
    modules: [JS, JAVA],
    guard: await PathGuard.create(root),
  });
}

describe("test paths and markers", () => {
  it("accepts test files only, inside a module's test roots", () => {
    expect(isTestPath("src/orders.test.ts", JS)).toBe(true);
    expect(isTestPath("src/orders.spec.tsx", JS)).toBe(true);
    // Colocated with the sources: only files named like tests.
    expect(isTestPath("src/orders.ts", JS)).toBe(false);
    expect(isTestPath("lib/orders.test.ts", JS)).toBe(false);
    // A root that holds only tests accepts helpers too.
    expect(isTestPath("api/src/test/java/com/acme/OrderTest.java", JAVA)).toBe(true);
    expect(isTestPath("api/src/test/java/com/acme/Fixtures.java", JAVA)).toBe(true);
    expect(isTestPath("api/src/main/java/com/acme/Order.java", JAVA)).toBe(false);
  });

  it("finds the marker the adapter parses", () => {
    expect(hasMarker('it("AC-1: works", () => {})', "AC-1", "title-prefix")).toBe(true);
    expect(hasMarker("describe('AC-2', () => {})", "AC-2", "title-prefix")).toBe(true);
    expect(hasMarker('it("AC-12: works")', "AC-1", "title-prefix")).toBe(false);
    expect(hasMarker("// covers AC-1", "AC-1", "title-prefix")).toBe(false);
    expect(hasMarker("void ac1_returnsPage() {}", "AC-1", "method-name-prefix")).toBe(true);
    expect(hasMarker("void bac1_x() {}", "AC-1", "method-name-prefix")).toBe(false);
    expect(hasMarker("void ac1_ac2_x() {}", "AC-2", "method-name-prefix")).toBe(true);
    expect(hasMarker("def test_ac1_page():", "AC-1", "method-name-prefix")).toBe(true);
    expect(hasMarker("def test_ac1_ac3_page():", "AC-3", "method-name-prefix")).toBe(true);
    expect(hasMarker("def test_ac12_page():", "AC-1", "method-name-prefix")).toBe(false);
    expect(hasMarker("def test_bac1_page():", "AC-1", "method-name-prefix")).toBe(false);
    expect(hasMarker('@DisplayName("AC-1: page")', "AC-1", "method-name-prefix")).toBe(true);
  });
});

describe("applyEdits", () => {
  it("applies each edit where its search text occurs exactly once", () => {
    expect(applyEdits("a\nb\nc\n", [{ search: "b\n", replace: "b\nB\n" }])).toEqual({
      text: "a\nb\nB\nc\n",
    });
    expect(applyEdits("x x", [{ search: "x", replace: "y" }])).toEqual({
      error: "the search text occurs 2 times; it must identify one place",
      index: 0,
    });
    expect(applyEdits("abc", [{ search: "z", replace: "y" }])).toMatchObject({ index: 0 });
    expect(applyEdits("abc", [{ search: "", replace: "y" }])).toMatchObject({ index: 0 });
  });

  it("accepts LF search text in a CRLF file and keeps its line endings", () => {
    expect(applyEdits("a\r\nb\r\n", [{ search: "a\nb\n", replace: "a\nb\nc\n" }])).toEqual({
      text: "a\r\nb\r\nc\r\n",
    });
  });
});

describe("checkTestDesign", () => {
  it("accepts a new test file that carries the criterion's marker", async () => {
    const { tests, files, checks } = await check([{}]);
    expect(checks.filter((c) => c.severity === "error")).toEqual([]);
    expect(tests).toEqual([
      {
        id: "T-1",
        acIds: ["AC-1"],
        module: "shop",
        path: "src/pagination.test.ts",
        action: "create",
        description: "Pagination tests.",
      },
    ]);
    expect(files).toEqual([
      { path: "src/pagination.test.ts", action: "create", before: null, after: NEW_TEST },
    ]);
  });

  it("modifies an existing test file with edits", async () => {
    const { files, checks } = await check([
      {
        path: "src/orders.test.ts",
        action: "modify",
        content: null,
        edits: [
          {
            search: 'import { listOrders } from "./orders";\n',
            replace: 'import { listOrders } from "./orders";\nit("AC-1: pages", () => {});\n',
          },
        ],
      },
    ]);
    expect(checks.filter((c) => c.severity === "error")).toEqual([]);
    expect(files[0]?.before).toBe('import { listOrders } from "./orders";\n');
    expect(files[0]?.after).toContain('it("AC-1: pages"');
  });

  it("refuses production code, protected paths and paths outside the workspace", async () => {
    const { tests, checks } = await check([
      { path: "src/orders.ts", action: "modify", content: null, edits: [] },
      { path: ".devflow/config.test.ts" },
      { path: "../outside.test.ts" },
    ]);
    expect(tests).toEqual([]);
    expect(checks.map((c) => c.code)).toEqual([
      "not-a-test-file",
      "not-a-test-file",
      "invalid-path",
      "untested-criterion",
    ]);
  });

  it("rejects files without marker, unusable edits, and existing files to create", async () => {
    const { checks } = await check([
      { content: NEW_TEST.replace("AC-1: ", "") },
      { path: "src/orders.test.ts" },
      {
        path: "src/a.test.ts",
        action: "modify",
        content: null,
        edits: [{ search: "x", replace: "y" }],
      },
    ]);
    expect(checks.filter((c) => c.severity === "error").map((c) => c.code)).toEqual([
      "missing-marker",
      "file-exists",
      "missing-file",
    ]);
  });

  it("drops manual and unknown criteria, and needs at least one automated one", async () => {
    const { tests, checks } = await check([{ acIds: ["AC-2", "AC-9"] }]);
    expect(tests).toEqual([]);
    expect(checks.map((c) => c.code)).toEqual([
      "manual-criterion",
      "unknown-criterion",
      "no-criterion",
      "untested-criterion",
    ]);
  });

  it("rejects an empty design", async () => {
    const { checks } = await check([]);
    expect(checks.map((c) => c.code)).toContain("no-tests");
  });

  it("binds the written files to one hash", async () => {
    const { files } = await check([{}]);
    const record = testFilesRecord(files);
    expect(record.files[0]?.afterSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(record.testsSha256).toBe(testsHash(record.files));
    expect(testsHash([])).not.toBe(record.testsSha256);
    // The design never writes anything itself.
    const root = await workspace();
    await expect(readFile(path.join(root, "src", "pagination.test.ts"))).rejects.toThrow();
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
      description: "Pagination.",
    },
  ],
  revised: false,
  checks: [],
};

function result(outcome: TestOutcome, overrides: Partial<TestCaseResult> = {}): TestCaseResult {
  const status =
    outcome === "passed"
      ? "passed"
      : outcome === "skipped"
        ? "skipped"
        : outcome === "not_executed"
          ? "not_executed"
          : "failed";
  return {
    id: "src/pagination.test.ts > AC-1: pages",
    name: "AC-1: pages",
    file: "src/pagination.test.ts",
    outcome,
    status,
    markers: ["AC-1"],
    ...overrides,
  };
}

function gate(overrides: Partial<GateResult> = {}): GateResult {
  return {
    gateId: "test-shop",
    commandId: "vitest",
    required: true,
    status: "failed",
    execution: { exitCode: 1, timedOut: false, durationMs: 10 },
    tests: [],
    diagnostics: [],
    evidence: [],
    ...overrides,
  } as GateResult;
}

function evidence(gates: GateResult[], intent: "feature" | "regression" = "feature") {
  const base = task();
  return baselineEvidence({
    task: {
      ...base,
      acceptanceCriteria: base.acceptanceCriteria.map((c) =>
        c.id === "AC-1" ? { ...c, testIntent: intent } : c,
      ),
    },
    design: DESIGN,
    gates,
    gateOfModule: new Map(gates.length === 0 ? [] : [["shop", "test-shop"]]),
  });
}

describe("baselineEvidence", () => {
  it("records a feature test that fails on an assertion as the expected red", () => {
    const [entry] = evidence([gate({ tests: [result("assertion_failure", { message: "x" })] })]);
    expect(entry).toMatchObject({
      acId: "AC-1",
      designedTestId: "T-1",
      gateId: "test-shop",
      outcome: "assertion_failure",
      message: "x",
      evidence: {
        intent: "feature",
        baseline: "assertion_failure",
        after: "not_executed",
        baselineAssessment: "expected",
        afterAssessment: "not_verified",
        established: false,
      },
    });
  });

  it("assesses each outcome by the criterion's intent (ADR 0015)", () => {
    const assess = (outcome: TestOutcome, intent: "feature" | "regression") =>
      evidence([gate({ tests: [result(outcome)] })], intent)[0]?.evidence.baselineAssessment;
    expect(assess("passed", "feature")).toBe("unexpected_pass");
    expect(assess("runtime_error", "feature")).toBe("inconclusive");
    expect(assess("passed", "regression")).toBe("expected");
    expect(assess("assertion_failure", "regression")).toBe("unexpected_failure");
  });

  it("never invents an outcome for a test without a result", () => {
    const outcome = (gates: GateResult[]) => evidence(gates)[0]?.outcome;
    expect(outcome([])).toBe("not_executed");
    expect(
      outcome([gate({ status: "not_executed", execution: undefined, reason: "denied" })]),
    ).toBe("not_executed");
    expect(
      outcome([gate({ execution: { exitCode: null, timedOut: true, durationMs: 1 } as never })]),
    ).toBe("timeout");
    expect(
      outcome([
        gate({
          diagnostics: [
            {
              tool: "tsc",
              severity: "error",
              message: "Expected 1 arguments",
              location: { path: "src/pagination.test.ts" },
            },
          ],
        }),
      ]),
    ).toBe("compile_error");
    expect(outcome([gate({ status: "unverified", reason: "unparseable" })])).toBe(
      "infrastructure_error",
    );
    expect(outcome([gate({ tests: [result("passed", { markers: [] })] })])).toBe("not_found");
    expect(evidence([])[0]?.evidence.baselineAssessment).toBe("invalid");
  });
});

describe("baselineFindings", () => {
  it("reports deterministic facts about the red run, never a guess", () => {
    const findings = baselineFindings({
      task: task(),
      design: DESIGN,
      entries: evidence([gate({ tests: [result("passed")] })]),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      id: "F-1",
      source: "deterministic",
      verification: "confirmed",
      category: "test-fidelity",
      title: "AC-1: the feature test src/pagination.test.ts > AC-1: pages passed before any change",
    });
    expect(findings[0]?.evidence[0]?.deterministic).toBe(true);
  });

  it("has nothing to report for an expected red, and reports criteria without tests", () => {
    const red = evidence([gate({ tests: [result("assertion_failure")] })]);
    expect(baselineFindings({ task: task(), design: DESIGN, entries: red })).toEqual([]);
    const gap = baselineFindings({
      task: task(),
      design: { ...DESIGN, tests: DESIGN.tests.map((test) => ({ ...test, acIds: ["AC-9"] })) },
      entries: [],
    });
    expect(gap.map((finding) => [finding.category, finding.title])).toEqual([
      ["test-gap", "AC-1 has no test"],
    ]);
  });
});
