import { validatedAdapter } from "@devflow/core";
import { MemoryRepository } from "@devflow/core/testing";
import { describe, expect, it } from "vitest";
import { pythonAdapter, readIni, readToml, requirementName, tomlStrings } from "../src/index.js";
import { monorepoRepo, poetryRepo, unittestRepo, uvRepo } from "./fixtures.js";

const adapter = validatedAdapter(pythonAdapter);

async function profileOf(repo: MemoryRepository, root = ".") {
  const candidates = await adapter.detectModules(repo);
  const candidate = candidates.find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  return adapter.analyzeModule(candidate, repo);
}

const ids = (detections: readonly { id: string }[]) => detections.map((d) => d.id);

describe("configuration readers", () => {
  it("reads TOML tables, dotted keys, multi-line arrays and strings without evaluating anything", () => {
    const tables = readToml(
      [
        'title = "x" # comment',
        "[project]",
        "dependencies = [",
        '  "a>=1", # one',
        "  'b[extra]',",
        "]",
        '[ tool . "ruff" ]',
        "line-length = 100",
        "[[package]]",
        'name = "c"',
        'description = """',
        "multi [ line",
        '"""',
      ].join("\n"),
    );
    expect(tables.map((t) => t.name)).toEqual(["", "project", "tool.ruff", "package"]);
    const deps = tables[1]?.entries[0];
    expect(deps?.key).toBe("dependencies");
    expect(tomlStrings(deps?.value ?? "")).toEqual(["a>=1", "b[extra]"]);
    expect(tables[3]?.entries.map((e) => e.key)).toEqual(["name", "description"]);
  });

  it("reads INI sections with continuation lines", () => {
    const tables = readIni(
      "[options]\ninstall_requires =\n    a>=1\n    b\n; comment\n[flake8]\nmax-line-length: 100\n",
    );
    expect(tables[1]?.entries).toEqual([{ key: "install_requires", value: "a>=1\nb", line: 2 }]);
    expect(tables[2]?.entries[0]).toMatchObject({ key: "max-line-length", value: "100" });
  });

  it("reads PEP 508 requirement names", () => {
    expect(requirementName("Django>=5")).toBe("django");
    expect(requirementName("pydantic[email]~=2.7")).toBe("pydantic");
    expect(requirementName("Flask_Login ; python_version>'3.8'")).toBe("flask-login");
    expect(requirementName("pkg @ https://x/y.whl")).toBe("pkg");
    expect(requirementName("-r base.txt")).toBeUndefined();
  });
});

describe("module detection", () => {
  it("finds one module per project directory, leaving out fixtures, installed packages and auxiliary requirements", async () => {
    const roots = (await adapter.detectModules(monorepoRepo())).map((c) => c.root);
    expect(roots).toEqual(["libs/common", "services/api", "services/worker"]);
    const uv = await adapter.detectModules(uvRepo());
    expect(uv.map((c) => c.root)).toEqual(["."]);
    expect(uv[0]?.confidence).toBe(0.95);
    expect(uv[0]?.evidence.map((e) => e.path).sort()).toEqual(["pyproject.toml", "uv.lock"]);
  });

  it("treats a repository with Python code and no project files as one plain module", async () => {
    const candidates = await adapter.detectModules(unittestRepo());
    expect(candidates).toEqual([
      expect.objectContaining({ root: ".", confidence: 0.6, adapterId: "python" }),
    ]);
    expect(await adapter.detectModules(new MemoryRepository({ "README.md": "# x" }))).toEqual([]);
  });
});

describe("module profile", () => {
  it("profiles a uv project: version, frameworks, tools, src layout, installed versions", async () => {
    const profile = await profileOf(uvRepo());
    expect(profile.moduleId).toBe("python");
    expect(profile.buildTool).toMatchObject({ id: "uv", confidence: 0.95 });
    expect(profile.languages).toEqual([
      expect.objectContaining({ id: "python", version: "3.12", confidence: 0.95 }),
    ]);
    expect(ids(profile.frameworks)).toEqual(["fastapi"]);
    expect(profile.frameworks[0]?.version).toBe("0.115.0");
    expect(ids(profile.testFrameworks)).toEqual(["pytest"]);
    expect(profile.testFrameworks[0]).toMatchObject({ version: "8.3.3", confidence: 0.95 });
    expect(ids(profile.qualityTools)).toEqual(["ruff", "mypy"]);
    expect(profile.sourceRoots).toEqual(["src"]);
    expect(profile.testRoots).toEqual(["tests"]);
    const fastapi = profile.frameworks[0]?.evidence[0];
    expect(fastapi).toMatchObject({ path: "pyproject.toml", line: 6 });
  });

  it("profiles a Poetry project: Django from manage.py and dependencies, flake8 in setup.cfg", async () => {
    const profile = await profileOf(poetryRepo());
    expect(profile.buildTool).toMatchObject({ id: "poetry", version: "1.8.3" });
    expect(ids(profile.frameworks)).toEqual(["django"]);
    expect(ids(profile.testFrameworks)).toEqual(["pytest"]);
    expect(ids(profile.qualityTools)).toEqual(["flake8"]);
    // manage.py is a top-level module, so the whole module root holds code and tests.
    expect(profile.sourceRoots).toEqual(["."]);
    expect(profile.testRoots).toEqual(["."]);
  });

  it("profiles the projects of a monorepo independently", async () => {
    const repo = monorepoRepo();
    const api = await profileOf(repo, "services/api");
    expect(api.moduleId).toBe("services-api");
    expect(api.buildTool?.id).toBe("pip");
    expect(ids(api.frameworks)).toEqual(["flask"]);
    expect(ids(api.testFrameworks)).toEqual(["pytest"]);
    expect(ids(api.qualityTools)).toEqual(["ruff"]);
    expect(api.sourceRoots).toEqual(["services/api/api"]);
    const worker = await profileOf(repo, "services/worker");
    expect(ids(worker.testFrameworks)).toEqual(["pytest"]);
    expect(ids(worker.qualityTools)).toEqual(["mypy"]);
    expect(worker.sourceRoots).toEqual(["services/worker"]);
  });

  it("detects unittest from TestCase subclasses in a plain project", async () => {
    const profile = await profileOf(unittestRepo());
    expect(profile.buildTool).toBeUndefined();
    expect(ids(profile.testFrameworks)).toEqual(["unittest"]);
    expect(ids(profile.qualityTools)).toEqual(["mypy"]);
    expect(profile.sourceRoots).toEqual(["inventory"]);
    expect(profile.testRoots).toEqual(["tests"]);
  });
});
