import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalJson } from "@devflow/ai";
import {
  type Evidence,
  type Finding,
  type GateResult,
  type ModuleProfile,
  type PathGuard,
  RepoPath,
  type TaskContract,
  type TestAuthoringGuide,
  TestEvidence,
  type TestOutcome,
  assessTestEvidence,
  isDevflowError,
} from "@devflow/core";
import type {
  DesignedTest,
  EvidenceEntry,
  PlanCheck,
  TestDesign,
  TestDesignWire,
  TestFiles,
} from "./schemas.js";

/**
 * Test engineering (ADR 0015): the deterministic side of test mode. The model's tests are data:
 * they are checked here before anything is written, the written files are bound to a hash that
 * a person approves, and the red run's results are turned into evidence by rules, never by the
 * model.
 */

/** A module the tests can be written for: its profile and its adapter's authoring guide. */
export interface TestModule {
  readonly profile: ModuleProfile;
  readonly guide: TestAuthoringGuide;
}

/** A file the test design writes, before and after. */
export interface PlannedTestFile {
  readonly path: string;
  readonly action: "create" | "modify";
  /** The current content, or null when the file does not exist. */
  readonly before: string | null;
  readonly after: string;
}

/** Largest test file the model may write. */
export const MAX_TEST_FILE_BYTES = 256 * 1024;

export function sha256Of(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The hash a test approval refers to: every written path with the hash of its content. */
export function testsHash(files: readonly { path: string; afterSha256: string }[]): string {
  return sha256Of(
    canonicalJson(files.map((file) => ({ path: file.path, sha256: file.afterSha256 }))),
  );
}

const JS_TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
const JVM_TEST_NAME = /(Test|Tests|IT)\.(java|kt)$/;
const JVM_TEST_PREFIX = /^Test[A-Z0-9].*\.(java|kt)$/;

function within(path: string, root: string): boolean {
  return root === "." || root === "" || path === root || path.startsWith(`${root}/`);
}

function namePatternRegex(pattern: string): RegExp | undefined {
  if (!pattern.includes("{name}")) return undefined;
  const escaped = pattern
    .split("{name}")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${escaped}$`);
}

/**
 * Whether a path is a test file of the module: inside one of its test roots, and either in a
 * root that holds only tests or named like a test. Test mode never changes production code.
 */
export function isTestPath(path: string, module: TestModule): boolean {
  const { profile, guide } = module;
  const root = profile.testRoots.find((candidate) => within(path, candidate));
  if (root === undefined) return false;
  const dedicated =
    root !== profile.root &&
    root !== "." &&
    !profile.sourceRoots.some((source) => within(source, root) || within(root, source));
  if (dedicated) return true;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    JS_TEST_NAME.test(name) ||
    JVM_TEST_NAME.test(name) ||
    JVM_TEST_PREFIX.test(name) ||
    (namePatternRegex(guide.fileNamePattern)?.test(name) ?? false)
  );
}

/** Whether the text carries the acceptance-criterion marker the adapter parses (ADR 0015). */
export function hasMarker(
  text: string,
  acId: string,
  style: TestAuthoringGuide["acMarker"]["style"],
): boolean {
  const n = acId.slice(3);
  const title = new RegExp(`["'\`]AC-${n}(?![0-9])`);
  if (style === "title-prefix") return title.test(text);
  return new RegExp(`(^|[^A-Za-z0-9_])ac${n}_`).test(text) || title.test(text);
}

function occurrences(text: string, search: string): number {
  if (search === "") return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(search, from);
    if (index < 0) return count;
    count += 1;
    from = index + search.length;
  }
}

/**
 * Applies search and replace edits; each search must occur exactly once in the text as edited
 * so far. A file with CRLF line endings also accepts searches written with LF.
 */
export function applyEdits(
  text: string,
  edits: readonly { search: string; replace: string }[],
): { text: string } | { error: string; index: number } {
  let current = text;
  for (const [index, edit] of edits.entries()) {
    let { search, replace } = edit;
    let count = occurrences(current, search);
    if (count === 0 && current.includes("\r\n") && !search.includes("\r\n")) {
      const crlf = (value: string) => value.replace(/\r?\n/g, "\r\n");
      if (occurrences(current, crlf(search)) > 0) {
        search = crlf(search);
        replace = crlf(replace);
        count = occurrences(current, search);
      }
    }
    if (search === "") return { error: "the search text is empty", index };
    if (count !== 1) {
      return {
        error:
          count === 0
            ? "the search text does not occur in the file"
            : `the search text occurs ${String(count)} times; it must identify one place`,
        index,
      };
    }
    const at = current.indexOf(search);
    current = current.slice(0, at) + replace + current.slice(at + search.length);
  }
  return { text: current };
}

/**
 * Builds the test design from the model's answer and checks it against the task, the modules
 * and the path guard. Errors make the design unusable (the model gets one revision); warnings
 * are reported with it. Nothing is written here.
 */
export async function checkTestDesign(input: {
  wire: TestDesignWire;
  task: TaskContract;
  modules: readonly TestModule[];
  guard: PathGuard;
}): Promise<{
  tests: DesignedTest[];
  files: PlannedTestFile[];
  checks: PlanCheck[];
}> {
  const { wire, task, modules, guard } = input;
  const checks: PlanCheck[] = [];
  const add =
    (severity: PlanCheck["severity"]) =>
    (code: string, message: string, location?: string): void => {
      checks.push({
        severity,
        code,
        message,
        ...(location === undefined ? {} : { location }),
      });
    };
  const error = add("error");
  const warning = add("warning");
  const automated = new Set(
    task.acceptanceCriteria
      .filter((criterion) => criterion.verification === "automated")
      .map((criterion) => criterion.id),
  );
  const known = new Set(task.acceptanceCriteria.map((criterion) => criterion.id));

  const tests: DesignedTest[] = [];
  const files: PlannedTestFile[] = [];
  const seen = new Set<string>();
  for (const [index, test] of wire.tests.entries()) {
    const location = `tests[${String(index)}]`;
    if (!RepoPath.safeParse(test.path).success) {
      error("invalid-path", `"${test.path}" is not a repository-relative path`, `${location}.path`);
      continue;
    }
    if (seen.has(test.path)) {
      error(
        "duplicate-file",
        `"${test.path}" appears twice; put every test of a file in one entry`,
        `${location}.path`,
      );
      continue;
    }
    seen.add(test.path);

    const module = modules.find((candidate) => isTestPath(test.path, candidate));
    if (module === undefined) {
      const roots = modules.flatMap((candidate) => candidate.profile.testRoots);
      error(
        "not-a-test-file",
        `"${test.path}" is not a test file of any module (test roots: ${roots.join(", ") || "none"}); ` +
          "test mode writes tests only, never production code",
        `${location}.path`,
      );
      continue;
    }
    if (test.module !== null && test.module !== module.profile.moduleId) {
      warning(
        "module-corrected",
        `module "${test.module}" corrected to "${module.profile.moduleId}" from the path`,
        `${location}.module`,
      );
    }

    let exists: boolean;
    let absolute: string;
    try {
      const checked = await guard.check(test.path, { access: "write", origin: "model" });
      exists = checked.exists;
      absolute = checked.absolute;
    } catch (rejection) {
      if (!isDevflowError(rejection)) throw rejection;
      error(
        "path-not-writable",
        `"${test.path}" cannot be written: ${rejection.message}`,
        `${location}.path`,
      );
      continue;
    }

    const acIds: string[] = [];
    for (const id of new Set(test.acIds)) {
      if (!known.has(id)) {
        warning(
          "unknown-criterion",
          `"${id}" is not an acceptance criterion of the task`,
          location,
        );
      } else if (!automated.has(id)) {
        warning("manual-criterion", `${id} is verified manually; it was removed`, location);
      } else {
        acIds.push(id);
      }
    }
    if (acIds.length === 0) {
      error(
        "no-criterion",
        `"${test.path}" does not test any automated acceptance criterion of the task`,
        `${location}.acIds`,
      );
      continue;
    }

    let before: string | null = null;
    let after: string;
    let added: string;
    if (test.action === "create") {
      if (exists) {
        error(
          "file-exists",
          `"${test.path}" already exists; modify it with search and replace edits instead`,
          `${location}.path`,
        );
        continue;
      }
      if (test.content === null || test.content.trim() === "") {
        error(
          "missing-content",
          `"${test.path}" is created without content`,
          `${location}.content`,
        );
        continue;
      }
      if (test.edits.length > 0) {
        warning("edits-ignored", "edits are ignored when a file is created", `${location}.edits`);
      }
      after = test.content;
      added = test.content;
    } else {
      if (!exists) {
        error(
          "missing-file",
          `"${test.path}" does not exist, so it cannot be modified; create it instead`,
          `${location}.path`,
        );
        continue;
      }
      if (test.edits.length === 0) {
        error("missing-edits", `"${test.path}" is modified without edits`, `${location}.edits`);
        continue;
      }
      if (test.content !== null) {
        warning(
          "content-ignored",
          "content is ignored when a file is modified; only the edits apply",
          `${location}.content`,
        );
      }
      before = await readFile(absolute, "utf8");
      const edited = applyEdits(before, test.edits);
      if ("error" in edited) {
        error(
          "edit-not-applicable",
          `edit ${String(edited.index + 1)} of "${test.path}": ${edited.error}`,
          `${location}.edits[${String(edited.index)}]`,
        );
        continue;
      }
      after = edited.text;
      added = test.edits.map((edit) => edit.replace).join("\n");
    }
    if (Buffer.byteLength(after, "utf8") > MAX_TEST_FILE_BYTES) {
      error(
        "file-too-large",
        `"${test.path}" would be larger than ${String(MAX_TEST_FILE_BYTES / 1024)} KiB`,
        `${location}.path`,
      );
      continue;
    }
    const style = module.guide.acMarker.style;
    const unmarked = acIds.filter((id) => !hasMarker(added, id, style));
    if (unmarked.length > 0) {
      error(
        "missing-marker",
        `the tests written to "${test.path}" do not carry the marker of ${unmarked.join(", ")} ` +
          `(${style}, for example ${module.guide.acMarker.example}); DevFlow links results to ` +
          "criteria by this marker",
        location,
      );
      continue;
    }

    tests.push({
      id: `T-${String(tests.length + 1)}`,
      acIds,
      module: module.profile.moduleId,
      path: test.path,
      action: test.action,
      description: test.description,
    });
    files.push({ path: test.path, action: test.action, before, after });
  }

  for (const id of automated) {
    if (!tests.some((test) => test.acIds.includes(id))) {
      warning("untested-criterion", `${id} has no test`);
    }
  }
  if (wire.tests.length === 0) {
    error("no-tests", "the test design does not contain any test");
  }
  return { tests, files, checks };
}

/** The `test-files.json` record of files about to be written. */
export function testFilesRecord(files: readonly PlannedTestFile[]): TestFiles {
  const entries = files.map((file) => ({
    path: file.path,
    action: file.action,
    before: file.before,
    beforeSha256: file.before === null ? null : sha256Of(file.before),
    afterSha256: sha256Of(file.after),
  }));
  return { schemaVersion: 1, testsSha256: testsHash(entries), files: entries };
}

/**
 * Turns the red run's results into evidence: one entry per acceptance criterion and test
 * result in a designed file, and an entry without a result when a designed test produced none.
 * The intent comes from the task, the outcome from the test report; the assessment is the rule
 * of ADR 0015. No change was made yet, so nothing is `established`.
 */
export function baselineEvidence(input: {
  task: TaskContract;
  design: TestDesign;
  gates: readonly GateResult[];
  /** The gate that ran each module's tests. */
  gateOfModule: ReadonlyMap<string, string>;
}): EvidenceEntry[] {
  const { task, design, gates } = input;
  const entries: EvidenceEntry[] = [];
  const intentOf = new Map(
    task.acceptanceCriteria.map((criterion) => [criterion.id, criterion.testIntent]),
  );
  for (const test of design.tests) {
    for (const acId of test.acIds) {
      const intent = intentOf.get(acId) ?? "feature";
      for (const result of designedResults(test, acId, gates, input.gateOfModule)) {
        const assessment = assessTestEvidence(intent, result.outcome, "not_executed");
        entries.push({
          acId,
          designedTestId: test.id,
          testId: result.testId,
          gateId: result.gateId,
          file: test.path,
          outcome: result.outcome,
          evidence: TestEvidence.parse({
            intent,
            baseline: result.outcome,
            after: "not_executed",
            ...assessment,
          }),
          ...messageField("message", result.message),
        });
      }
    }
  }
  return entries;
}

/** One result of a designed test for one criterion, or the reason there is none. */
export interface DesignedResult {
  /** The result's id; the designed file when there is no result (`placeholder`). */
  readonly testId: string;
  readonly gateId: string;
  readonly outcome: TestOutcome;
  readonly message?: string | undefined;
  readonly placeholder: boolean;
}

export function messageField(
  key: "message" | "afterMessage",
  message: string | undefined,
): { message?: string; afterMessage?: string } {
  return message === undefined || message === "" ? {} : { [key]: message.slice(0, 8000) };
}

/**
 * The results a gate run gave for a designed test and criterion: each result in the designed
 * file carrying the criterion's marker, or one placeholder whose outcome says why there is none.
 * A designed test without a result is never given an outcome it did not have.
 */
export function designedResults(
  test: DesignedTest,
  acId: string,
  gates: readonly GateResult[],
  gateOfModule: ReadonlyMap<string, string>,
): DesignedResult[] {
  const gateId = gateOfModule.get(test.module);
  const gate = gates.find((candidate) => candidate.gateId === gateId);
  const inFile = gate?.tests.filter((result) => result.file === test.path) ?? [];
  const matching = inFile.filter((result) => result.markers.includes(acId));
  if (gate !== undefined && matching.length > 0) {
    return matching.map((result) => ({
      testId: result.id,
      gateId: gate.gateId,
      outcome: result.outcome,
      message: result.message,
      placeholder: false,
    }));
  }
  const none = (outcome: TestOutcome, gate: string, message: string | undefined) => [
    { testId: test.path, gateId: gate, outcome, message, placeholder: true },
  ];
  if (gate === undefined) {
    return none("not_executed", "none", `no test gate runs the tests of module ${test.module}`);
  }
  if (gate.execution === undefined) return none("not_executed", gate.gateId, gate.reason);
  if (gate.execution.timedOut) return none("timeout", gate.gateId, "the test command timed out");
  const diagnostic = gate.diagnostics.find(
    (candidate) => candidate.severity === "error" && candidate.location?.path === test.path,
  );
  if (diagnostic !== undefined) return none("compile_error", gate.gateId, diagnostic.message);
  if (gate.status === "unverified") return none("infrastructure_error", gate.gateId, gate.reason);
  return none(
    "not_found",
    gate.gateId,
    inFile.length > 0
      ? `the report has results for ${test.path}, but none is marked with ${acId}`
      : `the test report has no result for ${test.path}`,
  );
}

/**
 * Deterministic findings of the red run. They state facts established by the executed tests;
 * whether a fact points at a defect of the test or of the code is for a person to judge.
 */
export function baselineFindings(input: {
  task: TaskContract;
  design: TestDesign | undefined;
  entries: readonly EvidenceEntry[];
}): Finding[] {
  const findings: Finding[] = [];
  const add = (finding: Omit<Finding, "id" | "source">): void => {
    findings.push({ id: `F-${String(findings.length + 1)}`, source: "deterministic", ...finding });
  };
  const evidenceOf = (entry: EvidenceEntry): Evidence[] => [
    {
      kind: entry.testId === entry.file ? "note" : "test-report",
      description: `${entry.testId} (gate ${entry.gateId}): ${entry.outcome} before any change`,
      deterministic: true,
      path: entry.file,
      ...(entry.message === undefined ? {} : { excerpt: entry.message.slice(0, 4000) }),
    },
  ];
  for (const entry of input.entries) {
    const { acId, testId, evidence } = entry;
    switch (evidence.baselineAssessment) {
      case "expected":
        break;
      case "unexpected_pass":
        add({
          title: `${acId}: the feature test ${testId} passed before any change`,
          severity: "medium",
          category: "test-fidelity",
          verification: "confirmed",
          evidence: evidenceOf(entry),
          recommendation: `Check whether the current code already meets ${acId}; if it does not, make the test assert the new behaviour so that it fails before the implementation.`,
        });
        break;
      case "unexpected_failure":
        add({
          title: `${acId}: the ${evidence.intent} test ${testId} fails on the current code (${entry.outcome})`,
          severity: "medium",
          category: "test-fidelity",
          verification: "confirmed",
          evidence: evidenceOf(entry),
          recommendation:
            "A regression or characterization test must pass before the change. Check whether the test is wrong or the current code does not behave as the criterion says.",
        });
        break;
      case "inconclusive":
        add({
          title: `${acId}: the feature test ${testId} fails with a runtime error, not an assertion`,
          severity: "low",
          category: "test-fidelity",
          verification: "confirmed",
          evidence: evidenceOf(entry),
          recommendation:
            "Red evidence requires an assertion failure. Check that the error is the missing behaviour (for example a missing function) and not a broken test.",
        });
        break;
      case "invalid":
        add({
          title: `${acId}: no usable baseline for ${testId} (${entry.outcome})`,
          severity: "medium",
          category: "test-gap",
          verification: "confirmed",
          evidence: evidenceOf(entry),
          recommendation:
            "The test did not produce a pass or a failure, so it proves nothing yet. Fix the reason shown in the evidence and run the tests again.",
        });
        break;
    }
  }
  for (const criterion of input.task.acceptanceCriteria) {
    if (criterion.verification !== "automated") continue;
    if (input.design?.tests.some((test) => test.acIds.includes(criterion.id)) === true) continue;
    add({
      title: `${criterion.id} has no test`,
      severity: "medium",
      category: "test-gap",
      verification: "confirmed",
      evidence: [
        {
          kind: "note",
          description: `the approved test design has no test for ${criterion.id}`,
          deterministic: true,
        },
      ],
      recommendation: `Write a test for ${criterion.id}: "${criterion.statement}".`,
    });
  }
  return findings;
}
