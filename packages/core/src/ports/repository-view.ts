/**
 * Read-only access to the repository under analysis.
 *
 * All paths are repository-relative POSIX paths (`RepoPath`). Implementations (Phase 2) must
 * enforce the workspace boundary (realpath containment, symlink checks) and refuse to read
 * files on the sensitive-file denylist. Consumers such as language adapters never touch the
 * filesystem directly (ADR 0003).
 */
export interface RepositoryView {
  /** Absolute path of the workspace root. For display and diagnostics only. */
  readonly root: string;

  exists(path: string): Promise<boolean>;

  /** Reads a UTF-8 text file. Rejects files larger than `maxBytes`. */
  readText(path: string, options?: { readonly maxBytes?: number }): Promise<string>;

  /** Lists the direct children of a directory. */
  list(directory: string): Promise<readonly RepositoryEntry[]>;

  /** Expands repository-relative globs. Ignored and excluded files are never returned. */
  glob(
    patterns: readonly string[],
    options?: { readonly cwd?: string },
  ): Promise<readonly string[]>;
}

export interface RepositoryEntry {
  readonly path: string;
  readonly kind: "file" | "directory";
  readonly sizeBytes?: number;
}
