import { Finding, type GateResult, type TestCaseResult } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import { classifyProbe, probeCandidates, probedFinding } from "../src/index.js";

/** The deterministic rules of evidence-seeking review (ADR 0025). */

const PROBE_FILE = ".devflow/probes/worktree/src/sum-probe.test.js";

function finding(id: string, overrides: Partial<Finding> = {}): Finding {
  return Finding.parse({
    id,
    title: `finding ${id}`,
    severity: "high",
    category: "regression",
    source: "ai",
    verification: "unverified",
    confidence: 0.5,
    evidence: [{ kind: "note", description: "a model's suspicion", deterministic: false }],
    location: { path: "src/sum.js", line: 3 },
    recommendation: "Fix it.",
    ...overrides,
  });
}

function gate(tests: TestCaseResult[], overrides: Partial<GateResult> = {}): GateResult {
  return {
    gateId: "javascript-probe",
    commandId: "javascript:test-filter",
    required: true,
    status: tests.some((test) => test.status === "failed") ? "failed" : "passed",
    execution: {
      commandId: "javascript:test-filter",
      argv: ["node", "vitest.mjs", "--testNamePattern", "sum adds"],
      cwd: ".devflow/probes/worktree",
      invocation: "direct",
      approval: { via: "allowlist-flag", approvedBy: "mohamed" },
      startedAt: "2026-11-11T10:00:00.000Z",
      durationMs: 100,
      exitCode: 1,
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

const test = (
  name: string,
  outcome: TestCaseResult["outcome"],
  file = PROBE_FILE,
): TestCaseResult => ({
  id: `${file}#${name}`,
  name,
  file,
  outcome,
  status: outcome === "passed" ? "passed" : outcome === "skipped" ? "skipped" : "failed",
  markers: [],
  ...(outcome === "passed" ? {} : { message: "AssertionError: expected 3 to be 6" }),
});

const classify = (result: GateResult) =>
  classifyProbe({ gate: result, probeFile: PROBE_FILE, testName: "sum adds" });

describe("probeCandidates", () => {
  it("selects unverified AI findings of medium or higher with a location, most severe first", () => {
    const findings = [
      finding("F-1", { severity: "medium" }),
      finding("F-2", { severity: "low" }),
      finding("F-3", { source: "deterministic" }),
      finding("F-4", { location: undefined }),
      finding("F-5", { severity: "critical" }),
      finding("F-6", { severity: "high", confidence: 0.9 }),
      finding("F-7", { severity: "high", confidence: 0.2 }),
    ];
    expect(probeCandidates(findings, 3)).toEqual({
      selected: [findings[4], findings[5], findings[6]],
      notProbed: ["F-1"],
    });
  });
});

describe("classifyProbe", () => {
  it("confirms only on an assertion failure of the targeted test", () => {
    const result = classify(gate([test("sum adds", "assertion_failure")]));
    expect(result).toMatchObject({ outcome: "confirmed", testId: `${PROBE_FILE}#sum adds` });
    // The same name failing in another file does not count while the probe's own test ran.
    expect(
      classify(
        gate([
          test("sum adds", "passed"),
          test("sum adds", "assertion_failure", "src/other.test.js"),
        ]),
      ).outcome,
    ).toBe("not_reproduced");
  });

  it("is not reproduced when the targeted test passed", () => {
    expect(classify(gate([test("sum adds", "passed")]))).toMatchObject({
      outcome: "not_reproduced",
      reason: "probe passed: not reproduced",
    });
  });

  it("is inconclusive on a runtime error, a compile error, a timeout, no test or no run", () => {
    expect(classify(gate([test("sum adds", "runtime_error")])).outcome).toBe("inconclusive");
    expect(classify(gate([test("sum-probe.test.js (test file)", "compile_error")]))).toMatchObject({
      outcome: "inconclusive",
      reason: expect.stringContaining("compile error") as string,
    });
    expect(classify(gate([]))).toMatchObject({
      outcome: "inconclusive",
      reason: expect.stringContaining('no test named "sum adds" ran') as string,
    });
    const passed = gate([]);
    const timedOut = gate([test("sum adds", "assertion_failure")], {
      ...(passed.execution === undefined
        ? {}
        : { execution: { ...passed.execution, timedOut: true } }),
    });
    expect(classify(timedOut)).toMatchObject({
      outcome: "inconclusive",
      reason: expect.stringContaining("timed out") as string,
    });
    const { execution: _ignored, ...notRun } = gate([]);
    expect(
      classify({ ...notRun, status: "not_executed", reason: "the tool is not installed" }),
    ).toMatchObject({
      outcome: "inconclusive",
      reason: expect.stringContaining("not installed") as string,
    });
    expect(
      classifyProbe({
        gate: { ...notRun, status: "not_executed", reason: "denied" },
        denial: {
          gateId: "javascript-probe",
          commandId: "javascript:test-filter",
          argv: [],
          cwd: ".",
          reason: "approval-required",
          message: "approval required",
          fingerprint: "f".repeat(64),
        },
        probeFile: PROBE_FILE,
        testName: "sum adds",
      }),
    ).toMatchObject({
      outcome: "inconclusive",
      reason: expect.stringContaining("--allow") as string,
    });
  });
});

describe("probedFinding", () => {
  it("confirms with deterministic evidence, and otherwise only adds a note", () => {
    const base = finding("F-1");
    const confirmed = probedFinding(base, {
      findingId: "F-1",
      outcome: "confirmed",
      reason: "failed",
      testFile: "src/sum-probe.test.js",
      testName: "sum adds",
      sha256: "a".repeat(64),
      argv: ["node", "vitest.mjs"],
      exitCode: 1,
      testId: "src/sum-probe.test.js#sum adds",
    });
    expect(Finding.parse(confirmed).verification).toBe("confirmed");
    expect(confirmed.evidence.filter((item) => item.deterministic)).toHaveLength(3);

    for (const outcome of ["not_reproduced", "inconclusive", "refused", "declined"] as const) {
      const after = probedFinding(base, { findingId: "F-1", outcome, reason: "why" });
      expect(after.verification, outcome).toBe("unverified");
      expect(after.evidence).toHaveLength(base.evidence.length + 1);
    }
  });
});
