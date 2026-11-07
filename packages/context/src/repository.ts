import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  DevflowError,
  ErrorCode,
  createPathMatcher,
  type PathGuard,
  type RepositoryEntry,
  type RepositoryView,
} from "@devflow/core";
import { ALWAYS_EXCLUDED_DIRECTORIES, discoverFiles } from "./discover.js";
import { readTextForPrompt } from "./files.js";

export interface WorkspaceRepositoryOptions {
  /** Largest file `readText` returns by default. */
  readonly maxFileBytes: number;
  /** Globs excluded from `glob`, in addition to ignore files. */
  readonly exclude?: readonly string[];
}

/**
 * The read-only `RepositoryView` over a workspace. Every access goes through the path guard:
 * paths stay inside the workspace, links are resolved, and sensitive files are never returned
 * or read. Language adapters receive this object and nothing else (ADR 0003).
 */
export class WorkspaceRepository implements RepositoryView {
  readonly root: string;
  private files: Promise<readonly string[]> | undefined;

  constructor(
    private readonly guard: PathGuard,
    private readonly options: WorkspaceRepositoryOptions,
  ) {
    this.root = guard.root;
  }

  async exists(relative: string): Promise<boolean> {
    try {
      const checked = await this.guard.check(relative, { access: "read", origin: "internal" });
      return checked.exists && !this.guard.isSensitive(checked.relative);
    } catch {
      return false;
    }
  }

  async readText(relative: string, options: { readonly maxBytes?: number } = {}): Promise<string> {
    const loaded = await readTextForPrompt(
      this.guard,
      relative,
      options.maxBytes ?? this.options.maxFileBytes,
    );
    if (!loaded.ok) {
      throw new DevflowError(
        ErrorCode.RepositoryFileUnreadable,
        `${relative} cannot be read (${loaded.reason})`,
        { details: { path: relative, reason: loaded.reason } },
      );
    }
    return loaded.text;
  }

  async list(directory: string): Promise<readonly RepositoryEntry[]> {
    const checked = await this.guard.check(directory, { access: "read", origin: "internal" });
    if (!checked.exists) return [];
    const entries = await readdir(checked.absolute, { withFileTypes: true });
    const result: RepositoryEntry[] = [];
    for (const entry of entries) {
      const relative = checked.relative === "." ? entry.name : `${checked.relative}/${entry.name}`;
      if (entry.isSymbolicLink() || this.guard.isSensitive(relative)) continue;
      if (entry.isDirectory()) {
        if (ALWAYS_EXCLUDED_DIRECTORIES.includes(entry.name) || relative === ".devflow/runs") {
          continue;
        }
        result.push({ path: relative, kind: "directory" });
      } else if (entry.isFile()) {
        const size = (await stat(path.join(checked.absolute, entry.name))).size;
        result.push({ path: relative, kind: "file", sizeBytes: size });
      }
    }
    return result.sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  async glob(
    patterns: readonly string[],
    options: { readonly cwd?: string } = {},
  ): Promise<readonly string[]> {
    const prefix = options.cwd === undefined || options.cwd === "." ? "" : `${options.cwd}/`;
    const matcher = createPathMatcher(
      patterns.map((pattern) => `${prefix}${pattern}`),
      { caseInsensitive: process.platform === "win32" || process.platform === "darwin" },
    );
    this.files ??= discoverFiles(this.guard, {
      maxFileBytes: Number.MAX_SAFE_INTEGER,
      exclude: this.options.exclude ?? [],
    }).then((result) => result.files.map((file) => file.path));
    return (await this.files).filter((file) => matcher.match(file) !== undefined);
  }
}
