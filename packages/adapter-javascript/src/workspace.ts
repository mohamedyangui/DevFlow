import {
  createPathMatcher,
  fileEvidence,
  isWithin,
  joinRepoPath,
  readTextIfPresent,
  type Detection,
  type ModuleCandidate,
  type RepositoryView,
} from "@devflowai/core";
import {
  isProjectManifest,
  keyLine,
  manifestWorkspaces,
  pnpmWorkspacePackages,
  readManifest,
  type PackageManifest,
} from "./manifest.js";
import { ancestors, sortPaths } from "./paths.js";

export const ADAPTER_ID = "javascript";

/**
 * Manifests inside these directories are test fixtures, mocks or snapshots, not projects of
 * their own. `glob` already leaves out `node_modules`, `dist` and `build`.
 */
const FIXTURE_PATH =
  /(^|\/)(fixtures|__fixtures__|test-fixtures|testdata|__mocks__|__snapshots__)\/|(^|\/)src\/test\/resources\//;

const MAX_MANIFESTS = 1_000;

/**
 * Every `package.json` below `within` (the whole repository by default) that describes a
 * project, sorted by path.
 */
export async function projectManifests(
  repo: RepositoryView,
  within = ".",
): Promise<PackageManifest[]> {
  const paths = sortPaths(
    (await repo.glob(["**/package.json"], { cwd: within })).filter(
      (path) => !FIXTURE_PATH.test(path),
    ),
  ).slice(0, MAX_MANIFESTS);
  const out: PackageManifest[] = [];
  for (const path of paths) {
    const manifest = await readManifest(repo, path);
    if (manifest !== undefined && isProjectManifest(manifest)) out.push(manifest);
  }
  return out;
}

/** Roots of the JavaScript modules nested inside `root` (not `root` itself). */
export async function nestedModuleRoots(repo: RepositoryView, root: string): Promise<string[]> {
  return (await projectManifests(repo, root))
    .map((manifest) => manifest.dir)
    .filter((dir) => dir !== root && isWithin(root, dir));
}

/** True when `path` belongs to the module at `root` and not to a module nested inside it. */
export function ownedBy(root: string, nested: readonly string[], path: string): boolean {
  return (
    isWithin(root, path) && !nested.some((dir) => isWithin(dir, path)) && !FIXTURE_PATH.test(path)
  );
}

/** A workspace root and the package patterns it declares. */
export interface WorkspaceRoot {
  readonly dir: string;
  readonly patterns: readonly string[];
  readonly evidence: ReturnType<typeof fileEvidence>;
}

async function workspaceRootAt(
  repo: RepositoryView,
  manifest: PackageManifest,
): Promise<WorkspaceRoot | undefined> {
  const pnpmPath = joinRepoPath(manifest.dir, "pnpm-workspace.yaml");
  const pnpm = await readTextIfPresent(repo, pnpmPath);
  if (pnpm !== undefined) {
    const patterns = pnpmWorkspacePackages(pnpm);
    const line = pnpm.split(/\r?\n/).findIndex((text) => /^packages\s*:/.test(text));
    return {
      dir: manifest.dir,
      patterns,
      evidence: fileEvidence(
        pnpmPath,
        "pnpm workspace",
        line === -1 ? undefined : { line: line + 1, excerpt: "packages:" },
      ),
    };
  }
  const patterns = manifestWorkspaces(manifest);
  if (patterns.length === 0) return undefined;
  const line = keyLine(manifest.text, "workspaces");
  return {
    dir: manifest.dir,
    patterns,
    evidence: fileEvidence(
      manifest.path,
      "workspaces in package.json",
      line === undefined ? undefined : { line, excerpt: '"workspaces"' },
    ),
  };
}

/** True when the workspace's package patterns include the package directory `dir`. */
export function workspaceIncludes(workspace: WorkspaceRoot, dir: string): boolean {
  if (dir === workspace.dir || !isWithin(workspace.dir, dir)) return false;
  const relative = workspace.dir === "." ? dir : dir.slice(workspace.dir.length + 1);
  const positive = workspace.patterns.filter((p) => !p.startsWith("!")).map(cleanPattern);
  const negative = workspace.patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
  const options = { caseInsensitive: false };
  const included = createPathMatcher(positive, options).match(relative) !== undefined;
  return (
    included && createPathMatcher(negative.map(cleanPattern), options).match(relative) === undefined
  );
}

function cleanPattern(pattern: string): string {
  return pattern.replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The nearest workspace root above `dir` whose patterns include it. */
export async function workspaceOf(
  repo: RepositoryView,
  dir: string,
): Promise<WorkspaceRoot | undefined> {
  for (const candidate of ancestors(dir).slice(1)) {
    const manifest = await readManifest(repo, joinRepoPath(candidate, "package.json"));
    if (manifest === undefined) continue;
    const workspace = await workspaceRootAt(repo, manifest);
    if (workspace !== undefined && workspaceIncludes(workspace, dir)) return workspace;
  }
  return undefined;
}

/**
 * Finds JavaScript and TypeScript projects: one module per `package.json` that describes a
 * project. A workspace root and each of its packages are separate modules; files of a nested
 * package belong to that package, not to the root.
 */
export async function detectJavaScriptModules(repo: RepositoryView): Promise<ModuleCandidate[]> {
  const manifests = await projectManifests(repo);
  const candidates: ModuleCandidate[] = [];
  for (const manifest of manifests) {
    const workspace = await workspaceRootAt(repo, manifest);
    const members =
      workspace === undefined
        ? 0
        : manifests.filter((other) => workspaceIncludes(workspace, other.dir)).length;
    const parent = workspace === undefined ? await workspaceOf(repo, manifest.dir) : undefined;
    const name = typeof manifest.json?.name === "string" ? manifest.json.name : undefined;
    const description =
      manifest.json === undefined
        ? "package.json (not valid JSON)"
        : workspace !== undefined
          ? `workspace root with ${String(members)} package(s)`
          : parent !== undefined
            ? `package ${name ?? manifest.dir} of the workspace at ${parent.dir}`
            : `package ${name ?? manifest.dir}`;
    candidates.push({
      adapterId: ADAPTER_ID,
      root: manifest.dir,
      confidence: manifest.json === undefined ? 0.5 : 0.95,
      evidence: [
        fileEvidence(manifest.path, description),
        ...(workspace === undefined ? [] : [workspace.evidence]),
      ],
    });
  }
  return candidates.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

// ---- Package manager ------------------------------------------------------------------------

const LOCKFILES: readonly (readonly [string, string])[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
];

const PACKAGE_MANAGER_FIELD = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+[\w.+-]*?)(?:\+.*)?$/;

/**
 * The package manager of the module at `root`: the `packageManager` field of the nearest
 * manifest that has one, otherwise the nearest lockfile, otherwise a pnpm workspace file.
 * Undefined when nothing says.
 */
export async function packageManagerOf(
  repo: RepositoryView,
  root: string,
): Promise<Detection | undefined> {
  for (const dir of ancestors(root)) {
    const manifest = await readManifest(repo, joinRepoPath(dir, "package.json"));
    const field = manifest?.json?.packageManager;
    if (manifest !== undefined && typeof field === "string") {
      const match = PACKAGE_MANAGER_FIELD.exec(field.trim());
      if (match !== null) {
        const line = keyLine(manifest.text, "packageManager");
        return {
          id: match[1] ?? "npm",
          confidence: 0.95,
          evidence: [
            fileEvidence(
              manifest.path,
              "packageManager field",
              line === undefined ? undefined : { line, excerpt: `"packageManager": "${field}"` },
            ),
          ],
          ...(match[2] === undefined ? {} : { version: match[2] }),
        };
      }
    }
    for (const [file, id] of LOCKFILES) {
      const path = joinRepoPath(dir, file);
      if (await repo.exists(path)) {
        return { id, confidence: 0.9, evidence: [fileEvidence(path, `${id} lockfile`)] };
      }
    }
    const pnpmWorkspace = joinRepoPath(dir, "pnpm-workspace.yaml");
    if (await repo.exists(pnpmWorkspace)) {
      return {
        id: "pnpm",
        confidence: 0.85,
        evidence: [fileEvidence(pnpmWorkspace, "pnpm workspace file")],
      };
    }
  }
  return undefined;
}
