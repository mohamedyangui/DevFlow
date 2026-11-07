import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { LineCounter, parseDocument } from "yaml";
import { DevflowError, ErrorCode } from "../errors.js";
import { ProjectConfig } from "../schemas/config.js";
import type { PathGuard } from "../security/path-guard.js";
import { issuesFromZodError, type IssuePath } from "../task/issues.js";
import { locateYamlPath, yamlMessage } from "../task/yaml-lines.js";

/** Location of the project configuration, relative to the workspace root. */
export const PROJECT_CONFIG_PATH = ".devflow/config.yaml";

/** Configuration files larger than this are refused before parsing. */
export const MAX_CONFIG_FILE_BYTES = 256 * 1024;

export const ConfigIssueCode = {
  ParseError: "CONFIG_PARSE_ERROR",
  Schema: "CONFIG_SCHEMA",
} as const;
export type ConfigIssueCode = (typeof ConfigIssueCode)[keyof typeof ConfigIssueCode];

export interface ConfigIssue {
  readonly severity: "error" | "warning";
  readonly code: ConfigIssueCode;
  readonly message: string;
  readonly path: IssuePath;
  readonly line?: number;
}

export interface LoadedProjectConfig {
  /** Repository-relative path of the configuration file. */
  readonly path: typeof PROJECT_CONFIG_PATH;
  readonly exists: boolean;
  /**
   * SHA-256 of the file's exact bytes, or `null` when there is no file. Workspace trust is
   * keyed by this hash, so any edit invalidates trust (ADR 0007).
   */
  readonly sha256: string | null;
  readonly valid: boolean;
  /** The parsed configuration with defaults applied; defaults only when the file is absent. */
  readonly config: ProjectConfig | undefined;
  readonly issues: readonly ConfigIssue[];
}

/**
 * Loads `.devflow/config.yaml` from a workspace. A missing file is not an error: the defaults
 * apply. Content problems are returned as issues with line numbers.
 *
 * The file is read through the path guard, so a configuration that is a link to a file
 * outside the workspace is refused.
 *
 * @throws DevflowError `CONFIG_FILE_UNREADABLE` when the file exists but cannot be used, or
 * `PATH_REJECTED` when the path guard refuses it.
 */
export async function loadProjectConfig(guard: PathGuard): Promise<LoadedProjectConfig> {
  const checked = await guard.check(PROJECT_CONFIG_PATH, { access: "read", origin: "internal" });
  if (!checked.exists) {
    return {
      path: PROJECT_CONFIG_PATH,
      exists: false,
      sha256: null,
      valid: true,
      config: ProjectConfig.parse({ version: 1 }),
      issues: [],
    };
  }

  const unreadable = (message: string, cause?: unknown): DevflowError =>
    new DevflowError(ErrorCode.ConfigFileUnreadable, `${PROJECT_CONFIG_PATH}: ${message}`, {
      details: { path: PROJECT_CONFIG_PATH },
      ...(cause === undefined ? {} : { cause }),
    });

  const info = await stat(checked.absolute);
  if (!info.isFile()) throw unreadable("not a file");
  if (info.size > MAX_CONFIG_FILE_BYTES) {
    throw unreadable(`${info.size} bytes; the limit is ${MAX_CONFIG_FILE_BYTES} bytes`);
  }
  const bytes = await readFile(checked.absolute);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw unreadable("it must be UTF-8 text", error);
  }

  const parsed = parseConfigText(text);
  return { path: PROJECT_CONFIG_PATH, exists: true, sha256, ...parsed };
}

/** Parses and validates configuration text. */
export function parseConfigText(
  text: string,
): Pick<LoadedProjectConfig, "valid" | "config" | "issues"> {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: true });
  const syntax: ConfigIssue[] = [...doc.errors, ...doc.warnings].map((problem) => {
    const line = problem.linePos?.[0]?.line;
    return {
      severity: doc.errors.includes(problem) ? "error" : "warning",
      code: ConfigIssueCode.ParseError,
      message: yamlMessage(problem.message),
      path: [],
      ...(line === undefined ? {} : { line }),
    };
  });
  if (doc.errors.length > 0) return { valid: false, config: undefined, issues: syntax };

  let data: unknown;
  try {
    data = doc.toJS({ maxAliasCount: 50 });
  } catch (error) {
    return {
      valid: false,
      config: undefined,
      issues: [
        ...syntax,
        {
          severity: "error",
          code: ConfigIssueCode.ParseError,
          message: (error as Error).message,
          path: [],
        },
      ],
    };
  }

  const result = ProjectConfig.safeParse(data);
  if (result.success) return { valid: true, config: result.data, issues: syntax };
  const schema: ConfigIssue[] = issuesFromZodError(result.error).map((issue) => {
    // For an unknown key, point at the key itself rather than at its parent object.
    const unknownKey = /^Unrecognized keys?: "([^"]+)"/.exec(issue.message)?.[1];
    const line =
      (unknownKey === undefined
        ? undefined
        : locateYamlPath(doc, lineCounter, [...issue.path, unknownKey])) ??
      locateYamlPath(doc, lineCounter, issue.path);
    return {
      severity: "error",
      code: ConfigIssueCode.Schema,
      message: issue.message,
      path: issue.path,
      ...(line === undefined ? {} : { line }),
    };
  });
  return { valid: false, config: undefined, issues: [...syntax, ...schema] };
}
