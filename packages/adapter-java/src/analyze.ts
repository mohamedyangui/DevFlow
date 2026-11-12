import {
  detection,
  fileEvidence,
  isWithin,
  joinRepoPath,
  moduleIdFor,
  type ContractRelation,
  type Detection,
  type Evidence,
  type ModuleCandidate,
  type ModuleProfile,
  type RepositoryView,
} from "@devflow-ai/core";
import { ADAPTER_ID, loadBuildModel } from "./build.js";
import { matches, type BuildModel, type Declaration } from "./model.js";
import { baseName, unique } from "./paths.js";

type Kind = Declaration["kind"];

/** One way a build shows that it uses something. */
interface Signal {
  readonly kinds: readonly Kind[];
  readonly group: string | RegExp;
  readonly artifact?: string | RegExp;
  readonly confidence: number;
  readonly label: string;
  /** Take the detection version from this declaration. */
  readonly version?: boolean;
}

interface Rule {
  readonly id: string;
  readonly signals: readonly Signal[];
}

const LIBRARY: readonly Kind[] = ["dependency", "catalog-library"];
const MAVEN_PLUGIN: readonly Kind[] = ["plugin"];
const GRADLE_PLUGIN: readonly Kind[] = ["plugin"];
/** A version catalog entry declares a library; only a build file that references it uses it. */
const CATALOG_CONFIDENCE = 0.7;
const STARTER_TEST = "spring-boot-starter-test";

const lib = (
  group: string | RegExp,
  artifact: string | RegExp | undefined,
  confidence: number,
  label: string,
  version = true,
): Signal => ({
  kinds: LIBRARY,
  group,
  ...(artifact === undefined ? {} : { artifact }),
  confidence,
  label,
  version,
});
const mavenPlugin = (group: string, artifact: string, label: string): Signal => ({
  kinds: MAVEN_PLUGIN,
  group,
  artifact,
  confidence: 0.95,
  label,
  version: true,
});
const gradlePlugin = (id: string | RegExp, label: string): Signal => ({
  kinds: GRADLE_PLUGIN,
  group: id,
  artifact: "",
  confidence: 0.95,
  label,
  version: true,
});

export const FRAMEWORK_RULES: readonly Rule[] = [
  {
    id: "spring-boot",
    signals: [
      {
        kinds: ["parent"],
        group: "org.springframework.boot",
        artifact: "spring-boot-starter-parent",
        confidence: 0.95,
        label: "Spring Boot parent POM",
        version: true,
      },
      {
        kinds: ["bom"],
        group: "org.springframework.boot",
        artifact: "spring-boot-dependencies",
        confidence: 0.9,
        label: "Spring Boot BOM import",
        version: true,
      },
      mavenPlugin(
        "org.springframework.boot",
        "spring-boot-maven-plugin",
        "Spring Boot Maven plugin",
      ),
      gradlePlugin("org.springframework.boot", "Spring Boot Gradle plugin"),
      lib("org.springframework.boot", /^spring-boot-starter/, 0.9, "Spring Boot starter", false),
      lib(
        "org.springframework.boot",
        "spring-boot-gradle-plugin",
        0.85,
        "Spring Boot Gradle plugin on the build classpath",
      ),
    ],
  },
];

export const TEST_FRAMEWORK_RULES: readonly Rule[] = [
  {
    id: "junit5",
    signals: [
      lib("org.junit.jupiter", undefined, 0.95, "JUnit Jupiter dependency"),
      {
        kinds: ["bom"],
        group: "org.junit",
        artifact: "junit-bom",
        confidence: 0.85,
        label: "JUnit BOM",
        version: true,
      },
      lib("org.junit", "junit-bom", 0.85, "JUnit BOM"),
      lib("org.junit.platform", undefined, 0.85, "JUnit Platform dependency", false),
      lib(
        "org.springframework.boot",
        STARTER_TEST,
        0.8,
        "spring-boot-starter-test (includes JUnit Jupiter)",
        false,
      ),
    ],
  },
  {
    id: "junit4",
    signals: [
      lib("junit", "junit", 0.95, "JUnit 4 dependency"),
      lib("org.junit.vintage", undefined, 0.8, "JUnit Vintage engine (runs JUnit 4 tests)", false),
    ],
  },
  { id: "testng", signals: [lib("org.testng", "testng", 0.95, "TestNG dependency")] },
  {
    id: "mockito",
    signals: [
      lib("org.mockito", undefined, 0.95, "Mockito dependency"),
      lib(
        "org.springframework.boot",
        STARTER_TEST,
        0.7,
        "spring-boot-starter-test (includes Mockito)",
        false,
      ),
    ],
  },
  {
    id: "assertj",
    signals: [
      lib("org.assertj", undefined, 0.95, "AssertJ dependency"),
      lib(
        "org.springframework.boot",
        STARTER_TEST,
        0.7,
        "spring-boot-starter-test (includes AssertJ)",
        false,
      ),
    ],
  },
  {
    id: "testcontainers",
    signals: [lib("org.testcontainers", undefined, 0.95, "Testcontainers dependency")],
  },
];

export const QUALITY_RULES: readonly Rule[] = [
  {
    id: "checkstyle",
    signals: [
      mavenPlugin("org.apache.maven.plugins", "maven-checkstyle-plugin", "Checkstyle Maven plugin"),
      gradlePlugin("checkstyle", "Gradle checkstyle plugin"),
    ],
  },
  {
    id: "spotbugs",
    signals: [
      mavenPlugin("com.github.spotbugs", "spotbugs-maven-plugin", "SpotBugs Maven plugin"),
      gradlePlugin("com.github.spotbugs", "SpotBugs Gradle plugin"),
    ],
  },
  {
    id: "pmd",
    signals: [
      mavenPlugin("org.apache.maven.plugins", "maven-pmd-plugin", "PMD Maven plugin"),
      gradlePlugin("pmd", "Gradle pmd plugin"),
    ],
  },
  {
    id: "jacoco",
    signals: [
      mavenPlugin("org.jacoco", "jacoco-maven-plugin", "JaCoCo Maven plugin"),
      gradlePlugin("jacoco", "Gradle jacoco plugin"),
    ],
  },
  {
    id: "spotless",
    signals: [
      mavenPlugin("com.diffplug.spotless", "spotless-maven-plugin", "Spotless Maven plugin"),
      gradlePlugin("com.diffplug.spotless", "Spotless Gradle plugin"),
    ],
  },
];

const KOTLIN_RULE: Rule = {
  id: "kotlin",
  signals: [
    mavenPlugin("org.jetbrains.kotlin", "kotlin-maven-plugin", "Kotlin Maven plugin"),
    gradlePlugin(/^org\.jetbrains\.kotlin\./, "Kotlin Gradle plugin"),
  ],
};

const MAX_EVIDENCE = 3;

function evidenceKey(evidence: Evidence): string {
  return `${evidence.path ?? ""}:${String(evidence.line ?? 0)}`;
}

/** Applies a rule to a build; null when no signal matches. */
export function applyRule(
  model: BuildModel,
  rule: Rule,
  extra: readonly Evidence[] = [],
): Detection | null {
  let confidence = 0;
  let version: string | undefined;
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const signal of rule.signals) {
    for (const declaration of model.declarations) {
      if (!signal.kinds.includes(declaration.kind)) continue;
      if (!matches(declaration, signal.group, signal.artifact)) continue;
      confidence = Math.max(
        confidence,
        declaration.kind.startsWith("catalog-")
          ? Math.min(signal.confidence, CATALOG_CONFIDENCE)
          : signal.confidence,
      );
      if (signal.version === true && version === undefined && declaration.version !== undefined) {
        version = declaration.version;
      }
      const item = { ...declaration.evidence, description: signal.label };
      if (!seen.has(evidenceKey(item)) && evidence.length < MAX_EVIDENCE) {
        seen.add(evidenceKey(item));
        evidence.push(item);
      }
    }
  }
  for (const item of extra) {
    confidence = Math.max(confidence, 0.85);
    if (!seen.has(evidenceKey(item)) && evidence.length < MAX_EVIDENCE) {
      seen.add(evidenceKey(item));
      evidence.push(item);
    }
  }
  if (evidence.length === 0) return null;
  return detection(rule.id, confidence, evidence, version);
}

function applyRules(model: BuildModel, rules: readonly Rule[]): Detection[] {
  return rules
    .map((rule) =>
      applyRule(
        model,
        rule,
        rule.id === "junit5" && model.junitPlatform !== undefined ? [model.junitPlatform] : [],
      ),
    )
    .filter((found): found is Detection => found !== null);
}

async function existing(repo: RepositoryView, paths: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const path of unique(paths)) if (await repo.exists(path)) out.push(path);
  return out;
}

/** Gradle source sets other than `main` and `test` that hold tests (`integrationTest`, …). */
async function extraTestSourceSets(repo: RepositoryView, projectDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await repo.list(joinRepoPath(projectDir, "src"));
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.kind === "directory")
    .map((entry) => baseName(entry.path))
    .filter((name) => /test/i.test(name) && name !== "test" && name !== "testFixtures")
    .sort();
}

export async function sourceAndTestRoots(
  repo: RepositoryView,
  model: BuildModel,
): Promise<{ sourceRoots: string[]; testRoots: string[] }> {
  const main: string[] = [];
  const test: string[] = [];
  for (const dir of model.projectDirs) {
    const configured = model.configuredSources.find((entry) => entry.projectDir === dir);
    main.push(
      configured?.main ?? joinRepoPath(dir, "src/main/java"),
      joinRepoPath(dir, "src/main/kotlin"),
    );
    test.push(
      configured?.test ?? joinRepoPath(dir, "src/test/java"),
      joinRepoPath(dir, "src/test/kotlin"),
    );
    if (model.tool === "gradle") {
      for (const set of await extraTestSourceSets(repo, dir)) {
        test.push(joinRepoPath(dir, "src", set, "java"), joinRepoPath(dir, "src", set, "kotlin"));
      }
    }
  }
  const inside = (paths: string[]) => paths.filter((path) => isWithin(model.root, path));
  return {
    sourceRoots: await existing(repo, inside(main)),
    testRoots: await existing(repo, inside(test)),
  };
}

const MAX_CONTRACT_FILES = 200;
const CONTRACT_GLOBS = [
  "**/*.proto",
  "**/openapi.yaml",
  "**/openapi.yml",
  "**/openapi.json",
  "**/swagger.yaml",
  "**/swagger.yml",
  "**/swagger.json",
  "**/*.openapi.yaml",
  "**/*.openapi.yml",
  "**/*.openapi.json",
];

async function contractsOf(repo: RepositoryView, model: BuildModel): Promise<ContractRelation[]> {
  const out: ContractRelation[] = [];
  const kindOf = (path: string): ContractRelation["kind"] =>
    path.endsWith(".proto") ? "protobuf" : "openapi";
  const inModule = (await repo.glob(CONTRACT_GLOBS, { cwd: model.root }))
    .slice()
    .sort()
    .slice(0, MAX_CONTRACT_FILES);
  for (const path of inModule) {
    out.push({
      kind: kindOf(path),
      path,
      role: "defines",
      evidence: [
        fileEvidence(
          path,
          `${kindOf(path) === "protobuf" ? "Protobuf" : "OpenAPI"} file inside the module`,
        ),
      ],
    });
  }
  const protobufPlugin = model.declarations.find(
    (d) =>
      (d.kind === "plugin" && d.artifact === "protobuf-maven-plugin") ||
      (d.kind === "plugin" && d.group === "com.google.protobuf"),
  );
  if (protobufPlugin !== undefined) {
    const generated = new Set<string>();
    for (const dir of model.protoRoots) {
      for (const path of await repo.glob(["**/*.proto"], { cwd: dir })) generated.add(path);
    }
    for (const path of [...generated].sort().slice(0, MAX_CONTRACT_FILES)) {
      out.push({
        kind: "protobuf",
        path,
        role: "generates-code-from",
        evidence: [{ ...protobufPlugin.evidence, description: "Protobuf code generation plugin" }],
      });
    }
  }
  for (const input of model.openApiInputs) {
    if (!(await repo.exists(input.value))) continue;
    out.push({
      kind: "openapi",
      path: input.value,
      role: "generates-code-from",
      evidence: [input.evidence],
    });
  }
  return out;
}

const TOOL_NAMES: Readonly<Record<BuildModel["tool"], string>> = {
  maven: "Maven",
  gradle: "Gradle",
};

export async function analyzeJavaModule(
  candidate: ModuleCandidate,
  repo: RepositoryView,
): Promise<ModuleProfile> {
  const base = {
    moduleId: moduleIdFor(candidate),
    adapterId: ADAPTER_ID,
    root: candidate.root,
  };
  const model = await loadBuildModel(repo, candidate.root);
  if (model === undefined) {
    return {
      ...base,
      languages: [],
      frameworks: [],
      testFrameworks: [],
      qualityTools: [],
      sourceRoots: [],
      testRoots: [],
      contracts: [],
    };
  }
  const { sourceRoots, testRoots } = await sourceAndTestRoots(repo, model);
  const primary = fileEvidence(model.primaryFile, `${TOOL_NAMES[model.tool]} build file`);

  const buildEvidence = [primary];
  if (model.toolVersion !== undefined) buildEvidence.push(model.toolVersion.evidence);
  if (model.wrapper !== undefined) {
    buildEvidence.push(fileEvidence(model.wrapper, `${TOOL_NAMES[model.tool]} wrapper script`));
  }
  const buildTool = {
    ...detection(model.tool, 1, buildEvidence, model.toolVersion?.value),
    ...(model.wrapper === undefined ? {} : { wrapper: model.wrapper }),
  };

  const javaEvidence = [
    primary,
    ...(model.javaVersion === undefined ? [] : [model.javaVersion.evidence]),
  ];
  const javaSources = sourceRoots.filter((root) => root.endsWith("/java") || root === "java");
  for (const root of javaSources.slice(0, 1))
    javaEvidence.push(fileEvidence(root, "Java source directory"));
  const languages: Detection[] = [
    detection("java", javaSources.length > 0 ? 1 : 0.9, javaEvidence, model.javaVersion?.value),
  ];
  const kotlinSources = [...sourceRoots, ...testRoots].filter((root) => root.endsWith("/kotlin"));
  const kotlin = applyRule(
    model,
    KOTLIN_RULE,
    kotlinSources.slice(0, 1).map((root) => fileEvidence(root, "Kotlin source directory")),
  );
  if (kotlin !== null) languages.push(kotlin);

  return {
    ...base,
    languages,
    buildTool,
    frameworks: applyRules(model, FRAMEWORK_RULES),
    testFrameworks: applyRules(model, TEST_FRAMEWORK_RULES),
    qualityTools: applyRules(model, QUALITY_RULES),
    sourceRoots,
    testRoots,
    contracts: await contractsOf(repo, model),
  };
}
