/**
 * Classification of red/green test evidence (ADR 0015, docs/specs/verification-and-evidence.md).
 *
 * The rules are intentionally strict:
 * - Only an executed test that fails on an assertion counts as valid "red" evidence for a
 *   feature test. Compilation failures and infrastructure errors never count.
 * - A feature test that already passes on the baseline is NOT automatically invalid; it is
 *   classified `unexpected_pass` and must be reviewed (the behaviour may already exist).
 * - Regression and characterization tests are expected to pass on the baseline.
 */

/** Why a test exists. */
export type TestIntent = "feature" | "regression" | "characterization";

/** Detailed outcome of one test on one revision. */
export type TestOutcome =
  | "passed"
  | "assertion_failure"
  | "runtime_error"
  | "compile_error"
  | "infrastructure_error"
  | "timeout"
  | "not_found"
  | "skipped"
  | "not_executed";

/** Coarse status shown in reports. */
export type ResultStatus = "passed" | "failed" | "skipped" | "not_executed" | "unverified";

/** How the baseline (pre-change) outcome relates to what the test's intent expects. */
export type BaselineAssessment =
  "expected" | "unexpected_pass" | "unexpected_failure" | "inconclusive" | "invalid";

/** How the post-change outcome should be read. */
export type AfterAssessment = "passed" | "failed" | "not_verified";

export interface TestEvidenceAssessment {
  readonly baselineAssessment: BaselineAssessment;
  readonly afterAssessment: AfterAssessment;
  /** True only when both the baseline and the post-change outcomes match the intent. */
  readonly established: boolean;
}

/**
 * Outcomes that mean the test never produced a trustworthy verdict on that revision.
 * None of them can be used as red-phase evidence.
 */
const NON_EVIDENCE_OUTCOMES: ReadonlySet<TestOutcome> = new Set<TestOutcome>([
  "compile_error",
  "infrastructure_error",
  "timeout",
  "not_found",
  "skipped",
  "not_executed",
]);

export function assessBaseline(intent: TestIntent, baseline: TestOutcome): BaselineAssessment {
  if (NON_EVIDENCE_OUTCOMES.has(baseline)) return "invalid";
  switch (intent) {
    case "feature":
      if (baseline === "assertion_failure") return "expected";
      if (baseline === "passed") return "unexpected_pass";
      // An unexpected exception (e.g. TypeError, NullPointerException) may mean the feature is
      // missing or that the test itself is broken; it needs review before it counts as red.
      return "inconclusive";
    case "regression":
    case "characterization":
      return baseline === "passed" ? "expected" : "unexpected_failure";
  }
}

export function assessAfterChange(after: TestOutcome): AfterAssessment {
  switch (after) {
    case "passed":
      return "passed";
    case "assertion_failure":
    case "runtime_error":
    case "compile_error":
      // A compilation failure after the change is a failure of the change itself.
      return "failed";
    case "infrastructure_error":
    case "timeout":
    case "not_found":
    case "skipped":
    case "not_executed":
      return "not_verified";
  }
}

export function assessTestEvidence(
  intent: TestIntent,
  baseline: TestOutcome,
  after: TestOutcome,
): TestEvidenceAssessment {
  const baselineAssessment = assessBaseline(intent, baseline);
  const afterAssessment = assessAfterChange(after);
  return {
    baselineAssessment,
    afterAssessment,
    established: baselineAssessment === "expected" && afterAssessment === "passed",
  };
}

/** Maps a detailed outcome to the coarse report status. */
export function statusForOutcome(outcome: TestOutcome): ResultStatus {
  switch (outcome) {
    case "passed":
      return "passed";
    case "assertion_failure":
    case "runtime_error":
      return "failed";
    case "skipped":
      return "skipped";
    case "compile_error":
    case "not_found":
    case "not_executed":
      // The test itself never ran.
      return "not_executed";
    case "infrastructure_error":
    case "timeout":
      // The test may have started, but no trustworthy verdict exists.
      return "unverified";
  }
}
