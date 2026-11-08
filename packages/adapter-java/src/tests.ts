import {
  fileEvidence,
  findLine,
  joinRepoPath,
  readTextIfPresent,
  type Evidence,
  type InferredConvention,
  type ModuleProfile,
  type RepositoryView,
  type TestAuthoringGuide,
  type TestInventory,
  type TestLevel,
} from "@devflow/core";
import { baseName } from "./paths.js";

/** Surefire's default includes (unit tests, `mvn test`). */
const SUREFIRE = [/^Test\w*$/, /^\w*Test$/, /^\w*Tests$/, /^\w*TestCase$/];
/** Failsafe's default includes (integration tests, `mvn verify`). */
const FAILSAFE = [/^IT\w*$/, /^\w*IT$/, /^\w*ITCase$/];
export const MAVEN_TEST_PATTERNS = [
  "**/Test*.java",
  "**/*Test.java",
  "**/*Tests.java",
  "**/*TestCase.java",
  "**/IT*.java",
  "**/*IT.java",
  "**/*ITCase.java",
];

const TEST_MARKER =
  /@(?:org\.junit\.(?:jupiter\.api\.)?)?(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b|\bextends\s+TestCase\b/;
const INTEGRATION_MARKER = /@(?:SpringBootTest|Testcontainers|QuarkusTest|MicronautTest)\b/;

/** Gradle source sets that hold integration tests: `integrationTest`, `intTest`, `it`, … */
const INTEGRATION_SOURCE_SET =
  /^(?:it|int|integration|functional|e2e|acceptance)(?:test)?s?$|integration|functional|e2e|acceptance/i;

/** The source set of a test root such as `app/src/integrationTest/java`. */
function sourceSetOf(root: string): string {
  return /(?:^|\/)src\/([^/]+)\/[^/]+$/.exec(root)?.[1] ?? "";
}

const MAX_TEST_FILES = 2_000;
const MAX_TEST_FILE_BYTES = 512 * 1024;

export interface ScannedTest {
  readonly path: string;
  /** Class name: the file name without extension. */
  readonly name: string;
  readonly framework: string;
  readonly level: TestLevel;
  readonly text: string | undefined;
}

function className(path: string): string {
  return baseName(path).replace(/\.(java|kt)$/, "");
}

function frameworkOf(text: string | undefined, fallback: string): string {
  if (text === undefined) return fallback;
  if (/\borg\.junit\.jupiter\b/.test(text)) return "junit5";
  if (/\borg\.testng\b/.test(text)) return "testng";
  if (/\borg\.junit\.(?:Test|runner|Assert|Before|After)\b|\bjunit\.framework\b/.test(text))
    return "junit4";
  if (/\bkotlin\.test\b/.test(text)) return "kotlin-test";
  return fallback;
}

/** The module's main test framework, used when a file does not say. */
export function primaryTestFramework(profile: ModuleProfile): string {
  for (const id of ["junit5", "junit4", "testng"]) {
    if (profile.testFrameworks.some((d) => d.id === id)) return id;
  }
  return "unknown";
}

/**
 * Test classes of the module. Maven runs only classes whose names match the Surefire and
 * Failsafe includes, so for Maven builds the name decides; Gradle runs every test class in
 * its test source sets. Either way, a readable file must contain a test annotation (or extend
 * `TestCase`), so helpers such as `TestData` are not counted.
 */
export async function scanTests(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<ScannedTest[]> {
  const maven = profile.buildTool?.id === "maven";
  const fallback = primaryTestFramework(profile);
  const out: ScannedTest[] = [];
  const seen = new Set<string>();
  for (const root of profile.testRoots) {
    const files = (await repo.glob(["**/*.java", "**/*.kt"], { cwd: root })).slice().sort();
    const integrationSet = INTEGRATION_SOURCE_SET.test(sourceSetOf(root));
    for (const path of files) {
      if (out.length >= MAX_TEST_FILES) return out;
      if (seen.has(path)) continue;
      seen.add(path);
      const name = className(path);
      const failsafe = FAILSAFE.some((pattern) => pattern.test(name));
      if (maven && !failsafe && !SUREFIRE.some((pattern) => pattern.test(name))) continue;
      const text = await readTextIfPresent(repo, path, MAX_TEST_FILE_BYTES);
      if (text !== undefined && !TEST_MARKER.test(text)) continue;
      const integration =
        failsafe || integrationSet || (text !== undefined && INTEGRATION_MARKER.test(text));
      out.push({
        path,
        name,
        framework: frameworkOf(text, fallback),
        level: integration ? "integration" : "unit",
        text,
      });
    }
  }
  return out;
}

function namingPattern(test: ScannedTest): string {
  const ext = test.path.endsWith(".kt") ? "kt" : "java";
  const { name } = test;
  if (name.endsWith("IT")) return `**/*IT.${ext}`;
  if (name.endsWith("ITCase")) return `**/*ITCase.${ext}`;
  if (name.startsWith("IT")) return `**/IT*.${ext}`;
  if (name.endsWith("Tests")) return `**/*Tests.${ext}`;
  if (name.endsWith("TestCase")) return `**/*TestCase.${ext}`;
  if (name.endsWith("Test")) return `**/*Test.${ext}`;
  if (name.startsWith("Test")) return `**/Test*.${ext}`;
  return `**/*.${ext}`;
}

export async function discoverJavaTests(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<TestInventory> {
  const tests = await scanTests(profile, repo);
  const namingPatterns =
    profile.buildTool?.id === "maven"
      ? MAVEN_TEST_PATTERNS
      : [...new Set(tests.map(namingPattern))].sort();
  return {
    moduleId: profile.moduleId,
    files: tests.map((test) => ({ path: test.path, framework: test.framework, level: test.level })),
    namingPatterns,
  };
}

// ---- Conventions ----------------------------------------------------------------------------

/** A convention is reported when it holds for at least this share of at least two files. */
const MIN_SHARE = 0.6;
const MIN_FILES = 2;
const MAX_CONVENTION_EVIDENCE = 5;

function convention(
  id: string,
  description: string,
  appliesTo: readonly string[],
  matching: readonly ScannedTest[],
  total: number,
  pattern: RegExp,
): InferredConvention | undefined {
  if (matching.length < MIN_FILES || total === 0 || matching.length / total < MIN_SHARE) {
    return undefined;
  }
  const evidence: Evidence[] = matching.slice(0, MAX_CONVENTION_EVIDENCE).map((test) => {
    const hit = test.text === undefined ? undefined : findLine(test.text, pattern);
    return fileEvidence(
      test.path,
      description,
      hit === undefined ? undefined : { line: hit.line, excerpt: hit.excerpt },
    );
  });
  return {
    id,
    description,
    appliesTo: [...appliesTo],
    confidence: Math.round((matching.length / total) * 100) / 100,
    evidence,
  };
}

function globsFor(profile: ModuleProfile, fileGlob: string): string[] {
  return profile.testRoots.map((root) => joinRepoPath(root, "**", fileGlob));
}

const ASSERTION_STYLES = [
  { id: "assertj", label: "AssertJ assertions", pattern: /\borg\.assertj\b/ },
  {
    id: "junit",
    label: "JUnit Assertions",
    pattern: /\borg\.junit\.jupiter\.api\.Assertions\b|\borg\.junit\.Assert\b/,
  },
  { id: "hamcrest", label: "Hamcrest matchers", pattern: /\borg\.hamcrest\b/ },
] as const;

const SPRING_ROLES = [
  { role: "controller", suffix: "Controller" },
  { role: "service", suffix: "Service" },
  { role: "repository", suffix: "Repository" },
] as const;
const SPRING_TEST_STYLES = [
  { label: "@WebMvcTest", pattern: /@WebMvcTest\b/ },
  { label: "@WebFluxTest", pattern: /@WebFluxTest\b/ },
  { label: "@DataJpaTest", pattern: /@DataJpaTest\b/ },
  { label: "@JdbcTest", pattern: /@JdbcTest\b/ },
  { label: "@DataMongoTest", pattern: /@DataMongoTest\b/ },
  { label: "@SpringBootTest", pattern: /@SpringBootTest\b/ },
  { label: "Mockito (MockitoExtension)", pattern: /MockitoExtension|MockitoJUnitRunner/ },
] as const;

/** Conventions measured over the existing tests. Each one names the files it was seen in. */
export async function inferJavaConventions(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<InferredConvention[]> {
  const tests = (await scanTests(profile, repo)).filter((test) => test.text !== undefined);
  const out: (InferredConvention | undefined)[] = [];
  const has = (pattern: RegExp) => (test: ScannedTest) =>
    test.text !== undefined && pattern.test(test.text);

  const unit = tests.filter((test) => test.level === "unit");
  for (const suffix of ["Tests", "Test"]) {
    const matching = unit.filter(
      (test) => test.name.endsWith(suffix) && !(suffix === "Test" && test.name.endsWith("Tests")),
    );
    const found = convention(
      `java.test-class-suffix.${suffix.toLowerCase()}`,
      `${String(matching.length)} of ${String(unit.length)} unit test classes end in "${suffix}"`,
      [...globsFor(profile, `*${suffix}.java`), ...globsFor(profile, `*${suffix}.kt`)],
      matching,
      unit.length,
      new RegExp(`class\\s+\\w*${suffix}\\b`),
    );
    if (found !== undefined) {
      out.push(found);
      break;
    }
  }

  const asserting = tests.filter((test) =>
    ASSERTION_STYLES.some((style) => has(style.pattern)(test)),
  );
  for (const style of ASSERTION_STYLES) {
    const matching = asserting.filter(has(style.pattern));
    out.push(
      convention(
        `java.assertions.${style.id}`,
        `${style.label} in ${String(matching.length)} of ${String(asserting.length)} test classes that make assertions`,
        globsFor(profile, "*.java"),
        matching,
        asserting.length,
        style.pattern,
      ),
    );
  }

  const mockito = tests.filter(has(/\borg\.mockito\b/));
  const extension =
    /@ExtendWith\(\s*MockitoExtension\.class\s*\)|@RunWith\(\s*MockitoJUnitRunner\.class\s*\)/;
  const extended = mockito.filter(has(extension));
  out.push(
    convention(
      "java.mockito.extension",
      `${String(extended.length)} of ${String(mockito.length)} test classes that use Mockito run with the Mockito extension`,
      globsFor(profile, "*.java"),
      extended,
      mockito.length,
      extension,
    ),
  );

  for (const { role, suffix } of SPRING_ROLES) {
    const group = tests.filter((test) =>
      new RegExp(`${suffix}\\w*(?:Test|Tests|IT)$`).test(test.name),
    );
    let best: { label: string; pattern: RegExp; matching: ScannedTest[] } | undefined;
    for (const style of SPRING_TEST_STYLES) {
      const matching = group.filter(has(style.pattern));
      if (best === undefined || matching.length > best.matching.length) {
        best = { label: style.label, pattern: style.pattern, matching };
      }
    }
    if (best === undefined) continue;
    out.push(
      convention(
        `java.${role}-tests`,
        `${String(best.matching.length)} of ${String(group.length)} ${role} tests use ${best.label}`,
        [
          ...globsFor(profile, `*${suffix}*Test.java`),
          ...globsFor(profile, `*${suffix}*Tests.java`),
        ],
        best.matching,
        group.length,
        best.pattern,
      ),
    );
  }

  const jupiter = tests.filter((test) => test.framework === "junit5");
  const named = jupiter.filter(has(/@DisplayName\b/));
  out.push(
    convention(
      "java.display-names",
      `${String(named.length)} of ${String(jupiter.length)} JUnit 5 test classes use @DisplayName`,
      globsFor(profile, "*.java"),
      named,
      jupiter.length,
      /@DisplayName\b/,
    ),
  );

  return out.filter((item): item is InferredConvention => item !== undefined);
}

// ---- Authoring guide ------------------------------------------------------------------------

export function javaTestAuthoringGuide(profile: ModuleProfile): TestAuthoringGuide {
  const framework = primaryTestFramework(profile);
  const testRoot =
    profile.testRoots.find((root) => root.endsWith("src/test/java")) ??
    profile.testRoots[0] ??
    joinRepoPath(profile.root, "src/test/java");
  const jupiter = framework === "junit5" || framework === "unknown";
  const notes = [
    "Put the test class in the same package as the class under test.",
    "Start each test method name with the acceptance criterion it covers (ac1_, ac2_, ...): the method name reaches the JUnit XML report, which is how DevFlow links results to criteria.",
  ];
  if (framework === "unknown") {
    notes.push(
      "No test framework was detected in the build; this guide assumes JUnit 5, which needs the org.junit.jupiter:junit-jupiter test dependency.",
    );
  }
  if (jupiter) {
    notes.push(
      'Add @DisplayName("AC-n: ...") for a readable name; the method-name prefix is what DevFlow relies on.',
    );
  }
  if (profile.buildTool?.id === "maven") {
    notes.push(
      "Surefire runs classes named *Test, *Tests, Test* and *TestCase in `test`; Failsafe runs *IT classes in `verify`.",
    );
  } else if (profile.buildTool?.id === "gradle") {
    notes.push("Gradle runs every test class of the test source set with the `test` task.");
  }
  for (const [id, note] of [
    ["mockito", "Mockito is available for test doubles."],
    ["assertj", "AssertJ is available for assertions."],
    ["testcontainers", "Testcontainers is available; tests that use it need Docker."],
  ] as const) {
    if (profile.testFrameworks.some((d) => d.id === id)) notes.push(note);
  }
  return {
    framework: framework === "unknown" ? "junit5" : framework,
    testRoot,
    fileNamePattern: "{name}Test.java",
    acMarker: {
      style: "method-name-prefix",
      example: jupiter
        ? '@Test @DisplayName("AC-1: returns the second page") void ac1_returnsSecondPage()'
        : "@Test public void ac1_returnsSecondPage()",
    },
    notes,
  };
}
