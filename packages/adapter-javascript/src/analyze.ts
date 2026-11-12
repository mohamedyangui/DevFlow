import {
  detection,
  fileEvidence,
  joinRepoPath,
  moduleIdFor,
  type ContractRelation,
  type Detection,
  type Evidence,
  type ModuleCandidate,
  type ModuleProfile,
  type RepositoryView,
} from "@devflow-ai/core";
import {
  dependencies,
  installedPackage,
  manifestEvidence,
  readManifest,
  scripts,
  type DeclaredDependency,
  type PackageManifest,
} from "./manifest.js";
import { resolveRepoPath, sortPaths, unique } from "./paths.js";
import { scanTestPaths } from "./tests.js";
import { ADAPTER_ID, nestedModuleRoots, ownedBy, packageManagerOf } from "./workspace.js";

/**
 * How a module shows that it uses a tool or framework: a dependency it declares, a
 * configuration file in its directory, or a configuration key in its `package.json`.
 */
export interface Rule {
  readonly id: string;
  /** Packages that indicate the tool; the first one's installed version is reported. */
  readonly packages: readonly string[];
  readonly configFiles?: readonly string[];
  readonly manifestKey?: string;
  readonly label: string;
}

const SCRIPT_EXTENSIONS = ["js", "mjs", "cjs", "ts", "mts", "cts"];
const configs = (base: string, extensions = SCRIPT_EXTENSIONS): string[] =>
  extensions.map((ext) => `${base}.${ext}`);

export const FRAMEWORK_RULES: readonly Rule[] = [
  { id: "express", packages: ["express"], label: "Express" },
  { id: "fastify", packages: ["fastify"], label: "Fastify" },
  { id: "nestjs", packages: ["@nestjs/core"], configFiles: ["nest-cli.json"], label: "NestJS" },
  { id: "nextjs", packages: ["next"], configFiles: configs("next.config"), label: "Next.js" },
  { id: "react", packages: ["react"], label: "React" },
  { id: "vue", packages: ["vue"], label: "Vue" },
  { id: "angular", packages: ["@angular/core"], configFiles: ["angular.json"], label: "Angular" },
  { id: "vite", packages: ["vite"], configFiles: configs("vite.config"), label: "Vite" },
];

export const TEST_FRAMEWORK_RULES: readonly Rule[] = [
  {
    id: "vitest",
    packages: ["vitest"],
    configFiles: [
      ...configs("vitest.config"),
      ...configs("vitest.workspace", ["ts", "js", "mts", "mjs", "json"]),
    ],
    label: "Vitest",
  },
  {
    id: "jest",
    packages: ["jest"],
    configFiles: configs("jest.config", [...SCRIPT_EXTENSIONS, "json"]),
    manifestKey: "jest",
    label: "Jest",
  },
  {
    id: "mocha",
    packages: ["mocha"],
    configFiles: configs(".mocharc", ["js", "cjs", "mjs", "json", "jsonc", "yaml", "yml"]),
    manifestKey: "mocha",
    label: "Mocha",
  },
  {
    id: "playwright",
    packages: ["@playwright/test"],
    configFiles: configs("playwright.config"),
    label: "Playwright Test",
  },
];

export const QUALITY_RULES: readonly Rule[] = [
  {
    id: "eslint",
    packages: ["eslint"],
    configFiles: [
      ...configs("eslint.config"),
      ".eslintrc",
      ...configs(".eslintrc", ["js", "cjs", "json", "yaml", "yml"]),
    ],
    manifestKey: "eslintConfig",
    label: "ESLint",
  },
  {
    id: "prettier",
    packages: ["prettier"],
    configFiles: [
      ".prettierrc",
      ...configs(".prettierrc", ["json", "json5", "yaml", "yml", "toml", "js", "cjs", "mjs"]),
      ...configs("prettier.config", ["js", "cjs", "mjs", "ts"]),
    ],
    manifestKey: "prettier",
    label: "Prettier",
  },
  {
    id: "tsc",
    packages: ["typescript"],
    configFiles: ["tsconfig.json"],
    label: "TypeScript compiler",
  },
];

/** Declared in `dependencies` or `devDependencies`. */
const DECLARED = 0.95;
/** Only a peer or optional dependency: the package supports the tool, it may not use it. */
const PEER = 0.7;
const CONFIGURED = 0.9;

/** What the analysis reads once per module. */
export interface ModuleContext {
  readonly root: string;
  readonly manifest: PackageManifest | undefined;
  readonly declared: readonly DeclaredDependency[];
  /** Roots of modules nested inside this one; their files are not this module's. */
  readonly nested: readonly string[];
}

export async function moduleContext(repo: RepositoryView, root: string): Promise<ModuleContext> {
  const manifest = await readManifest(repo, joinRepoPath(root, "package.json"));
  return {
    root,
    manifest,
    declared: manifest === undefined ? [] : dependencies(manifest),
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
  for (const name of rule.packages) {
    for (const dependency of context.declared.filter((d) => d.name === name)) {
      const peer =
        dependency.field === "peerDependencies" || dependency.field === "optionalDependencies";
      confidence = Math.max(confidence, peer ? PEER : DECLARED);
      evidence.push({
        ...dependency.evidence,
        description: `${rule.label}: ${name}@${dependency.range} in ${dependency.field}`,
      });
    }
  }
  for (const file of rule.configFiles ?? []) {
    const path = joinRepoPath(context.root, file);
    if (await repo.exists(path)) {
      confidence = Math.max(confidence, CONFIGURED);
      evidence.push(fileEvidence(path, `${rule.label} configuration file`));
    }
  }
  if (
    rule.manifestKey !== undefined &&
    context.manifest?.json !== undefined &&
    rule.manifestKey in context.manifest.json
  ) {
    confidence = Math.max(confidence, CONFIGURED);
    evidence.push(
      manifestEvidence(
        context.manifest,
        `${rule.label} configuration in package.json`,
        rule.manifestKey,
      ),
    );
  }
  if (evidence.length === 0) return undefined;
  const first = rule.packages[0];
  const installed =
    first === undefined ? undefined : await installedPackage(repo, context.root, first);
  return detection(rule.id, confidence, evidence, installed?.version);
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

// ---- Languages and roots --------------------------------------------------------------------

const JS_SOURCE = "**/*.{js,jsx,mjs,cjs}";
const TS_SOURCE = "**/*.{ts,tsx,mts,cts}";
/** Configuration scripts (`vite.config.ts`, `.eslintrc.js`) are not the module's source. */
const CONFIG_FILE = /(^|\/)(\.[^/]*|[^/]*\.config\.[cm]?[jt]s|[^/]*rc\.[cm]?js)$/;
const DECLARATION_FILE = /\.d\.[cm]?ts$/;

async function ownedFiles(
  repo: RepositoryView,
  context: ModuleContext,
  pattern: string,
): Promise<string[]> {
  return sortPaths(
    (await repo.glob([pattern], { cwd: context.root })).filter(
      (path) =>
        ownedBy(context.root, context.nested, path) &&
        !CONFIG_FILE.test(path) &&
        !DECLARATION_FILE.test(path),
    ),
  );
}

async function languagesOf(
  repo: RepositoryView,
  context: ModuleContext,
): Promise<{ languages: Detection[]; sources: string[] }> {
  const languages: Detection[] = [];
  const tsFiles = await ownedFiles(repo, context, TS_SOURCE);
  const jsFiles = await ownedFiles(repo, context, JS_SOURCE);
  const tsEvidence: Evidence[] = [];
  const tsconfig = joinRepoPath(context.root, "tsconfig.json");
  if (await repo.exists(tsconfig)) tsEvidence.push(fileEvidence(tsconfig, "tsconfig.json"));
  const typescript = context.declared.find((d) => d.name === "typescript");
  if (typescript !== undefined) {
    tsEvidence.push({
      ...typescript.evidence,
      description: `typescript@${typescript.range} in ${typescript.field}`,
    });
  }
  const firstTs = tsFiles[0];
  if (firstTs !== undefined) {
    tsEvidence.push(fileEvidence(firstTs, `TypeScript source (${String(tsFiles.length)} file(s))`));
  }
  if (tsEvidence.length > 0) {
    const installed = await installedPackage(repo, context.root, "typescript");
    languages.push(
      detection("typescript", tsFiles.length > 0 ? 0.95 : 0.8, tsEvidence, installed?.version),
    );
  }
  const firstJs = jsFiles[0];
  if (firstJs !== undefined) {
    languages.push(
      detection("javascript", 0.95, [
        fileEvidence(firstJs, `JavaScript source (${String(jsFiles.length)} file(s))`),
      ]),
    );
  } else if (languages.length === 0 && context.manifest !== undefined) {
    languages.push(
      detection("javascript", 0.6, [fileEvidence(context.manifest.path, "Node.js package")]),
    );
  }
  return { languages, sources: [...tsFiles, ...jsFiles] };
}

const SOURCE_DIRS = ["src", "lib", "app", "server", "pages"];
const TEST_DIRS = ["test", "tests", "__tests__", "spec", "e2e"];

async function rootsOf(
  repo: RepositoryView,
  context: ModuleContext,
  sources: readonly string[],
  mocha: boolean,
): Promise<{ sourceRoots: string[]; testRoots: string[] }> {
  const existingDirs = async (names: readonly string[]): Promise<string[]> => {
    const out: string[] = [];
    for (const name of names) {
      const dir = joinRepoPath(context.root, name);
      if (ownedBy(context.root, context.nested, dir) && (await repo.exists(dir))) out.push(dir);
    }
    return out;
  };
  let sourceRoots = await existingDirs(SOURCE_DIRS);
  const tests = await scanTestPaths(repo, context.root, context.nested, mocha);
  const testSet = new Set(tests);
  if (sourceRoots.length === 0 && sources.some((path) => !testSet.has(path))) {
    sourceRoots = [context.root];
  }
  const testRoots = await existingDirs(TEST_DIRS);
  for (const test of tests) {
    const colocated = sourceRoots.find(
      (root) => root !== context.root && test.startsWith(`${root}/`),
    );
    if (colocated !== undefined) testRoots.push(colocated);
  }
  if (tests.some((test) => !testRoots.some((root) => test.startsWith(`${root}/`)))) {
    testRoots.push(context.root);
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
const PROTOBUF_GENERATORS = [
  "ts-proto",
  "@bufbuild/protoc-gen-es",
  "@bufbuild/buf",
  "@protobuf-ts/plugin",
  "protobufjs-cli",
  "grpc-tools",
];
const OPENAPI_GENERATORS = [
  "openapi-typescript",
  "@openapitools/openapi-generator-cli",
  "orval",
  "swagger-typescript-api",
  "openapi-typescript-codegen",
  "@hey-api/openapi-ts",
];
const PROTOBUF_COMMAND =
  /\b(protoc|buf\s+generate|ts-proto|protoc-gen-\w+|pbjs|pbts|grpc_tools_node_protoc)\b/;
const OPENAPI_COMMAND =
  /\b(openapi-typescript|openapi-generator(?:-cli)?|orval|swagger-typescript-api|openapi-ts)\b/;
const CONTRACT_TOKEN = /^[^\s'"`$;&|<>]+\.(proto|ya?ml|json)$/;

function relation(
  kind: ContractRelation["kind"],
  path: string,
  role: ContractRelation["role"],
  evidence: Evidence,
): ContractRelation {
  return { kind, path, role, evidence: [evidence] };
}

async function contractsOf(
  repo: RepositoryView,
  context: ModuleContext,
): Promise<ContractRelation[]> {
  const out: ContractRelation[] = [];
  const kindOf = (path: string): ContractRelation["kind"] =>
    path.endsWith(".proto") ? "protobuf" : "openapi";
  const defined = sortPaths(
    (await repo.glob(CONTRACT_GLOBS, { cwd: context.root })).filter((path) =>
      ownedBy(context.root, context.nested, path),
    ),
  ).slice(0, MAX_CONTRACT_FILES);
  for (const path of defined) {
    const label = kindOf(path) === "protobuf" ? "Protobuf" : "OpenAPI";
    out.push(
      relation(
        kindOf(path),
        path,
        "defines",
        fileEvidence(path, `${label} file inside the module`),
      ),
    );
  }

  // Generator commands in package scripts name their inputs.
  const fromScripts = new Set<string>();
  if (context.manifest !== undefined) {
    for (const [name, command] of scripts(context.manifest)) {
      const kind = PROTOBUF_COMMAND.test(command)
        ? "protobuf"
        : OPENAPI_COMMAND.test(command)
          ? "openapi"
          : undefined;
      if (kind === undefined) continue;
      const evidence = manifestEvidence(
        context.manifest,
        `${kind === "protobuf" ? "Protobuf" : "OpenAPI"} code generation in the "${name}" script`,
        name,
        "scripts",
      );
      for (const token of command.split(/[\s=]+/).map((t) => t.replace(/^['"]|['"]$/g, ""))) {
        if (!CONTRACT_TOKEN.test(token)) continue;
        if (kind === "protobuf" && !token.endsWith(".proto")) continue;
        if (kind === "openapi" && token.endsWith(".proto")) continue;
        const path = resolveRepoPath(context.root, token);
        if (path === undefined || !(await repo.exists(path))) continue;
        fromScripts.add(`${kind}:${path}`);
        out.push(relation(kind, path, "generates-code-from", evidence));
      }
    }
  }

  // A generator dependency, or buf.gen.yaml, generates code from the module's own contracts.
  const generator = async (
    packages: readonly string[],
    kind: ContractRelation["kind"],
  ): Promise<Evidence | undefined> => {
    const dependency = context.declared.find((d) => packages.includes(d.name));
    if (dependency !== undefined) {
      return { ...dependency.evidence, description: `${dependency.name}: ${kind} code generator` };
    }
    if (kind === "protobuf") {
      const bufGen = joinRepoPath(context.root, "buf.gen.yaml");
      if (await repo.exists(bufGen)) return fileEvidence(bufGen, "buf code generation template");
    }
    return undefined;
  };
  for (const kind of ["protobuf", "openapi"] as const) {
    const evidence = await generator(
      kind === "protobuf" ? PROTOBUF_GENERATORS : OPENAPI_GENERATORS,
      kind,
    );
    if (evidence === undefined) continue;
    for (const path of defined.filter((p) => kindOf(p) === kind)) {
      if (fromScripts.has(`${kind}:${path}`)) continue;
      out.push(relation(kind, path, "generates-code-from", evidence));
    }
  }
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.kind}:${item.path}:${item.role}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---- Profile --------------------------------------------------------------------------------

export async function analyzeJavaScriptModule(
  candidate: ModuleCandidate,
  repo: RepositoryView,
): Promise<ModuleProfile> {
  const context = await moduleContext(repo, candidate.root);
  const { languages, sources } = await languagesOf(repo, context);
  const testFrameworks = await detectAll(TEST_FRAMEWORK_RULES, context, repo);
  const roots = await rootsOf(
    repo,
    context,
    sources,
    testFrameworks.some((d) => d.id === "mocha"),
  );
  const buildTool = await packageManagerOf(repo, candidate.root);
  return {
    moduleId: moduleIdFor(candidate),
    adapterId: ADAPTER_ID,
    root: candidate.root,
    languages,
    ...(buildTool === undefined ? {} : { buildTool }),
    frameworks: await detectAll(FRAMEWORK_RULES, context, repo),
    testFrameworks,
    qualityTools: await detectAll(QUALITY_RULES, context, repo),
    sourceRoots: roots.sourceRoots,
    testRoots: roots.testRoots,
    contracts: await contractsOf(repo, context),
  };
}
