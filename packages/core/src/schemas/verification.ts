import { z } from "zod";
import {
  assessTestEvidence,
  statusForOutcome,
  type TestEvidenceAssessment,
} from "../verification/test-evidence.js";
import { ExecutionRecord } from "./command.js";
import { AcceptanceCriterionId, Evidence, RepoPath, SourceLocation } from "./primitives.js";

/**
 * Verification results. Invariants enforced here (docs/specs/verification-and-evidence.md):
 * - nothing is `passed` without an execution record;
 * - `not_executed` and `unverified` always carry a reason;
 * - red/green assessments must agree with the recorded outcomes.
 */

export const ResultStatus = z.enum(["passed", "failed", "skipped", "not_executed", "unverified"]);
export type ResultStatus = z.infer<typeof ResultStatus>;

export const TestIntent = z
  .enum(["feature", "regression", "characterization"])
  .meta({
    description:
      "feature: new or corrected behaviour (expected to fail before the change); regression: existing behaviour that must keep working; characterization: captures current behaviour before refactoring.",
  });
export type TestIntent = z.infer<typeof TestIntent>;

export const TestLevel = z.enum(["unit", "integration", "e2e"]);
export type TestLevel = z.infer<typeof TestLevel>;

export const TestOutcome = z.enum([
  "passed",
  "assertion_failure",
  "runtime_error",
  "compile_error",
  "infrastructure_error",
  "timeout",
  "not_found",
  "skipped",
  "not_executed",
]);
export type TestOutcome = z.infer<typeof TestOutcome>;

export const BaselineAssessment = z.enum([
  "expected",
  "unexpected_pass",
  "unexpected_failure",
  "inconclusive",
  "invalid",
]);
export type BaselineAssessment = z.infer<typeof BaselineAssessment>;

export const AfterAssessment = z.enum(["passed", "failed", "not_verified"]);
export type AfterAssessment = z.infer<typeof AfterAssessment>;

/** Red/green evidence for one test. The assessments must match the outcomes. */
export const TestEvidence = z
  .strictObject({
    intent: TestIntent,
    baseline: TestOutcome,
    after: TestOutcome,
    baselineAssessment: BaselineAssessment,
    afterAssessment: AfterAssessment,
    established: z.boolean(),
  })
  .superRefine((evidence, ctx) => {
    const expected: TestEvidenceAssessment = assessTestEvidence(
      evidence.intent,
      evidence.baseline,
      evidence.after,
    );
    for (const key of ["baselineAssessment", "afterAssessment", "established"] as const) {
      if (evidence[key] !== expected[key]) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `inconsistent with the recorded outcomes (expected ${String(expected[key])})`,
        });
      }
    }
  });
export type TestEvidence = z.infer<typeof TestEvidence>;

export const TestCaseResult = z
  .strictObject({
    /** Stable identifier, e.g. `com.acme.OrderControllerTest#ac1_returnsSecondPage`. */
    id: z.string().min(1),
    name: z.string(),
    file: RepoPath.optional(),
    outcome: TestOutcome,
    status: ResultStatus,
    /** Acceptance criteria referenced by the test's marker (ADR 0015). */
    markers: z.array(AcceptanceCriterionId),
    durationMs: z.int().nonnegative().optional(),
    /** Failure message, already redacted. */
    message: z.string().max(8000).optional(),
  })
  .superRefine((test, ctx) => {
    const expected = statusForOutcome(test.outcome);
    if (test.status !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: `outcome "${test.outcome}" must be reported as "${expected}"`,
      });
    }
  });
export type TestCaseResult = z.infer<typeof TestCaseResult>;

export const Diagnostic = z.strictObject({
  tool: z.string().min(1),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1),
  ruleId: z.string().optional(),
  location: SourceLocation.optional(),
});
export type Diagnostic = z.infer<typeof Diagnostic>;

/** What an adapter extracts from a command's output. The verification engine adds context. */
export const ParsedCommandResults = z.strictObject({
  /** `unparseable` when no machine-readable result could be found. Never guess. */
  parse: z.enum(["parsed", "unparseable"]),
  tests: z.array(TestCaseResult),
  diagnostics: z.array(Diagnostic),
  evidence: z.array(Evidence),
  note: z.string().optional(),
});
export type ParsedCommandResults = z.infer<typeof ParsedCommandResults>;

export const GateResult = z
  .strictObject({
    gateId: z.string().min(1),
    commandId: z.string().min(1),
    required: z.boolean(),
    status: ResultStatus,
    reason: z.string().min(1).optional(),
    execution: ExecutionRecord.optional(),
    tests: z.array(TestCaseResult),
    diagnostics: z.array(Diagnostic),
    evidence: z.array(Evidence),
  })
  .superRefine((gate, ctx) => {
    const executed = gate.execution !== undefined;
    if ((gate.status === "passed" || gate.status === "failed" || gate.status === "skipped") && !executed) {
      ctx.addIssue({
        code: "custom",
        path: ["execution"],
        message: `a gate can only be "${gate.status}" if it was executed`,
      });
    }
    if (gate.status === "not_executed" && executed) {
      ctx.addIssue({
        code: "custom",
        path: ["execution"],
        message: 'a "not_executed" gate must not have an execution record',
      });
    }
    if ((gate.status === "not_executed" || gate.status === "unverified") && gate.reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: `a "${gate.status}" gate must explain why`,
      });
    }
    if (gate.status === "passed") {
      if (gate.execution !== undefined && (gate.execution.exitCode !== 0 || gate.execution.timedOut)) {
        ctx.addIssue({
          code: "custom",
          path: ["status"],
          message: "a passed gate requires exit code 0 and no timeout",
        });
      }
      gate.tests.forEach((test, index) => {
        if (test.status !== "passed" && test.status !== "skipped") {
          ctx.addIssue({
            code: "custom",
            path: ["tests", index, "status"],
            message: `a passed gate cannot contain a "${test.status}" test`,
          });
        }
      });
    }
  });
export type GateResult = z.infer<typeof GateResult>;
