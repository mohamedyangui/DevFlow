import {
  freshReportFiles,
  joinRepoPath,
  statusForOutcome,
  unparseable,
  type CommandSpec,
  type Diagnostic,
  type Evidence,
  type ExecutionRecord,
  type ParsedCommandResults,
  type RepositoryView,
  type TestCaseResult,
  type TestOutcome,
} from "@devflow-ai/core";
import { sourceAndTestRoots } from "./analyze.js";
import { loadBuildModel } from "./build.js";
import { JAVA_PARSERS } from "./commands.js";
import type { BuildModel } from "./model.js";
import { baseName, toRepoRelative, unique } from "./paths.js";
import { child, children, descendants, parseXml, path, type XmlElement } from "./xml.js";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE = 2_000;
const MAX_DIAGNOSTICS = 500;
const MAX_REPORT_EVIDENCE = 100;

// ---- Markers --------------------------------------------------------------------------------

const METHOD_PREFIX = /^((?:ac[1-9][0-9]{0,3}_)+)/i;
const TITLE_MARKER = /\bAC-([1-9][0-9]{0,3})\b/g;

/**
 * Acceptance criteria named by a test (ADR 0015): a method-name prefix (`ac1_…`, `ac1_ac2_…`)
 * or `AC-n` in a display name (`AC-1: returns the second page`).
 */
export function acceptanceMarkers(...names: readonly string[]): string[] {
  const numbers = new Set<number>();
  for (const name of names) {
    const prefix = METHOD_PREFIX.exec(name)?.[1];
    if (prefix !== undefined) {
      for (const part of prefix.split("_")) {
        const n = /^ac([0-9]+)$/i.exec(part)?.[1];
        if (n !== undefined) numbers.add(Number(n));
      }
    }
    for (const match of name.matchAll(TITLE_MARKER)) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b).map((n) => `AC-${String(n)}`);
}

// ---- JUnit XML ------------------------------------------------------------------------------

export interface JUnitCase {
  readonly classname: string;
  readonly name: string;
  readonly outcome: TestOutcome;
  readonly durationMs?: number;
  readonly message?: string;
}

function shorten(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

function problemMessage(element: {
  attributes: Readonly<Record<string, string>>;
  text: string;
}): string | undefined {
  const type = element.attributes.type;
  const message =
    element.attributes.message ?? element.text.split(/\r?\n/).find((line) => line.trim() !== "");
  const text = [type, message?.trim()]
    .filter((part) => part !== undefined && part !== "")
    .join(": ");
  return text === "" ? undefined : shorten(text);
}

/**
 * Reads a Surefire, Failsafe or Gradle JUnit XML report (`<testsuite>` or `<testsuites>`).
 * Returns undefined when the document is not such a report.
 */
export function parseJUnitXml(text: string): JUnitCase[] | undefined {
  const root = parseXml(text);
  if (root === undefined || (root.name !== "testsuite" && root.name !== "testsuites"))
    return undefined;
  const out: JUnitCase[] = [];
  for (const testcase of descendants(root, "testcase")) {
    const classname = testcase.attributes.classname ?? "";
    const name = testcase.attributes.name ?? "";
    if (classname === "" && name === "") continue;
    const failure = child(testcase, "failure");
    const error = child(testcase, "error");
    const skipped = child(testcase, "skipped");
    let outcome: TestOutcome = "passed";
    let problem: XmlElement | undefined;
    if (failure !== undefined) {
      outcome = "assertion_failure";
      problem = failure;
    } else if (error !== undefined) {
      outcome = /(?:Timeout|TimedOut)Exception$/.test(error.attributes.type ?? "")
        ? "timeout"
        : "runtime_error";
      problem = error;
    } else if (skipped !== undefined) {
      outcome = "skipped";
      problem = skipped;
    }
    const seconds = Number.parseFloat((testcase.attributes.time ?? "").replace(/,/g, ""));
    const message = problem === undefined ? undefined : problemMessage(problem);
    out.push({
      classname,
      name,
      outcome,
      ...(Number.isFinite(seconds) && seconds >= 0
        ? { durationMs: Math.round(seconds * 1000) }
        : {}),
      ...(message === undefined ? {} : { message }),
    });
  }
  return out;
}

const OUTCOME_WEIGHT: Readonly<Record<TestOutcome, number>> = {
  assertion_failure: 6,
  runtime_error: 6,
  timeout: 5,
  infrastructure_error: 4,
  compile_error: 4,
  passed: 2,
  skipped: 1,
  not_found: 0,
  not_executed: 0,
};

/** One result per test id; a test reported twice keeps its worst outcome. */
function mergeById(tests: readonly TestCaseResult[]): TestCaseResult[] {
  const byId = new Map<string, TestCaseResult>();
  for (const test of tests) {
    const existing = byId.get(test.id);
    if (existing === undefined || OUTCOME_WEIGHT[test.outcome] > OUTCOME_WEIGHT[existing.outcome]) {
      byId.set(test.id, test);
    }
  }
  return [...byId.values()];
}

// ---- Checkstyle and SpotBugs ----------------------------------------------------------------

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function positive(value: string | undefined): number | undefined {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** Reads a Checkstyle XML report. File names are absolute; they are made repository-relative. */
export function parseCheckstyleXml(text: string, repoRoot: string): Diagnostic[] | undefined {
  const root = parseXml(text);
  if (root?.name !== "checkstyle") return undefined;
  const out: Diagnostic[] = [];
  for (const file of children(root, "file")) {
    const location = toRepoRelative(repoRoot, file.attributes.name ?? "");
    for (const error of children(file, "error")) {
      const severity = error.attributes.severity;
      if (severity === "ignore") continue;
      const source = error.attributes.source;
      const ruleId =
        source === undefined
          ? undefined
          : (source.split(".").pop() ?? source).replace(/Check$/, "");
      const line = positive(error.attributes.line);
      const column = positive(error.attributes.column);
      const message = error.attributes.message ?? ruleId ?? "Checkstyle violation";
      out.push({
        tool: "checkstyle",
        severity: severity === "error" ? "error" : severity === "warning" ? "warning" : "info",
        message: shorten(
          location === undefined ? `${baseName(file.attributes.name ?? "")}: ${message}` : message,
        ),
        ...(ruleId === undefined || ruleId === "" ? {} : { ruleId }),
        ...(location === undefined
          ? {}
          : {
              location: {
                path: location,
                ...(line === undefined ? {} : { line }),
                ...(column === undefined ? {} : { column }),
              },
            }),
      });
    }
  }
  return out;
}

export interface SpotBugsFinding {
  readonly type: string;
  readonly severity: Diagnostic["severity"];
  readonly message: string;
  /** Package-relative source path, e.g. `com/acme/Orders.java`. */
  readonly sourcePath?: string;
  readonly line?: number;
}

/** Reads a SpotBugs XML report (`<BugCollection>`). */
export function parseSpotBugsXml(
  text: string,
): { readonly findings: SpotBugsFinding[]; readonly srcDirs: string[] } | undefined {
  const root = parseXml(text);
  if (root?.name !== "BugCollection") return undefined;
  const srcDirs = path(root, ["Project", "SrcDir"])
    .map((dir) => dir.text)
    .filter((dir) => dir !== "");
  const findings: SpotBugsFinding[] = [];
  for (const bug of children(root, "BugInstance")) {
    const type = bug.attributes.type ?? "SPOTBUGS";
    const priority = bug.attributes.priority;
    const message =
      nonEmpty(child(bug, "LongMessage")?.text) ??
      nonEmpty(child(bug, "ShortMessage")?.text) ??
      type;
    const sourceLine = child(bug, "SourceLine");
    const line = positive(sourceLine?.attributes.start);
    const sourcePath = sourceLine?.attributes.sourcepath;
    findings.push({
      type,
      severity: priority === "1" ? "error" : priority === "2" ? "warning" : "info",
      message: shorten(message),
      ...(sourcePath === undefined || sourcePath === "" ? {} : { sourcePath }),
      ...(line === undefined ? {} : { line }),
    });
  }
  return { findings, srcDirs };
}

// ---- Compiler output ------------------------------------------------------------------------

const MAVEN_COMPILER = /^\[(ERROR|WARNING)\]\s+(.+?\.(?:java|kt)):\[(\d+)(?:,(\d+))?\]\s*(.*)$/;
const JAVAC = /^(.+?\.java):(\d+):\s*(error|warning):\s*(.*)$/;
const KOTLINC = /^([ew]):\s+(.+?\.kts?):(\d+):(\d+)\s+(.*)$/;
const KOTLINC_OLD = /^([ew]):\s+(.+?\.kts?):\s*\((\d+),\s*(\d+)\):\s*(.*)$/;

/** Compiler errors and warnings in Maven or Gradle output (javac and kotlinc formats). */
export function parseCompilerOutput(text: string, repoRoot: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    if (out.length >= MAX_DIAGNOSTICS) break;
    const line = raw.trimEnd();
    let file: string | undefined;
    let row: string | undefined;
    let column: string | undefined;
    let level: "error" | "warning" | undefined;
    let message: string | undefined;
    let tool = "javac";
    let match = MAVEN_COMPILER.exec(line);
    if (match !== null) {
      [, , file, row, column, message] = match;
      level = match[1] === "ERROR" ? "error" : "warning";
      if (file?.endsWith(".kt") === true) tool = "kotlinc";
    } else if ((match = JAVAC.exec(line)) !== null) {
      [, file, row, , message] = match;
      level = match[3] === "error" ? "error" : "warning";
    } else if ((match = KOTLINC.exec(line) ?? KOTLINC_OLD.exec(line)) !== null) {
      [, , file, row, column, message] = match;
      level = match[1] === "e" ? "error" : "warning";
      tool = "kotlinc";
    }
    if (file === undefined || level === undefined || message === undefined || message.trim() === "")
      continue;
    const location = toRepoRelative(repoRoot, file);
    const lineNumber = positive(row);
    const columnNumber = positive(column);
    const key = `${location ?? file}:${row ?? ""}:${column ?? ""}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      tool,
      severity: level,
      message: shorten(
        location === undefined
          ? `${baseName(file.replace(/\\/g, "/"))}: ${message.trim()}`
          : message.trim(),
      ),
      ...(location === undefined
        ? {}
        : {
            location: {
              path: location,
              ...(lineNumber === undefined ? {} : { line: lineNumber }),
              ...(columnNumber === undefined ? {} : { column: columnNumber }),
            },
          }),
    });
  }
  return out;
}

// ---- parseResults ---------------------------------------------------------------------------

/**
 * The command's output. The verification engine makes the execution's stdout and stderr logs
 * readable through the repository view for this call; when they are not, there is no output.
 */
async function readOutput(
  repo: RepositoryView,
  execution: ExecutionRecord,
): Promise<string | undefined> {
  const parts: string[] = [];
  for (const logPath of [execution.stdoutPath, execution.stderrPath]) {
    try {
      parts.push(await repo.readText(logPath, { maxBytes: MAX_LOG_BYTES }));
    } catch {
      // Not readable: treated as no output.
    }
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function executionEvidence(execution: ExecutionRecord): Evidence {
  return {
    kind: "execution",
    description: `${execution.commandId} exited with ${
      execution.exitCode === null ? "no exit code" : `code ${String(execution.exitCode)}`
    }${execution.timedOut ? " (timed out)" : ""}`,
    deterministic: true,
  };
}

interface ReportLocation {
  readonly directory: string;
  readonly name: RegExp;
  readonly depth: number;
}

async function freshReports(
  repo: RepositoryView,
  locations: readonly ReportLocation[],
  startedAt: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const location of locations) {
    const files = await freshReportFiles(repo, location.directory, {
      name: location.name,
      startedAt,
      depth: location.depth,
    });
    found.push(...files.map((file) => file.path));
  }
  return unique(found).sort();
}

async function readReport(repo: RepositoryView, reportPath: string): Promise<string | undefined> {
  try {
    return await repo.readText(reportPath, { maxBytes: MAX_REPORT_BYTES });
  } catch {
    return undefined;
  }
}

function reportEvidence(paths: readonly string[], description: string): Evidence[] {
  return paths.slice(0, MAX_REPORT_EVIDENCE).map((reportPath) => ({
    kind: "tool-report" as const,
    description,
    deterministic: true,
    path: reportPath,
  }));
}

async function compilerDiagnostics(
  repo: RepositoryView,
  execution: ExecutionRecord,
): Promise<Diagnostic[]> {
  if (execution.exitCode === 0) return [];
  const output = await readOutput(repo, execution);
  return output === undefined
    ? []
    : parseCompilerOutput(output, repo.root).filter((d) => d.severity === "error");
}

/** Maps a test class to its source file in one of the test roots, when it exists. */
function testFileResolver(repo: RepositoryView, testRoots: readonly string[]) {
  const cache = new Map<string, string | undefined>();
  return async (classname: string): Promise<string | undefined> => {
    const outer = classname.replace(/\$.*$/, "");
    if (cache.has(outer)) return cache.get(outer);
    let found: string | undefined;
    if (/^[A-Za-z_$][A-Za-z0-9_$.]*$/.test(outer)) {
      const relative = outer.replace(/\./g, "/");
      search: for (const root of testRoots) {
        for (const ext of [".java", ".kt"]) {
          const candidate = joinRepoPath(root, `${relative}${ext}`);
          if (await repo.exists(candidate)) {
            found = candidate;
            break search;
          }
        }
      }
    }
    cache.set(outer, found);
    return found;
  };
}

async function parseTests(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
  model: BuildModel | undefined,
): Promise<ParsedCommandResults> {
  const dirs = model?.projectDirs ?? [command.cwd];
  const locations: ReportLocation[] =
    model?.tool === "gradle"
      ? dirs.map((dir) => ({
          directory: joinRepoPath(dir, "build/test-results"),
          name: /^TEST-.+\.xml$/,
          depth: 1,
        }))
      : dirs.flatMap((dir) => [
          {
            directory: joinRepoPath(dir, "target/surefire-reports"),
            name: /^TEST-.+\.xml$/,
            depth: 0,
          },
          {
            directory: joinRepoPath(dir, "target/failsafe-reports"),
            name: /^TEST-.+\.xml$/,
            depth: 0,
          },
        ]);
  const reports = await freshReports(repo, locations, execution.startedAt);
  const diagnostics = await compilerDiagnostics(repo, execution);
  if (reports.length === 0) {
    return {
      ...unparseable(
        diagnostics.length > 0
          ? "no test report was written by this run; the build failed with compiler errors"
          : "no fresh JUnit XML report was written by this run",
      ),
      diagnostics,
      evidence: [executionEvidence(execution)],
    };
  }
  const testRoots = model === undefined ? [] : (await sourceAndTestRoots(repo, model)).testRoots;
  const resolveFile = testFileResolver(repo, testRoots);
  const tests: TestCaseResult[] = [];
  for (const reportPath of reports) {
    const text = await readReport(repo, reportPath);
    const cases = text === undefined ? undefined : parseJUnitXml(text);
    if (cases === undefined) {
      return {
        ...unparseable(`test report ${reportPath} could not be read as JUnit XML`),
        diagnostics,
        evidence: [executionEvidence(execution)],
      };
    }
    for (const testCase of cases) {
      const method = testCase.name.replace(/\(\)$/, "");
      const file = testCase.classname === "" ? undefined : await resolveFile(testCase.classname);
      tests.push({
        id: testCase.classname === "" ? method : `${testCase.classname}#${method}`,
        name: testCase.name,
        ...(file === undefined ? {} : { file }),
        outcome: testCase.outcome,
        status: statusForOutcome(testCase.outcome),
        markers: acceptanceMarkers(testCase.name),
        ...(testCase.durationMs === undefined ? {} : { durationMs: testCase.durationMs }),
        ...(testCase.message === undefined ? {} : { message: testCase.message }),
      });
    }
  }
  const merged = mergeById(tests);
  return {
    parse: "parsed",
    tests: merged,
    diagnostics,
    evidence: [executionEvidence(execution), ...reportEvidence(reports, "JUnit XML test report")],
    ...(merged.length === 0 ? { note: "the test reports contain no test cases" } : {}),
    ...(reports.length > MAX_REPORT_EVIDENCE
      ? {
          note: `${String(reports.length)} reports were read; the first ${String(MAX_REPORT_EVIDENCE)} are listed as evidence`,
        }
      : {}),
  };
}

async function parseCheckstyle(
  execution: ExecutionRecord,
  repo: RepositoryView,
  dirs: readonly string[],
  tool: BuildModel["tool"] | undefined,
): Promise<ParsedCommandResults> {
  const locations: ReportLocation[] = dirs.map((dir) =>
    tool === "gradle"
      ? { directory: joinRepoPath(dir, "build/reports/checkstyle"), name: /\.xml$/, depth: 0 }
      : { directory: joinRepoPath(dir, "target"), name: /^checkstyle-result\.xml$/, depth: 0 },
  );
  const reports = await freshReports(repo, locations, execution.startedAt);
  if (reports.length === 0) {
    return {
      ...unparseable("no fresh Checkstyle report was written by this run"),
      evidence: [executionEvidence(execution)],
    };
  }
  const diagnostics: Diagnostic[] = [];
  for (const reportPath of reports) {
    const text = await readReport(repo, reportPath);
    const found = text === undefined ? undefined : parseCheckstyleXml(text, repo.root);
    if (found === undefined) {
      return {
        ...unparseable(`Checkstyle report ${reportPath} could not be read`),
        evidence: [executionEvidence(execution)],
      };
    }
    diagnostics.push(...found);
  }
  return {
    parse: "parsed",
    tests: [],
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    evidence: [executionEvidence(execution), ...reportEvidence(reports, "Checkstyle report")],
    ...(diagnostics.length > MAX_DIAGNOSTICS
      ? {
          note: `${String(diagnostics.length)} violations; the first ${String(MAX_DIAGNOSTICS)} are listed`,
        }
      : {}),
  };
}

async function parseSpotBugs(
  execution: ExecutionRecord,
  repo: RepositoryView,
  model: BuildModel | undefined,
  dirs: readonly string[],
): Promise<ParsedCommandResults> {
  const locations: ReportLocation[] = dirs.map((dir) =>
    model?.tool === "gradle"
      ? { directory: joinRepoPath(dir, "build/reports/spotbugs"), name: /\.xml$/, depth: 0 }
      : { directory: joinRepoPath(dir, "target"), name: /^spotbugsXml\.xml$/, depth: 0 },
  );
  const reports = await freshReports(repo, locations, execution.startedAt);
  if (reports.length === 0) {
    return {
      ...unparseable("no fresh SpotBugs XML report was written by this run"),
      evidence: [executionEvidence(execution)],
    };
  }
  const sourceRoots =
    model === undefined ? [] : (await sourceAndTestRoots(repo, model)).sourceRoots;
  const diagnostics: Diagnostic[] = [];
  for (const reportPath of reports) {
    const text = await readReport(repo, reportPath);
    const parsed = text === undefined ? undefined : parseSpotBugsXml(text);
    if (parsed === undefined) {
      return {
        ...unparseable(`SpotBugs report ${reportPath} could not be read`),
        evidence: [executionEvidence(execution)],
      };
    }
    const roots = unique([
      ...parsed.srcDirs
        .map((dir) => toRepoRelative(repo.root, dir))
        .filter((dir): dir is string => dir !== undefined),
      ...sourceRoots,
    ]);
    for (const finding of parsed.findings) {
      let location: string | undefined;
      if (finding.sourcePath !== undefined) {
        for (const root of roots) {
          const candidate = joinRepoPath(root, finding.sourcePath);
          if (await repo.exists(candidate)) {
            location = candidate;
            break;
          }
        }
      }
      diagnostics.push({
        tool: "spotbugs",
        severity: finding.severity,
        message: finding.message,
        ruleId: finding.type,
        ...(location === undefined
          ? {}
          : {
              location: {
                path: location,
                ...(finding.line === undefined ? {} : { line: finding.line }),
              },
            }),
      });
    }
  }
  return {
    parse: "parsed",
    tests: [],
    diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS),
    evidence: [executionEvidence(execution), ...reportEvidence(reports, "SpotBugs report")],
  };
}

async function parseCompile(
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  if (execution.exitCode === null) {
    return {
      ...unparseable("the build did not exit normally"),
      evidence: [executionEvidence(execution)],
    };
  }
  const output = await readOutput(repo, execution);
  const diagnostics = output === undefined ? [] : parseCompilerOutput(output, repo.root);
  const evidence = [executionEvidence(execution)];
  if (execution.exitCode === 0) {
    return {
      parse: "parsed",
      tests: [],
      diagnostics,
      evidence,
      ...(output === undefined
        ? { note: "the build output could not be read; the result is the exit code" }
        : {}),
    };
  }
  if (!diagnostics.some((d) => d.severity === "error")) {
    return {
      ...unparseable(
        output === undefined
          ? "the build failed and its output could not be read"
          : "the build failed, but its output names no compiler error",
      ),
      diagnostics,
      evidence,
    };
  }
  return { parse: "parsed", tests: [], diagnostics, evidence };
}

function parseExitCode(execution: ExecutionRecord): ParsedCommandResults {
  if (execution.exitCode === null) {
    return {
      ...unparseable("the command did not exit normally"),
      evidence: [executionEvidence(execution)],
    };
  }
  return {
    parse: "parsed",
    tests: [],
    diagnostics: [],
    evidence: [executionEvidence(execution)],
    note: "this tool reports its result through the exit code only",
  };
}

export async function parseJavaResults(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  switch (command.results.parser) {
    case JAVA_PARSERS.junitXml:
      return parseTests(command, execution, repo, await loadBuildModel(repo, command.cwd));
    case JAVA_PARSERS.checkstyle: {
      const model = await loadBuildModel(repo, command.cwd);
      return parseCheckstyle(execution, repo, model?.projectDirs ?? [command.cwd], model?.tool);
    }
    case JAVA_PARSERS.spotbugs: {
      const model = await loadBuildModel(repo, command.cwd);
      return parseSpotBugs(execution, repo, model, model?.projectDirs ?? [command.cwd]);
    }
    case JAVA_PARSERS.compiler:
      return parseCompile(execution, repo);
    case JAVA_PARSERS.exitCode:
      return parseExitCode(execution);
    default:
      return unparseable(`the java adapter has no result parser named "${command.results.parser}"`);
  }
}
