import {
  freshReportFiles,
  isRecord,
  joinRepoPath,
  parseJsonOrUndefined,
  repoDirname,
  statusForOutcome,
  unparseable,
  type CommandSpec,
  type Diagnostic,
  type Evidence,
  type ExecutionRecord,
  type ParsedCommandResults,
  type RepositoryView,
  type SourceLocation,
  type TestCaseResult,
  type TestOutcome,
} from "@devflow-ai/core";
import { PYTHON_PARSERS } from "./commands.js";
import { baseName, escapeRegExp, sortPaths, toolPath, unique } from "./paths.js";
import { acceptanceMarkers } from "./tests.js";
import { child, descendants, parseXml, type XmlElement } from "./xml.js";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE = 2_000;
const MAX_DIAGNOSTICS = 500;

function shorten(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
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

/** A Python test case as reported: its module or class (`tests.test_orders.TestOrders`) and name. */
export interface PythonCase {
  readonly classname: string;
  readonly name: string;
  readonly outcome: TestOutcome;
  readonly durationMs?: number;
  readonly message?: string;
}

// ---- pytest JUnit XML -----------------------------------------------------------------------

/** Numeric character references (`&#10;`, which pytest writes for line breaks in messages). */
function decodeCharacterReferences(text: string): string {
  return text.replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (reference, code: string) => {
    const point =
      code.startsWith("x") || code.startsWith("X")
        ? Number.parseInt(code.slice(1), 16)
        : Number.parseInt(code, 10);
    return Number.isInteger(point) && point > 0 && point <= 0x10ffff
      ? String.fromCodePoint(point)
      : reference;
  });
}

function problemMessage(element: XmlElement): string | undefined {
  const message =
    element.attributes.message ?? element.text.split(/\r?\n/).find((line) => line.trim() !== "");
  const text = decodeCharacterReferences(message ?? "").trim();
  return text === "" ? undefined : shorten(text);
}

const TIMEOUT = /\bTimeout\b|\btimed out\b/i;

/**
 * Reads the JUnit XML report pytest writes with `--junitxml` (xunit2, and xunit1 with its extra
 * attributes). A `<failure>` is an assertion failure (a timeout when pytest-timeout says so); an
 * `<error>` is a runtime error, or a compile error when the module could not be collected;
 * `<skipped>` (also `xfail`) is skipped. Returns undefined when the document is not a report.
 */
export function parsePytestJUnitXml(text: string): PythonCase[] | undefined {
  const root = parseXml(text);
  if (root === undefined || (root.name !== "testsuite" && root.name !== "testsuites")) {
    return undefined;
  }
  const out: PythonCase[] = [];
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
      problem = failure;
      outcome = TIMEOUT.test(problemMessage(failure) ?? "") ? "timeout" : "assertion_failure";
    } else if (error !== undefined) {
      problem = error;
      const message = problemMessage(error) ?? "";
      outcome = /collection failure/i.test(message)
        ? "compile_error"
        : TIMEOUT.test(message)
          ? "timeout"
          : "runtime_error";
    } else if (skipped !== undefined) {
      problem = skipped;
      outcome = "skipped";
    }
    const seconds = Number.parseFloat(testcase.attributes.time ?? "");
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

// ---- unittest verbose output ----------------------------------------------------------------

const SEPARATOR = /^(?:={70}|-{70})$/;
/** `test_x (pkg.mod.Class)`, `test_x (pkg.mod.Class.test_x)` (3.11+), with a docstring line. */
const UNITTEST_START = /([A-Za-z_][\w.]*) \(([A-Za-z_][\w.]*)\)(?:\r?\n[^\r\n]*?)? \.\.\. /g;
const UNITTEST_STATUS = /^(ok|FAIL|ERROR|skipped(?: .*)?|expected failure|unexpected success)$/;
const SECTION_HEADER =
  /^(FAIL|ERROR|UNEXPECTED SUCCESS): ([A-Za-z_][\w.]*) \(([A-Za-z_][\w.]*)\)(.*)$/;
const RAN = /^Ran (\d+) tests? in [0-9.]+s$/m;
/** Class and module fixture errors are reported like tests but not counted as tests run. */
const FIXTURES = new Set(["setUpClass", "tearDownClass", "setUpModule", "tearDownModule"]);
/** A test module that could not be imported. */
const FAILED_IMPORT = "unittest.loader._FailedTest";

function statusOutcome(status: string): TestOutcome | undefined {
  if (status === "ok" || status === "expected failure") return "passed";
  if (status === "FAIL" || status === "unexpected success") return "assertion_failure";
  if (status === "ERROR") return "runtime_error";
  if (status.startsWith("skipped")) return "skipped";
  return undefined;
}

function caseKey(name: string, classname: string): { name: string; classname: string } {
  const own = classname.endsWith(`.${name}`) ? classname.slice(0, -name.length - 1) : classname;
  return { name, classname: own };
}

/**
 * Reads the verbose output of `python -m unittest -v` (what it writes to stderr), in the
 * formats of Python 3.8 to 3.13. Every test line must be matched and their number must equal
 * the `Ran N tests` summary; otherwise the output is not trusted and undefined is returned.
 */
export function parseUnittestOutput(text: string): PythonCase[] | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const firstSeparator = lines.findIndex((line) => SEPARATOR.test(line));
  const ran = RAN.exec(normalized);
  if (ran === null) return undefined;
  const verbose =
    firstSeparator === -1
      ? normalized.slice(0, ran.index)
      : lines.slice(0, firstSeparator).join("\n");

  // Problems reported in the sections after the verbose lines.
  const sections = new Map<string, { outcome: TestOutcome; message?: string }>();
  for (let index = Math.max(firstSeparator, 0); index < lines.length; index += 1) {
    const header = SECTION_HEADER.exec(lines[index] ?? "");
    if (header === null) continue;
    const key = caseKey(header[2] ?? "", header[3] ?? "");
    let end = index + 2;
    while (end < lines.length && !SEPARATOR.test(lines[end] ?? "")) end += 1;
    const body = lines.slice(index + 2, end).map((line) => line.trim());
    const message = body.filter((line) => line !== "").at(-1);
    const kind = header[1];
    const outcome: TestOutcome =
      key.classname === FAILED_IMPORT
        ? "compile_error"
        : kind === "ERROR"
          ? "runtime_error"
          : "assertion_failure";
    const id = `${key.classname}#${key.name}`;
    const previous = sections.get(id);
    if (previous === undefined || OUTCOME_WEIGHT[outcome] > OUTCOME_WEIGHT[previous.outcome]) {
      sections.set(id, {
        outcome,
        ...(message === undefined ? {} : { message: shorten(message) }),
      });
    }
    index = end - 1;
  }

  const starts = [...verbose.matchAll(UNITTEST_START)];
  const out: PythonCase[] = [];
  let counted = 0;
  for (const [index, start] of starts.entries()) {
    const key = caseKey(start[1] ?? "", start[2] ?? "");
    const from = start.index + start[0].length;
    const to = starts[index + 1]?.index ?? verbose.length;
    // The status is the last status word before the next test; output printed by the test
    // can come first. A failed subtest (Python 3.10) leaves no status on the line at all.
    const status = verbose
      .slice(from, to)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => UNITTEST_STATUS.test(line))
      .at(-1);
    const section = sections.get(`${key.classname}#${key.name}`);
    let outcome = status === undefined ? undefined : statusOutcome(status);
    if (
      section !== undefined &&
      (outcome === undefined || OUTCOME_WEIGHT[section.outcome] >= OUTCOME_WEIGHT[outcome])
    ) {
      outcome = section.outcome;
    }
    if (key.classname === FAILED_IMPORT && outcome !== undefined && outcome !== "passed") {
      outcome = "compile_error";
    }
    const message =
      section?.message ??
      (status === "unexpected success" ? "the test was expected to fail but passed" : undefined);
    out.push({
      classname: key.classname,
      name: key.name,
      outcome: outcome ?? "infrastructure_error",
      ...(outcome === undefined
        ? { message: "unittest reported no status for this test" }
        : message === undefined
          ? {}
          : { message }),
    });
    if (!FIXTURES.has(key.name)) counted += 1;
  }
  return counted === Number(ran[1]) ? out : undefined;
}

// ---- Ruff, flake8, mypy ---------------------------------------------------------------------

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function location(
  path: string | undefined,
  line: number | undefined,
  column: number | undefined,
  endLine?: number,
): SourceLocation | undefined {
  if (path === undefined) return undefined;
  return {
    path,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(endLine === undefined || line === undefined || endLine < line ? {} : { endLine }),
  };
}

/** Reads `ruff check --output-format json`. Returns undefined when it is not such a report. */
export function parseRuffJson(
  text: string,
  repoRoot: string,
  cwd: string,
): Diagnostic[] | undefined {
  const json = parseJsonOrUndefined(text.trim());
  if (!Array.isArray(json)) return undefined;
  const out: Diagnostic[] = [];
  for (const item of json) {
    if (!isRecord(item) || typeof item.message !== "string" || typeof item.filename !== "string") {
      return undefined;
    }
    const start = isRecord(item.location) ? item.location : {};
    const end = isRecord(item.end_location) ? item.end_location : {};
    const at = location(
      toolPath(repoRoot, cwd, item.filename),
      positive(start.row),
      positive(start.column),
      positive(end.row),
    );
    out.push({
      tool: "ruff",
      severity: "error",
      message: shorten(item.message.trim() === "" ? "(no message)" : item.message.trim()),
      ...(typeof item.code === "string" && item.code !== "" ? { ruleId: item.code } : {}),
      ...(at === undefined ? {} : { location: at }),
    });
  }
  return out;
}

const FLAKE8_LINE = /^(.+?):(\d+):(\d+): ([A-Z]+[0-9]+) (.*)$/;

/** Reads flake8's default output, `path:line:column: CODE message`, one diagnostic per line. */
export function parseFlake8Output(text: string, repoRoot: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = FLAKE8_LINE.exec(raw.trim());
    if (match === null) continue;
    const [, file = "", line, column, code = "", message = ""] = match;
    const at = location(
      toolPath(repoRoot, cwd, file),
      Number(line) || undefined,
      Number(column) || undefined,
    );
    out.push({
      tool: "flake8",
      // pycodestyle warnings (W) and complexity (C) are style; errors (E) and pyflakes (F) are not.
      severity: /^[WC]/.test(code) ? "warning" : "error",
      message: shorten(message.trim() === "" ? code : message.trim()),
      ruleId: code,
      ...(at === undefined ? {} : { location: at }),
    });
  }
  return out;
}

const MYPY_LINE =
  /^(.+?):(\d+)(?::(\d+))?(?::\d+:\d+)?: (error|warning|note): (.*?)(?:\s{2}\[([a-z0-9-]+)\])?$/;

/** Reads mypy output: `path:line:column: error: message  [code]`, warnings and notes. */
export function parseMypyOutput(text: string, repoRoot: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = MYPY_LINE.exec(raw.trimEnd());
    if (match === null) continue;
    const [, file = "", line, column, level = "error", message = "", code] = match;
    const at = location(
      toolPath(repoRoot, cwd, file),
      Number(line) || undefined,
      column === undefined ? undefined : Number(column) || undefined,
    );
    out.push({
      tool: "mypy",
      severity: level === "error" ? "error" : level === "warning" ? "warning" : "info",
      message: shorten(message.trim() === "" ? "mypy error" : message.trim()),
      ...(code === undefined ? {} : { ruleId: code }),
      ...(at === undefined ? {} : { location: at }),
    });
  }
  return out;
}

// ---- Reading the artifacts of an execution --------------------------------------------------

function executionEvidence(execution: ExecutionRecord): Evidence {
  return {
    kind: "execution",
    description: `${execution.commandId} exited with ${
      execution.exitCode === null ? "no exit code" : `code ${String(execution.exitCode)}`
    }${execution.timedOut ? " (timed out)" : ""}`,
    deterministic: true,
  };
}

async function readLog(repo: RepositoryView, path: string): Promise<string | undefined> {
  try {
    return await repo.readText(path, { maxBytes: MAX_LOG_BYTES });
  } catch {
    return undefined;
  }
}

async function readOutput(
  repo: RepositoryView,
  execution: ExecutionRecord,
): Promise<string | undefined> {
  const parts: string[] = [];
  for (const path of [execution.stdoutPath, execution.stderrPath]) {
    const text = await readLog(repo, path);
    if (text !== undefined) parts.push(text);
  }
  return parts.length === 0 ? undefined : parts.join("\n");
}

function limited(diagnostics: readonly Diagnostic[]): { diagnostics: Diagnostic[]; note?: string } {
  if (diagnostics.length <= MAX_DIAGNOSTICS) return { diagnostics: [...diagnostics] };
  const kept = [
    ...diagnostics.filter((d) => d.severity === "error"),
    ...diagnostics.filter((d) => d.severity !== "error"),
  ].slice(0, MAX_DIAGNOSTICS);
  return {
    diagnostics: kept,
    note: `${String(diagnostics.length)} diagnostics were reported; the first ${String(MAX_DIAGNOSTICS)} are kept, errors first`,
  };
}

/** Maps a dotted module or class name to its test file, trying the working directory and test roots. */
function testFileResolver(repo: RepositoryView, bases: readonly string[]) {
  const cache = new Map<string, string | undefined>();
  return async (dotted: string): Promise<string | undefined> => {
    if (cache.has(dotted)) return cache.get(dotted);
    let found: string | undefined;
    if (/^[A-Za-z_][\w.]*$/.test(dotted)) {
      const parts = dotted.split(".");
      search: for (let length = parts.length; length > 0; length -= 1) {
        const relative = `${parts.slice(0, length).join("/")}.py`;
        for (const base of bases) {
          const candidate = joinRepoPath(base, relative);
          if (await repo.exists(candidate)) {
            found = candidate;
            break search;
          }
        }
      }
    }
    cache.set(dotted, found);
    return found;
  };
}

async function toResults(
  cases: readonly PythonCase[],
  repo: RepositoryView,
  command: CommandSpec,
): Promise<TestCaseResult[]> {
  const bases = unique([
    command.cwd,
    ...["tests", "test"].map((dir) => joinRepoPath(command.cwd, dir)),
  ]);
  const resolve = testFileResolver(repo, bases);
  const out: TestCaseResult[] = [];
  for (const testCase of cases) {
    const failedImport = testCase.classname === FAILED_IMPORT;
    const owner = failedImport ? testCase.name : testCase.classname;
    const file = owner === "" ? undefined : await resolve(owner);
    out.push({
      id:
        failedImport || testCase.classname === ""
          ? testCase.name
          : `${testCase.classname}#${testCase.name}`,
      name: testCase.name,
      ...(file === undefined ? {} : { file }),
      outcome: testCase.outcome,
      status: statusForOutcome(testCase.outcome),
      markers: failedImport ? [] : acceptanceMarkers(testCase.name),
      ...(testCase.durationMs === undefined ? {} : { durationMs: testCase.durationMs }),
      ...(testCase.message === undefined ? {} : { message: testCase.message }),
    });
  }
  return mergeById(out);
}

async function parsePytest(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  const evidence = [executionEvidence(execution)];
  if (execution.exitCode === 3 || execution.exitCode === 4) {
    return {
      ...unparseable(
        `pytest stopped with ${execution.exitCode === 3 ? "an internal error" : "a usage error"} (exit code ${String(execution.exitCode)})`,
      ),
      evidence,
    };
  }
  const reports: string[] = [];
  for (const glob of command.results.reportGlobs) {
    const files = await freshReportFiles(repo, repoDirname(glob), {
      name: new RegExp(`^${escapeRegExp(baseName(glob))}$`),
      startedAt: execution.startedAt,
    });
    reports.push(...files.map((file) => file.path));
  }
  if (reports.length === 0) {
    return {
      ...unparseable(
        "no fresh JUnit XML report was written by this run (is pytest installed in the interpreter?)",
      ),
      evidence,
    };
  }
  const cases: PythonCase[] = [];
  for (const report of sortPaths(unique(reports))) {
    let text: string | undefined;
    try {
      text = await repo.readText(report, { maxBytes: MAX_REPORT_BYTES });
    } catch {
      text = undefined;
    }
    const parsed = text === undefined ? undefined : parsePytestJUnitXml(text);
    if (parsed === undefined) {
      return { ...unparseable(`test report ${report} could not be read as JUnit XML`), evidence };
    }
    cases.push(...parsed);
  }
  const tests = await toResults(cases, repo, command);
  return {
    parse: "parsed",
    tests,
    diagnostics: [],
    evidence: [
      ...evidence,
      ...reports.map((path) => ({
        kind: "test-report" as const,
        description: "pytest JUnit XML report",
        deterministic: true,
        path,
      })),
    ],
    ...(tests.length === 0 ? { note: "the test report contains no tests" } : {}),
  };
}

async function parseUnittest(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  const evidence = [executionEvidence(execution)];
  if (execution.exitCode === null) {
    return { ...unparseable("unittest did not exit normally"), evidence };
  }
  const stderr = await readLog(repo, execution.stderrPath);
  if (stderr === undefined) {
    return { ...unparseable("the unittest output could not be read"), evidence };
  }
  const cases = parseUnittestOutput(stderr);
  if (cases === undefined) {
    return {
      ...unparseable(
        execution.outputTruncated
          ? "the unittest output was truncated, so not every test can be read"
          : 'the unittest output does not list every test it ran (no verbose result lines or no "Ran N tests" summary)',
      ),
      evidence,
    };
  }
  const tests = await toResults(cases, repo, command);
  return {
    parse: "parsed",
    tests,
    diagnostics: [],
    evidence,
    ...(tests.length === 0 ? { note: "unittest ran no tests" } : {}),
  };
}

/**
 * A linter or type checker that reports through its output: exit code 0 is a pass; a failure
 * must name at least one error, otherwise the result is not trusted. Exit codes above 1 mean
 * the tool itself failed (a configuration error, a crash, the tool not installed).
 */
async function parseToolOutput(
  execution: ExecutionRecord,
  repo: RepositoryView,
  tool: string,
  read: () => Promise<Diagnostic[] | undefined>,
): Promise<ParsedCommandResults> {
  const evidence = [executionEvidence(execution)];
  if (execution.exitCode === null)
    return { ...unparseable(`${tool} did not exit normally`), evidence };
  if (execution.exitCode > 1) {
    const output = (await readOutput(repo, execution)) ?? "";
    const reason = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /No module named|error:/i.test(line));
    return {
      ...unparseable(
        `${tool} failed to run (exit code ${String(execution.exitCode)})${reason === undefined ? "" : `: ${shorten(reason)}`}`,
      ),
      evidence,
    };
  }
  const diagnostics = await read();
  if (diagnostics === undefined) {
    return execution.exitCode === 0
      ? {
          parse: "parsed",
          tests: [],
          diagnostics: [],
          evidence,
          note: `the ${tool} output could not be read; the result is the exit code`,
        }
      : { ...unparseable(`the ${tool} output could not be read`), evidence };
  }
  const kept = limited(diagnostics);
  if (execution.exitCode === 1 && !kept.diagnostics.some((d) => d.severity === "error")) {
    return {
      ...unparseable(`${tool} failed, but its output names no error`),
      diagnostics: kept.diagnostics,
      evidence,
    };
  }
  return {
    parse: "parsed",
    tests: [],
    diagnostics: kept.diagnostics,
    evidence,
    ...(kept.note === undefined ? {} : { note: kept.note }),
  };
}

export async function parsePythonResults(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  switch (command.results.parser) {
    case PYTHON_PARSERS.pytestJunitXml:
      return parsePytest(command, execution, repo);
    case PYTHON_PARSERS.unittestText:
      return parseUnittest(command, execution, repo);
    case PYTHON_PARSERS.ruffJson:
      return parseToolOutput(execution, repo, "ruff", async () => {
        if (execution.outputTruncated) return undefined;
        const stdout = await readLog(repo, execution.stdoutPath);
        return stdout === undefined ? undefined : parseRuffJson(stdout, repo.root, command.cwd);
      });
    case PYTHON_PARSERS.flake8Text:
      return parseToolOutput(execution, repo, "flake8", async () => {
        const output = await readOutput(repo, execution);
        return output === undefined ? undefined : parseFlake8Output(output, repo.root, command.cwd);
      });
    case PYTHON_PARSERS.mypyText:
      return parseToolOutput(execution, repo, "mypy", async () => {
        const output = await readOutput(repo, execution);
        return output === undefined ? undefined : parseMypyOutput(output, repo.root, command.cwd);
      });
    default:
      return unparseable(
        `the python adapter has no result parser named "${command.results.parser}"`,
      );
  }
}
