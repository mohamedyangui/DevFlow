import {
  EngineeringReport,
  type Finding,
  type ImplementationPlan,
  type Risk,
  type TaskContract,
  statusForOutcome,
} from "@devflow/core";
import type {
  BaselineRun,
  Clarifications,
  EvidenceEntry,
  PlanCheck,
  RequirementsAnalysis,
  RunRecord,
  TestDesign,
  TestEvidenceRecord,
  TestFiles,
} from "./schemas.js";

export interface ReportInput {
  readonly record: RunRecord;
  readonly task: TaskContract;
  readonly analysis?: RequirementsAnalysis | undefined;
  readonly clarifications?: Clarifications | undefined;
  readonly plan?: ImplementationPlan | undefined;
  /** Set when the plan was approved by a person. */
  readonly planApproval?: { by: string; at: string } | undefined;
  /** Test mode: the tests, the files written, their approval and the red run. */
  readonly testDesign?: TestDesign | undefined;
  readonly testFiles?: TestFiles | undefined;
  readonly testsApproval?: { by: string; at: string } | undefined;
  readonly baseline?: BaselineRun | undefined;
  readonly evidence?: TestEvidenceRecord | undefined;
  readonly findings?: readonly Finding[] | undefined;
}

/**
 * Builds the engineering report of a finished run (ADR 0013).
 *
 * Assist mode runs no gates and no tests, so the verdict is always `not_verified` and every
 * automated acceptance criterion is `not_executed`. Test mode runs the tests once, before any
 * change: the red/green evidence is reported per criterion, but nothing is implemented, so no
 * criterion is verified and the verdict stays `not_verified`. The report is validated against
 * the core schema, whose invariants reject any overstatement.
 */
export function buildReport(input: ReportInput): EngineeringReport {
  const { record, task, analysis, plan } = input;
  const questions = input.clarifications?.questions ?? [];

  const risks: Risk[] = [];
  const seenRisks = new Set<string>();
  for (const risk of [...(plan?.risks ?? []), ...(analysis?.risks ?? [])]) {
    const key = risk.description.trim().toLowerCase();
    if (seenRisks.has(key)) continue;
    seenRisks.add(key);
    risks.push(risk);
  }

  const assumptions = [
    ...(analysis?.assumptions ?? []),
    ...questions
      .filter((question) => question.answer !== null)
      .map(
        (question) => `${question.id} ${question.question} Answer: ${question.answer?.text ?? ""}`,
      ),
    ...questions
      .filter((question) => question.answer === null)
      .map(
        (question) =>
          `Unanswered question ${question.id}${question.blocking ? " (blocking)" : ""}: ${question.question}`,
      ),
  ];

  // The analysis section is present only when the analysis found something to report.
  const found =
    analysis !== undefined &&
    analysis.edgeCases.length + analysis.contradictions.length + analysis.dependencies.length > 0;
  const analysisSection =
    analysis === undefined || !found
      ? undefined
      : {
          edgeCases: analysis.edgeCases,
          contradictions: analysis.contradictions.map((contradiction) => ({
            ...contradiction,
            resolution:
              questions.find((question) => question.id === contradiction.questionId)?.answer
                ?.text ?? null,
          })),
          dependencies: analysis.dependencies,
        };

  const written = input.testFiles?.files ?? [];
  const manualChecks = [
    ...task.acceptanceCriteria
      .filter((criterion) => criterion.verification === "manual")
      .map((criterion) => `${criterion.id}: ${criterion.statement}`),
    ...(plan === undefined || input.planApproval !== undefined || record.state !== "COMPLETED"
      ? []
      : ["Review the implementation plan: it was not approved by a person in this run."]),
    ...(written.length === 0 || input.testsApproval !== undefined
      ? []
      : [
          `Review or remove the test files this run wrote, which no person approved: ${written.map((file) => file.path).join(", ")}.`,
        ]),
  ];

  const entries = input.evidence?.entries ?? [];
  const designed = (acId: string) =>
    written.length > 0 &&
    input.testDesign?.tests.some((test) => test.acIds.includes(acId)) === true;

  return EngineeringReport.parse({
    schemaVersion: 1,
    run: {
      id: record.id,
      devflowVersion: record.devflowVersion,
      mode: record.mode,
      state: record.state,
      startedAt: record.createdAt,
      finishedAt: record.finishedAt ?? record.updatedAt,
    },
    verdict: "not_verified",
    task: { id: task.id, title: task.title, source: task.source },
    ...(plan === undefined ? {} : { plan }),
    ...(analysisSection === undefined ? {} : { analysis: analysisSection }),
    filesChanged: written.map((file) => ({
      path: file.path,
      change: file.action === "create" ? "added" : "modified",
    })),
    acceptanceMatrix: task.acceptanceCriteria.map((criterion) => {
      const row = {
        acId: criterion.id,
        requirementIds: criterion.covers,
        verification: criterion.verification,
      };
      if (criterion.verification === "manual") {
        return {
          ...row,
          tests: [],
          status: "manual",
          note: "verified by a person, outside DevFlow",
        };
      }
      const linked = entries.filter((entry) => entry.acId === criterion.id);
      if (linked.length === 0) {
        return {
          ...row,
          tests: [],
          status: "not_executed",
          note:
            record.mode === "assist"
              ? "assist mode does not write or run tests"
              : designed(criterion.id)
                ? "the test written for it has not run"
                : "no test was written for it",
        };
      }
      return {
        ...row,
        tests: linked.map((entry) => ({
          testId: entry.testId,
          gateId: entry.gateId,
          status: statusForOutcome(entry.outcome),
          evidence: entry.evidence,
        })),
        // Evidence from before the change cannot verify a criterion: nothing was implemented.
        status: linked.every((entry) => entry.outcome === "not_executed")
          ? "not_executed"
          : "unverified",
        note:
          `before the change: ${linked.map((entry) => `${entry.outcome} (${entry.evidence.baselineAssessment.replace("_", " ")})`).join(", ")}; ` +
          "the implementation has not run",
      };
    }),
    gates: input.baseline?.gates ?? [],
    findings: input.findings ?? [],
    risks,
    assumptions,
    manualChecks,
    usage: {
      calls: record.budgetUsage.calls,
      inputTokens: record.budgetUsage.inputTokens,
      outputTokens: record.budgetUsage.outputTokens,
      // A cost is reported only when every call was priced; a partial sum would understate it.
      ...(record.budgetUsage.calls > 0 &&
      (record.budgetUsage.unpricedCalls ?? 0) === 0 &&
      record.budgetUsage.costUsd !== undefined
        ? { costUsd: record.budgetUsage.costUsd }
        : {}),
    },
  });
}

/** Renders the Markdown report from the JSON report; it adds nothing (ADR 0013). */
export function renderReportMarkdown(
  report: EngineeringReport,
  extra: {
    lastError?: RunRecord["lastError"];
    planApproval?: { by: string; at: string } | undefined;
    testsApproval?: { by: string; at: string } | undefined;
    evidence?: readonly EvidenceEntry[] | undefined;
  } = {},
): string {
  const lines: string[] = [];
  lines.push(`# DevFlow report: ${report.task.id} - ${escapeInline(report.task.title)}`, "");
  lines.push(
    `- **Run:** ${report.run.id}`,
    `- **Mode:** ${report.run.mode}`,
    `- **Workflow state:** ${report.run.state}`,
    `- **Verdict:** ${report.verdict}${verdictNote(report)}`,
    `- **Started:** ${report.run.startedAt}`,
    `- **Finished:** ${report.run.finishedAt}`,
  );
  if (report.usage !== undefined) {
    lines.push(
      `- **Model usage:** ${report.usage.calls} call(s), ${report.usage.inputTokens} input tokens, ` +
        `${report.usage.outputTokens} output tokens`,
    );
  }
  if (extra.planApproval !== undefined) {
    lines.push(
      `- **Plan approved by:** ${escapeInline(extra.planApproval.by)} at ${extra.planApproval.at}`,
    );
  }
  if (extra.testsApproval !== undefined) {
    lines.push(
      `- **Tests approved by:** ${escapeInline(extra.testsApproval.by)} at ${extra.testsApproval.at}`,
    );
  }
  if (extra.lastError !== undefined && extra.lastError !== null) {
    lines.push(
      `- **Stopped by:** ${extra.lastError.code}: ${escapeInline(extra.lastError.message)}`,
    );
  }
  lines.push("");

  lines.push("## Acceptance criteria", "");
  lines.push(
    "| Criterion | Covers | Verification | Status | Note |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const row of report.acceptanceMatrix) {
    lines.push(
      `| ${row.acId} | ${row.requirementIds.join(", ") || "-"} | ${row.verification} | ${row.status} | ${escapeCell(row.note ?? "")} |`,
    );
  }
  lines.push("");

  const evidence = extra.evidence ?? [];
  if (evidence.length > 0) {
    lines.push(
      "## Test evidence before the change",
      "",
      "Feature tests must fail on an assertion before the change (red); regression and " +
        "characterization tests must pass. Green evidence needs the implementation, which has not run.",
      "",
      "| Criterion | Test | Intent | Outcome | Assessment |",
      "| --- | --- | --- | --- | --- |",
    );
    for (const entry of evidence) {
      lines.push(
        `| ${entry.acId} | ${escapeCell(entry.testId)} | ${entry.evidence.intent} | ${entry.outcome} | ${entry.evidence.baselineAssessment} |`,
      );
    }
    lines.push("");
  }

  if (report.gates.length > 0) {
    lines.push("## Gates", "");
    for (const gate of report.gates) {
      const tests =
        gate.tests.length === 0
          ? ""
          : `, ${String(gate.tests.length)} test(s), ${String(gate.tests.filter((test) => test.status === "failed").length)} failed`;
      lines.push(
        `- ${gate.gateId} (${gate.commandId}): ${gate.status}${tests}${gate.reason === undefined ? "" : `. ${escapeInline(gate.reason)}`}`,
      );
    }
    lines.push("");
  }

  if (report.findings.length > 0) {
    lines.push("## Findings", "");
    for (const finding of report.findings) {
      lines.push(
        `- **${finding.id}** (${finding.severity}, ${finding.category}, ${finding.source}, ${finding.verification}): ` +
          `${escapeInline(finding.title)}. ${escapeInline(finding.recommendation)}`,
      );
    }
    lines.push("");
  }

  if (report.filesChanged.length > 0) {
    lines.push("## Files changed", "");
    for (const file of report.filesChanged) lines.push(`- ${file.change} \`${file.path}\``);
    lines.push("");
  }

  if (report.plan !== undefined) {
    lines.push("## Plan", "", renderPlanBody(report.plan, 3), "");
  }

  if (report.analysis !== undefined) {
    const related = (ids: readonly string[]) => (ids.length > 0 ? ` (${ids.join(", ")})` : "");
    section(
      lines,
      "Edge cases",
      report.analysis.edgeCases.map(
        (edge) =>
          `${edge.id}${related(edge.relatedIds)}: ${edge.description} ` +
          (edge.coveredBy.length > 0
            ? `Covered by ${edge.coveredBy.join(", ")}.`
            : "Not covered by any acceptance criterion."),
      ),
    );
    section(
      lines,
      "Contradictions",
      report.analysis.contradictions.map(
        (conflict) =>
          `${conflict.id} between ${conflict.ids.join(", ")}: ${conflict.description} ` +
          (conflict.resolution === null
            ? `Unresolved: question ${conflict.questionId} is not answered.`
            : `Resolved by the answer to ${conflict.questionId}: ${conflict.resolution}`),
      ),
    );
    section(
      lines,
      "Dependencies",
      report.analysis.dependencies.map(
        (dependency) =>
          `${dependency.id} ${dependency.kind}${related(dependency.relatedIds)}: ${dependency.description}`,
      ),
    );
  }

  section(
    lines,
    "Risks",
    report.risks.map(
      (risk) =>
        `${risk.description} (likelihood ${risk.likelihood}, impact ${risk.impact}). Mitigation: ${risk.mitigation}`,
    ),
  );
  section(lines, "Assumptions and questions", report.assumptions);
  section(lines, "Manual checks", report.manualChecks);
  lines.push("## What was not done", "", notDone(report), "");
  return lines.join("\n");
}

function verdictNote(report: EngineeringReport): string {
  if (report.verdict !== "not_verified") return "";
  return report.gates.length === 0
    ? " (nothing was executed or verified)"
    : " (no criterion is verified: the implementation has not run)";
}

function notDone(report: EngineeringReport): string {
  if (report.run.mode === "assist") {
    return "Assist mode analyses and plans only: no file was changed, no command was run and no test was executed.";
  }
  const ran =
    report.gates.length > 0
      ? "The tests ran once, against the code before any change."
      : "The tests did not run in this run.";
  return (
    "Test mode writes and runs tests only: no production code was changed and the " +
    `implementation step has not run, so no criterion is verified. ${ran}`
  );
}

/** Renders `test-design.md` for review before the tests are approved and run. */
export function renderTestDesignMarkdown(
  design: TestDesign,
  context: { task: TaskContract; runId: string; files: TestFiles },
): string {
  const lines = [
    `# Tests to review: ${context.task.id} - ${escapeInline(context.task.title)}`,
    "",
    `Run ${context.runId}, test design iteration ${String(design.iteration)}. Written by a model ` +
      "into the workspace and checked by DevFlow's deterministic test checks; they have not run. " +
      "Review the files themselves (for example with git diff): approved tests run against the " +
      "current code, with your privileges.",
    "",
    "## Summary",
    "",
    escapeHtml(design.summary),
    "",
    "## Tests",
    "",
  ];
  for (const test of design.tests) {
    lines.push(
      `- **${test.id}** ${test.action} \`${test.path}\` (module ${test.module}) for ${test.acIds.join(", ")}: ${escapeInline(test.description)}`,
    );
  }
  lines.push("", "## Files", "", "| File | Change | SHA-256 |", "| --- | --- | --- |");
  for (const file of context.files.files) {
    lines.push(
      `| \`${file.path}\` | ${file.action === "create" ? "added" : "modified"} | ${file.afterSha256} |`,
    );
  }
  lines.push("", `Approval hash: ${context.files.testsSha256}`, "");
  const warnings = design.checks.filter((check) => check.severity === "warning");
  if (warnings.length > 0) {
    lines.push("## Check warnings", "");
    for (const check of warnings) {
      lines.push(
        `- ${check.location === undefined ? "" : `\`${check.location}\`: `}${escapeInline(check.message)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Renders `plan.md` for review before approval. */
export function renderPlanMarkdown(
  plan: ImplementationPlan,
  context: { task: TaskContract; runId: string; iteration: number; checks: readonly PlanCheck[] },
): string {
  const lines = [
    `# Implementation plan: ${context.task.id} - ${escapeInline(context.task.title)}`,
    "",
    `Run ${context.runId}, plan iteration ${context.iteration}. Generated by a model and checked by ` +
      "DevFlow's deterministic plan checks; review it before approving.",
    "",
    renderPlanBody(plan, 2),
    "",
  ];
  const warnings = context.checks.filter((check) => check.severity === "warning");
  if (warnings.length > 0) {
    lines.push("## Plan check warnings", "");
    for (const check of warnings) {
      lines.push(
        `- ${check.location === undefined ? "" : `\`${check.location}\`: `}${escapeInline(check.message)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderPlanBody(plan: ImplementationPlan, level: number): string {
  const h = "#".repeat(level);
  const out: string[] = [];
  out.push(
    `${h} Summary`,
    "",
    escapeHtml(plan.summary),
    "",
    `${h} Approach`,
    "",
    escapeHtml(plan.approach),
    "",
  );
  out.push(`${h} Changes`, "");
  if (plan.changes.length === 0) out.push("No file changes.");
  for (const change of plan.changes) {
    out.push(
      `- **${change.id}** ${change.action} \`${change.path}\` (module ${change.module}): ${escapeInline(change.description)}` +
        (change.satisfies.length > 0 ? ` Satisfies ${change.satisfies.join(", ")}.` : ""),
    );
  }
  out.push("");
  if (plan.interfaceChanges.length > 0) {
    out.push(`${h} Interface changes`, "");
    for (const change of plan.interfaceChanges) {
      out.push(
        `- ${change.kind}${change.breaking ? " (breaking)" : ""}: ${escapeInline(change.description)}`,
      );
    }
    out.push("");
  }
  out.push(`${h} Test strategy`, "");
  if (plan.testStrategy.length === 0) out.push("No test strategy entries.");
  for (const entry of plan.testStrategy) {
    out.push(
      `- **${entry.acId}** ${entry.level} test, ${entry.intent}: ${escapeInline(entry.approach)}` +
        (entry.targetFile === undefined ? "" : ` (\`${entry.targetFile}\`)`),
    );
  }
  out.push("");
  if (plan.relevantFiles.length > 0) {
    out.push(`${h} Relevant files`, "");
    for (const file of plan.relevantFiles)
      out.push(`- \`${file.path}\`: ${escapeInline(file.reason)}`);
    out.push("");
  }
  if (plan.risks.length > 0) {
    out.push(`${h} Risks`, "");
    for (const risk of plan.risks) {
      out.push(
        `- ${escapeInline(risk.description)} (likelihood ${risk.likelihood}, impact ${risk.impact}). Mitigation: ${escapeInline(risk.mitigation)}`,
      );
    }
    out.push("");
  }
  if (plan.regressionWatch.length > 0) {
    out.push(`${h} Watch for regressions`, "");
    for (const item of plan.regressionWatch) out.push(`- ${escapeInline(item)}`);
    out.push("");
  }
  if (plan.openQuestions.length > 0) {
    out.push(`${h} Open questions`, "");
    for (const question of plan.openQuestions) {
      out.push(
        `- ${question.id}${question.blocking ? " (blocking)" : ""}: ${escapeInline(question.question)}`,
      );
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

function section(lines: string[], title: string, items: readonly string[]): void {
  if (items.length === 0) return;
  lines.push(`## ${title}`, "");
  for (const item of items) lines.push(`- ${escapeInline(item)}`);
  lines.push("");
}

/** Model text is rendered as text: HTML is neutralized so a report viewer cannot run it. */
function escapeHtml(text: string): string {
  return text.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeInline(text: string): string {
  return escapeHtml(text.replace(/\r?\n/g, " "));
}

function escapeCell(text: string): string {
  return escapeInline(text).replace(/\|/g, "\\|");
}
