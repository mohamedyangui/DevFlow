import { realpath as realpathCallback } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { DevflowError, ErrorCode } from "../errors.js";
import { checkRepoRelativePath } from "../schemas/primitives.js";
import {
  DEFAULT_PROTECTED_PATH_PATTERNS,
  HARD_PROTECTED_PATH_PATTERNS,
  SENSITIVE_PATH_PATTERNS,
  caseInsensitiveFileSystem,
  createPathMatcher,
  type PathMatcher,
} from "./path-patterns.js";

/**
 * The path guard decides whether a path may be read, sent to a model, or written
 * (docs/specs/security-model.md, section 6). Every file access that DevFlow performs on behalf
 * of a workflow step goes through it.
 *
 * - `read`: DevFlow reads the file for its own use (hashing, parsing).
 * - `prompt`: the content may be sent to a model. Sensitive files and repository metadata are
 *   refused.
 * - `write`: DevFlow writes the file. Protected paths are refused unless a confirmed plan
 *   unlocked that exact path; `.git` and `.devflow` can never be unlocked.
 *
 * The origin says who supplied the path. Paths from model output (`model`) must be
 * repository-relative and syntactically clean; paths typed by the user (`user`) may be
 * absolute but must lie inside the workspace. DevFlow's own bookkeeping (`internal`) is not
 * subject to the protected-path list but still cannot leave the workspace.
 *
 * Residual risk: a check and the following file operation are two steps. A process that swaps
 * a directory for a symbolic link in between could redirect the operation. Writers re-check
 * immediately before writing and refuse to write through symbolic links.
 */

export type PathAccess = "read" | "prompt" | "write";
export type PathOrigin = "model" | "user" | "internal";

export interface PathCheckRequest {
  readonly access: PathAccess;
  readonly origin: PathOrigin;
}

export type PathRejectionReason =
  | "empty"
  | "too-long"
  | "nul-byte"
  | "control-character"
  | "absolute-path"
  | "invalid-syntax"
  | "outside-workspace"
  | "device-name"
  | "alternate-data-stream"
  | "trailing-dot-or-space"
  | "symlink-escape"
  | "symlink-write"
  | "workspace-root"
  | "protected"
  | "sensitive";

/** A path that passed the guard. */
export interface GuardedPath {
  /** Repository-relative path with forward slashes, as requested (`.` for the root). */
  readonly relative: string;
  /** Repository-relative path of the real location, after resolving symbolic links. */
  readonly realRelative: string;
  /** Absolute native path of the real location. Use this for the file operation. */
  readonly absolute: string;
  /** Whether the path existed when it was checked. */
  readonly exists: boolean;
}

export interface PathGuardOptions {
  /** Extra write-protected globs from `security.additionalProtectedPaths`. */
  readonly additionalProtectedPaths?: readonly string[];
  /** Exact repository-relative paths that a confirmed plan unlocked for writing. */
  readonly unlockedPaths?: readonly string[];
  /** Overrides the case sensitivity derived from the platform (tests only). */
  readonly caseInsensitive?: boolean;
}

/** `realpath` that asks the OS for the canonical path (long names on Windows, real case). */
const realpathNative = promisify(realpathCallback.native);

const MAX_PATH_LENGTH = 4096;
const WINDOWS_RESERVED_NAME =
  /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0001-\u001f\u007f]/;

export class PathGuard {
  readonly root: string;
  private readonly caseInsensitive: boolean;
  private readonly sensitive: PathMatcher;
  private readonly metadata: PathMatcher;
  private readonly hardProtected: PathMatcher;
  private readonly protectedPaths: PathMatcher;
  private readonly unlocked: ReadonlySet<string>;

  private constructor(root: string, options: PathGuardOptions) {
    this.root = root;
    this.caseInsensitive = options.caseInsensitive ?? caseInsensitiveFileSystem();
    const matcherOptions = { caseInsensitive: this.caseInsensitive };
    this.sensitive = createPathMatcher(SENSITIVE_PATH_PATTERNS, matcherOptions);
    this.metadata = createPathMatcher(
      HARD_PROTECTED_PATH_PATTERNS.filter((pattern) => pattern.includes(".git")),
      matcherOptions,
    );
    this.hardProtected = createPathMatcher(HARD_PROTECTED_PATH_PATTERNS, matcherOptions);
    this.protectedPaths = createPathMatcher(
      [...DEFAULT_PROTECTED_PATH_PATTERNS, ...(options.additionalProtectedPaths ?? [])],
      matcherOptions,
    );
    this.unlocked = new Set((options.unlockedPaths ?? []).map((p) => this.key(p)));
  }

  /**
   * Creates a guard for a workspace. The root is resolved to its real path, so a workspace
   * reached through a symbolic link is guarded at its real location.
   */
  static async create(root: string, options: PathGuardOptions = {}): Promise<PathGuard> {
    let realRoot: string;
    try {
      realRoot = await realpathNative(path.resolve(root));
    } catch (error) {
      throw new DevflowError(ErrorCode.WorkspaceInvalid, `workspace ${root} does not exist`, {
        details: { root },
        cause: error,
      });
    }
    if (!(await lstat(realRoot)).isDirectory()) {
      throw new DevflowError(ErrorCode.WorkspaceInvalid, `workspace ${root} is not a directory`, {
        details: { root },
      });
    }

    for (const glob of options.additionalProtectedPaths ?? []) {
      const problem = checkRepoRelativePath(glob, { glob: true });
      if (problem !== null) {
        throw new DevflowError(
          ErrorCode.PathRejected,
          `invalid protected path "${glob}": ${problem}`,
          {
            details: { path: glob, reason: "invalid-syntax" },
          },
        );
      }
    }
    const guard = new PathGuard(realRoot, options);
    for (const unlocked of options.unlockedPaths ?? []) {
      const problem = checkRepoRelativePath(unlocked);
      if (problem !== null) {
        throw new DevflowError(
          ErrorCode.PathRejected,
          `invalid unlocked path "${unlocked}": ${problem}`,
          {
            details: { path: unlocked, reason: "invalid-syntax" },
          },
        );
      }
      if (guard.hardProtected.match(unlocked) !== undefined) {
        throw new DevflowError(
          ErrorCode.PathRejected,
          `"${unlocked}" is repository or DevFlow metadata and cannot be unlocked`,
          { details: { path: unlocked, reason: "protected" } },
        );
      }
    }
    return guard;
  }

  /** Whether a repository-relative path is on the sensitive-path list (lexical check). */
  isSensitive(relative: string): boolean {
    return (
      this.sensitive.match(relative) !== undefined || this.metadata.match(relative) !== undefined
    );
  }

  /** Whether a repository-relative path is write-protected (lexical check, ignores unlocks). */
  isProtected(relative: string): boolean {
    return (
      this.hardProtected.match(relative) !== undefined ||
      this.protectedPaths.match(relative) !== undefined
    );
  }

  /**
   * Checks a path and returns where it really is. Throws a `DevflowError` with code
   * `PATH_REJECTED` and `details.reason` set to a {@link PathRejectionReason} otherwise.
   */
  async check(input: string, request: PathCheckRequest): Promise<GuardedPath> {
    const reject = (reason: PathRejectionReason, explanation: string): never => {
      throw new DevflowError(
        ErrorCode.PathRejected,
        `path ${JSON.stringify(input)} was rejected: ${explanation}`,
        { details: { path: input, reason, access: request.access, origin: request.origin } },
      );
    };

    if (input.length === 0) reject("empty", "the path is empty");
    if (input.length > MAX_PATH_LENGTH)
      reject("too-long", `it is longer than ${MAX_PATH_LENGTH} characters`);
    if (input.includes("\u0000")) reject("nul-byte", "it contains a NUL byte");
    if (CONTROL_CHARACTER.test(input))
      reject("control-character", "it contains a control character");

    const relative = this.lexicalRelative(input, request, reject);

    if (relative !== ".") {
      for (const segment of relative.split("/")) {
        if (segment.includes(":")) {
          reject("alternate-data-stream", `segment "${segment}" names an alternate data stream`);
        }
        if (WINDOWS_RESERVED_NAME.test(segment)) {
          reject("device-name", `segment "${segment}" is a reserved device name on Windows`);
        }
        if (/[ .]$/.test(segment)) {
          reject(
            "trailing-dot-or-space",
            `segment "${segment}" ends with a dot or a space, which Windows silently removes`,
          );
        }
      }
    }

    const lexicalAbsolute =
      relative === "." ? this.root : path.join(this.root, ...relative.split("/"));
    const resolved = await this.resolveReal(lexicalAbsolute, reject);
    const realRelative = this.relativeInside(resolved.real);
    if (realRelative === null) {
      reject("symlink-escape", "it leads outside the workspace through a symbolic link");
    }
    const realRel = realRelative ?? ".";

    if (request.access === "prompt") {
      const hit =
        this.sensitive.match(relative) ??
        this.sensitive.match(realRel) ??
        this.metadata.match(relative) ??
        this.metadata.match(realRel);
      if (hit !== undefined) {
        reject(
          "sensitive",
          `it matches the sensitive-path pattern "${hit}" and is never sent to a model`,
        );
      }
    }

    if (request.access === "write") {
      if (relative === "." || realRel === ".") reject("workspace-root", "it is the workspace root");
      if (resolved.isSymlink)
        reject("symlink-write", "writing through a symbolic link is not allowed");
      if (request.origin !== "internal") {
        const hard = this.hardProtected.match(relative) ?? this.hardProtected.match(realRel);
        if (hard !== undefined) {
          reject(
            "protected",
            `it is protected by "${hard}" and can never be written by a workflow`,
          );
        }
        const unlocked =
          this.unlocked.has(this.key(relative)) && this.unlocked.has(this.key(realRel));
        const protectedBy =
          this.protectedPaths.match(relative) ?? this.protectedPaths.match(realRel);
        if (protectedBy !== undefined && !unlocked) {
          reject(
            "protected",
            `it is protected by "${protectedBy}"; only a confirmed plan can unlock it`,
          );
        }
      }
    }

    return { relative, realRelative: realRel, absolute: resolved.real, exists: resolved.exists };
  }

  /** Normalizes the input to a repository-relative POSIX path, or rejects it. */
  private lexicalRelative(
    input: string,
    request: PathCheckRequest,
    reject: (reason: PathRejectionReason, explanation: string) => never,
  ): string {
    if (request.origin === "model") {
      if (isAbsoluteOnAnyPlatform(input)) {
        reject("absolute-path", "paths from model output must be relative to the workspace");
      }
      const trimmed = input.length > 1 && input.endsWith("/") ? input.slice(0, -1) : input;
      for (const segment of trimmed.split("/")) {
        if (WINDOWS_RESERVED_NAME.test(segment)) {
          reject("device-name", `segment "${segment}" is a reserved device name on Windows`);
        }
        if (segment.includes(":")) {
          reject("alternate-data-stream", `segment "${segment}" names an alternate data stream`);
        }
        if (segment === "..") reject("outside-workspace", 'it contains a ".." segment');
      }
      const problem = checkRepoRelativePath(trimmed);
      if (problem !== null) reject("invalid-syntax", problem);
      return trimmed;
    }

    const resolved = path.resolve(this.root, input);
    const relative = this.relativeInside(resolved);
    if (relative === null) return reject("outside-workspace", "it is outside the workspace");
    return relative;
  }

  /** Repository-relative POSIX path of an absolute path, or null when it is outside. */
  private relativeInside(absolute: string): string | null {
    const relative = path.relative(this.root, absolute);
    if (relative === "") return ".";
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    if (this.caseInsensitive && !samePrefix(this.root, absolute)) return null;
    return relative.split(path.sep).join("/");
  }

  /**
   * Resolves symbolic links. For a path that does not exist yet, resolves its deepest existing
   * ancestor and appends the rest.
   */
  private async resolveReal(
    absolute: string,
    reject: (reason: PathRejectionReason, explanation: string) => never,
  ): Promise<{ real: string; exists: boolean; isSymlink: boolean }> {
    let existing = absolute;
    const missing: string[] = [];
    let isSymlink = false;
    for (;;) {
      try {
        const stats = await lstat(existing);
        if (existing === absolute) isSymlink = stats.isSymbolicLink();
        break;
      } catch (error) {
        if (!isNotFound(error) || existing === this.root) throw error;
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    let realExisting: string;
    try {
      realExisting = await realpathNative(existing);
    } catch (error) {
      if (isNotFound(error)) reject("symlink-escape", "it goes through a dangling symbolic link");
      throw error;
    }
    return { real: path.join(realExisting, ...missing), exists: missing.length === 0, isSymlink };
  }

  private key(relative: string): string {
    return this.caseInsensitive ? relative.toLowerCase() : relative;
  }
}

function isAbsoluteOnAnyPlatform(value: string): boolean {
  return (
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("~")
  );
}

/** Case-insensitive prefix comparison used as a second containment check on Windows/macOS. */
function samePrefix(root: string, absolute: string): boolean {
  return absolute.toLowerCase().startsWith(root.toLowerCase());
}

function isNotFound(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
