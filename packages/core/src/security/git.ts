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
 * process), the pager and terminal prompts. Diffs pass `--no-ext-diff` and `--no-textconv`,
 * so no diff driver or conversion filter runs. Pathspecs are literal. The executable is looked up
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

/** One file of a local diff, relative to the workspace. */
export interface GitDiffFile {
  readonly path: string;
  readonly change: "added" | "modified" | "deleted";
  /** Lines added and deleted; null for binary and untracked files. */
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
  /** False for a file git does not track yet (untracked and not ignored). */
  readonly tracked: boolean;
}

/** The changes of the working tree since a commit (review mode). */
export interface GitDiff {
  readonly base: string;
  /** The checked-out commit. */
  readonly head: string;
  /** Sorted by path; `.devflow/` is left out. */
  readonly files: readonly GitDiffFile[];
  /** Unified diff of the tracked files (3 lines of context); untracked files are not in it. */
  readonly patch: string;
  /** True when the patch was longer than the limit and was cut at a file boundary. */
  readonly patchTruncated: boolean;
}

/** References a review may compare with: no leading dash, no spaces, no shell syntax. */
const REF = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^-]{0,199}$/;
const DEFAULT_MAX_PATCH_BYTES = 1024 * 1024;

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
  /** The commit a review compares with: the merge base of `ref` and HEAD. */
  mergeBase(ref: string): Promise<string>;
  /** The changes of the working tree (staged, unstaged and untracked) since `base`. */
  diff(base: string, options?: { readonly maxPatchBytes?: number }): Promise<GitDiff>;
  /** The configured URL of a remote (`origin` by default), or null when it has none. */
  remoteUrl(name?: string): Promise<string | null>;
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
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** Branches DevFlow pushes: no leading dash or `+`, no `:`, spaces or wildcards. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly outputTruncated: boolean;
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

  async remoteUrl(name = "origin"): Promise<string | null> {
    this.checkRemoteName(name);
    const result = await this.git(["config", "--get", `remote.${name}.url`]);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw this.failure("config", result);
    const url = result.stdout.trim();
    return url === "" ? null : url;
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

  async mergeBase(ref: string): Promise<string> {
    if (!REF.test(ref)) {
      throw new DevflowError(
        ErrorCode.GitFailed,
        `"${ref}" is not a git reference DevFlow accepts`,
        {
          details: { ref },
        },
      );
    }
    const commit = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    const id = commit.stdout.trim();
    if (commit.exitCode !== 0 || !COMMIT_ID.test(id)) {
      throw new DevflowError(ErrorCode.GitFailed, `"${ref}" is not a commit of this repository`, {
        details: { ref },
      });
    }
    const base = await this.git(["merge-base", id, "HEAD"]);
    const baseId = base.stdout.trim();
    if (base.exitCode !== 0 || !COMMIT_ID.test(baseId)) {
      throw new DevflowError(
        ErrorCode.GitFailed,
        `"${ref}" has no common history with the checked-out commit`,
        { details: { ref } },
      );
    }
    return baseId;
  }

  async diff(base: string, options: { readonly maxPatchBytes?: number } = {}): Promise<GitDiff> {
    if (!COMMIT_ID.test(base)) {
      throw new DevflowError(ErrorCode.GitFailed, `"${base}" is not a commit id`);
    }
    const head = await this.git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (head.exitCode !== 0) throw this.failure("rev-parse", head);
    const common = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--relative",
    ];
    const names = await this.git([...common, "--name-status", "-z", base, "--"]);
    if (names.exitCode !== 0) throw this.failure("diff --name-status", names);
    const counts = await this.git([...common, "--numstat", "-z", base, "--"]);
    if (counts.exitCode !== 0) throw this.failure("diff --numstat", counts);
    const patch = await this.git([...common, "--unified=3", base, "--"]);
    if (patch.exitCode !== 0) throw this.failure("diff", patch);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked.exitCode !== 0) throw this.failure("ls-files", untracked);

    const stats = numstat(counts.stdout);
    const files: GitDiffFile[] = [];
    const fields = names.stdout.split("\0");
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const status = fields[i] ?? "";
      const file = fields[i + 1] ?? "";
      if (status === "" || file === "") continue;
      const stat = stats.get(file);
      files.push({
        path: file,
        change: status.startsWith("A") ? "added" : status.startsWith("D") ? "deleted" : "modified",
        additions: stat?.additions ?? null,
        deletions: stat?.deletions ?? null,
        binary: stat?.binary ?? false,
        tracked: true,
      });
    }
    for (const file of untracked.stdout.split("\0")) {
      if (file === "") continue;
      files.push({
        path: file,
        change: "added",
        additions: null,
        deletions: null,
        binary: false,
        tracked: false,
      });
    }
    const max = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    const cut = cutPatch(patch.stdout, patch.outputTruncated, max);
    return {
      base,
      head: head.stdout.trim(),
      files: files
        .filter((file) => file.path !== ".devflow" && !file.path.startsWith(".devflow/"))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      patch: cut.patch,
      patchTruncated: cut.truncated,
    };
  }

  /** The commit a local branch points to, or null when the branch does not exist. */
  async branchCommit(branch: string): Promise<string | null> {
    await this.checkBranchName(branch);
    const result = await this.git([
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branch}^{commit}`,
    ]);
    const id = result.stdout.trim();
    if (result.exitCode !== 0 || !COMMIT_ID.test(id)) return null;
    return id;
  }

  /** Whether `commit` is `descendant` or one of its ancestors (both commit ids). */
  async isAncestor(commit: string, descendant: string): Promise<boolean> {
    if (!COMMIT_ID.test(commit) || !COMMIT_ID.test(descendant)) {
      throw new DevflowError(ErrorCode.GitFailed, "isAncestor compares two commit ids");
    }
    const result = await this.git(["merge-base", "--is-ancestor", commit, descendant]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw this.failure("merge-base --is-ancestor", result);
  }

  /**
   * The URLs a push to a remote goes to, with `pushurl`, `pushInsteadOf` and `insteadOf`
   * applied; an empty list when the remote does not exist.
   */
  async pushUrls(name = "origin"): Promise<string[]> {
    this.checkRemoteName(name);
    const exists = await this.git(["config", "--get", `remote.${name}.url`]);
    if (exists.exitCode === 1) return [];
    if (exists.exitCode !== 0) throw this.failure("config", exists);
    const result = await this.git(["remote", "get-url", "--push", "--all", name]);
    if (result.exitCode !== 0) throw this.failure("remote get-url", result);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  }

  /**
   * Pushes one local branch to a remote (Phase 5, `devflow pr create`): exactly the refspec
   * `refs/heads/<branch>:refs/heads/<branch>`, never forced (no `+`, no `--force`: a remote
   * branch that has moved is rejected by git), never tags, no other branch, no upstream
   * configured, no pre-push hook, no signed push, no submodules. Git uses the user's own
   * credentials; DevFlow adds none, and the child environment carries no token.
   *
   * @returns the pushed commit.
   */
  async push(branch: string, options: { readonly remote?: string } = {}): Promise<string> {
    const remote = options.remote ?? "origin";
    this.checkRemoteName(remote);
    const commit = await this.branchCommit(branch);
    if (commit === null) {
      throw new DevflowError(ErrorCode.GitFailed, `branch ${branch} does not exist`, {
        details: { branch },
      });
    }
    const ref = `refs/heads/${branch}`;
    const result = await this.git([
      "-c",
      "push.followTags=false",
      "-c",
      "push.gpgSign=false",
      "-c",
      "push.recurseSubmodules=no",
      "-c",
      `remote.${remote}.mirror=false`,
      "push",
      "--porcelain",
      "--no-verify",
      "--no-follow-tags",
      "--no-signed",
      "--recurse-submodules=no",
      remote,
      `${ref}:${ref}`,
    ]);
    if (result.exitCode !== 0) {
      throw new DevflowError(
        ErrorCode.GitPushFailed,
        `git push of ${branch} to ${remote} failed: ${pushProblem(result) || `exit code ${String(result.exitCode)}`}`,
        { details: { branch, remote, exitCode: result.exitCode } },
      );
    }
    return commit;
  }

  private checkRemoteName(name: string): void {
    if (!REMOTE.test(name)) {
      throw new DevflowError(ErrorCode.GitFailed, `"${name}" is not a git remote name`, {
        details: { remote: name },
      });
    }
  }

  /** A branch name DevFlow passes to git: no option, no refspec syntax, a valid ref. */
  private async checkBranchName(branch: string): Promise<void> {
    const valid =
      BRANCH.test(branch) &&
      (await this.git(["check-ref-format", `refs/heads/${branch}`])).exitCode === 0;
    if (!valid) {
      const shown = branch.slice(0, 80);
      throw new DevflowError(
        ErrorCode.GitFailed,
        `"${shown}" is not a branch name DevFlow accepts`,
        { details: { branch: shown } },
      );
    }
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
      outputTruncated: result.outputTruncated,
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

/** `git diff --numstat -z` without renames: `added<TAB>deleted<TAB>path<NUL>` (`-` for binary). */
function numstat(
  output: string,
): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const stats = new Map<
    string,
    { additions: number | null; deletions: number | null; binary: boolean }
  >();
  for (const record of output.split("\0")) {
    const match = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(record);
    if (match === null) continue;
    const [, added = "-", deleted = "-", file = ""] = match;
    const binary = added === "-" && deleted === "-";
    stats.set(file, {
      additions: binary ? null : Number(added),
      deletions: binary ? null : Number(deleted),
      binary,
    });
  }
  return stats;
}

/**
 * Keeps a patch within `max` bytes, cut at a file boundary. When the launcher already dropped
 * the start of the output, the first partial file is dropped too.
 */
export function cutPatch(
  patch: string,
  launcherTruncated: boolean,
  max: number,
): { patch: string; truncated: boolean } {
  let text = patch;
  let truncated = launcherTruncated;
  if (launcherTruncated) {
    const start = text.indexOf("\ndiff --git ");
    text = start === -1 ? "" : text.slice(start + 1);
  }
  if (Buffer.byteLength(text, "utf8") > max) {
    truncated = true;
    // The last file boundary before which everything fits.
    const marker = "\ndiff --git ";
    let end = 0;
    for (let at = text.indexOf(marker); at !== -1; at = text.indexOf(marker, at + 1)) {
      if (Buffer.byteLength(text.slice(0, at + 1), "utf8") > max) break;
      end = at + 1;
    }
    text = text.slice(0, end);
  }
  return { patch: text, truncated };
}

/**
 * Why a push failed: the `error:` or `fatal:` line and the rejected ref, with credentials in
 * a URL removed.
 */
function pushProblem(result: GitResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const rejected = lines.find((line) => /\[(rejected|remote rejected)\]/.test(line));
  const main = lines.find((line) => /^(fatal|error):/.test(line)) ?? rejected ?? lines[0] ?? "";
  const text = rejected !== undefined && rejected !== main ? `${main} (${rejected})` : main;
  return text.replace(/\/\/[^/@\s]*@/g, "//");
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
