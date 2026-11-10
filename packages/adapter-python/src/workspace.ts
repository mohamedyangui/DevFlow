import {
  fileEvidence,
  isWithin,
  joinRepoPath,
  readTextIfPresent,
  repoDirname,
  type Detection,
  type Evidence,
  type ModuleCandidate,
  type RepositoryView,
} from "@devflow/core";
import { entry, readIni, readToml, tableLine, tomlString } from "./config-files.js";
import type { ProjectFiles } from "./manifest.js";
import { baseName, isIgnoredPath, sortPaths } from "./paths.js";

export const ADAPTER_ID = "python";

const MANIFEST_GLOBS = [
  "**/pyproject.toml",
  "**/setup.py",
  "**/setup.cfg",
  "**/Pipfile",
  "**/uv.lock",
  "**/poetry.lock",
  "**/requirements*.txt",
  "**/requirements/*.txt",
];
const MAX_MANIFESTS = 2_000;

interface ManifestHit {
  readonly dir: string;
  readonly confidence: number;
  readonly evidence: Evidence;
  /** Only requirements files: auxiliary when inside another module (`docs/requirements.txt`). */
  readonly requirementsOnly: boolean;
}

async function classify(repo: RepositoryView, path: string): Promise<ManifestHit | undefined> {
  const name = baseName(path);
  const parent = repoDirname(path);
  if (name.endsWith(".txt")) {
    const inRequirementsDir = baseName(parent) === "requirements";
    if (!inRequirementsDir && !name.startsWith("requirements")) return undefined;
    return {
      dir: inRequirementsDir ? repoDirname(parent) : parent,
      confidence: 0.8,
      evidence: fileEvidence(path, "pip requirements file"),
      requirementsOnly: true,
    };
  }
  const hit = (confidence: number, description: string, line?: number): ManifestHit => ({
    dir: parent,
    confidence,
    evidence: fileEvidence(path, description, line === undefined ? undefined : { line }),
    requirementsOnly: false,
  });
  switch (name) {
    case "pyproject.toml": {
      const text = await readTextIfPresent(repo, path);
      if (text === undefined) return hit(0.5, "pyproject.toml (unreadable)");
      const tables = readToml(text);
      const project = tableLine(tables, "project");
      if (project !== undefined) return hit(0.95, "pyproject.toml with [project]", project);
      const poetry = tableLine(tables, "tool.poetry");
      if (poetry !== undefined) return hit(0.95, "pyproject.toml with [tool.poetry]", poetry);
      const build = tableLine(tables, "build-system");
      if (build !== undefined) return hit(0.9, "pyproject.toml with [build-system]", build);
      return hit(0.6, "pyproject.toml with tool configuration only");
    }
    case "setup.cfg": {
      const text = await readTextIfPresent(repo, path);
      const tables = text === undefined ? [] : readIni(text);
      const line = tableLine(tables, "metadata") ?? tableLine(tables, "options");
      // A setup.cfg with only tool sections ([flake8], [mypy]) configures tools, nothing more.
      return line === undefined ? undefined : hit(0.9, "setup.cfg with package metadata", line);
    }
    case "setup.py":
      return hit(0.9, "setuptools setup.py (read as text, never run)");
    case "Pipfile":
      return hit(0.9, "Pipenv Pipfile");
    case "uv.lock":
      return hit(0.9, "uv lockfile");
    case "poetry.lock":
      return hit(0.9, "Poetry lockfile");
    default:
      return undefined;
  }
}

/**
 * Finds Python projects: one module per directory holding a `pyproject.toml`, `setup.py`,
 * `setup.cfg` with metadata, `Pipfile`, `uv.lock`, `poetry.lock` or `requirements*.txt`
 * (files in a `requirements/` directory belong to its parent). A directory with only
 * requirements files inside another module (such as `docs/requirements.txt`) is part of that
 * module. Virtual environments, installed packages and fixtures are never modules. When the
 * repository has none of these files, a root with Python sources or tests is one plain module.
 */
export async function detectPythonModules(repo: RepositoryView): Promise<ModuleCandidate[]> {
  const paths = sortPaths(
    (await repo.glob(MANIFEST_GLOBS)).filter((path) => !isIgnoredPath(path)),
  ).slice(0, MAX_MANIFESTS);
  const byDir = new Map<string, ManifestHit[]>();
  for (const path of paths) {
    const hit = await classify(repo, path);
    if (hit === undefined) continue;
    byDir.set(hit.dir, [...(byDir.get(hit.dir) ?? []), hit]);
  }
  const full = [...byDir.entries()]
    .filter(([, hits]) => hits.some((hit) => !hit.requirementsOnly))
    .map(([dir]) => dir);
  const candidates: ModuleCandidate[] = [];
  for (const [dir, hits] of byDir) {
    const auxiliary =
      hits.every((hit) => hit.requirementsOnly) &&
      full.some((other) => other !== dir && isWithin(other, dir));
    if (auxiliary) continue;
    candidates.push({
      adapterId: ADAPTER_ID,
      root: dir,
      confidence: Math.max(...hits.map((hit) => hit.confidence)),
      evidence: hits.map((hit) => hit.evidence),
    });
  }
  if (candidates.length === 0) {
    const plain = await plainModule(repo);
    if (plain !== undefined) candidates.push(plain);
  }
  return candidates.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : 0));
}

async function plainModule(repo: RepositoryView): Promise<ModuleCandidate | undefined> {
  const files = sortPaths(
    (await repo.glob(["*.py", "tests/**/test_*.py", "test/**/test_*.py"])).filter(
      (path) => !isIgnoredPath(path),
    ),
  );
  const first = files[0];
  if (first === undefined) return undefined;
  return {
    adapterId: ADAPTER_ID,
    root: ".",
    confidence: 0.6,
    evidence: [fileEvidence(first, "Python code without project metadata (a plain project)")],
  };
}

/** Roots of the Python modules nested inside `root` (not `root` itself). */
export async function nestedModuleRoots(repo: RepositoryView, root: string): Promise<string[]> {
  return (await detectPythonModules(repo))
    .map((candidate) => candidate.root)
    .filter((dir) => dir !== root && isWithin(root, dir));
}

/** True when `path` belongs to the module at `root` and not to a module nested inside it. */
export function ownedBy(root: string, nested: readonly string[], path: string): boolean {
  return isWithin(root, path) && !nested.some((dir) => isWithin(dir, path)) && !isIgnoredPath(path);
}

// ---- Build tool -----------------------------------------------------------------------------

/** The directory itself and each of its parents up to the repository root, nearest first. */
function ancestors(dir: string): string[] {
  const out = [dir];
  let current = dir;
  while (current !== ".") {
    current = repoDirname(current);
    out.push(current);
  }
  return out;
}

/**
 * The tool that manages the module's environment: uv, Poetry or Pipenv (from their lockfiles,
 * the nearest one first, or their configuration in `pyproject.toml`), otherwise pip when the
 * module declares requirements in a standard file. Undefined for a plain project.
 */
export async function buildToolOf(
  repo: RepositoryView,
  files: ProjectFiles,
): Promise<Detection | undefined> {
  const tables = files.pyproject?.tables ?? [];
  const pyproject = files.pyproject?.path ?? "";
  for (const [index, dir] of ancestors(files.root).entries()) {
    const confidence = index === 0 ? 0.95 : 0.85;
    const uvLock = joinRepoPath(dir, "uv.lock");
    if (await repo.exists(uvLock)) {
      return { id: "uv", confidence, evidence: [fileEvidence(uvLock, "uv lockfile")] };
    }
    const poetryLock = joinRepoPath(dir, "poetry.lock");
    const poetryText = await readTextIfPresent(repo, poetryLock, 64 * 1024);
    if (poetryText !== undefined) {
      const version = /generated by Poetry ([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(poetryText)?.[1];
      return {
        id: "poetry",
        confidence,
        evidence: [fileEvidence(poetryLock, "Poetry lockfile", { line: 1 })],
        ...(version === undefined ? {} : { version }),
      };
    }
    for (const name of ["Pipfile.lock", "Pipfile"]) {
      const path = joinRepoPath(dir, name);
      if (await repo.exists(path)) {
        return { id: "pipenv", confidence, evidence: [fileEvidence(path, `Pipenv ${name}`)] };
      }
    }
    if (index === 0) {
      const poetry = tableLine(tables, "tool.poetry");
      const backend = tomlString(entry(tables, "build-system", "build-backend")?.value ?? "");
      if (poetry !== undefined || backend?.startsWith("poetry") === true) {
        return {
          id: "poetry",
          confidence: 0.9,
          evidence: [
            fileEvidence(
              pyproject,
              "Poetry configuration in pyproject.toml",
              poetry === undefined ? undefined : { line: poetry },
            ),
          ],
        };
      }
      const uv = tableLine(tables, "tool.uv");
      if (uv !== undefined) {
        return {
          id: "uv",
          confidence: 0.9,
          evidence: [fileEvidence(pyproject, "uv configuration in pyproject.toml", { line: uv })],
        };
      }
    }
  }
  const standard = [
    ...(files.pyproject !== undefined && tableLine(tables, "project") !== undefined
      ? [fileEvidence(pyproject, "pyproject.toml [project] (installable with pip)")]
      : []),
    ...(files.setupPy === undefined ? [] : [fileEvidence(files.setupPy.path, "setup.py")]),
    ...(files.setupCfg === undefined ? [] : [fileEvidence(files.setupCfg.path, "setup.cfg")]),
    ...files.requirements.map((file) => fileEvidence(file.path, "pip requirements file")),
  ];
  return standard.length === 0 ? undefined : { id: "pip", confidence: 0.8, evidence: standard };
}
