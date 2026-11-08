import { DevflowError, ErrorCode } from "../errors.js";
import type { RepositoryEntry, RepositoryView } from "../ports/repository-view.js";
import { createPathMatcher } from "../security/path-patterns.js";

/** A file of an in-memory repository: its text, or its text and modification time. */
export type MemoryFile = string | { readonly text: string; readonly modifiedMs: number };

/** Directories that `glob` never returns files from, as in the workspace repository. */
const EXCLUDED_DIRECTORIES = [".git", "node_modules", "target", "build", "dist"];

/**
 * An in-memory `RepositoryView` for adapter tests and the conformance kit. Paths are
 * repository-relative POSIX paths; directories exist implicitly when a file is below them.
 */
export class MemoryRepository implements RepositoryView {
  readonly root: string;
  private readonly files: ReadonlyMap<string, { text: string; modifiedMs: number }>;

  constructor(
    files: Readonly<Record<string, MemoryFile>>,
    options: { readonly root?: string; readonly modifiedMs?: number } = {},
  ) {
    this.root = options.root ?? "/memory/repo";
    const defaultTime = options.modifiedMs ?? Date.parse("2026-01-01T00:00:00Z");
    this.files = new Map(
      Object.entries(files).map(([path, file]) => [
        normalize(path),
        typeof file === "string" ? { text: file, modifiedMs: defaultTime } : { ...file },
      ]),
    );
  }

  /** A copy with files added or replaced (for example, test reports written by a run). */
  with(files: Readonly<Record<string, MemoryFile>>): MemoryRepository {
    const merged: Record<string, MemoryFile> = {};
    for (const [path, file] of this.files) merged[path] = file;
    for (const [path, file] of Object.entries(files)) merged[normalize(path)] = file;
    return new MemoryRepository(merged, { root: this.root });
  }

  exists(path: string): Promise<boolean> {
    const target = normalize(path);
    if (target === ".") return Promise.resolve(true);
    if (this.files.has(target)) return Promise.resolve(true);
    const prefix = `${target}/`;
    return Promise.resolve([...this.files.keys()].some((file) => file.startsWith(prefix)));
  }

  readText(path: string, options: { readonly maxBytes?: number } = {}): Promise<string> {
    const file = this.files.get(normalize(path));
    if (file === undefined) {
      return Promise.reject(
        new DevflowError(
          ErrorCode.RepositoryFileUnreadable,
          `${path} cannot be read (unreadable)`,
          {
            details: { path, reason: "unreadable" },
          },
        ),
      );
    }
    if (options.maxBytes !== undefined && Buffer.byteLength(file.text, "utf8") > options.maxBytes) {
      return Promise.reject(
        new DevflowError(ErrorCode.RepositoryFileUnreadable, `${path} cannot be read (too-large)`, {
          details: { path, reason: "too-large" },
        }),
      );
    }
    return Promise.resolve(file.text);
  }

  list(directory: string): Promise<readonly RepositoryEntry[]> {
    const dir = normalize(directory);
    const prefix = dir === "." ? "" : `${dir}/`;
    const entries = new Map<string, RepositoryEntry>();
    for (const [path, file] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) {
        entries.set(path, {
          path,
          kind: "file",
          sizeBytes: Buffer.byteLength(file.text, "utf8"),
          modifiedMs: file.modifiedMs,
        });
      } else {
        const child = `${prefix}${rest.slice(0, slash)}`;
        entries.set(child, { path: child, kind: "directory" });
      }
    }
    return Promise.resolve([...entries.values()].sort((a, b) => (a.path < b.path ? -1 : 1)));
  }

  glob(
    patterns: readonly string[],
    options: { readonly cwd?: string } = {},
  ): Promise<readonly string[]> {
    const prefix =
      options.cwd === undefined || options.cwd === "." ? "" : `${normalize(options.cwd)}/`;
    const matcher = createPathMatcher(
      patterns.map((pattern) => `${prefix}${pattern}`),
      { caseInsensitive: false },
    );
    return Promise.resolve(
      [...this.files.keys()]
        .filter(
          (path) =>
            !path
              .split("/")
              .slice(0, -1)
              .some((segment) => EXCLUDED_DIRECTORIES.includes(segment)),
        )
        .filter((path) => matcher.match(path) !== undefined)
        .sort(),
    );
  }
}

function normalize(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return trimmed === "" ? "." : trimmed;
}
