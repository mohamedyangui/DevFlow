import { hardDenyReason, validatedAdapter, type ModuleProfile } from "@devflow/core";
import { MemoryRepository, StaticToolchainProbe } from "@devflow/core/testing";
import { describe, expect, it } from "vitest";
import { acceptanceMarkers, pythonAdapter } from "../src/index.js";
import { monorepoRepo, poetryRepo, unittestRepo, uvRepo } from "./fixtures.js";

const adapter = validatedAdapter(pythonAdapter);

async function profileOf(repo: MemoryRepository, root = "."): Promise<ModuleProfile> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  return adapter.analyzeModule(candidate, repo);
}

describe("test inventory", () => {
  it("lists test_*.py and *_test.py files that define tests, with framework and level", async () => {
    const repo = poetryRepo();
    const inventory = await adapter.discoverTests(await profileOf(repo), repo);
    expect(inventory.files).toEqual([
      {
        path: "books/integration/test_store_integration.py",
        framework: "pytest",
        level: "integration",
      },
      { path: "books/test_models.py", framework: "pytest", level: "unit" },
      { path: "books/test_views.py", framework: "pytest", level: "unit" },
    ]);
    expect(inventory.namingPatterns).toEqual(["**/test_*.py"]);
  });

  it("never lists tests of installed packages or helpers without tests", async () => {
    const repo = uvRepo();
    const inventory = await adapter.discoverTests(await profileOf(repo), repo);
    expect(inventory.files.map((file) => file.path)).toEqual([
      "tests/test_api.py",
      "tests/test_orders.py",
    ]);
  });

  it("marks unittest TestCase files", async () => {
    const repo = unittestRepo();
    const inventory = await adapter.discoverTests(await profileOf(repo), repo);
    expect(inventory.files.map((file) => file.framework)).toEqual(["unittest", "unittest"]);
  });
});

describe("conventions", () => {
  it("infers file names, location, style and acceptance-criterion names", async () => {
    const repo = poetryRepo();
    const conventions = await adapter.inferConventions(await profileOf(repo), repo);
    expect(conventions.map((c) => c.id)).toEqual([
      "py.test-file-name.prefix",
      "py.test-location.colocated",
      "py.test-style.classes",
    ]);
    const uv = uvRepo();
    const uvConventions = await adapter.inferConventions(await profileOf(uv), uv);
    expect(uvConventions.map((c) => c.id)).toEqual([
      "py.test-file-name.prefix",
      "py.test-location.tests-directory",
      "py.test-style.functions",
      "py.ac-name-marker",
    ]);
    expect(uvConventions[3]?.evidence[0]).toMatchObject({ path: "tests/test_api.py", line: 4 });
  });
});

describe("authoring guide and markers", () => {
  it("guides pytest and unittest tests with a test_acN_ name prefix", async () => {
    const pytestGuide = adapter.testAuthoringGuide(await profileOf(uvRepo()));
    expect(pytestGuide).toMatchObject({
      framework: "pytest",
      testRoot: "tests",
      fileNamePattern: "test_{name}.py",
      acMarker: { style: "method-name-prefix" },
    });
    expect(pytestGuide.acMarker.example).toContain("def test_ac1_");
    const unittestGuide = adapter.testAuthoringGuide(await profileOf(unittestRepo()));
    expect(unittestGuide.framework).toBe("unittest");
    expect(unittestGuide.acMarker.example).toContain("(self)");
  });

  it("reads acceptance criteria from test names and parameter ids", () => {
    expect(acceptanceMarkers("test_ac1_returns_page")).toEqual(["AC-1"]);
    expect(acceptanceMarkers("test_ac2_ac10_pages")).toEqual(["AC-2", "AC-10"]);
    expect(acceptanceMarkers("testAc3_x")).toEqual(["AC-3"]);
    expect(acceptanceMarkers("test_page[AC-4]")).toEqual(["AC-4"]);
    expect(acceptanceMarkers("test_back1_x", "test_ac0_x")).toEqual([]);
  });
});

describe("command catalog", () => {
  it("runs pytest, Ruff and mypy with the virtual environment's interpreter", async () => {
    const repo = uvRepo();
    const profile = await profileOf(repo);
    const windows = await adapter.commandCatalog(
      profile,
      new StaticToolchainProbe([], "win32"),
      repo,
    );
    expect(windows.map((c) => [c.id, c.executable, c.args.join(" ")])).toEqual([
      [
        "python:test",
        "./.venv/Scripts/python.exe",
        "-m pytest -q --junitxml=.pytest_cache/devflow-python-junit.xml",
      ],
      [
        "python:test-filter",
        "./.venv/Scripts/python.exe",
        "-m pytest -q --junitxml=.pytest_cache/devflow-python-junit.xml -k {testExpression}",
      ],
      [
        "python:lint",
        "./.venv/Scripts/python.exe",
        "-m ruff check --no-fix --output-format json .",
      ],
      [
        "python:typecheck",
        "./.venv/Scripts/python.exe",
        "-m mypy --no-color-output --show-column-numbers --show-error-codes --no-pretty",
      ],
    ]);
    expect(windows[0]).toMatchObject({
      network: "none",
      results: {
        parser: "pytest-junit-xml",
        reportGlobs: [".pytest_cache/devflow-python-junit.xml"],
      },
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    });
    const linux = await adapter.commandCatalog(
      profile,
      new StaticToolchainProbe([], "linux"),
      repo,
    );
    expect(linux[0]?.executable).toBe("./.venv/bin/python");
    for (const command of [...windows, ...linux]) {
      expect(hardDenyReason(command.executable, command.args)).toBeUndefined();
    }
  });

  it("falls back to the interpreter on PATH, then to a default name", async () => {
    const repo = poetryRepo();
    const profile = await profileOf(repo);
    const catalog = (tools: string[], platform: NodeJS.Platform) =>
      adapter.commandCatalog(profile, new StaticToolchainProbe(tools, platform), repo);
    const py = await catalog(["py", "python3"], "win32");
    expect(py[0]).toMatchObject({
      executable: "py",
      args: ["-3", "-m", "pytest", "-q", expect.any(String)],
    });
    expect((await catalog(["python", "python3"], "linux"))[0]?.executable).toBe("python3");
    expect((await catalog([], "linux"))[0]?.executable).toBe("python3");
    expect((await catalog([], "win32"))[0]?.executable).toBe("python");
    const lint = py.find((c) => c.purpose === "lint");
    expect(lint?.args).toEqual([
      "-3",
      "-m",
      "flake8",
      "--format=default",
      "--extend-exclude",
      ".venv,venv,.tox,.nox,node_modules",
      ".",
    ]);
    expect(py.some((c) => c.purpose === "typecheck")).toBe(false);
  });

  it("runs unittest discovery from the tests package and mypy from its configured files", async () => {
    const repo = unittestRepo();
    const catalog = await adapter.commandCatalog(
      await profileOf(repo),
      new StaticToolchainProbe(["python3"], "linux"),
      repo,
    );
    expect(catalog.map((c) => [c.id, c.args.join(" "), c.results.parser])).toEqual([
      ["python:test", "-m unittest discover -v -s tests -t .", "unittest-text"],
      [
        "python:test-filter",
        "-m unittest discover -v -s tests -t . -k {testPattern}",
        "unittest-text",
      ],
      [
        "python:typecheck",
        "-m mypy --no-color-output --show-column-numbers --show-error-codes --no-pretty",
        "mypy-text",
      ],
    ]);
  });

  it("gives mypy the source roots when its configuration names no files, and runs in nested modules", async () => {
    const repo = monorepoRepo();
    const catalog = await adapter.commandCatalog(
      await profileOf(repo, "services/worker"),
      new StaticToolchainProbe(["python3"], "linux"),
      repo,
    );
    expect(catalog.map((c) => [c.id, c.cwd, c.args.at(-1)])).toEqual([
      [
        "services-worker:test",
        "services/worker",
        "--junitxml=.pytest_cache/devflow-services-worker-junit.xml",
      ],
      ["services-worker:test-filter", "services/worker", "{testExpression}"],
      ["services-worker:typecheck", "services/worker", "."],
    ]);
  });

  it("offers no test command when no test framework is detected", async () => {
    const repo = new MemoryRepository({ "pyproject.toml": "[project]\nname = 'x'\n", "x.py": "" });
    const catalog = await adapter.commandCatalog(
      await profileOf(repo),
      new StaticToolchainProbe(["python3"], "linux"),
      repo,
    );
    expect(catalog).toEqual([]);
  });
});
