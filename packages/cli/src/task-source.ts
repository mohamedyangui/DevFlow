import path from "node:path";
import {
  DevflowError,
  ErrorCode,
  type TaskContract,
  type ValidationIssue,
  formatIssuePath,
  loadTaskFile,
  parseTaskText,
} from "@devflowai/core";
import { GitHubIssueSource } from "@devflowai/github";
import { githubClient, githubRepository } from "./github.js";
import type { CliIo } from "./io.js";

/** Where a workflow command's task comes from: a file (`--task`) or a GitHub issue (`--issue`). */
export interface TaskSourceOptions {
  readonly task?: string | undefined;
  readonly issue?: string | undefined;
  /** The repository of `--issue` or `--pr` (`owner/name`); default: the origin remote. */
  readonly repo?: string | undefined;
  /** A pull request to review (`devflow review --pr`); `--repo` then applies to it too. */
  readonly pr?: string | undefined;
}

export interface ResolvedTask {
  readonly contract: TaskContract;
  /** The task file relative to the workspace, or null for an issue. */
  readonly taskFile: string | null;
  /** Facts about the source a person should know (for example a closed issue). */
  readonly warnings: readonly string[];
}

/**
 * Loads and validates the task of a workflow command. An issue is read from GitHub and parsed
 * by the core Markdown task parser exactly like a task file; it is `external` text.
 */
export async function resolveTask(
  options: TaskSourceOptions,
  context: { readonly io: CliIo; readonly root: string; readonly signal?: AbortSignal | undefined },
): Promise<ResolvedTask> {
  const { io, root } = context;
  if ((options.task === undefined) === (options.issue === undefined)) {
    throw new DevflowError(
      ErrorCode.TaskSourceInvalid,
      options.task === undefined
        ? "give the task: --task <file> or --issue <number>"
        : "give either --task or --issue, not both",
    );
  }
  if (options.repo !== undefined && options.issue === undefined && options.pr === undefined) {
    throw new DevflowError(ErrorCode.TaskSourceInvalid, "--repo only applies to --issue and --pr");
  }

  if (options.task !== undefined) {
    const loaded = await loadTaskFile(options.task, { cwd: io.cwd });
    const contract = validContract(
      loaded,
      options.task,
      `run \`devflow task validate ${options.task}\` for details`,
    );
    return { contract, taskFile: displayPath(root, loaded.path), warnings: [] };
  }

  const reference = options.issue ?? "";
  const repository = await githubRepository(options.repo, root, io);
  const source = new GitHubIssueSource(githubClient(io), repository);
  const document = await source.fetch(reference, context.signal ?? new AbortController().signal);
  const parsed = parseTaskText(document.text, document.format, document.source, {
    ...(document.defaults === undefined ? {} : { defaults: document.defaults }),
  });
  const contract = validContract(
    parsed,
    `issue ${document.source.ref ?? reference}`,
    "edit the issue so that it follows the Markdown task format (docs/specs/task-contract.md)",
  );
  return { contract, taskFile: null, warnings: document.warnings ?? [] };
}

function validContract(
  result: {
    readonly valid: boolean;
    readonly contract: TaskContract | undefined;
    readonly issues: readonly ValidationIssue[];
  },
  label: string,
  hint: string,
): TaskContract {
  if (result.valid && result.contract !== undefined) return result.contract;
  const errors = result.issues.filter((issue) => issue.severity === "error");
  const first = errors[0];
  throw new DevflowError(
    ErrorCode.TaskInvalid,
    `${label} is not a valid task (${String(errors.length)} error(s)` +
      `${first === undefined ? "" : `, first: ${formatIssuePath(first.path) || "(task)"}: ${first.message}`}); ` +
      hint,
    { details: { source: label } },
  );
}

function displayPath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? absolute
    : relative.split(path.sep).join("/");
}
