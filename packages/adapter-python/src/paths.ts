import { checkRepoRelativePath } from "@devflow/core";

/**
 * Paths that never belong to a Python project of their own: virtual environments, installed
 * packages, tox and nox environments, caches, other ecosystems' dependency directories and
 * test fixtures (a `pyproject.toml` under `tests/fixtures/` is test data).
 */
export const IGNORED_PATH =
  /(^|\/)(\.venv|venv|\.tox|\.nox|site-packages|dist-packages|__pypackages__|__pycache__|\.mypy_cache|\.pytest_cache|\.ruff_cache|\.eggs|node_modules|fixtures|__fixtures__|test-fixtures|testdata)\//;

/** True when the repository path is inside a directory the adapter never reads as project code. */
export function isIgnoredPath(path: string): boolean {
  return IGNORED_PATH.test(path);
}

/**
 * Resolves `relative` (which may contain `.` and `..` segments) against the repository
 * directory `base`. Returns undefined for absolute paths and for paths that leave the
 * repository. Backslashes (Windows tool output) are read as separators.
 */
export function resolveRepoPath(base: string, relative: string): string | undefined {
  const cleaned = relative.trim().replace(/\\/g, "/");
  if (cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) return undefined;
  const out = base === "." ? [] : base.split("/");
  for (const segment of cleaned.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const result = out.length === 0 ? "." : out.join("/");
  return checkRepoRelativePath(result) === null ? result : undefined;
}

/**
 * The path of the repository path `target` relative to the repository directory `from`, as a
 * process started in `from` would name it.
 */
export function pathFrom(from: string, target: string): string {
  const a = from === "." ? [] : from.split("/");
  const b = target === "." ? [] : target.split("/");
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  const parts = [...a.slice(common).map(() => ".."), ...b.slice(common)];
  return parts.length === 0 ? "." : parts.join("/");
}

/**
 * Converts an absolute path printed by a tool (`/home/me/repo/src/a.py`, `C:\repo\src\a.py`)
 * into a repository-relative path, or undefined when it is outside the repository root.
 */
export function toRepoRelative(root: string, absolute: string): string | undefined {
  const normalize = (value: string): string =>
    value
      .replace(/\\/g, "/")
      .replace(/^\/([A-Za-z]:)/, "$1")
      .replace(/\/+$/, "");
  const file = normalize(absolute.trim());
  const base = normalize(root);
  const caseInsensitive = /^[A-Za-z]:/.test(base);
  const a = caseInsensitive ? file.toLowerCase() : file;
  const b = caseInsensitive ? base.toLowerCase() : base;
  if (!a.startsWith(`${b}/`)) return undefined;
  const relative = file.slice(base.length + 1);
  return checkRepoRelativePath(relative) === null ? relative : undefined;
}

/** A path printed by a tool, relative to `cwd` or absolute, as a repository path. */
export function toolPath(repoRoot: string, cwd: string, printed: string): string | undefined {
  const absolute = printed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(printed);
  return absolute ? toRepoRelative(repoRoot, printed) : resolveRepoPath(cwd, printed);
}

/** The file name of a repository path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Removes duplicates, keeping the first occurrence. */
export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Sorts repository paths in a stable, locale-independent order. */
export function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Escapes a string for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
