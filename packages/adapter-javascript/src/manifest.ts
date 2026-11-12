import {
  fileEvidence,
  isRecord,
  joinRepoPath,
  parseJsonOrUndefined,
  readTextIfPresent,
  repoDirname,
  type Evidence,
  type RepositoryView,
} from "@devflow-ai/core";
import { ancestors, escapeRegExp } from "./paths.js";

/** A `package.json` file. `json` is undefined when the file is not valid JSON. */
export interface PackageManifest {
  readonly path: string;
  readonly dir: string;
  readonly text: string;
  readonly json: Readonly<Record<string, unknown>> | undefined;
}

export const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;
export type DependencyField = (typeof DEPENDENCY_FIELDS)[number];

/** A dependency declared in a manifest, with the line that declares it. */
export interface DeclaredDependency {
  readonly name: string;
  readonly range: string;
  readonly field: DependencyField;
  readonly evidence: Evidence;
}

export async function readManifest(
  repo: RepositoryView,
  path: string,
): Promise<PackageManifest | undefined> {
  const text = await readTextIfPresent(repo, path);
  if (text === undefined) return undefined;
  const parsed = parseJsonOrUndefined(text.replace(/^\uFEFF/, ""));
  return { path, dir: repoDirname(path), text, json: isRecord(parsed) ? parsed : undefined };
}

/** The 1-based line of `"key":` inside the top-level `section` object, or of the first `"key":`. */
export function keyLine(text: string, key: string, section?: string): number | undefined {
  const lines = text.split(/\r?\n/);
  const keyPattern = new RegExp(`^\\s*"${escapeRegExp(key)}"\\s*:`);
  let start = 0;
  if (section !== undefined) {
    const sectionPattern = new RegExp(`^\\s*"${escapeRegExp(section)}"\\s*:`);
    const found = lines.findIndex((line) => sectionPattern.test(line));
    if (found !== -1) start = found + 1;
  }
  for (let index = start; index < lines.length; index += 1) {
    if (keyPattern.test(lines[index] ?? "")) return index + 1;
  }
  return section === undefined ? undefined : keyLine(text, key);
}

/** Evidence for a top-level key (or a key inside `section`) of the manifest. */
export function manifestEvidence(
  manifest: PackageManifest,
  description: string,
  key: string,
  section?: string,
): Evidence {
  const line = keyLine(manifest.text, key, section);
  if (line === undefined) return fileEvidence(manifest.path, description);
  const excerpt = manifest.text.split(/\r?\n/)[line - 1] ?? "";
  return fileEvidence(manifest.path, description, { line, excerpt });
}

/** Every dependency the manifest declares, in field order. */
export function dependencies(manifest: PackageManifest): DeclaredDependency[] {
  const json = manifest.json;
  if (json === undefined) return [];
  const out: DeclaredDependency[] = [];
  for (const field of DEPENDENCY_FIELDS) {
    const section = json[field];
    if (!isRecord(section)) continue;
    for (const [name, range] of Object.entries(section)) {
      if (typeof range !== "string") continue;
      out.push({
        name,
        range,
        field,
        evidence: manifestEvidence(manifest, `${name} in ${field}`, name, field),
      });
    }
  }
  return out;
}

/** The manifest's `scripts`, in declaration order. */
export function scripts(manifest: PackageManifest): [string, string][] {
  const section = manifest.json?.scripts;
  if (!isRecord(section)) return [];
  return Object.entries(section).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
}

/**
 * True when the manifest describes a package or project. `{"type": "module"}` files that only
 * set the module format of a directory (common in build output and source trees) are not.
 */
export function isProjectManifest(manifest: PackageManifest): boolean {
  const json = manifest.json;
  if (json === undefined) return true;
  return ["name", "version", "scripts", "workspaces", "private", ...DEPENDENCY_FIELDS].some(
    (key) => key in json,
  );
}

/** Workspace patterns from `workspaces` (an array, or `{ packages: [...] }` as in Yarn). */
export function manifestWorkspaces(manifest: PackageManifest): string[] {
  const field = manifest.json?.workspaces;
  const list = Array.isArray(field) ? field : isRecord(field) ? field.packages : undefined;
  return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

/** Package patterns listed under `packages:` in `pnpm-workspace.yaml`. */
export function pnpmWorkspacePackages(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = /^packages\s*:\s*\[(.*)\]\s*$/.exec(line)?.[1];
      if (inline !== undefined) {
        for (const item of inline.split(",")) {
          const value = unquote(item.trim());
          if (value !== "") out.push(value);
        }
        inPackages = false;
      }
      continue;
    }
    if (!inPackages) continue;
    if (line.trim() === "" || /^\s*#/.test(raw)) continue;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line)?.[1];
    if (item !== undefined) {
      out.push(unquote(item));
      continue;
    }
    if (/^\S/.test(line)) inPackages = false;
  }
  return out;
}

function unquote(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value);
  return match === null ? value : (match[2] ?? "");
}

/** The first of `names` that exists in `root` and can be read, for simple pattern lookups. */
export async function readModuleFile(
  repo: RepositoryView,
  root: string,
  names: readonly string[],
): Promise<{ path: string; text: string } | undefined> {
  for (const name of names) {
    const path = joinRepoPath(root, name);
    const text = await readTextIfPresent(repo, path);
    if (text !== undefined) return { path, text };
  }
  return undefined;
}

/** A package installed in a `node_modules` directory. */
export interface InstalledPackage {
  readonly name: string;
  /** The package directory, e.g. `node_modules/vitest`. */
  readonly dir: string;
  /** The `node_modules` directory it was found in. */
  readonly nodeModules: string;
  readonly version?: string;
  readonly json: Readonly<Record<string, unknown>>;
}

/**
 * Finds a package the way Node.js resolves it from `fromDir`: in `node_modules` of that
 * directory, then of each parent, up to the repository root.
 */
export async function installedPackage(
  repo: RepositoryView,
  fromDir: string,
  name: string,
): Promise<InstalledPackage | undefined> {
  if (!/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name)) return undefined;
  for (const dir of ancestors(fromDir)) {
    const nodeModules = joinRepoPath(dir, "node_modules");
    const packageDir = joinRepoPath(nodeModules, name);
    const text = await readTextIfPresent(repo, joinRepoPath(packageDir, "package.json"));
    if (text === undefined) continue;
    const json = parseJsonOrUndefined(text.replace(/^\uFEFF/, ""));
    if (!isRecord(json)) continue;
    const version = typeof json.version === "string" ? json.version : undefined;
    return {
      name,
      dir: packageDir,
      nodeModules,
      ...(version === undefined ? {} : { version }),
      json,
    };
  }
  return undefined;
}
