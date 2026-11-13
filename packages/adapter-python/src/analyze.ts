import {
  detection,
  fileEvidence,
  findLine,
  joinRepoPath,
  moduleIdFor,
  readTextIfPresent,
  type ContractRelation,
  type Detection,
  type Evidence,
  type ModuleCandidate,
  type ModuleProfile,
  type RepositoryView,
} from "@devflowai/core";
import { entry, tableLine } from "./config-files.js";
import {
  declaredDependencies,
  findVirtualEnv,
  installedVersions,
  readProjectFiles,
  type ConfigFile,
  type DeclaredDependency,
  type ProjectFiles,
} from "./manifest.js";
import { sortPaths, unique } from "./paths.js";
import { scanTestPaths } from "./tests.js";
import { ADAPTER_ID, buildToolOf, nestedModuleRoots, ownedBy } from "./workspace.js";

type ConfigSource = "pyproject" | "setupCfg" | "toxIni";

/**
 * How a module shows that it uses a tool or framework: a dependency it declares, a
 * configuration file in its directory, or a table of a shared configuration file
 * (`[tool.ruff]` in `pyproject.toml`, `[flake8]` in `setup.cfg` or `tox.ini`).
 */
export interface Rule {
  readonly id: string;
  readonly label: string;
  /** Distribution names (normalized); the first one's installed version is reported. */
  readonly packages: readonly string[];
  readonly configFiles?: readonly string[];
  readonly tables?: readonly { readonly file: ConfigSource; readonly name: string }[];
}

export const FRAMEWORK_RULES: readonly Rule[] = [
  { id: "django", label: "Django", packages: ["django"], configFiles: ["manage.py"] },
  { id: "flask", label: "Flask", packages: ["flask"] },
  { id: "fastapi", label: "FastAPI", packages: ["fastapi"] },
];

export const TEST_FRAMEWORK_RULES: readonly Rule[] = [
  {
    id: "pytest",
    label: "pytest",
    packages: ["pytest"],
    configFiles: ["pytest.ini", "conftest.py"],
    tables: [
      { file: "pyproject", name: "tool.pytest.ini_options" },
      { file: "pyproject", name: "tool.pytest" },
      { file: "setupCfg", name: "tool:pytest" },
      { file: "toxIni", name: "pytest" },
    ],
  },
];

export const QUALITY_RULES: readonly Rule[] = [
  {
    id: "ruff",
    label: "Ruff",
    packages: ["ruff"],
    configFiles: ["ruff.toml", ".ruff.toml"],
    tables: [{ file: "pyproject", name: "tool.ruff" }],
  },
  {
    id: "flake8",
    label: "flake8",
    packages: ["flake8"],
    configFiles: [".flake8"],
    tables: [
      { file: "setupCfg", name: "flake8" },
      { file: "toxIni", name: "flake8" },
    ],
  },
  {
    id: "mypy",
    label: "mypy",
    packages: ["mypy"],
    configFiles: ["mypy.ini", ".mypy.ini"],
    tables: [
      { file: "pyproject", name: "tool.mypy" },
      { file: "setupCfg", name: "mypy" },
    ],
  },
  {
    id: "pyright",
    label: "Pyright",
    packages: ["pyright", "basedpyright"],
    configFiles: ["pyrightconfig.json"],
    tables: [{ file: "pyproject", name: "tool.pyright" }],
  },
];

const DECLARED = 0.95;
const CONFIGURED = 0.9;
const IMPORTED = 0.8;

/** What the analysis reads once per module. */
export interface ModuleContext {
  readonly root: string;
  readonly files: ProjectFiles;
  readonly declared: readonly DeclaredDependency[];
  readonly installed: ReadonlyMap<string, string>;
  readonly nested: readonly string[];
}

export async function moduleContext(repo: RepositoryView, root: string): Promise<ModuleContext> {
  const files = await readProjectFiles(repo, root);
  return {
    root,
    files,
    declared: declaredDependencies(files),
    installed: await installedVersions(repo, await findVirtualEnv(repo, root)),
    nested: await nestedModuleRoots(repo, root),
  };
}

/** The detection for `rule`, or undefined when the module shows no sign of it. */
export async function applyRule(
  rule: Rule,
  context: ModuleContext,
  repo: RepositoryView,
): Promise<Detection | undefined> {
  const evidence: Evidence[] = [];
  let confidence = 0;
  for (const dependency of context.declared.filter((d) => rule.packages.includes(d.name))) {
    confidence = Math.max(confidence, DECLARED);
    evidence.push({
      ...dependency.evidence,
      description: `${rule.label}: ${dependency.evidence.description}`,
    });
  }
  for (const file of rule.configFiles ?? []) {
    const path = joinRepoPath(context.root, file);
    if (await repo.exists(path)) {
      confidence = Math.max(confidence, CONFIGURED);
      evidence.push(fileEvidence(path, `${rule.label} configuration file`));
    }
  }
  for (const source of rule.tables ?? []) {
    const file: ConfigFile | undefined = context.files[source.file];
    const line = file === undefined ? undefined : tableLine(file.tables, source.name);
    if (file === undefined || line === undefined) continue;
    confidence = Math.max(confidence, CONFIGURED);
    evidence.push(
      fileEvidence(file.path, `${rule.label} configuration [${source.name}]`, { line }),
    );
  }
  if (evidence.length === 0) return undefined;
  const version = rule.packages
    .map((name) => context.installed.get(name))
    .find((found) => found !== undefined);
  return detection(rule.id, confidence, evidence, version);
}

async function detectAll(
  rules: readonly Rule[],
  context: ModuleContext,
  repo: RepositoryView,
): Promise<Detection[]> {
  const out: Detection[] = [];
  for (const rule of rules) {
    const found = await applyRule(rule, context, repo);
    if (found !== undefined) out.push(found);
  }
  return out;
}

const PYTEST_IMPORT = /^\s*(?:import\s+pytest\b|from\s+pytest\b)/;
const UNITTEST_TEST_CASE = /^\s*class\s+\w+\s*\([^)]*\b(?:unittest\.)?TestCase\b/;

/**
 * Test frameworks: pytest from its dependency or configuration; otherwise from test files that
 * import it. unittest (the standard library) from test files that subclass `TestCase`.
 */
async function testFrameworksOf(
  repo: RepositoryView,
  context: ModuleContext,
  tests: readonly string[],
): Promise<Detection[]> {
  const found = await detectAll(TEST_FRAMEWORK_RULES, context, repo);
  let pytestImport: Evidence | undefined;
  let unittestCase: Evidence | undefined;
  for (const path of tests.slice(0, 200)) {
    if (pytestImport !== undefined && unittestCase !== undefined) break;
    const text = await readTextIfPresent(repo, path, 512 * 1024);
    if (text === undefined) continue;
    const pytestHit = findLine(text, PYTEST_IMPORT);
    if (pytestImport === undefined && pytestHit !== undefined) {
      pytestImport = fileEvidence(path, "test file imports pytest", pytestHit);
    }
    const unittestHit = findLine(text, UNITTEST_TEST_CASE);
    if (unittestCase === undefined && unittestHit !== undefined && /\bunittest\b/.test(text)) {
      unittestCase = fileEvidence(path, "unittest.TestCase subclass", unittestHit);
    }
  }
  if (pytestImport !== undefined && !found.some((d) => d.id === "pytest")) {
    found.push(detection("pytest", IMPORTED, [pytestImport], context.installed.get("pytest")));
  }
  if (unittestCase !== undefined) found.push(detection("unittest", IMPORTED, [unittestCase]));
  return found.sort((a, b) => b.confidence - a.confidence);
}

// ---- Language and roots ---------------------------------------------------------------------

async function languageOf(
  repo: RepositoryView,
  context: ModuleContext,
  sources: readonly string[],
): Promise<Detection> {
  const evidence: Evidence[] = [];
  let version: string | undefined;
  const pinned = joinRepoPath(context.root, ".python-version");
  const pinnedText = await readTextIfPresent(repo, pinned, 4096);
  const pinnedVersion = /^\s*([0-9]+\.[0-9]+(?:\.[0-9]+)?)\s*$/m.exec(pinnedText ?? "")?.[1];
  if (pinnedVersion !== undefined) {
    version = pinnedVersion;
    evidence.push(
      fileEvidence(pinned, `.python-version pins Python ${pinnedVersion}`, { line: 1 }),
    );
  }
  const venv = await findVirtualEnv(repo, context.root);
  if (venv?.version !== undefined) {
    version ??= venv.version;
    evidence.push(
      fileEvidence(venv.config, `virtual environment with Python ${venv.version}`, {
        ...(venv.versionLine === undefined ? {} : { line: venv.versionLine }),
      }),
    );
  }
  const pyproject = context.files.pyproject;
  const requires =
    pyproject === undefined ? undefined : entry(pyproject.tables, "project", "requires-python");
  if (pyproject !== undefined && requires !== undefined) {
    evidence.push(
      fileEvidence(pyproject.path, `requires-python = ${requires.value}`, { line: requires.line }),
    );
  }
  const first = sources[0];
  if (first !== undefined) {
    evidence.push(fileEvidence(first, `Python source (${String(sources.length)} file(s))`));
  }
  const manifest =
    pyproject?.path ??
    context.files.setupPy?.path ??
    context.files.setupCfg?.path ??
    context.files.requirements[0]?.path;
  if (evidence.length === 0 && manifest !== undefined) {
    evidence.push(fileEvidence(manifest, "Python project file"));
  }
  return detection("python", first === undefined ? 0.7 : 0.95, evidence, version);
}

const TEST_DIRS = ["tests", "test"];

async function rootsOf(
  repo: RepositoryView,
  context: ModuleContext,
  sources: readonly string[],
  tests: readonly string[],
): Promise<{ sourceRoots: string[]; testRoots: string[] }> {
  const { root, nested } = context;
  const testSet = new Set(tests);
  const code = sources.filter((path) => !testSet.has(path) && !/(^|\/)conftest\.py$/.test(path));
  const isTestDir = (path: string) =>
    TEST_DIRS.some((dir) => path.startsWith(`${joinRepoPath(root, dir)}/`));
  let sourceRoots: string[] = [];
  const src = joinRepoPath(root, "src");
  if (code.some((path) => path.startsWith(`${src}/`))) {
    sourceRoots = [src];
  } else {
    // Flat layout: each top-level package (a directory with __init__.py) is a source root.
    const packages = unique(
      code
        .filter((path) => path.endsWith("/__init__.py"))
        .map((path) => path.slice(0, -"/__init__.py".length))
        .filter((dir) => dir.split("/").length === (root === "." ? 1 : root.split("/").length + 1))
        .filter((dir) => !isTestDir(`${dir}/`)),
    );
    sourceRoots = sortPaths(packages);
    const outside = code.filter(
      (path) => !isTestDir(path) && !sourceRoots.some((dir) => path.startsWith(`${dir}/`)),
    );
    if (outside.length > 0) sourceRoots = [root];
  }
  const testRoots: string[] = [];
  for (const name of TEST_DIRS) {
    const dir = joinRepoPath(root, name);
    if (ownedBy(root, nested, `${dir}/x`) && (await repo.exists(dir))) testRoots.push(dir);
  }
  for (const test of tests) {
    const colocated = sourceRoots.find((dir) => dir !== root && test.startsWith(`${dir}/`));
    if (colocated !== undefined) testRoots.push(colocated);
  }
  if (tests.some((test) => !testRoots.some((dir) => test.startsWith(`${dir}/`)))) {
    testRoots.push(root);
  }
  return { sourceRoots, testRoots: unique(testRoots) };
}

// ---- Contracts ------------------------------------------------------------------------------

const MAX_CONTRACT_FILES = 200;
const CONTRACT_GLOBS = [
  "**/*.proto",
  "**/openapi.{yaml,yml,json}",
  "**/swagger.{yaml,yml,json}",
  "**/*.openapi.{yaml,yml,json}",
];
const GENERATORS: Readonly<Record<ContractRelation["kind"], readonly string[]>> = {
  protobuf: ["grpcio-tools", "betterproto", "protobuf-protoc-bin", "mypy-protobuf"],
  openapi: ["openapi-python-client", "datamodel-code-generator", "openapi-generator-cli"],
};

async function contractsOf(
  repo: RepositoryView,
  context: ModuleContext,
): Promise<ContractRelation[]> {
  const kindOf = (path: string): ContractRelation["kind"] =>
    path.endsWith(".proto") ? "protobuf" : "openapi";
  const defined = sortPaths(
    (await repo.glob(CONTRACT_GLOBS, { cwd: context.root })).filter((path) =>
      ownedBy(context.root, context.nested, path),
    ),
  ).slice(0, MAX_CONTRACT_FILES);
  const out: ContractRelation[] = defined.map((path) => ({
    kind: kindOf(path),
    path,
    role: "defines",
    evidence: [
      fileEvidence(
        path,
        `${kindOf(path) === "protobuf" ? "Protobuf" : "OpenAPI"} file inside the module`,
      ),
    ],
  }));
  for (const kind of ["protobuf", "openapi"] as const) {
    const generator = context.declared.find((d) => GENERATORS[kind].includes(d.name));
    if (generator === undefined) continue;
    for (const path of defined.filter((p) => kindOf(p) === kind)) {
      out.push({
        kind,
        path,
        role: "generates-code-from",
        evidence: [
          { ...generator.evidence, description: `${generator.name}: ${kind} code generator` },
        ],
      });
    }
  }
  return out;
}

// ---- Profile --------------------------------------------------------------------------------

/** The module's own `.py` files (outside nested modules and virtual environments). */
export async function moduleSources(
  repo: RepositoryView,
  root: string,
  nested: readonly string[],
): Promise<string[]> {
  return sortPaths(
    (await repo.glob(["**/*.py"], { cwd: root })).filter((path) => ownedBy(root, nested, path)),
  );
}

export async function analyzePythonModule(
  candidate: ModuleCandidate,
  repo: RepositoryView,
): Promise<ModuleProfile> {
  const context = await moduleContext(repo, candidate.root);
  const sources = await moduleSources(repo, candidate.root, context.nested);
  const tests = await scanTestPaths(repo, candidate.root, context.nested);
  const roots = await rootsOf(repo, context, sources, tests);
  const buildTool = await buildToolOf(repo, context.files);
  return {
    moduleId: moduleIdFor(candidate),
    adapterId: ADAPTER_ID,
    root: candidate.root,
    languages: [await languageOf(repo, context, sources)],
    ...(buildTool === undefined ? {} : { buildTool }),
    frameworks: await detectAll(FRAMEWORK_RULES, context, repo),
    testFrameworks: await testFrameworksOf(repo, context, tests),
    qualityTools: await detectAll(QUALITY_RULES, context, repo),
    sourceRoots: roots.sourceRoots,
    testRoots: roots.testRoots,
    contracts: await contractsOf(repo, context),
  };
}
