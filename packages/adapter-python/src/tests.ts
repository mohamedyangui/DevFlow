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
} from "@devflowai/core";
import { baseName, sortPaths, unique } from "./paths.js";
import { nestedModuleRoots, ownedBy } from "./workspace.js";

/** pytest's default test file names; unittest's default pattern (`test*.py`) is a subset. */
export const TEST_GLOBS = ["**/test_*.py", "**/*_test.py"];
const MAX_TEST_FILES = 2_000;
const MAX_TEST_FILE_BYTES = 512 * 1024;

/** A readable test file must define a test function, a test class or a TestCase. */
export const TEST_DEFINITION =
  /^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*class\s+Test\w*\s*[(:]|\bTestCase\s*\)/m;
const PYTEST_IMPORT = /^\s*(?:import\s+pytest\b|from\s+pytest\b)/m;
const UNITTEST_IMPORT = /^\s*(?:import\s+unittest\b|from\s+unittest\b)/m;
const TEST_CASE_CLASS = /^\s*class\s+\w+\s*\([^)]*\bTestCase\b[^)]*\)\s*:/m;
const TEST_DIR_SEGMENT = /(^|\/)(tests?)\//;

/** Paths of the module's test files (by name only; nothing is read). */
export async function scanTestPaths(
  repo: RepositoryView,
  root: string,
  nested: readonly string[],
): Promise<string[]> {
  return sortPaths(
    (await repo.glob(TEST_GLOBS, { cwd: root })).filter((path) => ownedBy(root, nested, path)),
  ).slice(0, MAX_TEST_FILES);
}

/**
 * The module's main test framework: pytest when it is detected, unittest when only unittest is,
 * otherwise `unknown`. pytest also runs unittest test cases.
 */
export function primaryTestFramework(profile: ModuleProfile): "pytest" | "unittest" | "unknown" {
  if (profile.testFrameworks.some((d) => d.id === "pytest")) return "pytest";
  if (profile.testFrameworks.some((d) => d.id === "unittest")) return "unittest";
  return "unknown";
}

export interface ScannedTest {
  readonly path: string;
  readonly text?: string;
  readonly framework: string;
  readonly level: TestLevel;
}

export function testFileFramework(text: string | undefined, fallback: string): string {
  if (text === undefined) return fallback;
  if (PYTEST_IMPORT.test(text)) return "pytest";
  if (UNITTEST_IMPORT.test(text) && TEST_CASE_CLASS.test(text)) return "unittest";
  return fallback;
}

function levelOf(path: string, text: string | undefined): TestLevel {
  if (/(^|\/)e2e\//.test(path) || /_e2e(_test)?\.py$/.test(path)) return "e2e";
  if (text !== undefined && /^\s*(?:from|import)\s+(?:playwright|selenium)\b/m.test(text)) {
    return "e2e";
  }
  if (/(^|\/)integration\//.test(path) || /_integration(_test)?\.py$/.test(path)) {
    return "integration";
  }
  if (
    text !== undefined &&
    /\btestcontainers\b|pytest\.mark\.integration\b|\bLiveServerTestCase\b/.test(text)
  ) {
    return "integration";
  }
  return "unit";
}

/** The module's test files: `test_*.py` and `*_test.py` that define a test. */
export async function scanTests(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<ScannedTest[]> {
  const nested = await nestedModuleRoots(repo, profile.root);
  const primary = primaryTestFramework(profile);
  const fallback = primary === "unknown" ? "pytest" : primary;
  const out: ScannedTest[] = [];
  for (const path of await scanTestPaths(repo, profile.root, nested)) {
    const text = await readTextIfPresent(repo, path, MAX_TEST_FILE_BYTES);
    if (text !== undefined && !TEST_DEFINITION.test(text)) continue;
    out.push({
      path,
      ...(text === undefined ? {} : { text }),
      framework: testFileFramework(text, fallback),
      level: levelOf(path, text),
    });
  }
  return out;
}

function namingPattern(path: string): string {
  return baseName(path).startsWith("test_") ? "**/test_*.py" : "**/*_test.py";
}

export async function discoverPythonTests(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<TestInventory> {
  const tests = await scanTests(profile, repo);
  return {
    moduleId: profile.moduleId,
    files: tests.map((test) => ({ path: test.path, framework: test.framework, level: test.level })),
    namingPatterns: sortPaths(unique(tests.map((test) => namingPattern(test.path)))),
  };
}

// ---- Markers --------------------------------------------------------------------------------

const NAME_PREFIX = /^(?:test_?)?((?:ac[1-9][0-9]{0,3}_)+)/i;
const TITLE_MARKER = /\bAC-([1-9][0-9]{0,3})\b/g;

/**
 * Acceptance criteria named by a test (ADR 0015): the test name prefix `test_ac1_…` (several
 * criteria: `test_ac1_ac2_…`), or `AC-n` in a name such as a pytest parameter id
 * (`test_page[AC-1]`).
 */
export function acceptanceMarkers(...names: readonly string[]): string[] {
  const numbers = new Set<number>();
  for (const name of names) {
    const prefix = NAME_PREFIX.exec(name)?.[1];
    if (prefix !== undefined) {
      for (const part of prefix.split("_")) {
        const n = /^ac([0-9]+)$/i.exec(part)?.[1];
        if (n !== undefined) numbers.add(Number(n));
      }
    }
    for (const match of name.matchAll(TITLE_MARKER)) numbers.add(Number(match[1]));
  }
  return [...numbers].sort((a, b) => a - b).map((n) => `AC-${String(n)}`);
}

// ---- Conventions ----------------------------------------------------------------------------

const MIN_SHARE = 0.6;
const MIN_FILES = 2;
const MAX_CONVENTION_EVIDENCE = 5;

interface Option {
  readonly id: string;
  readonly description: (n: number, total: number) => string;
  readonly matching: readonly ScannedTest[];
  readonly pattern?: RegExp;
}

function convention(
  option: Option,
  total: number,
  appliesTo: readonly string[],
): InferredConvention | undefined {
  const { matching } = option;
  if (matching.length < MIN_FILES || total === 0 || matching.length / total < MIN_SHARE) {
    return undefined;
  }
  const description = option.description(matching.length, total);
  const evidence: Evidence[] = matching.slice(0, MAX_CONVENTION_EVIDENCE).map((test) => {
    const hit =
      option.pattern === undefined || test.text === undefined
        ? undefined
        : findLine(test.text, option.pattern);
    return fileEvidence(
      test.path,
      description,
      hit === undefined ? undefined : { line: hit.line, excerpt: hit.excerpt },
    );
  });
  return {
    id: option.id,
    description,
    appliesTo: [...appliesTo],
    confidence: Math.round((matching.length / total) * 100) / 100,
    evidence,
  };
}

function bestOf(
  options: readonly Option[],
  total: number,
  appliesTo: readonly string[],
): InferredConvention | undefined {
  for (const option of [...options].sort((a, b) => b.matching.length - a.matching.length)) {
    const found = convention(option, total, appliesTo);
    if (found !== undefined) return found;
  }
  return undefined;
}

const TEST_FUNCTION = /^(?:async\s+)?def\s+test\w*\s*\(/m;
const TEST_CLASS = /^\s*class\s+Test\w*\s*[(:]/m;
const AC_NAME = /^\s*(?:async\s+)?def\s+test_?ac[1-9][0-9]*_\w*\s*\(/m;

/**
 * Conventions that hold for at least 60% of at least two test files: the file name (`test_*.py`
 * or `*_test.py`), the location (a tests directory or next to the code), the test style
 * (module-level functions, pytest classes or unittest TestCase classes), and test names that
 * start with an acceptance criterion.
 */
export async function inferPythonConventions(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<InferredConvention[]> {
  const tests = (await scanTests(profile, repo)).filter((test) => test.level !== "e2e");
  const readable = tests.filter((test) => test.text !== undefined);
  const has = (pattern: RegExp) => (test: ScannedTest) =>
    test.text !== undefined && pattern.test(test.text);
  const everywhere = [joinRepoPath(profile.root, "**")];
  const out: (InferredConvention | undefined)[] = [];

  out.push(
    bestOf(
      [
        {
          id: "py.test-file-name.prefix",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files are named test_*.py`,
          matching: tests.filter((test) => baseName(test.path).startsWith("test_")),
        },
        {
          id: "py.test-file-name.suffix",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files are named *_test.py`,
          matching: tests.filter((test) => !baseName(test.path).startsWith("test_")),
        },
      ],
      tests.length,
      [joinRepoPath(profile.root, "**/test_*.py"), joinRepoPath(profile.root, "**/*_test.py")],
    ),
  );

  out.push(
    bestOf(
      [
        {
          id: "py.test-location.tests-directory",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files live in a tests directory (tests/, test/)`,
          matching: tests.filter((test) => TEST_DIR_SEGMENT.test(test.path)),
        },
        {
          id: "py.test-location.colocated",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files sit next to the code they test`,
          matching: tests.filter((test) => !TEST_DIR_SEGMENT.test(test.path)),
        },
      ],
      tests.length,
      everywhere,
    ),
  );

  const testCases = readable.filter(has(TEST_CASE_CLASS));
  const classes = readable.filter((t) => has(TEST_CLASS)(t) && !has(TEST_CASE_CLASS)(t));
  const functions = readable.filter((t) => has(TEST_FUNCTION)(t) && !has(TEST_CLASS)(t));
  out.push(
    bestOf(
      [
        {
          id: "py.test-style.functions",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files define module-level test functions`,
          matching: functions,
          pattern: TEST_FUNCTION,
        },
        {
          id: "py.test-style.classes",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files group tests in plain Test* classes`,
          matching: classes,
          pattern: TEST_CLASS,
        },
        {
          id: "py.test-style.unittest",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files define unittest.TestCase classes`,
          matching: testCases,
          pattern: TEST_CASE_CLASS,
        },
      ],
      testCases.length + classes.length + functions.length,
      everywhere,
    ),
  );

  const marked = readable.filter(has(AC_NAME));
  out.push(
    convention(
      {
        id: "py.ac-name-marker",
        description: (n, total) =>
          `${String(n)} of ${String(total)} test files start test names with an acceptance criterion (test_acN_)`,
        matching: marked,
        pattern: AC_NAME,
      },
      readable.length,
      everywhere,
    ),
  );
  return out.filter((item): item is InferredConvention => item !== undefined);
}

// ---- Authoring guide ------------------------------------------------------------------------

export function pythonTestAuthoringGuide(profile: ModuleProfile): TestAuthoringGuide {
  const framework = primaryTestFramework(profile);
  const testRoot =
    profile.testRoots.find((root) => root !== profile.root) ??
    profile.testRoots[0] ??
    joinRepoPath(profile.root, "tests");
  const unittest = framework === "unittest";
  const notes = [
    "Start each test name with the acceptance criteria it covers: test_ac1_returns_the_second_page (several: test_ac1_ac2_...). The name reaches the test report, which is how DevFlow links results to criteria; a docstring or a pytest marker does not.",
    "Follow the module's inferred conventions for the file name (test_*.py or *_test.py), the location and the test style.",
  ];
  if (unittest) {
    notes.push(
      "unittest runs the tests (python -m unittest discover): define methods of a unittest.TestCase subclass in a file named test*.py, in a directory unittest can import (a package with __init__.py, or the start directory).",
    );
  } else if (framework === "pytest") {
    notes.push(
      "pytest runs the tests: write plain functions with assert statements; use fixtures from conftest.py rather than setup code in each test.",
    );
  } else {
    notes.push(
      "No test framework was detected; this guide assumes pytest, which must be installed in the project's environment. DevFlow never installs it.",
    );
  }
  return {
    framework: unittest ? "unittest" : "pytest",
    testRoot,
    fileNamePattern: "test_{name}.py",
    acMarker: {
      style: "method-name-prefix",
      example: unittest
        ? "def test_ac1_returns_the_second_page(self) -> None: ..."
        : "def test_ac1_returns_the_second_page() -> None: ...",
    },
    notes,
  };
}
