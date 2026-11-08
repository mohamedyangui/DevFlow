import { describe, expect, it } from "vitest";
import {
  VerificationSnapshot,
  compareSnapshots,
  type GateResult,
  type TestCaseResult,
} from "../../src/index.js";

const execution = {
  commandId: "app:test",
  argv: ["node", "test.mjs"],
  cwd: "app",
  invocation: "direct" as const,
  approval: { via: "trust-store" as const },
  startedAt: "2026-03-01T10:00:00.000Z",
  durationMs: 10,
  exitCode: 1,
  signal: null,
  timedOut: false,
  stdoutPath: ".devflow/runs/verify/x/logs/a.stdout.log",
  stderrPath: ".devflow/runs/verify/x/logs/a.stderr.log",
  outputTruncated: false,
};

function test(
  id: string,
  status: "passed" | "failed" | "skipped" | "not_executed",
): TestCaseResult {
  const outcome = {
    passed: "passed",
    failed: "assertion_failure",
    skipped: "skipped",
    not_executed: "compile_error",
  } as const;
  return { id, name: id, outcome: outcome[status], status, markers: [] };
}

function gate(
  gateId: string,
  status: GateResult["status"],
  tests: TestCaseResult[],
  commandId = "app:test",
): GateResult {
  return {
    gateId,
    commandId,
    required: true,
    status,
    ...(status === "not_executed" ? { reason: "denied" } : { execution }),
    tests,
    diagnostics: [],
    evidence: [],
  };
}

function snapshot(gates: GateResult[]): VerificationSnapshot {
  return VerificationSnapshot.parse({ version: 1, createdAt: "2026-03-01T10:00:00.000Z", gates });
}

describe("VerificationSnapshot", () => {
  it("accepts a saved verification and rejects a malformed commit", () => {
    const valid = snapshot([gate("app-test", "failed", [test("a", "failed")])]);
    expect(
      VerificationSnapshot.parse({ ...valid, gitCommit: "a".repeat(40) }).gitCommit,
    ).toHaveLength(40);
    expect(VerificationSnapshot.safeParse({ ...valid, gitCommit: "HEAD" }).success).toBe(false);
    expect(VerificationSnapshot.safeParse({ ...valid, version: 2 }).success).toBe(false);
  });

  it("keeps the gate invariants: a passed gate needs an execution", () => {
    const { execution: _dropped, ...unexecuted } = gate("app-test", "passed", []);
    expect(
      VerificationSnapshot.safeParse({
        version: 1,
        createdAt: "2026-03-01T10:00:00.000Z",
        gates: [unexecuted],
      }).success,
    ).toBe(false);
  });
});

describe("compareSnapshots", () => {
  it("classifies every test that ran in both verifications", () => {
    const baseline = snapshot([
      gate("app-test", "failed", [
        test("keeps-passing", "passed"),
        test("regresses", "passed"),
        test("gets-fixed", "failed"),
        test("keeps-failing", "failed"),
        test("stops-running", "passed"),
        test("removed", "passed"),
      ]),
    ]);
    const current = snapshot([
      gate("app-test", "failed", [
        test("keeps-passing", "passed"),
        test("regresses", "failed"),
        test("gets-fixed", "passed"),
        test("keeps-failing", "failed"),
        test("stops-running", "not_executed"),
        test("new", "passed"),
      ]),
    ]);
    const comparison = compareSnapshots(baseline, current);
    const ids = (changes: readonly { testId: string }[]) => changes.map((c) => c.testId);
    expect(ids(comparison.regressions)).toEqual(["regresses"]);
    expect(ids(comparison.fixed)).toEqual(["gets-fixed"]);
    expect(ids(comparison.stillFailing)).toEqual(["keeps-failing"]);
    expect(comparison.otherChanges).toEqual([
      { gateId: "app-test", testId: "stops-running", before: "passed", after: "not_executed" },
    ]);
    expect(ids(comparison.added)).toEqual(["new"]);
    expect(ids(comparison.missing)).toEqual(["removed"]);
    expect(comparison.gateChanges).toEqual([]);
    expect(comparison.commandChanges).toEqual([]);
  });

  it("never counts a test that did not run as a regression", () => {
    const baseline = snapshot([gate("app-test", "failed", [test("a", "passed")])]);
    const current = snapshot([gate("app-test", "not_executed", [])]);
    const comparison = compareSnapshots(baseline, current);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.missing).toEqual([{ gateId: "app-test", testId: "a" }]);
    expect(comparison.gateChanges).toEqual([
      { gateId: "app-test", before: "failed", after: "not_executed" },
    ]);
  });

  it("keeps tests of different gates apart and reports changed commands", () => {
    const baseline = snapshot([
      gate("web-test", "failed", [test("same-name", "passed")]),
      gate("api-test", "failed", [test("same-name", "failed")], "api:test"),
    ]);
    const current = snapshot([
      gate("web-test", "failed", [test("same-name", "passed")]),
      gate("api-test", "failed", [test("same-name", "passed")], "api:test-filter"),
    ]);
    const comparison = compareSnapshots(baseline, current);
    expect(comparison.fixed).toEqual([
      { gateId: "api-test", testId: "same-name", before: "failed", after: "passed" },
    ]);
    expect(comparison.regressions).toEqual([]);
    expect(comparison.commandChanges).toEqual(["api-test"]);
  });
});
