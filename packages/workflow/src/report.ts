import {
  type AcceptanceMatrixRow,
  EngineeringReport,
  type Finding,
  type GateResult,
  type ImplementationPlan,
  RepoPath,
  type Risk,
  type TaskContract,
  statusForOutcome,
} from "@devflow/core";
import type {
  AfterRun,
  BaselineRun,
  ChangeFiles,
  ChangedFiles,
  Clarifications,
  EvidenceEntry,
  ImplementationRecord,
  PlanCheck,
  ProbesRecord,
  RequirementsAnalysis,
  ReviewDiff,
  ReviewContracts,
  ReviewGates,
  ReviewRecord,
  RunRecord,
  TestDesign,
  TestEvidenceRecord,
  TestFiles,
} from "./schemas.js";
import { contractManualChecks, reviewAcceptanceMatrix } from "./review.js";

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
  /** Implement mode: the latest implementation, every changed file, and the green run. */
  readonly implementation?: ImplementationRecord | undefined;
  readonly changedFiles?: ChangedFiles | undefined;
  /** Files of the latest implementation that no person approved. */
  readonly unapprovedChanges?: readonly string[] | undefined;
  readonly after?: AfterRun | undefined;
  /** Review mode: the reviewed diff, the gates run on it, and the model's review. */
  readonly reviewDiff?: ReviewDiff | undefined;
  readonly reviewGates?: ReviewGates | undefined;
  readonly reviewRecord?: ReviewRecord | undefined;
  /** Review mode: the changed contract files, compared at the base and the head (ADR 0021). */
  readonly reviewContracts?: ReviewContracts | undefined;
  /** Review mode with `--seek-evidence`: the probe tests and their outcomes (ADR 0025). */
  readonly probes?: ProbesRecord | undefined;
}

/**
 * Builds the engineering report of a finished run (ADR 0013).
 *
 * Assist mode runs no gates and no tests, so the verdict is always `not_verified` and every
 * automated acceptance criterion is `not_executed`. Test mode runs the tests once, before any
 * change: the red/green evidence is reported per criterion, but nothing is implemented, so no
 * criterion is verified and the verdict stays `not_verified`. Implement mode verifies the
 * change: a criterion is verified only by its approved tests passing after the change, and the
 * verdict follows docs/specs/verification-and-evidence.md section 7. The report is validated
 * against the core schema, whose invariants reject any overstatement.
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
  const git = record.git;
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
    ...((input.unapprovedChanges ?? []).length === 0
      ? []
      : [
          `Review or revert the code changes this run wrote, which no person approved: ${(input.unapprovedChanges ?? []).join(", ")}.`,
        ]),
    ...((input.changedFiles?.files ?? []).length === 0
      ? []
      : [
          (git?.status === "branch"
            ? `Review the diff (git diff ${git.baseCommit.slice(0, 12)}..${git.branch}) before you merge it: `
            : "Review the diff of the changed files before you keep it: ") +
            "the code was written by a model, and its content can be influenced by the " +
            "repository it read.",
        ]),
    ...(git?.status === "branch" ? git.warnings : []),
    ...(record.mode === "review" && input.reviewDiff !== undefined
      ? [
          "Read the diff yourself before you merge it: the AI findings are a model's suggestions " +
            "and stay unverified until a test or a person confirms them.",
          ...(input.reviewGates?.skipped === undefined
            ? []
            : [
                `The gates did not run: ${input.reviewGates.skipped}. Run them yourself on the change before you merge it.`,
              ]),
          ...contractManualChecks(input.reviewContracts),
          ...probeManualChecks(input.probes),
          ...(input.reviewDiff.withheld.length === 0
            ? []
            : [
                `These changed files were not shown to the model (sensitive): ${input.reviewDiff.withheld.join(", ")}; review them yourself.`,
              ]),
        ]
      : []),
    ...(git?.status === "none" &&
    (written.length > 0 || (input.changedFiles?.files ?? []).length > 0)
      ? [
          `The changes are not on a DevFlow branch (${git.reason}): they are uncommitted in the working tree.`,
        ]
      : []),
  ];

  const entries = input.evidence?.entries ?? [];
  const designed = (acId: string) =>
    written.length > 0 &&
    input.testDesign?.tests.some((test) => test.acIds.includes(acId)) === true;
  const after = record.mode === "implement" ? input.after : undefined;
  const reviewed = record.mode === "review" ? input.reviewGates : undefined;
  const gates: readonly GateResult[] =
    record.mode === "review"
      ? (reviewed?.gates ?? [])
      : (after?.gates ?? input.baseline?.gates ?? []);

  const acceptanceMatrix =
    record.mode === "review"
      ? reviewAcceptanceMatrix(task, gates)
      : task.acceptanceCriteria.map((criterion): AcceptanceMatrixRow => {
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
          const before = `before the change: ${linked.map((entry) => `${entry.outcome} (${entry.evidence.baselineAssessment.replace("_", " ")})`).join(", ")}`;
          if (after === undefined) {
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
              note: `${before}; the implementation has not run`,
            };
          }
          const statuses = linked.map((entry) => statusForOutcome(entry.evidence.after));
          const established = linked.every((entry) => entry.evidence.established);
          return {
            ...row,
            tests: linked.map((entry, index) => ({
              testId: entry.testId,
              gateId: entry.gateId,
              status: statuses[index] ?? "not_executed",
              evidence: entry.evidence,
            })),
            status: statuses.every((status) => status === "passed")
              ? "verified"
              : statuses.some((status) => status === "failed")
                ? "failed"
                : statuses.every((status) => status === "not_executed")
                  ? "not_executed"
                  : "unverified",
            note:
              `${before}; after the change: ${linked.map((entry) => entry.evidence.after).join(", ")}` +
              (established
                ? "; red/green evidence established"
                : "; red/green evidence not established"),
          };
        });
  const findings = input.findings ?? [];

  const changed = (input.changedFiles?.files ?? []).map((file) => ({
    path: file.path,
    change:
      file.originalSha256 === null
        ? ("added" as const)
        : file.currentSha256 === null
          ? ("deleted" as const)
          : ("modified" as const),
    planChangeId: file.planChangeId,
  }));

  return EngineeringReport.parse({
    schemaVersion: 1,
    run: {
      id: record.id,
      devflowVersion: record.devflowVersion,
      mode: record.mode,
      state: record.state,
      startedAt: record.createdAt,
      finishedAt: record.finishedAt ?? record.updatedAt,
      ...(git?.status === "branch"
        ? {
            branch: git.branch,
            baseCommit: git.baseCommit,
            headCommit: git.commits.at(-1)?.sha ?? git.baseCommit,
          }
        : {}),
      ...(record.mode === "review" && input.reviewDiff !== undefined
        ? { baseCommit: input.reviewDiff.baseCommit, headCommit: input.reviewDiff.headCommit }
        : {}),
      ...(record.review?.pullRequest === undefined
        ? {}
        : {
            pullRequest: {
              repository: record.review.pullRequest.repository,
              number: record.review.pullRequest.number,
              url: record.review.pullRequest.url,
            },
          }),
    },
    verdict:
      after === undefined && reviewed === undefined
        ? "not_verified"
        : verdictOf({ state: record.state, gates, acceptanceMatrix, findings }),
    task: { id: task.id, title: task.title, source: task.source },
    ...(plan === undefined ? {} : { plan }),
    ...(analysisSection === undefined ? {} : { analysis: analysisSection }),
    filesChanged: [
      ...written.map((file) => ({
        path: file.path,
        change: file.action === "create" ? ("added" as const) : ("modified" as const),
      })),
      ...changed,
      ...(record.mode === "review" ? (input.reviewDiff?.files ?? []) : []).flatMap((file) =>
        RepoPath.safeParse(file.path).success ? [{ path: file.path, change: file.change }] : [],
      ),
    ],
    acceptanceMatrix,
    gates,
    findings,
    risks,
    assumptions,
    manualChecks,
    ...(record.mode === "review" && input.reviewContracts?.impact !== undefined
      ? { impact: input.reviewContracts.impact }
      : {}),
    ...(input.probes === undefined ? {} : { evidenceProbes: evidenceProbes(input.probes) }),
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

/**
 * The verdict of a verified change (docs/specs/verification-and-evidence.md section 7): verified
 * only when every required gate passed, every automated criterion is verified and no confirmed
 * critical or high finding remains; failed when a required gate, a criterion or such a finding
 * says so.
 */
function verdictOf(input: {
  state: RunRecord["state"];
  gates: readonly GateResult[];
  acceptanceMatrix: readonly AcceptanceMatrixRow[];
  findings: readonly Finding[];
}): EngineeringReport["verdict"] {
  const required = input.gates.filter((gate) => gate.required);
  const automated = input.acceptanceMatrix.filter((row) => row.verification === "automated");
  const blocking = input.findings.some(
    (finding) =>
      (finding.severity === "critical" || finding.severity === "high") &&
      finding.verification === "confirmed",
  );
  if (
    input.state === "COMPLETED" &&
    input.gates.length > 0 &&
    required.every((gate) => gate.status === "passed") &&
    automated.every((row) => row.status === "verified") &&
    !blocking
  ) {
    return "verified";
  }
  if (
    required.some((gate) => gate.status === "failed") ||
    automated.some((row) => row.status === "failed") ||
    blocking
  ) {
    return "failed_verification";
  }
  return automated.some((row) => row.status === "verified") ? "partially_verified" : "not_verified";
}

/** The report's view of the probes: what a reader needs, without the run's details. */
function evidenceProbes(record: ProbesRecord): NonNullable<EngineeringReport["evidenceProbes"]> {
  return {
    ...(record.skipped === undefined ? {} : { skipped: record.skipped }),
    probes: record.probes.map((probe) => ({
      findingId: probe.findingId,
      outcome: probe.outcome,
      reason: probe.reason,
      ...(probe.testFile === undefined ? {} : { testFile: probe.testFile }),
      ...(probe.testName === undefined ? {} : { testName: probe.testName }),
      ...(probe.sha256 === undefined ? {} : { sha256: probe.sha256 }),
      ...(probe.artifact === undefined ? {} : { artifact: probe.artifact }),
      ...(probe.commandId === undefined ? {} : { commandId: probe.commandId }),
    })),
  };
}

/** What a person must do about the probes: read the confirming tests, approve a command. */
function probeManualChecks(record: ProbesRecord | undefined): string[] {
  if (record === undefined) return [];
  const checks: string[] = [];
  const confirmed = record.probes.filter((probe) => probe.outcome === "confirmed");
  if (confirmed.length > 0) {
    checks.push(
      `Read the probe tests that confirmed ${confirmed.map((probe) => probe.findingId).join(", ")} ` +
        "before you rely on them: a model wrote each test, and its assertion is the model's " +
        "idea of the correct behaviour (copies are in the run directory, never committed).",
    );
  }
  const fingerprints = [...new Set(record.probes.flatMap((probe) => probe.fingerprint ?? []))];
  if (fingerprints.length > 0) {
    checks.push(
      `The probe command was not approved; after reading it, review again with ${fingerprints
        .map((fingerprint) => `--allow ${fingerprint}`)
        .join(" ")}.`,
    );
  }
  return checks;
}

/** Renders the Markdown report from the JSON report; it adds nothing (ADR 0013). */
export function renderReportMarkdown(
  report: EngineeringReport,
  extra: {
    lastError?: RunRecord["lastError"];
    planApproval?: { by: string; at: string } | undefined;
    testsApproval?: { by: string; at: string } | undefined;
    /** Implement mode: the person who approved the code change that was verified. */
    changeApproval?: { by: string; at: string } | undefined;
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
  if (report.run.pullRequest !== undefined) {
    const pull = report.run.pullRequest;
    lines.push(`- **Pull request:** ${pull.repository}#${String(pull.number)} (${pull.url})`);
  }
  if (report.run.mode === "review" && report.run.baseCommit !== undefined) {
    lines.push(
      `- **Reviewed:** the working tree at \`${(report.run.headCommit ?? "").slice(0, 12)}\` ` +
        `against base commit \`${report.run.baseCommit.slice(0, 12)}\``,
    );
  }
  if (report.run.branch !== undefined) {
    lines.push(
      `- **Branch:** \`${report.run.branch}\` (base commit \`${(report.run.baseCommit ?? "").slice(0, 12)}\`, ` +
        `head commit \`${(report.run.headCommit ?? "").slice(0, 12)}\`)`,
    );
  }
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
  if (extra.changeApproval !== undefined) {
    lines.push(
      `- **Change approved by:** ${escapeInline(extra.changeApproval.by)} at ${extra.changeApproval.at}`,
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
  const greenRun =
    report.run.mode === "implement" &&
    evidence.some((entry) => entry.evidence.after !== "not_executed");
  if (evidence.length > 0 && greenRun) {
    lines.push(
      "## Test evidence (red/green)",
      "",
      "Feature tests must fail on an assertion before the change (red) and pass after it " +
        "(green); regression and characterization tests must pass both times. Established " +
        "evidence shows the test detects the change; it does not prove business correctness.",
      "",
      "| Criterion | Test | Intent | Before | After | Established |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const entry of evidence) {
      lines.push(
        `| ${entry.acId} | ${escapeCell(entry.testId)} | ${entry.evidence.intent} | ${entry.outcome} (${entry.evidence.baselineAssessment}) | ${entry.evidence.after} (${entry.evidence.afterAssessment}) | ${entry.evidence.established ? "yes" : "no"} |`,
      );
    }
    lines.push("");
  } else if (evidence.length > 0) {
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

  if (report.impact !== undefined && report.impact.length > 0) {
    lines.push(
      "## Impact",
      "",
      "Consumers of each breaking contract change, found in the working tree by deterministic " +
        "heuristics (ADR 0022): Spring mappings, HTTP client calls, operation ids and imports of " +
        "generated code. They are leads to check, not confirmed breakages; a pattern match may " +
        "be a false positive, and a consumer the heuristics cannot see (a URL built elsewhere, " +
        "another repository) is not listed.",
      "",
    );
    for (const entry of report.impact) {
      lines.push(
        `- \`${entry.file}\` ${entry.rule}: ${escapeInline(entry.message)}. Consumers of ${escapeInline(entry.target)}: ` +
          (entry.consumers.length === 0
            ? "none found."
            : `${String(entry.consumers.length + entry.omitted)}.`),
      );
      for (const ref of entry.consumers) {
        const kind = ref.kind === "test" ? `test (${ref.via ?? "?"})` : ref.kind;
        const confidence = ref.confidence === "exact" ? "exact" : "pattern only";
        lines.push(
          `  - \`${ref.path}:${String(ref.line)}\` ${ref.language}, ${kind}, ${confidence}: ${escapeInline(ref.match)}`,
        );
      }
      if (entry.omitted > 0) lines.push(`  - ${String(entry.omitted)} more, not listed`);
    }
    lines.push("");
  }

  if (report.evidenceProbes !== undefined) {
    lines.push("## Evidence probes", "");
    if (report.evidenceProbes.skipped !== undefined) {
      lines.push(`No probe ran: ${escapeInline(report.evidenceProbes.skipped)}.`);
    }
    for (const probe of report.evidenceProbes.probes) {
      const test =
        probe.testFile === undefined
          ? ""
          : ` \`${probe.testFile}\`${probe.testName === undefined ? "" : ` (${escapeInline(probe.testName)})`}`;
      lines.push(
        `- **${probe.findingId}** ${probe.outcome.replace("_", " ")}${test}: ${escapeInline(probe.reason)}` +
          (probe.artifact === undefined ? "" : `. Kept in \`${probe.artifact}\``),
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
  if (report.gates.length === 0) return " (nothing was executed or verified)";
  if (report.run.mode === "review") {
    return " (no criterion is verified by a test that ran on the change)";
  }
  return report.acceptanceMatrix.some((row) =>
    row.tests.some((test) => test.status === "passed"),
  ) && report.run.mode === "implement"
    ? " (not every check that a verified verdict needs has passed)"
    : report.run.mode === "implement"
      ? " (no criterion is verified by a passing test after the change)"
      : " (no criterion is verified: the implementation has not run)";
}

function notDone(report: EngineeringReport): string {
  if (report.run.mode === "assist") {
    return "Assist mode analyses and plans only: no file was changed, no command was run and no test was executed.";
  }
  if (report.run.mode === "review") {
    return (
      "Review mode reviews a local change: it changed no file and committed nothing. " +
      (report.gates.length > 0
        ? "The gates ran once, on the changed code; there was no run before the change, so " +
          "failures that were already there are not told apart and no red/green evidence exists. "
        : "No gate ran. ") +
      (report.findings.some(
        (finding) => finding.source === "ai" && finding.verification === "confirmed",
      )
        ? "The AI findings are unverified suggestions, except those a probe test confirmed."
        : "The AI findings are unverified suggestions.")
    );
  }
  if (report.run.mode === "implement") {
    const verified =
      report.gates.length > 0 &&
      report.acceptanceMatrix.some((row) =>
        row.tests.some((test) => test.status !== "not_executed"),
      );
    return (
      (committed(report)
        ? `Implement mode committed the approved changes on the local branch ${report.run.branch ?? ""}; ` +
          "nothing was pushed or merged, so review the commits before you merge them. "
        : "Implement mode changed the files listed above in the working tree; nothing was " +
          "committed or pushed, so review the diff before you keep it. ") +
      "No model review of the change was made: the findings are deterministic. " +
      (verified
        ? "The gates ran before and after the change."
        : "The verification after the change did not run.")
    );
  }
  const ran =
    report.gates.length > 0
      ? "The tests ran once, against the code before any change."
      : "The tests did not run in this run.";
  return (
    "Test mode writes and runs tests only: no production code was changed and the " +
    `implementation step has not run, so no criterion is verified. ${ran}` +
    (committed(report)
      ? ` The approved tests are committed on the local branch ${report.run.branch ?? ""}; nothing was pushed.`
      : "")
  );
}

/** Whether the run committed anything on its own branch. */
function committed(report: EngineeringReport): boolean {
  return (
    report.run.branch !== undefined &&
    report.run.headCommit !== undefined &&
    report.run.headCommit !== report.run.baseCommit
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

/** Renders `implementation.md` for review before the change is approved and run. */
export function renderImplementationMarkdown(
  implementation: ImplementationRecord,
  context: {
    task: TaskContract;
    runId: string;
    files: ChangeFiles;
    /** The failures a repair addresses. */
    failures?: readonly string[] | undefined;
  },
): string {
  const lines = [
    `# Code change to review: ${context.task.id} - ${escapeInline(context.task.title)}`,
    "",
    `Run ${context.runId}, implementation ${String(implementation.iteration)}${implementation.repair ? " (a repair)" : ""}. ` +
      "Written by a model into the workspace and checked by DevFlow's deterministic change " +
      "checks (files of the approved plan only, never a test file); it has not run. Review the " +
      "files themselves (for example with git diff): approved code runs with the tests, with " +
      "your privileges.",
    "",
    "## Summary",
    "",
    escapeHtml(implementation.summary),
    "",
  ];
  if (context.failures !== undefined && context.failures.length > 0) {
    lines.push("## What it repairs", "");
    for (const failure of context.failures) lines.push(`    ${failure.replace(/\r?\n/g, " ")}`);
    lines.push("");
  }
  lines.push("## Changes", "");
  for (const change of implementation.changes) {
    lines.push(
      `- **${change.planChangeId}** ${change.action} \`${change.path}\`: ${escapeInline(change.description)}`,
    );
  }
  lines.push("", "## Files", "", "| File | Change | SHA-256 |", "| --- | --- | --- |");
  for (const file of context.files.files) {
    lines.push(
      `| \`${file.path}\` | ${file.action === "create" ? "added" : file.action === "delete" ? "deleted" : "modified"} | ${file.afterSha256 ?? "-"} |`,
    );
  }
  lines.push("", `Approval hash: ${context.files.changesSha256}`, "");
  const warnings = implementation.checks.filter((check) => check.severity === "warning");
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

/**
 * Model text is rendered as text: HTML is neutralized so a report viewer cannot run it. Only a
 * `<` that can open a tag, a comment or a declaration is escaped, so arrows and comparisons in
 * code (`=>`, `a > b`, `a < b`) stay readable.
 */
function escapeHtml(text: string): string {
  return text.replace(/<(?=[A-Za-z/!?])/g, "&lt;");
}

function escapeInline(text: string): string {
  return escapeHtml(text.replace(/\r?\n/g, " "));
}

function escapeCell(text: string): string {
  return escapeInline(text).replace(/\|/g, "\\|");
}
