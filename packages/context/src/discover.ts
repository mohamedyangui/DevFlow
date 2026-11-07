import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createPathMatcher, type PathGuard } from "@devflow/core";
import ignore, { type Ignore } from "ignore";
import type { SkipReason } from "./schemas.js";

/** Directories never walked, whatever the ignore files say (docs/specs/context-engine.md). */
export const ALWAYS_EXCLUDED_DIRECTORIES: readonly string[] = [
  ".git",
  "node_modules",
  "target",
  "build",
  "dist",
  ".devflow/runs",
];

/** File types that are never text, recognized without reading them. */
const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico webp tiff psd svgz mp3 mp4 mov avi wav ogg flac webm " +
    "zip gz tgz bz2 xz 7z rar tar jar war ear class dex so dll dylib exe bin obj o a lib pdb " +
    "pdf doc docx xls xlsx ppt pptx odt woff woff2 ttf otf eot sqlite db mdb pyc pyo wasm " +
    "keystore jks p12 pfx der"
  ).split(" "),
);

export interface DiscoveredFile {
  /** Repository-relative POSIX path. */
  readonly path: string;
  readonly sizeBytes: number;
}

export interface DiscoveryResult {
  /** Text candidates, sorted by path. */
  readonly files: readonly DiscoveredFile[];
  readonly skipped: readonly { readonly path: string; readonly reason: SkipReason }[];
  /** True when the walk stopped at `maxFiles`. */
  readonly truncated: boolean;
}

export interface DiscoverOptions {
  readonly maxFileBytes: number;
  /** Stop after this many candidate files. Default 20 000. */
  readonly maxFiles?: number;
  /** When non-empty, only files matching one of these globs are candidates. */
  readonly include?: readonly string[];
  /** Files matching these globs are never candidates. */
  readonly exclude?: readonly string[];
}

interface IgnoreLevel {
  /** Directory of the ignore file, relative to the root ("" for the root). */
  readonly base: string;
  readonly rules: Ignore;
}

/**
 * Lists the workspace files that may be used as context.
 *
 * The walk honours `.gitignore` files at every level and `.git/info/exclude`, never follows
 * symbolic links, and never reads a sensitive file (the path guard's list). Large files and
 * known binary types are reported as skipped. Content is not read here; binary content is
 * detected when a file is loaded.
 */
export async function discoverFiles(
  guard: PathGuard,
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const maxFiles = options.maxFiles ?? 20_000;
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const include =
    options.include !== undefined && options.include.length > 0
      ? createPathMatcher(options.include, { caseInsensitive })
      : undefined;
  const exclude = createPathMatcher(options.exclude ?? [], { caseInsensitive });
  const files: DiscoveredFile[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];
  let truncated = false;

  const rootRules = await readIgnoreFile(path.join(guard.root, ".git", "info", "exclude"));
  const initial: IgnoreLevel[] = rootRules === undefined ? [] : [{ base: "", rules: rootRules }];

  async function walk(directory: string, levels: readonly IgnoreLevel[]): Promise<void> {
    const absolute = directory === "" ? guard.root : path.join(guard.root, ...directory.split("/"));
    let entries: Dirent[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    const own = entries.some((entry) => entry.name === ".gitignore" && entry.isFile())
      ? await readIgnoreFile(path.join(absolute, ".gitignore"))
      : undefined;
    const scoped = own === undefined ? levels : [...levels, { base: directory, rules: own }];

    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (truncated) return;
      const relative = directory === "" ? entry.name : `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        skipped.push({ path: relative, reason: "symlink" });
        continue;
      }
      if (entry.isDirectory()) {
        if (isAlwaysExcluded(relative) || isIgnored(scoped, relative, true)) continue;
        await walk(relative, scoped);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnored(scoped, relative, false)) continue;
      if (include !== undefined && include.match(relative) === undefined) continue;
      if (exclude.match(relative) !== undefined) continue;
      if (guard.isSensitive(relative)) {
        skipped.push({ path: relative, reason: "sensitive" });
        continue;
      }
      if (BINARY_EXTENSIONS.has(extensionOf(relative))) {
        skipped.push({ path: relative, reason: "binary" });
        continue;
      }
      let size: number;
      try {
        size = (await stat(path.join(absolute, entry.name))).size;
      } catch {
        skipped.push({ path: relative, reason: "unreadable" });
        continue;
      }
      if (size > options.maxFileBytes) {
        skipped.push({ path: relative, reason: "too-large" });
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push({ path: relative, sizeBytes: size });
    }
  }

  await walk("", initial);
  return { files, skipped, truncated };
}

function isAlwaysExcluded(relative: string): boolean {
  const segments = relative.split("/");
  const name = segments.at(-1) ?? "";
  if (ALWAYS_EXCLUDED_DIRECTORIES.includes(name)) return true;
  return relative === ".devflow/runs";
}

/** Git precedence: deeper ignore files win, and within a file the last matching rule wins. */
function isIgnored(levels: readonly IgnoreLevel[], relative: string, directory: boolean): boolean {
  let ignored = false;
  for (const level of levels) {
    const local = level.base === "" ? relative : relative.slice(level.base.length + 1);
    const result = level.rules.test(directory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function readIgnoreFile(file: string): Promise<Ignore | undefined> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 1024 * 1024) return undefined;
    return ignore().add(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

export function extensionOf(relative: string): string {
  const name = relative.slice(relative.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}
