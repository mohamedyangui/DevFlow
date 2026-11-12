import {
  type Evidence,
  type Finding,
  type GateDenial,
  type GateResult,
  type PathGuard,
  RepoPath,
  type SecretRedactor,
  type TestCaseResult,
  isDevflowError,
} from "@devflow-ai/core";
import type { ProbeRecord, ProbeWire } from "./schemas.js";
import { type TestModule, isTestPath, sha256Of } from "./test-design.js";

/**
 * Evidence-seeking review (ADR 0025): the deterministic side. The model proposes one test file
 * per suspected defect; it is data, checked here before anything is written. The test runs in
 * a git worktree of the reviewed state, never in the user's working tree, through the
 * adapter's filtered test command and the command policy. Its result is classified by rules:
 * only an assertion failure of the targeted test confirms a finding.
 */

/** `--max-probes` when it is not given. */
export const DEFAULT_MAX_PROBES = 3;
/** `--max-probes` cannot go above this. */
export const MAX_PROBES = 10;
/** Largest probe test file the model may write. */
export const MAX_PROBE_FILE_BYTES = 64 * 1024;
/**
 * Where the worktree of the reviewed state is created, relative to the workspace. It is the
 * same for every run, so the probe command keeps one fingerprint that a person can approve
 * once (`--allow` or "always"); one review probes at a time.
 */
export const PROBE_WORKTREE = ".devflow/probes/worktree";

/** The test name doubles as the adapter's filter: letters, digits, spaces and `_:,-` only. */
const TEST_NAME = /^[A-Za-z0-9][A-Za-z0-9 _:,-]{0,119}$/;
const PROBED_SEVERITIES: ReadonlySet<Finding["severity"]> = new Set(["critical", "high", "medium"]);
const SEVERITY_ORDER: Readonly<Record<Finding["severity"], number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
const MAX_REASON = 600;

/**
 * The findings to probe: AI findings that are still unverified, of severity medium or higher,
 * with a location; the most severe (then the most confident) first, at most `max`.
 */
export function probeCandidates(
  findings: readonly Finding[],
  max: number,
): { selected: Finding[]; notProbed: string[] } {
  const eligible = findings
    .filter(
      (finding) =>
        finding.source === "ai" &&
        finding.verification === "unverified" &&
        PROBED_SEVERITIES.has(finding.severity) &&
        finding.location !== undefined,
    )
    .map((finding, index) => ({ finding, index }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.finding.severity] - SEVERITY_ORDER[b.finding.severity] ||
        (b.finding.confidence ?? 0) - (a.finding.confidence ?? 0) ||
        a.index - b.index,
    )
    .map(({ finding }) => finding);
  return {
    selected: eligible.slice(0, max),
    notProbed: eligible.slice(max).map((finding) => finding.id),
  };
}

function within(file: string, root: string): boolean {
  return root === "." || root === "" || file === root || file.startsWith(`${root}/`);
}

/** The module a file belongs to: the one with the deepest root that contains it. */
export function moduleOfFile(file: string, modules: readonly TestModule[]): TestModule | undefined {
  let best: TestModule | undefined;
  for (const module of modules) {
    const root = module.profile.root;
    if (!within(file, root)) continue;
    if (best === undefined || depth(root) > depth(best.profile.root)) best = module;
  }
  return best;
}

function depth(root: string): number {
  return root === "." || root === "" ? 0 : root.split("/").length;
}

function shorten(text: string, max = MAX_REASON): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export type ProbeCheck =
  | {
      readonly ok: true;
      readonly path: string;
      readonly testName: string;
      readonly content: string;
    }
  | {
      readonly ok: false;
      readonly outcome: "refused" | "declined";
      readonly reason: string;
      readonly path?: string;
      readonly testName?: string;
    };

/**
 * Checks the model's probe before anything is written: one new test file of the finding's
 * module (a test path per the adapter's authoring guide), allowed by the path guard for a
 * model write, that exists neither in the working tree nor in the reviewed change, small,
 * without anything the secret detector matches, and naming its test with a filter-safe name.
 */
export async function checkProbe(
  wire: ProbeWire,
  input: {
    readonly module: TestModule;
    readonly guard: PathGuard;
    readonly redactor: SecretRedactor;
    /** The paths of the reviewed diff, deleted files included. */
    readonly reviewed: ReadonlySet<string>;
  },
): Promise<ProbeCheck> {
  const redact = (text: string) => input.redactor.redactText(text);
  if (!wire.feasible) {
    return {
      ok: false,
      outcome: "declined",
      reason: `the model wrote no probe: ${shorten(redact(wire.explanation))}`,
    };
  }
  const { path, testName, content } = wire;
  if (path === null || testName === null || content === null) {
    return {
      ok: false,
      outcome: "refused",
      reason: "the answer has no file path, test name or content",
    };
  }
  const shown = { path: redact(path).slice(0, 300), testName: redact(testName).slice(0, 120) };
  const refuse = (reason: string): ProbeCheck => ({
    ok: false,
    outcome: "refused",
    reason,
    ...(RepoPath.safeParse(shown.path).success ? { path: shown.path } : {}),
    ...(TEST_NAME.test(shown.testName) ? { testName: shown.testName } : {}),
  });
  try {
    const checked = await input.guard.check(path, { access: "write", origin: "model" });
    if (checked.exists) return refuse(`${shown.path} already exists: a probe only adds a file`);
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    return refuse(`the path guard refused the probe file: ${shorten(redact(error.message))}`);
  }
  if (input.reviewed.has(path)) {
    return refuse(`${shown.path} is a file of the reviewed change: a probe only adds a file`);
  }
  const { profile, guide } = input.module;
  if (!within(path, profile.root)) {
    return refuse(`${shown.path} is outside module ${profile.moduleId} (${profile.root})`);
  }
  if (!isTestPath(path, input.module)) {
    return refuse(
      `${shown.path} is not a test file of module ${profile.moduleId} ` +
        `(tests go in ${guide.testRoot}, named like ${guide.fileNamePattern})`,
    );
  }
  if (content.trim() === "" || content.includes("\u0000")) {
    return refuse("the probe file is empty or not text");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_PROBE_FILE_BYTES) {
    return refuse(`the probe file is larger than ${String(MAX_PROBE_FILE_BYTES)} bytes`);
  }
  if (!TEST_NAME.test(testName)) {
    return refuse(
      "the test name must start with a letter or digit and use only letters, digits, spaces " +
        "and _ : , - (at most 120 characters): it is the test runner's filter",
    );
  }
  if (!content.includes(testName)) {
    return refuse(`the test name "${shown.testName}" does not occur in the probe file`);
  }
  if (redact(content) !== content) {
    return refuse("the probe file contains what looks like a secret");
  }
  return { ok: true, path, testName, content };
}

/** How a probe ended; only `confirmed` changes the finding's verification. */
export interface ProbeClassification {
  readonly outcome: "confirmed" | "not_reproduced" | "inconclusive";
  readonly reason: string;
  readonly testId?: string;
  readonly message?: string;
}

/**
 * Classifies the run of a probe from the gate result alone: the targeted test (the probe
 * file's test with the probe's name) failing on an assertion confirms the finding; passing
 * means it was not reproduced; anything else (the command was not allowed, timed out, the file
 * did not compile or load, the test threw another error, no such test ran) is inconclusive.
 */
export function classifyProbe(input: {
  readonly gate: GateResult;
  readonly denial?: GateDenial | undefined;
  /** The probe file, relative to the workspace (inside the worktree). */
  readonly probeFile: string;
  readonly testName: string;
}): ProbeClassification {
  const { gate, denial, testName } = input;
  if (denial !== undefined) {
    return {
      outcome: "inconclusive",
      reason:
        `the probe command was not allowed to run (${denial.reason}): ${shorten(denial.message)}` +
        (denial.fingerprint === undefined
          ? ""
          : `; approve it with --allow ${denial.fingerprint} after reading it`),
    };
  }
  const execution = gate.execution;
  if (execution === undefined) {
    return {
      outcome: "inconclusive",
      reason: `the probe did not run: ${shorten(gate.reason ?? gate.status)}`,
    };
  }
  if (execution.timedOut) {
    return { outcome: "inconclusive", reason: "the probe command timed out" };
  }
  const name = (test: TestCaseResult) => test.name.includes(testName) || test.id.includes(testName);
  const inFile = (test: TestCaseResult) =>
    test.file === input.probeFile || test.id.includes(input.probeFile);
  const named = gate.tests.filter(name);
  const targeted = named.some(inFile) ? named.filter(inFile) : named;
  const failed = targeted.find((test) => test.outcome === "assertion_failure");
  if (failed !== undefined) {
    return {
      outcome: "confirmed",
      reason: "the probe test failed with an assertion failure on the reviewed code",
      testId: failed.id,
      ...(failed.message === undefined ? {} : { message: failed.message }),
    };
  }
  if (targeted.length > 0 && targeted.every((test) => test.outcome === "passed")) {
    return {
      outcome: "not_reproduced",
      reason: "probe passed: not reproduced",
      testId: targeted[0]?.id ?? testName,
    };
  }
  const other = targeted.find((test) => test.outcome !== "passed");
  if (other !== undefined) {
    return {
      outcome: "inconclusive",
      reason:
        `the probe test ended with ${other.outcome.replace("_", " ")}, not an assertion failure` +
        (other.message === undefined ? "" : `: ${shorten(other.message)}`),
      testId: other.id,
    };
  }
  const fileProblem = gate.tests.find(
    (test) => inFile(test) && test.outcome !== "passed" && test.outcome !== "skipped",
  );
  if (fileProblem !== undefined) {
    return {
      outcome: "inconclusive",
      reason:
        `the probe file did not run (${fileProblem.outcome.replace("_", " ")})` +
        (fileProblem.message === undefined ? "" : `: ${shorten(fileProblem.message)}`),
    };
  }
  return {
    outcome: "inconclusive",
    reason:
      `no test named "${testName}" ran from the probe file` +
      (gate.reason === undefined ? "" : ` (${shorten(gate.reason)})`),
  };
}

/**
 * The finding after its probe. A confirmed probe makes it `confirmed`, with the probe file's
 * hash, the command and the failing test as deterministic evidence; any other outcome leaves it
 * `unverified` with a note (a probe that passed does not refute the finding).
 */
export function probedFinding(finding: Finding, probe: ProbeRecord): Finding {
  const evidence: Evidence[] = [];
  const kept =
    probe.artifact === undefined ? "" : ` (kept in ${probe.artifact}; it was never committed)`;
  if (probe.outcome === "confirmed") {
    evidence.push(
      {
        kind: "file",
        description: `probe test written by the model to show this defect${kept}`,
        deterministic: true,
        ...(probe.testFile === undefined ? {} : { path: probe.testFile }),
        ...(probe.sha256 === undefined ? {} : { sha256: probe.sha256 }),
      },
      {
        kind: "execution",
        description:
          `${(probe.argv ?? [probe.commandId ?? "the probe command"]).join(" ")} ran in a git ` +
          `worktree of the reviewed state and exited with ${String(probe.exitCode ?? "no exit code")}`,
        deterministic: true,
      },
      {
        kind: "test-report",
        description: `${probe.testId ?? probe.testName ?? "the probe test"} failed with an assertion failure`,
        deterministic: true,
        ...(probe.message === undefined ? {} : { excerpt: probe.message.slice(0, 4000) }),
      },
    );
    return { ...finding, verification: "confirmed", evidence: [...finding.evidence, ...evidence] };
  }
  evidence.push({
    kind: probe.outcome === "not_reproduced" ? "test-report" : "note",
    description:
      probe.outcome === "not_reproduced"
        ? `probe passed: not reproduced (${probe.testId ?? probe.testName ?? "the probe test"} ` +
          `passed in a worktree of the reviewed state${kept}); the finding stays unverified`
        : `probe ${probe.outcome}: ${probe.reason}`,
    deterministic: true,
    ...(probe.sha256 === undefined ? {} : { sha256: probe.sha256 }),
  });
  return { ...finding, evidence: [...finding.evidence, ...evidence] };
}

/** The hash a probe's evidence names: of the content exactly as it ran. */
export function probeSha256(content: string): string {
  return sha256Of(content);
}
