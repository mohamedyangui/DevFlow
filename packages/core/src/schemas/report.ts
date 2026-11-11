import { z } from "zod";
import { Finding } from "./findings.js";
import { ContractImpact } from "./impact.js";
import { Contradiction, Dependency, EdgeCase, ImplementationPlan, Risk } from "./plan.js";
import {
  AcceptanceCriterionId,
  GitCommit,
  IsoDateTime,
  RepoPath,
  RequirementId,
  Sha256,
  TaskId,
} from "./primitives.js";
import { AcceptanceVerification, TaskSource } from "./task.js";
import { GateResult, ResultStatus, TestEvidence } from "./verification.js";
import { WorkflowMode, WorkflowState, isTerminalState } from "./workflow.js";

/**
 * The machine-readable engineering report. The JSON report is the source of truth; Markdown
 * is rendered from it (ADR 0013). The invariants below make it impossible to produce a valid
 * report that calls something verified without evidence.
 */

/** Overall verdict of a completed run. Separate from the workflow state (ADR 0013). */
export const Verdict = z.enum([
  "verified",
  "partially_verified",
  "failed_verification",
  "not_verified",
]);
export type Verdict = z.infer<typeof Verdict>;

/**
 * Evidence-seeking review (ADR 0025): a test the model proposed to confirm one of its own
 * findings, run in an isolated worktree. Only `confirmed` (the targeted test failed on an
 * assertion) makes the finding confirmed; a probe that passed leaves it unverified.
 */
export const EvidenceProbe = z.strictObject({
  findingId: z.string().min(1),
  outcome: z.enum(["confirmed", "not_reproduced", "inconclusive", "refused", "declined"]),
  /** What happened, redacted. */
  reason: z.string().min(1),
  /** The probe test file, relative to the workspace (it was written only in the worktree). */
  testFile: RepoPath.optional(),
  testName: z.string().min(1).optional(),
  /** SHA-256 of the probe file's content as it ran. */
  sha256: Sha256.optional(),
  /** Where the run directory keeps a copy of the probe, for a person to keep or delete. */
  artifact: z.string().min(1).optional(),
  commandId: z.string().min(1).optional(),
});
export type EvidenceProbe = z.infer<typeof EvidenceProbe>;

export const AcceptanceStatus = z.enum(["verified", "failed", "unverified", "not_executed", "manual"]);
export type AcceptanceStatus = z.infer<typeof AcceptanceStatus>;

export const AcceptanceMatrixRow = z
  .strictObject({
    acId: AcceptanceCriterionId,
    requirementIds: z.array(RequirementId),
    verification: AcceptanceVerification,
    tests: z.array(
      z.strictObject({
        testId: z.string().min(1),
        gateId: z.string().min(1),
        status: ResultStatus,
        evidence: TestEvidence.optional(),
      }),
    ),
    status: AcceptanceStatus,
    note: z.string().optional(),
  })
  .superRefine((row, ctx) => {
    if ((row.verification === "manual") !== (row.status === "manual")) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: 'status "manual" is used exactly for manually verified criteria',
      });
    }
    if (row.status === "verified") {
      if (row.tests.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["tests"],
          message: "a criterion can only be verified by at least one executed test",
        });
      }
      row.tests.forEach((test, index) => {
        if (test.status !== "passed") {
          ctx.addIssue({
            code: "custom",
            path: ["tests", index, "status"],
            message: "a verified criterion requires every linked test to have passed",
          });
        }
      });
    }
    if (row.status === "failed" && !row.tests.some((test) => test.status === "failed")) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: 'status "failed" requires at least one failed test',
      });
    }
  });
export type AcceptanceMatrixRow = z.infer<typeof AcceptanceMatrixRow>;

export const FileChange = z.strictObject({
  path: RepoPath,
  change: z.enum(["added", "modified", "deleted"]),
  planChangeId: z.string().optional(),
});
export type FileChange = z.infer<typeof FileChange>;

export const UsageSummary = z.strictObject({
  calls: z.int().nonnegative(),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().optional(),
});
export type UsageSummary = z.infer<typeof UsageSummary>;

export const EngineeringReport = z
  .strictObject({
    schemaVersion: z.literal(1),
    run: z.strictObject({
      id: z.string().min(1),
      devflowVersion: z.string().min(1),
      mode: WorkflowMode,
      state: WorkflowState,
      startedAt: IsoDateTime,
      finishedAt: IsoDateTime,
      baseCommit: GitCommit.optional(),
      headCommit: GitCommit.optional(),
      branch: z.string().optional(),
      /** Review mode: the pull request that was reviewed (Phase 5). */
      pullRequest: z
        .strictObject({
          repository: z.string().min(1),
          number: z.int().positive(),
          url: z.string().min(1),
        })
        .optional(),
    }),
    verdict: Verdict,
    task: z.strictObject({ id: TaskId, title: z.string().min(1), source: TaskSource }),
    plan: ImplementationPlan.optional(),
    /** What requirements analysis found beyond risks and assumptions. */
    analysis: z
      .strictObject({
        edgeCases: z.array(EdgeCase),
        contradictions: z.array(
          Contradiction.extend({
            /** The person's answer to the linked question, or null while it is open. */
            resolution: z.string().nullable(),
          }),
        ),
        dependencies: z.array(Dependency),
      })
      .optional(),
    filesChanged: z.array(FileChange),
    acceptanceMatrix: z.array(AcceptanceMatrixRow),
    gates: z.array(GateResult),
    findings: z.array(Finding),
    risks: z.array(Risk),
    assumptions: z.array(z.string()),
    manualChecks: z.array(z.string()),
    /**
     * Review mode: the consumers of each breaking contract change (ADR 0022), found by
     * deterministic heuristics; leads for a person to check.
     */
    impact: z.array(ContractImpact).optional(),
    usage: UsageSummary.optional(),
    /** Review mode with `--seek-evidence` (ADR 0025). */
    evidenceProbes: z
      .strictObject({
        /** Why no probe ran, when none did. */
        skipped: z.string().min(1).optional(),
        probes: z.array(EvidenceProbe),
      })
      .optional(),
  })
  .superRefine((report, ctx) => {
    report.evidenceProbes?.probes.forEach((probe, index) => {
      const finding = report.findings.find((candidate) => candidate.id === probe.findingId);
      const confirmed = finding?.verification === "confirmed";
      if (probe.outcome === "confirmed" ? !confirmed : confirmed) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceProbes", "probes", index, "outcome"],
          message:
            probe.outcome === "confirmed"
              ? `probe of ${probe.findingId} confirmed a finding the report does not confirm`
              : `finding ${probe.findingId} is confirmed although its probe did not confirm it`,
        });
      }
    });
    if (!isTerminalState(report.run.state)) {
      ctx.addIssue({
        code: "custom",
        path: ["run", "state"],
        message: "reports are produced for terminal states only",
      });
    }
    if (report.verdict !== "verified") return;

    if (report.run.state !== "COMPLETED") {
      ctx.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "only a completed run can be verified",
      });
    }
    if (report.gates.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gates"],
        message: "a verified verdict requires at least one executed verification gate",
      });
    }
    report.gates.forEach((gate, index) => {
      if (gate.required && gate.status !== "passed") {
        ctx.addIssue({
          code: "custom",
          path: ["gates", index, "status"],
          message: `required gate "${gate.gateId}" did not pass`,
        });
      }
    });
    report.acceptanceMatrix.forEach((row, index) => {
      if (row.verification === "automated" && row.status !== "verified") {
        ctx.addIssue({
          code: "custom",
          path: ["acceptanceMatrix", index, "status"],
          message: `acceptance criterion ${row.acId} is not verified`,
        });
      }
    });
    report.findings.forEach((finding, index) => {
      const blocking = finding.severity === "critical" || finding.severity === "high";
      if (blocking && finding.verification === "confirmed") {
        ctx.addIssue({
          code: "custom",
          path: ["findings", index],
          message: `confirmed ${finding.severity} finding "${finding.id}" prevents a verified verdict`,
        });
      }
    });
  });
export type EngineeringReport = z.infer<typeof EngineeringReport>;
