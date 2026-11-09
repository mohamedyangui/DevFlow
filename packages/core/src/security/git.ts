import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { DevflowError, ErrorCode } from "../errors.js";
import { childEnvironment } from "./environment.js";
import { findOnPath } from "./invocation.js";
import { launchProcess } from "./process-launcher.js";

/**
 * DevFlow's own git operations (ADR 0012, docs/specs/security-model.md): a small set of fixed
 * internal calls, never a command a model or a repository proposed. `git` stays on the hard
 * deny list of model commands; this client is the only way DevFlow runs it.
 *
 * Every call disables what would run code from the repository or the user's configuration:
 * hooks (`core.hooksPath` points to a directory that does not exist, and commits pass
 * `--no-verify`), `core.fsmonitor`, commit signing (which would start a signing program and
 * may prompt), automatic garbage collection and maintenance (which would leave a background
 * process), the pager and terminal prompts. Pathspecs are literal. The executable is looked up
 * on the absolute entries of PATH and never inside the workspace, so a repository cannot ship
 * its own `git`.
 */

/** What a workspace's repository looks like before DevFlow changes anything. */
export type GitInspection =
  | {
      readonly kind: "repository";
      /** The checked-out commit. */
      readonly head: string;
      /** The checked-out branch, or null when HEAD is detached. */
      readonly branch: string | null;
      /**
       * Workspace-relative paths with uncommitted changes (modified, staged, deleted or
       * untracked, not ignored), outside `.devflow/`.
       */
      readonly changes: readonly string[];
    }
  | {
      /** DevFlow cannot use git here; `reason` says why. */
      readonly kind: "unavailable";
      readonly reason: string;
    };

/** The git operations the workflow needs (ADR 0012). */
export interface GitWorkspace {
  inspect(): Promise<GitInspection>;
  /** The checked-out branch, or null when HEAD is detached. */
  currentBranch(): Promise<string | null>;
  /** A branch name based on `base` that no branch has yet (`base`, `base-2`, `base-3`, ...). */
  freeBranchName(base: string): Promise<string>;
  /** Creates `name` at HEAD and checks it out; the working tree is left as it is. */
  createBranch(name: string): Promise<void>;
  /**
   * Commits exactly `paths` (workspace-relative; additions, changes and deletions) and returns
   * the new commit. Other changes in the working tree or the index are not committed.
   */
  commit(paths: readonly string[], message: string): Promise<string>;
}

export interface GitClientOptions {
  /** The workspace root (absolute). Git runs there and finds the repository from it. */
  readonly root: string;
  /** The environment PATH and the child environment come from. Default: `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Per git call. Default: 60 seconds. */
  readonly timeoutMs?: number;
  /** The git executable (absolute), instead of looking it up on PATH. */
  readonly executable?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMIT_ID = /^[a-f0-9]{40}([a-f0-9]{24})?$/;
const BRANCH_ATTEMPTS = 99;

interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export class GitClient implements GitWorkspace {
  private readonly root: string;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly platform: NodeJS.Platform;
  private readonly timeoutMs: number;
  private executable: Promise<string | undefined> | undefined;
  /** A directory that does not exist: git finds no hooks in it. */
  private readonly hooksPath = path.join(os.tmpdir(), `devflow-no-hooks-${randomUUID()}`);

  constructor(options: GitClientOptions) {
    this.root = path.resolve(options.root);
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (options.executable !== undefined) this.executable = Promise.resolve(options.executable);
  }

  async inspect(): Promise<GitInspection> {
    const file = await this.resolve();
    if (file === undefined) {
      return { kind: "unavailable", reason: "git was not found on PATH (outside the workspace)" };
    }
    const where = await this.run(["rev-parse", "--is-inside-work-tree", "--show-prefix"], file);
    if (where.exitCode !== 0) {
      return {
        kind: "unavailable",
        reason: `the workspace is not in a git repository (${firstLine(where.stderr)})`,
      };
    }
    const [inside, prefix = ""] = where.stdout.split(/\r?\n/);
    if (inside !== "true") {
      return { kind: "unavailable", reason: "the workspace is not in a git working tree" };
    }
    const head = await this.run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], file);
    const commit = head.stdout.trim();
    if (head.exitCode !== 0 || !COMMIT_ID.test(commit)) {
      return { kind: "unavailable", reason: "the repository has no commit yet" };
    }
    const status = await this.run(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=no", "--", "."],
      file,
    );
    if (status.exitCode !== 0) throw this.failure("status", status);
    return {
      kind: "repository",
      head: commit,
      branch: await this.currentBranch(),
      changes: statusPaths(status.stdout, prefix).filter(
        (entry) => entry !== ".devflow" && !entry.startsWith(".devflow/"),
      ),
    };
  }

  async currentBranch(): Promise<string | null> {
    const result = await this.git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw this.failure("symbolic-ref", result);
    return result.stdout.trim();
  }

  async freeBranchName(base: string): Promise<string> {
    const valid = await this.git(["check-ref-format", `refs/heads/${base}`]);
    if (valid.exitCode !== 0) {
      throw new DevflowError(ErrorCode.GitFailed, `"${base}" is not a valid branch name`, {
        details: { branch: base },
      });
    }
    for (let attempt = 1; attempt <= BRANCH_ATTEMPTS; attempt++) {
      const name = attempt === 1 ? base : `${base}-${String(attempt)}`;
      const exists = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      if (exists.exitCode !== 0) return name;
    }
    throw new DevflowError(
      ErrorCode.GitFailed,
      `branches ${base} to ${base}-${String(BRANCH_ATTEMPTS)} all exist; delete the ones you no longer need`,
      { details: { branch: base } },
    );
  }

  async createBranch(name: string): Promise<void> {
    const result = await this.git(["checkout", "--quiet", "-b", name]);
    if (result.exitCode !== 0) throw this.failure("checkout -b", result);
  }

  async commit(paths: readonly string[], message: string): Promise<string> {
    if (paths.length === 0) {
      throw new DevflowError(ErrorCode.GitFailed, "there is nothing to commit");
    }
    const add = await this.git(["add", "--all", "--", ...paths]);
    if (add.exitCode !== 0) throw this.failure("add", add);
    const commit = await this.git([
      "commit",
      "--quiet",
      "--no-verify",
      "--no-edit",
      "--cleanup=whitespace",
      "-m",
      message,
      "--only",
      "--",
      ...paths,
    ]);
    if (commit.exitCode !== 0) throw this.failure("commit", commit);
    const head = await this.git(["rev-parse", "--verify", "HEAD^{commit}"]);
    const id = head.stdout.trim();
    if (head.exitCode !== 0 || !COMMIT_ID.test(id)) throw this.failure("rev-parse", head);
    return id;
  }

  private resolve(): Promise<string | undefined> {
    this.executable ??= this.lookUp();
    return this.executable;
  }

  private async lookUp(): Promise<string | undefined> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(this.env)) {
      if (value !== undefined) env[name] = value;
    }
    const found = await findOnPath("git", env, this.platform);
    if (found === undefined) return undefined;
    const pathApi = this.platform === "win32" ? path.win32 : path.posix;
    const relative = pathApi.relative(this.root, found);
    const inside = relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
    if (inside) return undefined;
    // A batch file would need cmd.exe and its quoting rules; git for Windows ships git.exe.
    if (this.platform === "win32" && pathApi.extname(found).toLowerCase() !== ".exe") {
      return undefined;
    }
    return found;
  }

  private async git(args: readonly string[]): Promise<GitResult> {
    const file = await this.resolve();
    if (file === undefined) {
      throw new DevflowError(
        ErrorCode.GitFailed,
        "git was not found on PATH (outside the workspace)",
      );
    }
    return this.run(args, file);
  }

  private async run(args: readonly string[], file: string): Promise<GitResult> {
    const env = {
      ...childEnvironment(this.env, {}, this.platform),
      GIT_TERMINAL_PROMPT: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_ADVICE: "0",
    };
    const result = await launchProcess({
      file,
      args: [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        `core.hooksPath=${this.hooksPath}`,
        "-c",
        "commit.gpgSign=false",
        "-c",
        "gc.auto=0",
        "-c",
        "maintenance.auto=false",
        "-c",
        "color.ui=false",
        "-c",
        "core.quotePath=false",
        ...args,
      ],
      cwd: this.root,
      env,
      windowsVerbatimArguments: false,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      platform: this.platform,
    });
    if (result.timedOut) {
      throw new DevflowError(
        ErrorCode.GitFailed,
        `git ${args[0] ?? ""} did not finish within ${String(this.timeoutMs)} ms`,
      );
    }
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.toString("utf8"),
      stderr: result.stderr.toString("utf8"),
    };
  }

  private failure(operation: string, result: GitResult): DevflowError {
    return new DevflowError(
      ErrorCode.GitFailed,
      `git ${operation} failed: ${firstLine(result.stderr) || `exit code ${String(result.exitCode)}`}`,
      { details: { operation, exitCode: result.exitCode } },
    );
  }
}

function firstLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  );
}

/**
 * The paths of `git status --porcelain=v1 -z`, relative to the workspace. Status paths are
 * relative to the repository's top level; `prefix` is the workspace's place in it.
 */
export function statusPaths(output: string, prefix: string): string[] {
  const fields = output.split("\0");
  const paths: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    paths.push(field.slice(3));
    // Renames and copies are followed by their source path.
    if (code.includes("R") || code.includes("C")) {
      const source = fields[i + 1];
      if (source !== undefined && source !== "") paths.push(source);
      i++;
    }
  }
  const unique = [...new Set(paths)];
  return unique
    .map((entry) =>
      prefix !== "" && entry.startsWith(prefix) ? entry.slice(prefix.length) : entry,
    )
    .sort();
}
