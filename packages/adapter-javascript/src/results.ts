import {
  freshReportFiles,
  isRecord,
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
} from "@devflow/core";
import { JAVASCRIPT_PARSERS } from "./commands.js";
import {
  baseName,
  escapeRegExp,
  resolveRepoPath,
  sortPaths,
  toRepoRelative,
  unique,
} from "./paths.js";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_MESSAGE = 2_000;
const MAX_DIAGNOSTICS = 500;

// ---- Text helpers ---------------------------------------------------------------------------

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

/** Removes terminal color and cursor sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

function shorten(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE - 1)}…` : text;
}

const TITLE_MARKER = /\bAC-([1-9][0-9]{0,3})\b/g;

/**
 * Acceptance criteria named by a test (ADR 0015): `AC-n` in the test title or in the title of
 * an enclosing describe block (`describe("AC-2", ...)`).
 */
export function acceptanceMarkers(...titles: readonly string[]): string[] {
  const numbers = new Set<number>();
  for (const title of titles) {
    for (const match of title.matchAll(TITLE_MARKER)) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b).map((n) => `AC-${String(n)}`);
}

// ---- Jest and Vitest JSON -------------------------------------------------------------------

const TIMEOUT = /\b(?:test timed out|exceeded timeout of|timeout of \d+\s*ms exceeded)\b/i;
const ASSERTION =
  /^(?:\w*AssertionError\b|Error: expect\(|expect\(|Error: Snapshot .* mismatched|Snapshot .* mismatched)/;
/** Why a test file fails before any test runs: it does not compile or an import is missing. */
const LOAD_FAILURE =
  /SyntaxError|Transform failed|Failed to load url|Failed to resolve import|Cannot find module|ERR_MODULE_NOT_FOUND|does not provide an export named|Cannot use import statement outside a module|error TS\d+/;

function firstLine(text: string): string {
  return (
    stripAnsi(text)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

/**
 * The outcome of a failed test, from its first failure message: a failed expectation or
 * assertion is an `assertion_failure`, a timeout is a `timeout`, anything else (a thrown
 * error) a `runtime_error`.
 */
export function failureOutcome(messages: readonly string[]): TestOutcome {
  const text = messages.join("\n");
  if (TIMEOUT.test(stripAnsi(text))) return "timeout";
  return ASSERTION.test(firstLine(text)) ? "assertion_failure" : "runtime_error";
}

const SKIPPED_STATUSES = new Set(["pending", "skipped", "todo", "disabled"]);

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

function result(
  id: string,
  name: string,
  file: string | undefined,
  outcome: TestOutcome,
  titles: readonly string[],
  extra: { readonly durationMs?: number; readonly message?: string } = {},
): TestCaseResult {
  return {
    id,
    name,
    ...(file === undefined ? {} : { file }),
    outcome,
    status: statusForOutcome(outcome),
    markers: acceptanceMarkers(...titles),
    ...(extra.durationMs === undefined ? {} : { durationMs: extra.durationMs }),
    ...(extra.message === undefined || extra.message === "" ? {} : { message: extra.message }),
  };
}

export interface JestReport {
  readonly tests: TestCaseResult[];
  /** The runner's overall verdict, when the report states one. */
  readonly success?: boolean;
}

/**
 * Reads a Jest `--json` report, or the Vitest `json` reporter's output (the same format).
 * `toFile` turns the absolute test file paths of the report into repository paths. Returns
 * undefined for anything that is not a complete report.
 */
export function parseJestJson(
  text: string,
  toFile: (reported: string) => string | undefined,
): JestReport | undefined {
  const json = parseJsonOrUndefined(text);
  if (
    !isRecord(json) ||
    !Array.isArray(json.testResults) ||
    typeof json.numTotalTests !== "number"
  ) {
    return undefined;
  }
  const tests: TestCaseResult[] = [];
  for (const fileResult of json.testResults) {
    if (!isRecord(fileResult) || typeof fileResult.name !== "string") return undefined;
    const assertions = fileResult.assertionResults ?? [];
    if (!Array.isArray(assertions)) return undefined;
    const file = toFile(fileResult.name);
    const fileId = file ?? fileResult.name.replace(/\\/g, "/");
    let failedTests = 0;
    for (const assertion of assertions) {
      if (!isRecord(assertion) || typeof assertion.title !== "string") return undefined;
      const ancestors = Array.isArray(assertion.ancestorTitles)
        ? assertion.ancestorTitles.filter((t): t is string => typeof t === "string")
        : [];
      const titles = [...ancestors, assertion.title];
      const status = typeof assertion.status === "string" ? assertion.status : "";
      const messages = Array.isArray(assertion.failureMessages)
        ? assertion.failureMessages.filter((m): m is string => typeof m === "string")
        : [];
      let outcome: TestOutcome;
      let message: string | undefined;
      if (status === "passed") outcome = "passed";
      else if (SKIPPED_STATUSES.has(status)) outcome = "skipped";
      else if (status === "failed") {
        outcome = failureOutcome(messages);
        message = shorten(stripAnsi(messages.join("\n")).trim());
        failedTests += 1;
      } else {
        outcome = "infrastructure_error";
        message = `the report gives the unknown status "${status}"`;
      }
      const duration = assertion.duration;
      tests.push(
        result(
          `${fileId}#${titles.join(" > ")}`,
          typeof assertion.fullName === "string" ? assertion.fullName : titles.join(" "),
          file,
          outcome,
          titles,
          {
            ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
              ? { durationMs: Math.round(duration) }
              : {}),
            ...(message === undefined ? {} : { message }),
          },
        ),
      );
    }
    const fileMessage =
      typeof fileResult.message === "string" ? stripAnsi(fileResult.message).trim() : "";
    if (failedTests === 0 && fileMessage !== "") {
      // The file failed outside its tests: before any test ran (it does not load), or in a hook.
      const outcome: TestOutcome =
        assertions.length === 0
          ? LOAD_FAILURE.test(fileMessage)
            ? "compile_error"
            : "infrastructure_error"
          : "runtime_error";
      tests.push(
        result(fileId, `${baseName(fileId)} (test file)`, file, outcome, [], {
          message: shorten(fileMessage),
        }),
      );
    }
  }
  return {
    tests: mergeById(tests),
    ...(typeof json.success === "boolean" ? { success: json.success } : {}),
  };
}

// ---- ESLint JSON ----------------------------------------------------------------------------

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function location(
  path: string | undefined,
  line: unknown,
  column: unknown,
  endLine?: unknown,
): SourceLocation | undefined {
  if (path === undefined) return undefined;
  const l = positive(line);
  const c = positive(column);
  const e = positive(endLine);
  return {
    path,
    ...(l === undefined ? {} : { line: l }),
    ...(c === undefined ? {} : { column: c }),
    ...(e === undefined || l === undefined || e < l ? {} : { endLine: e }),
  };
}

/** Reads an ESLint `--format json` report. Returns undefined when it is not one. */
export function parseEslintJson(text: string, repoRoot: string): Diagnostic[] | undefined {
  const json = parseJsonOrUndefined(text);
  if (!Array.isArray(json)) return undefined;
  const out: Diagnostic[] = [];
  for (const file of json) {
    if (!isRecord(file) || typeof file.filePath !== "string" || !Array.isArray(file.messages)) {
      return undefined;
    }
    const path = toRepoRelative(repoRoot, file.filePath);
    for (const message of file.messages) {
      if (!isRecord(message) || typeof message.message !== "string") return undefined;
      const at = location(path, message.line, message.column, message.endLine);
      out.push({
        tool: "eslint",
        severity: message.severity === 2 || message.fatal === true ? "error" : "warning",
        message: shorten(message.message.trim() === "" ? "(no message)" : message.message.trim()),
        ...(typeof message.ruleId === "string" ? { ruleId: message.ruleId } : {}),
        ...(at === undefined ? {} : { location: at }),
      });
    }
  }
  return out;
}

// ---- TypeScript compiler --------------------------------------------------------------------

const TSC_LOCATED = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|message)\s+(TS\d+):\s*(.*)$/;
const TSC_GLOBAL = /^(error|warning|message)\s+(TS\d+):\s*(.*)$/;

/**
 * Reads `tsc --pretty false` output: `src/a.ts(3,7): error TS2322: ...` and global errors
 * such as `error TS5058: ...`. Relative paths are relative to `cwd`, the directory tsc ran in.
 */
export function parseTscOutput(text: string, repoRoot: string, cwd: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const severityOf = (word: string): Diagnostic["severity"] =>
    word === "error" ? "error" : word === "warning" ? "warning" : "info";
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const located = TSC_LOCATED.exec(raw);
    if (located !== null) {
      const [, file = "", line, column, severity = "error", code, message = ""] = located;
      const absolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file);
      const path = absolute ? toRepoRelative(repoRoot, file) : resolveRepoPath(cwd, file);
      const at = location(path, Number(line), Number(column));
      out.push({
        tool: "tsc",
        severity: severityOf(severity),
        message: shorten(message.trim() === "" ? (code ?? "TypeScript error") : message.trim()),
        ...(code === undefined ? {} : { ruleId: code }),
        ...(at === undefined ? {} : { location: at }),
      });
      continue;
    }
    const global = TSC_GLOBAL.exec(raw.trim());
    if (global !== null) {
      const [, severity = "error", code, message = ""] = global;
      out.push({
        tool: "tsc",
        severity: severityOf(severity),
        message: shorten(message.trim() === "" ? (code ?? "TypeScript error") : message.trim()),
        ...(code === undefined ? {} : { ruleId: code }),
      });
      continue;
    }
    const previous = out.at(-1);
    if (previous !== undefined && /^\s+\S/.test(raw) && previous.message.length < MAX_MESSAGE) {
      out[out.length - 1] = { ...previous, message: shorten(`${previous.message}\n${raw.trim()}`) };
    }
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

const GLOB_CHARACTER = /[*?[\]{}()!]/;

/**
 * The report files of `command` written by this execution. Exact paths (what the adapter's
 * own commands declare) are looked up directly, also inside `node_modules`; globs (from
 * project configuration) are expanded with `repo.glob`, which skips ignored directories.
 */
async function freshReports(
  repo: RepositoryView,
  command: CommandSpec,
  startedAt: string,
): Promise<string[]> {
  const found: string[] = [];
  for (const glob of command.results.reportGlobs) {
    if (!GLOB_CHARACTER.test(glob)) {
      const files = await freshReportFiles(repo, repoDirname(glob), {
        name: new RegExp(`^${escapeRegExp(baseName(glob))}$`),
        startedAt,
      });
      found.push(...files.map((file) => file.path));
      continue;
    }
    const matches = new Set(await repo.glob([glob]));
    for (const dir of unique([...matches].map(repoDirname))) {
      const files = await freshReportFiles(repo, dir, { name: /./, startedAt });
      found.push(...files.map((file) => file.path).filter((path) => matches.has(path)));
    }
  }
  return sortPaths(unique(found));
}

async function readReport(repo: RepositoryView, reportPath: string): Promise<string | undefined> {
  try {
    return await repo.readText(reportPath, { maxBytes: MAX_REPORT_BYTES });
  } catch {
    return undefined;
  }
}

function reportEvidence(
  paths: readonly string[],
  kind: "test-report" | "tool-report",
  description: string,
): Evidence[] {
  return paths.map((path) => ({ kind, description, deterministic: true, path }));
}

function limited(diagnostics: readonly Diagnostic[]): { diagnostics: Diagnostic[]; note?: string } {
  if (diagnostics.length <= MAX_DIAGNOSTICS) return { diagnostics: [...diagnostics] };
  const errors = diagnostics.filter((d) => d.severity === "error");
  const kept = [...errors, ...diagnostics.filter((d) => d.severity !== "error")].slice(
    0,
    MAX_DIAGNOSTICS,
  );
  return {
    diagnostics: kept,
    note: `${String(diagnostics.length)} diagnostics were reported; the first ${String(MAX_DIAGNOSTICS)} are kept, errors first`,
  };
}

async function parseTests(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  const reports = await freshReports(repo, command, execution.startedAt);
  if (reports.length === 0) {
    return {
      ...unparseable("no fresh JSON test report was written by this run"),
      evidence: [executionEvidence(execution)],
    };
  }
  const toFile = (reported: string) =>
    toRepoRelative(repo.root, reported) ?? resolveRepoPath(command.cwd, reported);
  const tests: TestCaseResult[] = [];
  let runnerFailed = false;
  for (const reportPath of reports) {
    const text = await readReport(repo, reportPath);
    const parsed = text === undefined ? undefined : parseJestJson(text, toFile);
    if (parsed === undefined) {
      return {
        ...unparseable(`test report ${reportPath} is not a complete Jest or Vitest JSON report`),
        evidence: [executionEvidence(execution)],
      };
    }
    tests.push(...parsed.tests);
    if (parsed.success === false) runnerFailed = true;
  }
  const merged = mergeById(tests);
  const notes: string[] = [];
  if (merged.length === 0) notes.push("the test report contains no tests");
  if (runnerFailed && merged.every((t) => t.status === "passed" || t.status === "skipped")) {
    notes.push(
      "the runner reported a failure outside the individual tests (for example an unhandled error)",
    );
  }
  return {
    parse: "parsed",
    tests: merged,
    diagnostics: [],
    evidence: [
      executionEvidence(execution),
      ...reportEvidence(reports, "test-report", "JSON test report"),
    ],
    ...(notes.length === 0 ? {} : { note: notes.join("; ") }),
  };
}

async function parseEslint(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  const reports = await freshReports(repo, command, execution.startedAt);
  if (reports.length === 0) {
    return {
      ...unparseable(
        "ESLint wrote no report in this run (a configuration error or a crash exits with code 2 before writing one)",
      ),
      evidence: [executionEvidence(execution)],
    };
  }
  const diagnostics: Diagnostic[] = [];
  for (const reportPath of reports) {
    const text = await readReport(repo, reportPath);
    const parsed = text === undefined ? undefined : parseEslintJson(text, repo.root);
    if (parsed === undefined) {
      return {
        ...unparseable(`report ${reportPath} is not a complete ESLint JSON report`),
        evidence: [executionEvidence(execution)],
      };
    }
    diagnostics.push(...parsed);
  }
  const kept = limited(diagnostics);
  return {
    parse: "parsed",
    tests: [],
    diagnostics: kept.diagnostics,
    evidence: [
      executionEvidence(execution),
      ...reportEvidence(reports, "tool-report", "ESLint report"),
    ],
    ...(kept.note === undefined ? {} : { note: kept.note }),
  };
}

async function parseTsc(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  const evidence = [executionEvidence(execution)];
  if (execution.exitCode === null) {
    return { ...unparseable("the compiler did not exit normally"), evidence };
  }
  const output = await readOutput(repo, execution);
  const kept = limited(output === undefined ? [] : parseTscOutput(output, repo.root, command.cwd));
  if (execution.exitCode === 0) {
    const note =
      output === undefined
        ? "the compiler output could not be read; the result is the exit code"
        : kept.note;
    return {
      parse: "parsed",
      tests: [],
      diagnostics: kept.diagnostics,
      evidence,
      ...(note === undefined ? {} : { note }),
    };
  }
  if (!kept.diagnostics.some((d) => d.severity === "error")) {
    return {
      ...unparseable(
        output === undefined
          ? "the compiler failed and its output could not be read"
          : "the compiler failed, but its output names no error",
      ),
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

export async function parseJavaScriptResults(
  command: CommandSpec,
  execution: ExecutionRecord,
  repo: RepositoryView,
): Promise<ParsedCommandResults> {
  switch (command.results.parser) {
    case JAVASCRIPT_PARSERS.jestJson:
      return parseTests(command, execution, repo);
    case JAVASCRIPT_PARSERS.eslintJson:
      return parseEslint(command, execution, repo);
    case JAVASCRIPT_PARSERS.tsc:
      return parseTsc(command, execution, repo);
    case JAVASCRIPT_PARSERS.exitCode:
      return parseExitCode(execution);
    default:
      return unparseable(
        `the javascript adapter has no result parser named "${command.results.parser}"`,
      );
  }
}
