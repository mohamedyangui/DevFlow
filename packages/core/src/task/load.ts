import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { LineCounter, parseDocument } from "yaml";
import { DevflowError, ErrorCode } from "../errors.js";
import type { TaskDefaults } from "../ports/issue-source.js";
import type { TaskSource } from "../schemas/task.js";
import { TaskIssueCode, hasErrors, type IssuePath, type ValidationIssue } from "./issues.js";
import { parseMarkdownTask } from "./markdown.js";
import { validateTaskInput, type TaskValidationResult } from "./validate.js";
import { locateYamlPath, yamlMessage } from "./yaml-lines.js";

export type TaskFormat = "yaml" | "json" | "markdown";

/** Task files larger than this are rejected before parsing. */
export const MAX_TASK_FILE_BYTES = 1024 * 1024;

const EXTENSIONS: Readonly<Record<string, TaskFormat>> = {
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
};

export function detectTaskFormat(filePath: string): TaskFormat | undefined {
  return EXTENSIONS[path.extname(filePath).toLowerCase()];
}

export interface TaskParseResult extends TaskValidationResult {
  readonly format: TaskFormat;
}

export interface LoadedTask extends TaskParseResult {
  /** Absolute path of the task file. */
  readonly path: string;
}

/**
 * Parses and validates task text. Content problems (syntax, schema, lint) are returned as
 * issues with 1-based line numbers where they can be determined; nothing is thrown for them.
 *
 * `defaults` fill the id and the title when the text does not define them (an issue's number
 * and title); a value in the text always wins.
 */
export function parseTaskText(
  text: string,
  format: TaskFormat,
  source: TaskSource,
  options: { readonly defaults?: TaskDefaults } = {},
): TaskParseResult {
  const parsed = parseByFormat(text, format);
  if (hasErrors(parsed.issues)) {
    return { format, valid: false, contract: undefined, issues: parsed.issues };
  }
  const result = validateTaskInput(withDefaults(parsed.data, options.defaults), source);
  const issues = [...parsed.issues, ...result.issues].map((issue) =>
    issue.line !== undefined ? issue : withLine(issue, parsed.lineOf(issue.path)),
  );
  return { format, valid: result.valid, contract: result.contract, issues };
}

/**
 * Reads, parses and validates a task file.
 *
 * @throws DevflowError when the file cannot be used at all (missing, not a file, too large,
 * unreadable, unsupported extension). Content problems are returned as issues instead.
 */
export async function loadTaskFile(
  filePath: string,
  options: { readonly cwd?: string } = {},
): Promise<LoadedTask> {
  const cwd = options.cwd ?? process.cwd();
  const absolutePath = path.resolve(cwd, filePath);
  const format = detectTaskFormat(absolutePath);
  if (format === undefined) {
    throw new DevflowError(
      ErrorCode.TaskUnsupportedFormat,
      `unsupported task file type "${path.extname(absolutePath) || "(none)"}"; use .yaml, .yml, .json or .md`,
      { details: { path: absolutePath } },
    );
  }

  let size: number;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      throw new DevflowError(ErrorCode.TaskFileNotAFile, `not a file: ${absolutePath}`, {
        details: { path: absolutePath },
      });
    }
    size = info.size;
  } catch (error) {
    if (error instanceof DevflowError) throw error;
    if (isErrnoException(error) && error.code === "ENOENT") {
      throw new DevflowError(ErrorCode.TaskFileNotFound, `task file not found: ${absolutePath}`, {
        details: { path: absolutePath },
        cause: error,
      });
    }
    throw new DevflowError(ErrorCode.TaskFileUnreadable, `cannot read task file: ${absolutePath}`, {
      details: { path: absolutePath },
      cause: error,
    });
  }
  if (size > MAX_TASK_FILE_BYTES) {
    throw new DevflowError(
      ErrorCode.TaskFileTooLarge,
      `task file is ${size} bytes; the limit is ${MAX_TASK_FILE_BYTES} bytes`,
      { details: { path: absolutePath, size } },
    );
  }

  let text: string;
  try {
    const bytes = await readFile(absolutePath);
    // `fatal` rejects invalid UTF-8 instead of silently replacing characters.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new DevflowError(
      ErrorCode.TaskFileUnreadable,
      `cannot read task file (it must be UTF-8 text): ${absolutePath}`,
      { details: { path: absolutePath }, cause: error },
    );
  }

  const source: TaskSource = { kind: "file", ref: displayPath(absolutePath, cwd), trust: "user" };
  return { ...parseTaskText(text, format, source), path: absolutePath };
}

function withDefaults(data: unknown, defaults: TaskDefaults | undefined): unknown {
  if (defaults === undefined || typeof data !== "object" || data === null || Array.isArray(data)) {
    return data;
  }
  const record = data as Record<string, unknown>;
  return {
    ...(defaults.id === undefined ? {} : { id: defaults.id }),
    ...(defaults.title === undefined ? {} : { title: defaults.title }),
    ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)),
  };
}

// ---- Format-specific parsing ---------------------------------------------------------------

interface RawParse {
  readonly data: unknown;
  readonly issues: readonly ValidationIssue[];
  readonly lineOf: (path: IssuePath) => number | undefined;
}

function parseByFormat(text: string, format: TaskFormat): RawParse {
  switch (format) {
    case "yaml":
      return parseYaml(text);
    case "json":
      return parseJson(text);
    case "markdown": {
      const result = parseMarkdownTask(text);
      return { data: result.data, issues: result.issues, lineOf: result.lineOf };
    }
  }
}

function parseYaml(text: string): RawParse {
  const lineCounter = new LineCounter();
  // `prettyErrors` is what makes the parser compute line positions for errors.
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: true });
  const issues: ValidationIssue[] = doc.errors.map((error) =>
    withLine(
      {
        severity: "error",
        code: TaskIssueCode.ParseError,
        message: yamlMessage(error.message),
        path: [],
      },
      error.linePos?.[0]?.line,
    ),
  );
  for (const warning of doc.warnings) {
    issues.push(
      withLine(
        {
          severity: "warning",
          code: TaskIssueCode.ParseError,
          message: yamlMessage(warning.message),
          path: [],
        },
        warning.linePos?.[0]?.line,
      ),
    );
  }
  if (hasErrors(issues)) return { data: undefined, issues, lineOf: () => undefined };
  try {
    // A low alias limit protects against "billion laughs" style documents.
    const data: unknown = doc.toJS({ maxAliasCount: 50 });
    return { data, issues, lineOf: (p) => locateYamlPath(doc, lineCounter, p) };
  } catch (error) {
    return {
      data: undefined,
      issues: [
        ...issues,
        {
          severity: "error",
          code: TaskIssueCode.ParseError,
          message: (error as Error).message,
          path: [],
        },
      ],
      lineOf: () => undefined,
    };
  }
}

function parseJson(text: string): RawParse {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    const message = (error as Error).message;
    return {
      data: undefined,
      issues: [
        withLine(
          { severity: "error", code: TaskIssueCode.ParseError, message, path: [] },
          jsonErrorLine(message, text),
        ),
      ],
      lineOf: () => undefined,
    };
  }
  // JSON is valid YAML 1.2; the YAML parser is used only to map paths to line numbers.
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: false });
  const lineOf =
    doc.errors.length === 0
      ? (p: IssuePath) => locateYamlPath(doc, lineCounter, p)
      : () => undefined;
  return { data, issues: [], lineOf };
}

// ---- Helpers --------------------------------------------------------------------------------

function withLine(issue: ValidationIssue, line: number | undefined): ValidationIssue {
  return line === undefined ? issue : { ...issue, line };
}

function jsonErrorLine(message: string, text: string): number | undefined {
  const explicit = /line (\d+)/.exec(message);
  if (explicit?.[1] !== undefined) return Number(explicit[1]);
  const position = /position (\d+)/.exec(message);
  if (position?.[1] === undefined) return undefined;
  return text.slice(0, Number(position[1])).split("\n").length;
}

function displayPath(absolutePath: string, cwd: string): string {
  const relative = path.relative(cwd, absolutePath);
  const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  return (inside ? relative : absolutePath).split(path.sep).join("/");
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
