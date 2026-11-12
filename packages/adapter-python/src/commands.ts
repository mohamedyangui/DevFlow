import {
  joinRepoPath,
  type CommandPurpose,
  type CommandSpec,
  type ModuleProfile,
  type ParamSpec,
  type RepositoryView,
  type ToolchainProbe,
} from "@devflow-ai/core";
import { entry, readIni, readToml } from "./config-files.js";
import { findVirtualEnv } from "./manifest.js";
import { pathFrom } from "./paths.js";
import { primaryTestFramework } from "./tests.js";

/** Result parsers of the Python adapter, named in `CommandSpec.results.parser`. */
export const PYTHON_PARSERS = {
  pytestJunitXml: "pytest-junit-xml",
  unittestText: "unittest-text",
  ruffJson: "ruff-json",
  flake8Text: "flake8-text",
  mypyText: "mypy-text",
} as const;

const MINUTE = 60_000;

export const PYTEST_EXPRESSION: ParamSpec = {
  name: "testExpression",
  description:
    'pytest -k expression: runs tests whose name matches, e.g. "test_ac1" or "test_ac1 or test_ac2"',
  pattern: "^[A-Za-z0-9_][A-Za-z0-9_ ]*$",
  maxLength: 256,
};

export const UNITTEST_PATTERN: ParamSpec = {
  name: "testPattern",
  description:
    'unittest -k pattern: runs test methods and classes whose name contains it (or matches it with *), e.g. "test_ac1"',
  pattern: "^[A-Za-z0-9_*][A-Za-z0-9_*.]*$",
  maxLength: 256,
};

/** The Python interpreter commands run with, and why it was chosen. */
export interface Interpreter {
  /** `./.venv/bin/python`, `./.venv/Scripts/python.exe`, `python3`, `python` or `py`. */
  readonly executable: string;
  /** Arguments before `-m` (`-3` for the Windows `py` launcher). */
  readonly prefix: readonly string[];
  readonly source: "virtual-environment" | "path" | "default";
}

/**
 * The interpreter for the module's commands: the module's virtual environment (`.venv` or
 * `venv`) when its interpreter is a regular file inside the workspace, otherwise the first of
 * `python`, `py -3`, `python3` (Windows) or `python3`, `python` (elsewhere) that the toolchain
 * probe finds on PATH. When none is found, the first name is used; the executor then reports it
 * as not found and the gate as not executed. Nothing is installed or created.
 */
export async function resolveInterpreter(
  profile: ModuleProfile,
  toolchain: ToolchainProbe,
  repo: RepositoryView,
): Promise<Interpreter> {
  const windows = toolchain.platform === "win32";
  const venv = await findVirtualEnv(repo, profile.root);
  const inVenv = windows ? venv?.windowsInterpreter : venv?.posixInterpreter;
  if (inVenv !== undefined) {
    return {
      executable: `./${pathFrom(profile.root, inVenv)}`,
      prefix: [],
      source: "virtual-environment",
    };
  }
  const candidates: readonly (readonly [string, ...string[]])[] = windows
    ? [["python"], ["py", "-3"], ["python3"]]
    : [["python3"], ["python"]];
  for (const [executable, ...prefix] of candidates) {
    if ((await toolchain.probe(executable)).available)
      return { executable, prefix, source: "path" };
  }
  return { executable: windows ? "python" : "python3", prefix: [], source: "default" };
}

/** Whether mypy's configuration names what to check (`files = ...`), so no target is needed. */
async function mypyHasFiles(profile: ModuleProfile, repo: RepositoryView): Promise<boolean> {
  const read = async (name: string) => {
    try {
      return await repo.readText(joinRepoPath(profile.root, name), { maxBytes: 1_048_576 });
    } catch {
      return undefined;
    }
  };
  const pyproject = await read("pyproject.toml");
  if (pyproject !== undefined && entry(readToml(pyproject), "tool.mypy", "files") !== undefined) {
    return true;
  }
  for (const name of ["mypy.ini", ".mypy.ini", "setup.cfg"]) {
    const text = await read(name);
    if (text !== undefined && entry(readIni(text), "mypy", "files") !== undefined) return true;
  }
  return false;
}

/**
 * The command catalog of a Python module. Every command runs the module's interpreter with
 * `-m` and a test runner, linter or type checker (the only modules the command policy allows),
 * never an installer: a tool that is not installed in that interpreter fails, and the gate
 * reports it. Commands need no network.
 *
 * - `test`: pytest, writing a JUnit XML report into `.pytest_cache`, or unittest (verbose
 *   output) when only unittest is detected; `test-filter` adds `-k`.
 * - `lint`: Ruff (`check --no-fix`, JSON on stdout), or flake8 when Ruff is not configured.
 * - `typecheck`: mypy. Pyright is detected but gets no command: its PyPI wrapper downloads
 *   Node.js packages on first use.
 */
export async function pythonCommandCatalog(
  profile: ModuleProfile,
  toolchain: ToolchainProbe,
  repo: RepositoryView,
): Promise<CommandSpec[]> {
  const cwd = profile.root;
  const python = await resolveInterpreter(profile, toolchain, repo);
  const command = (
    suffix: string,
    purpose: CommandPurpose,
    args: readonly string[],
    parser: string,
    reportGlobs: readonly string[],
    timeoutMs: number,
    parameters: readonly ParamSpec[] = [],
  ): CommandSpec => ({
    id: `${profile.moduleId}:${suffix}`,
    purpose,
    executable: python.executable,
    args: [...python.prefix, ...args],
    cwd,
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1" },
    timeoutMs,
    network: "none",
    parameters: [...parameters],
    results: { parser, reportGlobs: [...reportGlobs] },
    origin: "adapter",
  });
  const hasTool = (id: string) => profile.qualityTools.some((d) => d.id === id);
  const catalog: CommandSpec[] = [];

  const framework = primaryTestFramework(profile);
  if (framework === "pytest") {
    const report = joinRepoPath(cwd, ".pytest_cache", `devflow-${profile.moduleId}-junit.xml`);
    const args = ["-m", "pytest", "-q", `--junitxml=${pathFrom(cwd, report)}`];
    catalog.push(
      command("test", "test", args, PYTHON_PARSERS.pytestJunitXml, [report], 30 * MINUTE),
      command(
        "test-filter",
        "test",
        [...args, "-k", "{testExpression}"],
        PYTHON_PARSERS.pytestJunitXml,
        [report],
        30 * MINUTE,
        [PYTEST_EXPRESSION],
      ),
    );
  } else if (framework === "unittest") {
    const testDir = profile.testRoots.find((root) => root !== cwd);
    const start: string[] = [];
    if (testDir !== undefined) {
      start.push("-s", pathFrom(cwd, testDir));
      // A tests package is imported from the project root, so its modules can import the code.
      if (await repo.exists(joinRepoPath(testDir, "__init__.py"))) start.push("-t", ".");
    }
    const args = ["-m", "unittest", "discover", "-v", ...start];
    catalog.push(
      command("test", "test", args, PYTHON_PARSERS.unittestText, [], 30 * MINUTE),
      command(
        "test-filter",
        "test",
        [...args, "-k", "{testPattern}"],
        PYTHON_PARSERS.unittestText,
        [],
        30 * MINUTE,
        [UNITTEST_PATTERN],
      ),
    );
  }

  if (hasTool("ruff")) {
    catalog.push(
      command(
        "lint",
        "lint",
        ["-m", "ruff", "check", "--no-fix", "--output-format", "json", "."],
        PYTHON_PARSERS.ruffJson,
        [],
        15 * MINUTE,
      ),
    );
  } else if (hasTool("flake8")) {
    catalog.push(
      command(
        "lint",
        "lint",
        [
          "-m",
          "flake8",
          "--format=default",
          "--extend-exclude",
          ".venv,venv,.tox,.nox,node_modules",
          ".",
        ],
        PYTHON_PARSERS.flake8Text,
        [],
        15 * MINUTE,
      ),
    );
  }

  if (hasTool("mypy")) {
    const targets = (await mypyHasFiles(profile, repo))
      ? []
      : profile.sourceRoots.length === 0
        ? ["."]
        : profile.sourceRoots.map((root) => pathFrom(cwd, root));
    catalog.push(
      command(
        "typecheck",
        "typecheck",
        [
          "-m",
          "mypy",
          "--no-color-output",
          "--show-column-numbers",
          "--show-error-codes",
          "--no-pretty",
          ...targets,
        ],
        PYTHON_PARSERS.mypyText,
        [],
        15 * MINUTE,
      ),
    );
  }
  return catalog;
}
