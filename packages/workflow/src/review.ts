import {
  type AcceptanceMatrixRow,
  type Finding,
  type GateResult,
  RepoPath,
  type ResultStatus,
  type TaskContract,
  type TestCaseResult,
  statusForOutcome,
} from "@devflow/core";
import type { ReviewDiff, ReviewWire } from "./schemas.js";

/**
 * The review engine (architecture proposal, section 12): deterministic checks of a local diff
 * first, then the model's review. Deterministic findings come from the diff, the gates and the
 * task; the model's findings carry a confidence and always stay `unverified`: an AI suspicion
 * is never reported as a confirmed defect.
 */

/** Files whose change can add or change dependencies. */
const DEPENDENCY_MANIFESTS = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "libs.versions.toml",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
]);

/** Files that are neither code nor tests: documentation and the like. */
const NOT_CODE = /\.(md|mdx|txt|rst|adoc|png|jpe?g|gif|svg|ico|lock)$|(^|\/)(docs?|\.github)\//i;

/** At most this many findings are taken from the model. */
export const MAX_AI_FINDINGS = 20;

const FINDING_CATEGORIES = new Set<Finding["category"]>([
  "requirement",
  "regression",
  "test-gap",
  "test-fidelity",
  "convention",
  "security",
  "compatibility",
  "scope",
  "quality",
]);

/** Whether a path looks like a test file, in any of the supported languages. */
export function looksLikeTestPath(file: string): boolean {
  const lower = file.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  return (
    /(^|\/)(__tests__|tests?|spec|src\/test|src\/it)\//.test(lower) ||
    /\.(test|spec|e2e|it)\.[cm]?[jt]sx?$/.test(name) ||
    /(test|tests|it|spec)\.(java|kt|scala|groovy)$/.test(name) ||
    /^test_.*\.py$|_test\.(py|go)$/.test(name)
  );
}

export function isDependencyManifest(file: string): boolean {
  return DEPENDENCY_MANIFESTS.has(file.slice(file.lastIndexOf("/") + 1));
}

/** One added or removed line of a unified diff. */
export interface PatchLine {
  readonly path: string;
  /** The line number in the new file (added lines) or the old file (removed lines). */
  readonly line: number;
  readonly text: string;
}

/** The added and removed lines of a unified diff (`+++ b/<path>` and `--- a/<path>` names). */
export function patchLines(patch: string): { added: PatchLine[]; removed: PatchLine[] } {
  const added: PatchLine[] = [];
  const removed: PatchLine[] = [];
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of patch.split("\n")) {
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (text.startsWith("diff --git ")) {
      inHunk = false;
      oldPath = null;
      newPath = null;
      continue;
    }
    if (!inHunk && text.startsWith("--- ")) {
      oldPath = fileName(text.slice(4), "a/");
      continue;
    }
    if (!inHunk && text.startsWith("+++ ")) {
      newPath = fileName(text.slice(4), "b/");
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk !== null) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (!inHunk) continue;
    if (text.startsWith("+")) {
      if (newPath !== null) added.push({ path: newPath, line: newLine, text: text.slice(1) });
      newLine += 1;
    } else if (text.startsWith("-")) {
      if (oldPath !== null) removed.push({ path: oldPath, line: oldLine, text: text.slice(1) });
      oldLine += 1;
    } else if (text.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  return { added, removed };
}

function fileName(field: string, prefix: string): string | null {
  const name = field.split("\t")[0] ?? "";
  if (name === "/dev/null") return null;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/** A public declaration a line introduces: exported (JS/TS) or public (Java, Kotlin). */
export function publicDeclaration(file: string, text: string): string | undefined {
  if (/\.[cm]?[jt]sx?$/.test(file)) {
    const match =
      /^\s*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        text,
      );
    return match?.[1];
  }
  if (/\.(java|kt)$/.test(file)) {
    const type =
      /^\s*public\s+(?:[a-z]+\s+)*(?:class|interface|enum|record|@interface)\s+(\w+)/.exec(text);
    if (type !== null) return type[1];
    const method = /^\s*public\s+(?:[\w<>[\],.? ]+\s+)?(\w+)\s*\(/.exec(text);
    return method?.[1];
  }
  return undefined;
}

/** The tests of the gates that carry an acceptance criterion's marker. */
export function testsOfCriterion(
  gates: readonly GateResult[],
  acId: string,
): { gate: GateResult; test: TestCaseResult; status: ResultStatus }[] {
  return gates.flatMap((gate) =>
    gate.tests
      .filter((test) => test.markers.includes(acId))
      .map((test) => ({ gate, test, status: statusForOutcome(test.outcome) })),
  );
}

/** The acceptance matrix of a review: each criterion's tests in the gates that ran once. */
export function reviewAcceptanceMatrix(
  task: TaskContract,
  gates: readonly GateResult[],
): AcceptanceMatrixRow[] {
  return task.acceptanceCriteria.map((criterion): AcceptanceMatrixRow => {
    const row = {
      acId: criterion.id,
      requirementIds: criterion.covers,
      verification: criterion.verification,
    };
    if (criterion.verification === "manual") {
      return { ...row, tests: [], status: "manual", note: "verified by a person, outside DevFlow" };
    }
    const linked = testsOfCriterion(gates, criterion.id);
    const tests = linked.map(({ gate, test, status }) => ({
      testId: test.id,
      gateId: gate.gateId,
      status,
    }));
    if (tests.length === 0) {
      return {
        ...row,
        tests,
        status: "not_executed",
        note:
          gates.length === 0
            ? "no gate ran"
            : `no test that ran carries the marker ${criterion.id}`,
      };
    }
    const note = "the tests ran once, on the changed code; there is no run before the change";
    return {
      ...row,
      tests,
      status: tests.every((test) => test.status === "passed")
        ? "verified"
        : tests.some((test) => test.status === "failed")
          ? "failed"
          : tests.every((test) => test.status === "not_executed")
            ? "not_executed"
            : "unverified",
      note,
    };
  });
}

type NewFinding = Omit<Finding, "id">;

function note(description: string, deterministic = true): Finding["evidence"][number] {
  return { kind: "note", description, deterministic };
}

function location(path: string, line?: number): Pick<Finding, "location"> {
  const parsed = RepoPath.safeParse(path);
  if (!parsed.success) return {};
  return { location: { path: parsed.data, ...(line === undefined ? {} : { line }) } };
}

/**
 * Deterministic findings of a review: gates, acceptance criteria, secrets and protected files
 * in the change, source changed without tests, removed public declarations, dependency
 * manifests. Facts with deterministic evidence are `confirmed`; heuristics that may or may not
 * be a defect stay `unverified`.
 */
export function reviewFindings(input: {
  readonly task: TaskContract;
  readonly diff: ReviewDiff;
  readonly patch: string;
  readonly gates: readonly GateResult[];
}): NewFinding[] {
  const { task, diff, gates } = input;
  const findings: NewFinding[] = [];

  for (const gate of gates) {
    if (gate.status === "failed") {
      const failed = gate.tests.filter((test) => test.status === "failed");
      findings.push({
        title: `Gate ${gate.gateId} failed on the change`,
        severity: gate.required ? "high" : "medium",
        category: "quality",
        source: "deterministic",
        verification: "confirmed",
        evidence: [
          {
            kind: "execution",
            description:
              `${gate.commandId} exited with ${String(gate.execution?.exitCode ?? "no exit code")}` +
              (failed.length > 0 ? `; ${String(failed.length)} test(s) failed` : ""),
            deterministic: true,
          },
          ...failed.slice(0, 5).map((test) => note(`failed: ${test.id}`)),
        ],
        recommendation:
          "Fix the failures before merging. There was no run before the change, so failures " +
          "that were already there cannot be told apart: run `devflow verify` on the base to compare.",
      });
    } else if (gate.status === "not_executed" || gate.status === "unverified") {
      findings.push({
        title: `Gate ${gate.gateId} did not run`,
        severity: gate.required ? "medium" : "low",
        category: "test-gap",
        source: "deterministic",
        verification: "confirmed",
        evidence: [note(gate.reason ?? `the gate is ${gate.status}`)],
        recommendation: "Make the gate's tool available, then review again.",
      });
    }
  }

  for (const criterion of task.acceptanceCriteria) {
    if (criterion.verification === "manual") continue;
    const linked = testsOfCriterion(gates, criterion.id);
    const failed = linked.filter((entry) => entry.status === "failed");
    if (failed.length > 0) {
      findings.push({
        title: `${criterion.id} is not met: its tests fail`,
        severity: "high",
        category: "requirement",
        source: "deterministic",
        verification: "confirmed",
        evidence: failed.map(({ test }) => ({
          kind: "test-report" as const,
          description: `${test.id} ${test.outcome.replace("_", " ")}`,
          deterministic: true,
        })),
        recommendation: `Make the change satisfy ${criterion.id}: ${criterion.statement}`,
      });
    } else if (linked.length === 0 && gates.length > 0) {
      findings.push({
        title: `No test that ran is linked to ${criterion.id}`,
        severity: "medium",
        category: "test-gap",
        source: "deterministic",
        verification: "confirmed",
        evidence: [note(`no test result carries the marker ${criterion.id}`)],
        recommendation: `Add a test for ${criterion.id} with its marker (for example "${criterion.id}: ..." in the test title).`,
      });
    }
  }

  for (const secret of diff.secrets) {
    findings.push({
      title: "The change adds what looks like a secret",
      severity: "high",
      category: "security",
      source: "deterministic",
      verification: "confirmed",
      evidence: [
        {
          kind: "file",
          description: "the secret detector matched an added line (its value is not repeated here)",
          deterministic: true,
          ...location(secret.path, secret.line).location,
        },
      ],
      ...location(secret.path, secret.line),
      recommendation:
        "Remove the value from the change, rotate it if it is real, and read it from the environment instead.",
    });
  }

  for (const entry of diff.protected) {
    const workflow = /(^|\/)\.github\/workflows\//.test(entry.path);
    findings.push({
      title: workflow
        ? `The change modifies a CI workflow: ${entry.path}`
        : `The change touches a protected file: ${entry.path}`,
      severity: workflow ? "high" : "medium",
      category: workflow ? "security" : "scope",
      source: "deterministic",
      verification: "confirmed",
      evidence: [note(entry.reason)],
      ...location(entry.path),
      recommendation: workflow
        ? "Review the workflow change line by line: it runs in CI with the repository's permissions."
        : "Check that this file had to change, and review it with extra care.",
    });
  }

  const code = diff.files.filter((file) => !NOT_CODE.test(file.path) && !file.binary);
  const tests = code.filter((file) => file.test);
  const sources = code.filter(
    (file) => !file.test && !isDependencyManifest(file.path) && file.change !== "deleted",
  );
  if (sources.length > 0 && tests.length === 0) {
    findings.push({
      title: "Source files changed without any test change",
      severity: "low",
      category: "test-gap",
      source: "deterministic",
      verification: "unverified",
      evidence: [
        note(
          `changed: ${sources
            .slice(0, 10)
            .map((file) => file.path)
            .join(", ")}${sources.length > 10 ? ", ..." : ""}`,
        ),
      ],
      recommendation:
        "Check whether the change needs a new or updated test; existing tests may already cover it.",
    });
  }

  const { added, removed } = patchLines(input.patch);
  const addedNames = new Set(
    added.flatMap((line) => {
      const name = publicDeclaration(line.path, line.text);
      return name === undefined ? [] : [`${line.path}\0${name}`];
    }),
  );
  const reported = new Set<string>();
  for (const line of removed) {
    if (looksLikeTestPath(line.path)) continue;
    const name = publicDeclaration(line.path, line.text);
    if (name === undefined) continue;
    const key = `${line.path}\0${name}`;
    if (reported.has(key)) continue;
    reported.add(key);
    const kept = addedNames.has(key);
    findings.push({
      title: kept
        ? `The public declaration ${name} changed in ${line.path}`
        : `The public declaration ${name} was removed from ${line.path}`,
      severity: kept ? "low" : "medium",
      category: "compatibility",
      source: "deterministic",
      verification: "unverified",
      evidence: [note(`removed line ${String(line.line)}: ${line.text.trim().slice(0, 300)}`)],
      ...location(line.path, line.line),
      recommendation:
        "Check the callers of this declaration, in this repository and outside it, before merging.",
    });
  }

  const manifests = diff.files.filter((file) => isDependencyManifest(file.path));
  for (const manifest of manifests) {
    findings.push({
      title: `A dependency manifest changed: ${manifest.path}`,
      severity: "info",
      category: "compatibility",
      source: "deterministic",
      verification: "confirmed",
      evidence: [
        note(
          `${manifest.change}, ${String(manifest.additions ?? "?")} line(s) added and ` +
            `${String(manifest.deletions ?? "?")} removed`,
        ),
      ],
      ...location(manifest.path),
      recommendation:
        "Check each added or upgraded dependency: its licence, its maintainers and its install scripts.",
    });
  }

  if (diff.patchTruncated) {
    findings.push({
      title: "The diff was too large to review whole",
      severity: "info",
      category: "quality",
      source: "deterministic",
      verification: "confirmed",
      evidence: [note("the patch was cut at a file boundary; later files were not reviewed")],
      recommendation: "Review the remaining files yourself, or review the change in smaller parts.",
    });
  }
  return findings;
}

/**
 * The model's findings, as `unverified` AI findings with their confidence. A location is kept
 * only when it names a file of the diff; at most {@link MAX_AI_FINDINGS} are kept.
 */
export function aiFindings(
  wire: ReviewWire,
  input: { readonly diff: ReviewDiff; readonly task: TaskContract },
): { findings: NewFinding[]; dropped: number } {
  const files = new Set(input.diff.files.map((file) => file.path));
  const criteria = new Set(input.task.acceptanceCriteria.map((criterion) => criterion.id));
  const findings: NewFinding[] = [];
  for (const finding of wire.findings.slice(0, MAX_AI_FINDINGS)) {
    const inDiff = finding.path !== null && files.has(finding.path);
    const related = finding.acIds.filter((id) => criteria.has(id));
    findings.push({
      title: finding.title,
      severity: finding.severity,
      category: FINDING_CATEGORIES.has(finding.category) ? finding.category : "quality",
      source: "ai",
      verification: "unverified",
      confidence: finding.confidence,
      evidence: [
        note(finding.description, false),
        ...(related.length === 0 ? [] : [note(`related criteria: ${related.join(", ")}`, false)]),
        ...(finding.path !== null && !inDiff
          ? [note(`the model named ${finding.path}, which is not in the diff`, false)]
          : []),
      ],
      ...(inDiff && finding.path !== null ? location(finding.path, finding.line ?? undefined) : {}),
      recommendation: finding.recommendation,
    });
  }
  return { findings, dropped: Math.max(0, wire.findings.length - MAX_AI_FINDINGS) };
}

/** An untracked file as a new-file section of a unified diff, so it is reviewed like the rest. */
export function untrackedSection(file: string, content: string): string {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return [
    `diff --git a/${file} b/${file}`,
    "new file (untracked)",
    "--- /dev/null",
    `+++ b/${file}`,
    `@@ -0,0 +1,${String(lines.length)} @@`,
    ...lines.map((line) => `+${line}`),
    "",
  ].join("\n");
}

/**
 * Replaces the sections of files that are never sent to a model (`.env`, keys, ...) with a
 * line that says so. A section is the text from one `diff --git` line to the next.
 */
export function withholdSections(patch: string, withheld: ReadonlySet<string>): string {
  if (withheld.size === 0) return patch;
  const sections = patch.split(/(?=^diff --git )/m);
  return sections
    .map((section) => {
      const { added, removed } = patchLines(section);
      const names = new Set([...added, ...removed].map((line) => line.path));
      const header = /^\+\+\+ b\/(.+)$|^--- a\/(.+)$/m.exec(section);
      const name = header?.[1] ?? header?.[2];
      if (name !== undefined) names.add(name.split("\t")[0] ?? name);
      const hidden = [...names].find((file) => withheld.has(file));
      return hidden === undefined
        ? section
        : `diff --git a/${hidden} b/${hidden}\n(content withheld: this file is never sent to a model)\n`;
    })
    .join("");
}
