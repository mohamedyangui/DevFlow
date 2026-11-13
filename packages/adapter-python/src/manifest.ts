import {
  fileEvidence,
  joinRepoPath,
  readTextIfPresent,
  type Evidence,
  type RepositoryView,
} from "@devflowai/core";
import {
  readIni,
  readToml,
  table,
  tomlStrings,
  type ConfigEntry,
  type ConfigTable,
} from "./config-files.js";
import { sortPaths } from "./paths.js";

/** A configuration file of the module: its path, text and parsed tables. */
export interface ConfigFile {
  readonly path: string;
  readonly text: string;
  readonly tables: readonly ConfigTable[];
}

export interface TextFile {
  readonly path: string;
  readonly text: string;
}

/** The project files of one Python module, read once per analysis. */
export interface ProjectFiles {
  readonly root: string;
  readonly pyproject?: ConfigFile;
  readonly setupCfg?: ConfigFile;
  readonly toxIni?: ConfigFile;
  readonly pipfile?: ConfigFile;
  readonly setupPy?: TextFile;
  readonly requirements: readonly TextFile[];
}

async function configFile(
  repo: RepositoryView,
  path: string,
  format: "toml" | "ini",
): Promise<ConfigFile | undefined> {
  const text = await readTextIfPresent(repo, path);
  if (text === undefined) return undefined;
  return { path, text, tables: format === "toml" ? readToml(text) : readIni(text) };
}

/** `requirements*.txt` in the module root and `*.txt` in its `requirements/` directory. */
export async function requirementFiles(repo: RepositoryView, root: string): Promise<string[]> {
  const found = await repo.glob(["requirements*.txt", "requirements/*.txt"], { cwd: root });
  return sortPaths(found.filter((path) => path.split("/").length - depth(root) <= 2));
}

function depth(root: string): number {
  return root === "." ? 0 : root.split("/").length;
}

export async function readProjectFiles(repo: RepositoryView, root: string): Promise<ProjectFiles> {
  const at = (name: string) => joinRepoPath(root, name);
  const pyproject = await configFile(repo, at("pyproject.toml"), "toml");
  const setupCfg = await configFile(repo, at("setup.cfg"), "ini");
  const toxIni = await configFile(repo, at("tox.ini"), "ini");
  const pipfile = await configFile(repo, at("Pipfile"), "toml");
  const setupPyText = await readTextIfPresent(repo, at("setup.py"));
  const requirements: TextFile[] = [];
  for (const path of await requirementFiles(repo, root)) {
    const text = await readTextIfPresent(repo, path);
    if (text !== undefined) requirements.push({ path, text });
  }
  return {
    root,
    ...(pyproject === undefined ? {} : { pyproject }),
    ...(setupCfg === undefined ? {} : { setupCfg }),
    ...(toxIni === undefined ? {} : { toxIni }),
    ...(pipfile === undefined ? {} : { pipfile }),
    ...(setupPyText === undefined ? {} : { setupPy: { path: at("setup.py"), text: setupPyText } }),
    requirements,
  };
}

// ---- Declared dependencies ------------------------------------------------------------------

export interface DeclaredDependency {
  /** Normalized distribution name (PEP 503): lower case, runs of `-`, `_`, `.` as `-`. */
  readonly name: string;
  /** The requirement as written, e.g. `pytest>=8` or `^0.110` (Poetry). */
  readonly requirement: string;
  /** Where it is declared, e.g. `project.dependencies` or `requirements-dev.txt`. */
  readonly field: string;
  readonly evidence: Evidence;
}

/** PEP 503 normalization. */
export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[-_.]+/g, "-");
}

/** The distribution name of a PEP 508 requirement, or undefined when there is none. */
export function requirementName(requirement: string): string | undefined {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:$|[[<>=!~;@ (,])/.exec(
    requirement,
  );
  return match?.[1] === undefined ? undefined : normalizeName(match[1]);
}

/** The line of `needle` in the entry's value, counted from the entry's own line. */
function lineOf(entry: ConfigEntry, needle: string): number {
  const offset = entry.value.split("\n").findIndex((line) => line.includes(needle));
  return entry.line + Math.max(offset, 0);
}

function declared(
  file: string,
  field: string,
  requirement: string,
  line: number,
  excerpt: string,
): DeclaredDependency | undefined {
  const name = requirementName(requirement);
  if (name === undefined) return undefined;
  return {
    name,
    requirement: requirement.trim(),
    field,
    evidence: fileEvidence(file, `${requirement.trim()} in ${field}`, { line, excerpt }),
  };
}

/** Requirement strings of an array value, leaving out `{ include-group = "..." }` tables. */
function arrayRequirements(entry: ConfigEntry): string[] {
  return tomlStrings(entry.value.replace(/\{[^{}]*\}/g, ""));
}

function fromPyproject(file: ConfigFile): DeclaredDependency[] {
  const out: (DeclaredDependency | undefined)[] = [];
  const add = (field: string, entry: ConfigEntry) => {
    for (const requirement of arrayRequirements(entry)) {
      out.push(
        declared(file.path, field, requirement, lineOf(entry, requirement), `"${requirement}"`),
      );
    }
  };
  for (const candidate of file.tables) {
    if (candidate.name === "project") {
      for (const entry of candidate.entries) {
        if (entry.key === "dependencies") add("project.dependencies", entry);
        if (entry.key.startsWith("optional-dependencies.")) {
          add(`project.${entry.key}`, entry);
        }
      }
    } else if (
      candidate.name === "project.optional-dependencies" ||
      candidate.name === "dependency-groups" ||
      candidate.name === "tool.pdm.dev-dependencies"
    ) {
      for (const entry of candidate.entries) add(`${candidate.name}.${entry.key}`, entry);
    } else if (candidate.name === "tool.uv") {
      for (const entry of candidate.entries) {
        if (entry.key === "dev-dependencies") add("tool.uv.dev-dependencies", entry);
      }
    }
    // Poetry: dependencies are keys of [tool.poetry.dependencies] and its groups.
    const poetry = /^tool\.poetry\.(?:group\.[^.]+\.)?(?:dev-)?dependencies(?:\.(.+))?$/.exec(
      candidate.name,
    );
    if (poetry !== null) {
      const name = poetry[1];
      if (name !== undefined) {
        const field = candidate.name.slice(0, candidate.name.length - name.length - 1);
        out.push(declared(file.path, field, name, candidate.line, `[${candidate.name}]`));
      } else {
        for (const entry of candidate.entries) {
          if (entry.key === "python") continue;
          out.push(
            declared(
              file.path,
              candidate.name,
              entry.key,
              entry.line,
              `${entry.key} = ${entry.value}`,
            ),
          );
        }
      }
    }
  }
  return out.filter((item): item is DeclaredDependency => item !== undefined);
}

function fromSetupCfg(file: ConfigFile): DeclaredDependency[] {
  const out: (DeclaredDependency | undefined)[] = [];
  const add = (field: string, entry: ConfigEntry) => {
    for (const requirement of entry.value.split("\n")) {
      if (requirement.trim() === "") continue;
      out.push(declared(file.path, field, requirement, lineOf(entry, requirement), requirement));
    }
  };
  for (const entry of table(file.tables, "options")?.entries ?? []) {
    if (["install_requires", "tests_require", "setup_requires"].includes(entry.key)) {
      add(`options.${entry.key}`, entry);
    }
  }
  for (const entry of table(file.tables, "options.extras_require")?.entries ?? []) {
    add(`options.extras_require.${entry.key}`, entry);
  }
  return out.filter((item): item is DeclaredDependency => item !== undefined);
}

/** The bracketed text after `keyword=` in `setup.py`, read as text and never evaluated. */
function setupPyArgument(text: string, keyword: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  const pattern = new RegExp(`\\b${keyword}\\s*=\\s*([[{(])`, "g");
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[0].length - 1;
    let level = 0;
    let quote: string | undefined;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (quote !== undefined) {
        if (char === "\\") index += 1;
        else if (char === quote) quote = undefined;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === "[" || char === "{" || char === "(") {
        level += 1;
      } else if (char === "]" || char === "}" || char === ")") {
        level -= 1;
        if (level === 0) {
          out.push({ text: text.slice(start, index + 1), offset: start });
          break;
        }
      }
    }
  }
  return out;
}

function fromSetupPy(file: TextFile): DeclaredDependency[] {
  const out: (DeclaredDependency | undefined)[] = [];
  for (const keyword of ["install_requires", "tests_require", "extras_require", "setup_requires"]) {
    for (const argument of setupPyArgument(file.text, keyword)) {
      // Dictionary keys of extras_require ("dev": [...]) are not requirements.
      const values = argument.text.replace(/(["'])[^"'\n]*\1\s*:/g, "");
      for (const requirement of tomlStrings(values)) {
        const index = file.text.indexOf(requirement, argument.offset);
        const line = file.text.slice(0, Math.max(index, 0)).split("\n").length;
        out.push(declared(file.path, keyword, requirement, line, `"${requirement}"`));
      }
    }
  }
  return out.filter((item): item is DeclaredDependency => item !== undefined);
}

function fromRequirements(file: TextFile): DeclaredDependency[] {
  const out: (DeclaredDependency | undefined)[] = [];
  const field = file.path.slice(file.path.lastIndexOf("/") + 1);
  for (const [index, raw] of file.text.split(/\r?\n/).entries()) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-") || /^[a-z+]+:\/\//i.test(line))
      continue;
    out.push(declared(file.path, field, line, index + 1, line));
  }
  return out.filter((item): item is DeclaredDependency => item !== undefined);
}

function fromPipfile(file: ConfigFile): DeclaredDependency[] {
  const out: (DeclaredDependency | undefined)[] = [];
  for (const name of ["packages", "dev-packages"]) {
    for (const entry of table(file.tables, name)?.entries ?? []) {
      out.push(declared(file.path, name, entry.key, entry.line, `${entry.key} = ${entry.value}`));
    }
  }
  return out.filter((item): item is DeclaredDependency => item !== undefined);
}

/** Every dependency the module declares, in file order. */
export function declaredDependencies(files: ProjectFiles): DeclaredDependency[] {
  return [
    ...(files.pyproject === undefined ? [] : fromPyproject(files.pyproject)),
    ...(files.setupCfg === undefined ? [] : fromSetupCfg(files.setupCfg)),
    ...(files.setupPy === undefined ? [] : fromSetupPy(files.setupPy)),
    ...(files.pipfile === undefined ? [] : fromPipfile(files.pipfile)),
    ...files.requirements.flatMap(fromRequirements),
  ];
}

// ---- Virtual environments -------------------------------------------------------------------

/** A virtual environment in the module root (`.venv` or `venv`, with a `pyvenv.cfg`). */
export interface VirtualEnv {
  readonly dir: string;
  readonly config: string;
  /** `bin/python` (or `bin/python3`), when it is a regular file inside the workspace. */
  readonly posixInterpreter?: string;
  /** `Scripts/python.exe`, when present. */
  readonly windowsInterpreter?: string;
  /** The Python version recorded in `pyvenv.cfg`. */
  readonly version?: string;
  readonly versionLine?: number;
}

export const VIRTUAL_ENV_DIRS = [".venv", "venv"] as const;

/**
 * The first entry of `dir` that is a regular file named one of `names`. The workspace view
 * does not list symbolic links, so an interpreter that links outside the workspace (the
 * default for POSIX virtual environments) is not found and the module falls back to the
 * interpreter on PATH.
 */
async function listedFile(
  repo: RepositoryView,
  dir: string,
  names: readonly string[],
): Promise<string | undefined> {
  let entries;
  try {
    entries = await repo.list(dir);
  } catch {
    return undefined;
  }
  for (const name of names) {
    const path = joinRepoPath(dir, name);
    if (entries.some((entry) => entry.kind === "file" && entry.path === path)) return path;
  }
  return undefined;
}

export async function findVirtualEnv(
  repo: RepositoryView,
  root: string,
): Promise<VirtualEnv | undefined> {
  for (const name of VIRTUAL_ENV_DIRS) {
    const dir = joinRepoPath(root, name);
    const config = joinRepoPath(dir, "pyvenv.cfg");
    const text = await readTextIfPresent(repo, config, 64 * 1024);
    if (text === undefined) continue;
    const posixInterpreter = await listedFile(repo, joinRepoPath(dir, "bin"), [
      "python",
      "python3",
    ]);
    const windowsInterpreter = await listedFile(repo, joinRepoPath(dir, "Scripts"), ["python.exe"]);
    const lines = text.split(/\r?\n/);
    const versionIndex = lines.findIndex((line) =>
      /^\s*(?:version|version_info)\s*=\s*[0-9]+\.[0-9]+/.test(line),
    );
    const version = /=\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)/.exec(lines[versionIndex] ?? "")?.[1];
    return {
      dir,
      config,
      ...(posixInterpreter === undefined ? {} : { posixInterpreter }),
      ...(windowsInterpreter === undefined ? {} : { windowsInterpreter }),
      ...(version === undefined ? {} : { version, versionLine: versionIndex + 1 }),
    };
  }
  return undefined;
}

/**
 * Versions of the distributions installed in the virtual environment, from the names of their
 * `*.dist-info` directories (`Lib/site-packages` on Windows, `lib/python3.x/site-packages`
 * elsewhere). Nothing is imported or run.
 */
export async function installedVersions(
  repo: RepositoryView,
  venv: VirtualEnv | undefined,
): Promise<ReadonlyMap<string, string>> {
  const versions = new Map<string, string>();
  if (venv === undefined) return versions;
  const sites = [joinRepoPath(venv.dir, "Lib/site-packages")];
  try {
    for (const entry of await repo.list(joinRepoPath(venv.dir, "lib"))) {
      if (entry.kind === "directory" && /\/python[0-9.]*$/.test(entry.path)) {
        sites.push(joinRepoPath(entry.path, "site-packages"));
      }
    }
  } catch {
    // No POSIX layout.
  }
  for (const site of sites) {
    let entries;
    try {
      entries = await repo.list(site);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const match = /\/([^/]+)-([0-9][^-/]*)\.dist-info$/.exec(entry.path);
      if (entry.kind === "directory" && match !== null) {
        versions.set(normalizeName(match[1] ?? ""), match[2] ?? "");
      }
    }
  }
  return versions;
}
