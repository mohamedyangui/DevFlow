import { readFile } from "node:fs/promises";
import { canonicalJson } from "@devflow/ai";
import {
  type Evidence,
  type Finding,
  type GateResult,
  type ImplementationPlan,
  type PathGuard,
  RepoPath,
  type TaskContract,
  TestEvidence,
  type TestOutcome,
  assessTestEvidence,
  compareSnapshots,
  isDevflowError,
} from "@devflow/core";
import type {
  AfterRun,
  ChangeFiles,
  EvidenceEntry,
  ImplementationRecord,
  ImplementationWire,
  PlanCheck,
  TestDesign,
} from "./schemas.js";
import {
  type TestModule,
  applyEdits,
  designedResults,
  isTestPath,
  messageField,
  sha256Of,
} from "./test-design.js";

/**
 * The implementation engine's deterministic side (ADR 0006): the model's changes are data. They
 * are checked against the approved plan, the approved tests and the path guard before anything
 * is written; the written files are bound to a hash a person approves; the verification after
 * the change is compared with the baseline by rules, never by the model.
 */

/** Largest production file the implementation may write. */
export const MAX_SOURCE_FILE_BYTES = 512 * 1024;

/** A file the implementation writes, before and after; `after` is null for a deletion. */
export interface PlannedChangeFile {
  readonly path: string;
  readonly action: "create" | "modify" | "delete";
  readonly planChangeId: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** The hash a change approval refers to: every written path with the hash of its content. */
export function changesHash(
  files: readonly { path: string; afterSha256: string | null }[],
): string {
  return sha256Of(
    canonicalJson(files.map((file) => ({ path: file.path, sha256: file.afterSha256 }))),
  );
}

/** The `change-files.json` record of files about to be written. */
export function changeFilesRecord(
  files: readonly PlannedChangeFile[],
  iteration: number,
): ChangeFiles {
  const entries = files.map((file) => ({
    path: file.path,
    action: file.action,
    planChangeId: file.planChangeId,
    before: file.before,
    beforeSha256: file.before === null ? null : sha256Of(file.before),
    afterSha256: file.after === null ? null : sha256Of(file.after),
  }));
  return { schemaVersion: 1, iteration, changesSha256: changesHash(entries), files: entries };
}

/**
 * Builds the implementation from the model's answer and checks it: only files of the approved
 * plan, never a test file, writable by the path guard, exact search and replace edits. Errors
 * make it unusable (the model gets one revision); warnings are reported with it. Nothing is
 * written here.
 */
export async function checkImplementation(input: {
  wire: ImplementationWire;
  plan: ImplementationPlan;
  modules: readonly TestModule[];
  /** The approved test files: the implementation never changes them. */
  testFiles: ReadonlySet<string>;
  guard: PathGuard;
  /** A repair changes only what the failures need, so unaddressed plan changes are expected. */
  repair: boolean;
}): Promise<{
  changes: ImplementationRecord["changes"];
  files: PlannedChangeFile[];
  checks: PlanCheck[];
}> {
  const { wire, plan, modules, guard } = input;
  const checks: PlanCheck[] = [];
  const add =
    (severity: PlanCheck["severity"]) =>
    (code: string, message: string, location?: string): void => {
      checks.push({ severity, code, message, ...(location === undefined ? {} : { location }) });
    };
  const error = add("error");
  const warning = add("warning");
  const planned = plan.changes.map((change) => change.path);

  const changes: ImplementationRecord["changes"] = [];
  const files: PlannedChangeFile[] = [];
  const seen = new Set<string>();
  for (const [index, change] of wire.changes.entries()) {
    const location = `changes[${String(index)}]`;
    if (!RepoPath.safeParse(change.path).success) {
      error(
        "invalid-path",
        `"${change.path}" is not a repository-relative path`,
        `${location}.path`,
      );
      continue;
    }
    if (seen.has(change.path)) {
      error(
        "duplicate-file",
        `"${change.path}" appears twice; put every edit of a file in one entry`,
        `${location}.path`,
      );
      continue;
    }
    seen.add(change.path);
    if (
      input.testFiles.has(change.path) ||
      modules.some((module) => isTestPath(change.path, module))
    ) {
      error(
        "test-file",
        `"${change.path}" is a test file; the implementation changes production code only, and ` +
          "the approved tests must stay as a person approved them",
        `${location}.path`,
      );
      continue;
    }
    const planChange = plan.changes.find((candidate) => candidate.path === change.path);
    if (planChange === undefined) {
      error(
        "out-of-plan",
        `"${change.path}" is not a file of the approved plan (planned: ${planned.join(", ") || "none"}); ` +
          "change only the files the plan lists",
        `${location}.path`,
      );
      continue;
    }
    if (change.changeId !== null && change.changeId !== planChange.id) {
      warning(
        "change-corrected",
        `change "${change.changeId}" corrected to ${planChange.id} from the path`,
        `${location}.changeId`,
      );
    }
    if (change.action === "delete" && planChange.action !== "delete") {
      error(
        "delete-not-planned",
        `"${change.path}" is deleted, but the approved plan does not delete it (${planChange.id} ${planChange.action}s it)`,
        `${location}.action`,
      );
      continue;
    }

    let exists: boolean;
    let absolute: string;
    try {
      const checked = await guard.check(change.path, { access: "write", origin: "model" });
      exists = checked.exists;
      absolute = checked.absolute;
    } catch (rejection) {
      if (!isDevflowError(rejection)) throw rejection;
      error(
        "path-not-writable",
        `"${change.path}" cannot be written: ${rejection.message}`,
        `${location}.path`,
      );
      continue;
    }

    let before: string | null = null;
    let after: string | null;
    if (change.action === "create") {
      if (exists) {
        error(
          "file-exists",
          `"${change.path}" already exists; modify it with search and replace edits instead`,
          `${location}.path`,
        );
        continue;
      }
      if (change.content === null || change.content.trim() === "") {
        error(
          "missing-content",
          `"${change.path}" is created without content`,
          `${location}.content`,
        );
        continue;
      }
      if (change.edits.length > 0) {
        warning("edits-ignored", "edits are ignored when a file is created", `${location}.edits`);
      }
      after = change.content;
    } else {
      if (!exists) {
        error(
          "missing-file",
          `"${change.path}" does not exist, so it cannot be ${change.action === "delete" ? "deleted" : "modified"}`,
          `${location}.path`,
        );
        continue;
      }
      before = await readFile(absolute, "utf8");
      if (change.action === "delete") {
        if (change.content !== null || change.edits.length > 0) {
          warning(
            "content-ignored",
            "content and edits are ignored when a file is deleted",
            location,
          );
        }
        after = null;
      } else {
        if (change.edits.length === 0) {
          error("missing-edits", `"${change.path}" is modified without edits`, `${location}.edits`);
          continue;
        }
        if (change.content !== null) {
          warning(
            "content-ignored",
            "content is ignored when a file is modified; only the edits apply",
            `${location}.content`,
          );
        }
        const edited = applyEdits(before, change.edits);
        if ("error" in edited) {
          error(
            "edit-not-applicable",
            `edit ${String(edited.index + 1)} of "${change.path}": ${edited.error}`,
            `${location}.edits[${String(edited.index)}]`,
          );
          continue;
        }
        if (edited.text === before) {
          error("no-change", `the edits leave "${change.path}" unchanged`, `${location}.edits`);
          continue;
        }
        after = edited.text;
      }
    }
    if (after !== null && Buffer.byteLength(after, "utf8") > MAX_SOURCE_FILE_BYTES) {
      error(
        "file-too-large",
        `"${change.path}" would be larger than ${String(MAX_SOURCE_FILE_BYTES / 1024)} KiB`,
        `${location}.path`,
      );
      continue;
    }
    changes.push({
      path: change.path,
      action: change.action,
      planChangeId: planChange.id,
      description: change.description,
    });
    files.push({
      path: change.path,
      action: change.action,
      planChangeId: planChange.id,
      before,
      after,
    });
  }

  if (wire.changes.length === 0) {
    error("no-changes", "the implementation does not change any file");
  } else if (!input.repair) {
    for (const change of plan.changes) {
      if (!seen.has(change.path)) {
        warning(
          "unaddressed-change",
          `${change.id} (${change.action} ${change.path}) is not carried out`,
        );
      }
    }
  }
  return { changes, files, checks };
}

/**
 * Completes the red/green evidence with the verification after the change: each baseline entry
 * gets the outcome of the same test after the change. A result that appears only after the
 * change (the test compiled once the code existed) is paired with the baseline's reason for
 * having none, so it can never count as established.
 */
export function afterEvidence(input: {
  task: TaskContract;
  design: TestDesign;
  baseline: readonly EvidenceEntry[];
  gates: readonly GateResult[];
  gateOfModule: ReadonlyMap<string, string>;
}): EvidenceEntry[] {
  const entries: EvidenceEntry[] = [];
  const intentOf = new Map(
    input.task.acceptanceCriteria.map((criterion) => [criterion.id, criterion.testIntent]),
  );
  for (const test of input.design.tests) {
    for (const acId of test.acIds) {
      const intent = intentOf.get(acId) ?? "feature";
      const before = input.baseline.filter(
        (entry) => entry.designedTestId === test.id && entry.acId === acId,
      );
      const after = designedResults(test, acId, input.gates, input.gateOfModule);
      const beforePlaceholder = before.find((entry) => entry.testId === test.path);
      const afterPlaceholder = after.find((result) => result.placeholder);
      const ids = [
        ...new Set([
          ...before.filter((entry) => entry.testId !== test.path).map((entry) => entry.testId),
          ...after.filter((result) => !result.placeholder).map((result) => result.testId),
        ]),
      ];
      const pairs =
        ids.length === 0
          ? [
              {
                testId: test.path,
                b: beforePlaceholder ?? before[0],
                a: afterPlaceholder ?? after[0],
              },
            ]
          : ids.map((id) => ({
              testId: id,
              b: before.find((entry) => entry.testId === id) ?? beforePlaceholder,
              a:
                after.find((result) => !result.placeholder && result.testId === id) ??
                afterPlaceholder,
            }));
      for (const { testId, b, a } of pairs) {
        const baseline: TestOutcome = b?.outcome ?? "not_found";
        const outcome: TestOutcome = a?.outcome ?? "not_found";
        const assessment = assessTestEvidence(intent, baseline, outcome);
        entries.push({
          acId,
          designedTestId: test.id,
          testId,
          gateId: a?.gateId ?? b?.gateId ?? "none",
          file: test.path,
          outcome: baseline,
          evidence: TestEvidence.parse({ intent, baseline, after: outcome, ...assessment }),
          ...messageField("message", b?.message),
          ...messageField("afterMessage", a?.message),
        });
      }
    }
  }
  return entries;
}

const refKey = (gateId: string, testId: string) => JSON.stringify([gateId, testId]);

/**
 * Decides what a verification after the change means: compared with the baseline test by test,
 * with the failed gates run a second time. A test that failed and then passed is flaky, never a
 * regression. Required gates that still fail are repaired while attempts remain.
 */
export function assessAfterRun(input: {
  attempt: number;
  ranAt: string;
  changesSha256: string;
  baseline: readonly GateResult[];
  gates: readonly GateResult[];
  rerun: readonly GateResult[];
  maxRepairAttempts: number;
}): AfterRun {
  const { gates, rerun } = input;
  const comparison = compareSnapshots(
    { version: 1, createdAt: input.ranAt, gates: [...input.baseline] },
    { version: 1, createdAt: input.ranAt, gates: [...gates] },
  );
  const second = new Map(rerun.map((gate) => [gate.gateId, gate]));
  const flaky: AfterRun["flaky"] = [];
  for (const gate of gates) {
    const again = second.get(gate.gateId);
    if (again === undefined) continue;
    for (const test of gate.tests) {
      if (test.status !== "failed") continue;
      const later = again.tests.find((candidate) => candidate.id === test.id);
      if (later?.status === "passed") flaky.push({ gateId: gate.gateId, testId: test.id });
    }
  }
  const flakyKeys = new Set(flaky.map((ref) => refKey(ref.gateId, ref.testId)));
  const refs = (changes: readonly { gateId: string; testId: string }[]) =>
    changes
      .filter((change) => !flakyKeys.has(refKey(change.gateId, change.testId)))
      .map((change) => ({ gateId: change.gateId, testId: change.testId }));

  const required = gates.filter((gate) => gate.required);
  const failedGates = required
    .filter((gate) => gate.status !== "passed")
    .map((gate) => gate.gateId);
  const repairable = required.filter(
    (gate) => gate.status === "failed" && second.get(gate.gateId)?.status !== "passed",
  );
  let decision: AfterRun["decision"];
  let reason: string;
  if (gates.length === 0) {
    decision = "stop";
    reason = "no gate ran after the change";
  } else if (failedGates.length === 0) {
    decision = "passed";
    reason = "every required gate passed";
  } else if (repairable.length > 0 && input.attempt <= input.maxRepairAttempts) {
    decision = "repair";
    reason = `${repairable.map((gate) => gate.gateId).join(", ")} failed; repair ${String(input.attempt)} of ${String(input.maxRepairAttempts)}`;
  } else {
    decision = "stop";
    reason =
      repairable.length > 0
        ? `${repairable.map((gate) => gate.gateId).join(", ")} still failed and the ${String(input.maxRepairAttempts)} repair attempt(s) are used up`
        : `${failedGates.join(", ")} did not pass, and nothing a repair could fix failed ` +
          "(a gate did not run, had no trustworthy result, or failed only once)";
  }
  return {
    schemaVersion: 1,
    attempt: input.attempt,
    ranAt: input.ranAt,
    changesSha256: input.changesSha256,
    gates: [...gates],
    rerun: [...rerun],
    flaky,
    regressions: refs(comparison.regressions),
    stillFailing: refs(comparison.stillFailing),
    failedGates,
    decision,
    reason,
  };
}

/** What failed after the change, for the repair prompt; every text is already redacted. */
export function failureSummary(after: AfterRun, limit = 40): string[] {
  const lines: string[] = [];
  const flaky = new Set(after.flaky.map((ref) => refKey(ref.gateId, ref.testId)));
  for (const gate of after.gates) {
    if (gate.status === "passed") continue;
    lines.push(
      `Gate ${gate.gateId} (${gate.commandId}): ${gate.status}${gate.reason === undefined ? "" : `. ${gate.reason}`}`,
    );
    for (const test of gate.tests) {
      if (test.status !== "failed" || flaky.has(refKey(gate.gateId, test.id))) continue;
      lines.push(
        `- test ${test.id} (${test.outcome})${test.message === undefined ? "" : `: ${test.message.slice(0, 2000)}`}`,
      );
    }
    for (const diagnostic of gate.diagnostics) {
      if (diagnostic.severity !== "error") continue;
      const where =
        diagnostic.location === undefined
          ? ""
          : ` at ${diagnostic.location.path}${diagnostic.location.line === undefined ? "" : `:${String(diagnostic.location.line)}`}`;
      lines.push(`- ${diagnostic.tool} error${where}: ${diagnostic.message.slice(0, 2000)}`);
    }
  }
  return lines.length > limit
    ? [...lines.slice(0, limit), `(${String(lines.length - limit)} more line(s) not shown)`]
    : lines;
}

/**
 * Deterministic findings of the verification after the change: criteria whose tests fail or
 * did not run, regressions, flaky tests, failed gates, and failures already present before the
 * change (listed, not attributed to it).
 */
export function afterFindings(input: {
  entries: readonly EvidenceEntry[];
  after: AfterRun;
  baselineGates: readonly GateResult[];
}): Omit<Finding, "id">[] {
  const { after } = input;
  const findings: Omit<Finding, "id">[] = [];
  const flaky = new Set(after.flaky.map((ref) => refKey(ref.gateId, ref.testId)));
  const covered = new Set<string>();
  const report = (gateId: string, testId: string, text: string, excerpt?: string): Evidence => ({
    kind: "test-report",
    description: `${testId} (gate ${gateId}): ${text}`,
    deterministic: true,
    ...(excerpt === undefined ? {} : { excerpt: excerpt.slice(0, 4000) }),
  });

  for (const entry of input.entries) {
    const key = refKey(entry.gateId, entry.testId);
    const outcome = entry.evidence.after;
    if (flaky.has(key)) continue;
    if (entry.evidence.afterAssessment === "failed") {
      covered.add(key);
      findings.push({
        title: `${entry.acId}: ${entry.testId} fails after the change (${outcome})`,
        severity: "high",
        category: "requirement",
        source: "deterministic",
        verification: "confirmed",
        evidence: [
          report(entry.gateId, entry.testId, `${outcome} after the change`, entry.afterMessage),
        ],
        location: { path: entry.file },
        recommendation: `The implementation does not meet ${entry.acId} as its approved test checks it. Read the failure and fix the code, or the test if it is wrong.`,
      });
    } else if (entry.evidence.afterAssessment === "not_verified") {
      covered.add(key);
      findings.push({
        title: `${entry.acId}: ${entry.testId} gave no result after the change (${outcome})`,
        severity: "medium",
        category: "test-gap",
        source: "deterministic",
        verification: "confirmed",
        evidence: [
          report(entry.gateId, entry.testId, `${outcome} after the change`, entry.afterMessage),
        ],
        location: { path: entry.file },
        recommendation:
          "The test did not pass or fail, so it proves nothing. Fix the reason shown in the evidence and run the tests again.",
      });
    }
  }
  for (const regression of after.regressions) {
    const key = refKey(regression.gateId, regression.testId);
    if (covered.has(key)) continue;
    covered.add(key);
    const message = after.gates
      .find((gate) => gate.gateId === regression.gateId)
      ?.tests.find((test) => test.id === regression.testId)?.message;
    findings.push({
      title: `Regression: ${regression.testId} passed before the change and fails after it`,
      severity: "high",
      category: "regression",
      source: "deterministic",
      verification: "confirmed",
      evidence: [
        report(
          regression.gateId,
          regression.testId,
          "passed before, failed after, failed again when rerun",
          message,
        ),
      ],
      recommendation:
        "The change broke behaviour an existing test checks. Fix the code, or explain why the test must change.",
    });
  }
  for (const ref of after.flaky) {
    findings.push({
      title: `${ref.testId} is flaky: it failed and then passed when run again`,
      severity: "medium",
      category: "regression",
      source: "deterministic",
      verification: "unverified",
      evidence: [report(ref.gateId, ref.testId, "failed, then passed when rerun")],
      recommendation:
        "An inconsistent test proves nothing either way. Make it deterministic, then verify again.",
    });
  }
  if (after.stillFailing.length > 0) {
    findings.push({
      title: `${String(after.stillFailing.length)} test(s) failed before the change and still fail`,
      severity: "info",
      category: "quality",
      source: "deterministic",
      verification: "confirmed",
      evidence: after.stillFailing
        .slice(0, 20)
        .map((ref) => report(ref.gateId, ref.testId, "failed before and after the change")),
      recommendation: "These failures are not attributed to the change; fix them separately.",
    });
  }
  for (const gateId of after.failedGates) {
    const gate = after.gates.find((candidate) => candidate.gateId === gateId);
    if (gate === undefined) continue;
    const testFailed = gate.tests.some(
      (test) => test.status === "failed" && !flaky.has(refKey(gate.gateId, test.id)),
    );
    if (testFailed) continue;
    const before = input.baselineGates.find((candidate) => candidate.gateId === gateId);
    const already = before?.status === gate.status;
    findings.push({
      title: `Gate ${gateId} is ${gate.status} after the change${already ? ", as it was before" : ""}`,
      severity: already ? "low" : gate.status === "failed" ? "high" : "medium",
      category: "quality",
      source: "deterministic",
      verification: "confirmed",
      evidence: [
        {
          kind: "note",
          description: `gate ${gateId} (${gate.commandId}): ${gate.status}${gate.reason === undefined ? "" : `, ${gate.reason}`}`,
          deterministic: true,
        },
      ],
      recommendation:
        gate.status === "failed"
          ? "Read the gate's diagnostics and fix them."
          : "The gate did not give a trustworthy result; fix the reason and verify again.",
    });
  }
  return findings;
}
