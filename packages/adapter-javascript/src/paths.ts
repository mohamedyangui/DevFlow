import { checkRepoRelativePath, repoDirname } from "@devflow-ai/core";

/**
 * Resolves `relative` (which may contain `.` and `..` segments) against the repository
 * directory `base`. Returns undefined for absolute paths and for paths that leave the
 * repository.
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
 * process started in `from` would name it: `node_modules/x` or `../../node_modules/x`.
 */
export function pathFrom(from: string, target: string): string {
  const a = from === "." ? [] : from.split("/");
  const b = target === "." ? [] : target.split("/");
  let common = 0;
  while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
  const up = a.slice(common).map(() => "..");
  const parts = [...up, ...b.slice(common)];
  return parts.length === 0 ? "." : parts.join("/");
}

/**
 * Converts an absolute path printed by a tool (`/home/me/repo/src/a.ts`, `C:\repo\src\a.ts`,
 * `file:///C:/repo/src/a.ts`) into a repository-relative path, or undefined when it is outside
 * the repository root.
 */
export function toRepoRelative(root: string, absolute: string): string | undefined {
  const normalize = (value: string): string =>
    value
      .replace(/\\/g, "/")
      .replace(/^\/([A-Za-z]:)/, "$1")
      .replace(/\/+$/, "");
  let file = absolute.trim();
  if (file.startsWith("file://")) {
    try {
      file = decodeURIComponent(file.slice("file://".length));
    } catch {
      return undefined;
    }
  }
  file = normalize(file);
  const base = normalize(root);
  const caseInsensitive = /^[A-Za-z]:/.test(base);
  const a = caseInsensitive ? file.toLowerCase() : file;
  const b = caseInsensitive ? base.toLowerCase() : base;
  if (!a.startsWith(`${b}/`)) return undefined;
  const relative = file.slice(base.length + 1);
  return checkRepoRelativePath(relative) === null ? relative : undefined;
}

/** The directory itself and each of its parents up to the repository root, nearest first. */
export function ancestors(dir: string): string[] {
  const out = [dir];
  let current = dir;
  while (current !== ".") {
    current = repoDirname(current);
    out.push(current);
  }
  return out;
}

/** Escapes a string for use inside a regular expression. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
