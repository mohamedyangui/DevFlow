import { describe, expect, it } from "vitest";
import {
  TestCaseResult,
  TestEvidence,
  assessAfterChange,
  assessBaseline,
  assessTestEvidence,
  statusForOutcome,
  type TestOutcome,
} from "../src/index.js";

describe("assessBaseline", () => {
  it.each<[TestOutcome, string]>([
    ["assertion_failure", "expected"],
    ["passed", "unexpected_pass"],
    ["runtime_error", "inconclusive"],
    ["compile_error", "invalid"],
    ["infrastructure_error", "invalid"],
    ["timeout", "invalid"],
    ["not_found", "invalid"],
    ["skipped", "invalid"],
    ["not_executed", "invalid"],
  ])("feature test, baseline %s -> %s", (baseline, expected) => {
    expect(assessBaseline("feature", baseline)).toBe(expected);
  });

  it.each(["regression", "characterization"] as const)(
    "%s tests are expected to pass on the baseline",
    (intent) => {
      expect(assessBaseline(intent, "passed")).toBe("expected");
      expect(assessBaseline(intent, "assertion_failure")).toBe("unexpected_failure");
      expect(assessBaseline(intent, "runtime_error")).toBe("unexpected_failure");
      expect(assessBaseline(intent, "compile_error")).toBe("invalid");
      expect(assessBaseline(intent, "infrastructure_error")).toBe("invalid");
    },
  );
});

describe("assessAfterChange", () => {
  it.each<[TestOutcome, string]>([
    ["passed", "passed"],
    ["assertion_failure", "failed"],
    ["runtime_error", "failed"],
    ["compile_error", "failed"],
    ["infrastructure_error", "not_verified"],
    ["timeout", "not_verified"],
    ["not_found", "not_verified"],
    ["skipped", "not_verified"],
    ["not_executed", "not_verified"],
  ])("%s -> %s", (after, expected) => {
    expect(assessAfterChange(after)).toBe(expected);
  });
});

describe("assessTestEvidence", () => {
  it("establishes red/green evidence only for an assertion failure followed by a pass", () => {
    expect(assessTestEvidence("feature", "assertion_failure", "passed").established).toBe(true);
  });

  it("never accepts a compilation failure as red evidence", () => {
    expect(assessTestEvidence("feature", "compile_error", "passed")).toEqual({
      baselineAssessment: "invalid",
      afterAssessment: "passed",
      established: false,
    });
  });

  it("never accepts an infrastructure error as red evidence", () => {
    expect(assessTestEvidence("feature", "infrastructure_error", "passed").established).toBe(false);
  });

  it("flags, but does not invalidate, a feature test that already passes", () => {
    expect(assessTestEvidence("feature", "passed", "passed")).toEqual({
      baselineAssessment: "unexpected_pass",
      afterAssessment: "passed",
      established: false,
    });
  });

  it("accepts regression and characterization tests that pass before and after", () => {
    expect(assessTestEvidence("regression", "passed", "passed").established).toBe(true);
    expect(assessTestEvidence("characterization", "passed", "passed").established).toBe(true);
  });

  it("does not establish evidence when the test fails after the change", () => {
    expect(
      assessTestEvidence("feature", "assertion_failure", "assertion_failure").established,
    ).toBe(false);
  });
});

describe("statusForOutcome", () => {
  it.each<[TestOutcome, string]>([
    ["passed", "passed"],
    ["assertion_failure", "failed"],
    ["runtime_error", "failed"],
    ["skipped", "skipped"],
    ["compile_error", "not_executed"],
    ["not_found", "not_executed"],
    ["not_executed", "not_executed"],
    ["infrastructure_error", "unverified"],
    ["timeout", "unverified"],
  ])("%s -> %s", (outcome, status) => {
    expect(statusForOutcome(outcome)).toBe(status);
  });
});

describe("schemas enforce the evidence rules", () => {
  it("rejects TestEvidence whose assessment contradicts the outcomes", () => {
    const result = TestEvidence.safeParse({
      intent: "feature",
      baseline: "compile_error",
      after: "passed",
      baselineAssessment: "expected",
      afterAssessment: "passed",
      established: true,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toEqual([
      "baselineAssessment",
      "established",
    ]);
  });

  it("accepts consistent TestEvidence", () => {
    expect(
      TestEvidence.safeParse({
        intent: "feature",
        baseline: "assertion_failure",
        after: "passed",
        ...assessTestEvidence("feature", "assertion_failure", "passed"),
      }).success,
    ).toBe(true);
  });

  it("rejects a test result whose status contradicts its outcome", () => {
    const result = TestCaseResult.safeParse({
      id: "OrderTest#ac1_page",
      name: "ac1_page",
      outcome: "compile_error",
      status: "failed",
      markers: ["AC-1"],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'outcome "compile_error" must be reported as "not_executed"',
    );
  });
});
