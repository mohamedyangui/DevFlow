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
} from "@devflow-ai/core";
import { readModuleFile } from "./manifest.js";
import { baseName, resolveRepoPath, sortPaths, unique } from "./paths.js";
import { nestedModuleRoots, ownedBy } from "./workspace.js";

const TEST_EXTENSIONS = "{js,jsx,mjs,cjs,ts,tsx,mts,cts}";
const TEST_GLOBS = [`**/*.{test,spec}.${TEST_EXTENSIONS}`, `**/__tests__/**/*.${TEST_EXTENSIONS}`];
/** Mocha's default spec is `./test`, whatever the file names. */
const MOCHA_GLOBS = ["test/**/*.{js,cjs,mjs,ts}"];
const MAX_TEST_FILES = 2_000;
const MAX_TEST_FILE_BYTES = 512 * 1024;
/** A readable test file must declare a test or a suite, so helpers in `__tests__` are left out. */
const TEST_CALL = /\b(?:it|test|describe|suite)\s*(?:\.\s*[A-Za-z]+\s*)*\(/;
const TEST_SUFFIX = /\.(test|spec)\.([cm]?[jt]sx?)$/;
const TEST_DIR_SEGMENT = /(^|\/)(test|tests|__tests__|spec|e2e)\//;

/** Unit test runners, most preferred first. */
export const UNIT_RUNNERS = ["vitest", "jest", "mocha"] as const;

/**
 * The module's main unit test runner: the detected one with the highest confidence (ties keep
 * the order of `UNIT_RUNNERS`), `playwright` when only Playwright is used, otherwise `unknown`.
 */
export function primaryTestFramework(profile: ModuleProfile): string {
  let best: { id: string; confidence: number } | undefined;
  for (const id of UNIT_RUNNERS) {
    const found = profile.testFrameworks.find((d) => d.id === id);
    if (found !== undefined && (best === undefined || found.confidence > best.confidence)) {
      best = { id, confidence: found.confidence };
    }
  }
  if (best !== undefined) return best.id;
  return profile.testFrameworks.some((d) => d.id === "playwright") ? "playwright" : "unknown";
}

/** Paths of the module's test files (by name only; nothing is read). */
export async function scanTestPaths(
  repo: RepositoryView,
  root: string,
  nested: readonly string[],
  mocha: boolean,
): Promise<string[]> {
  const globs = mocha ? [...TEST_GLOBS, ...MOCHA_GLOBS] : TEST_GLOBS;
  return sortPaths(
    (await repo.glob(globs, { cwd: root })).filter(
      (path) => ownedBy(root, nested, path) && !/\.d\.[cm]?ts$/.test(path),
    ),
  ).slice(0, MAX_TEST_FILES);
}

export interface ScannedTest {
  readonly path: string;
  /** Undefined when the file could not be read. */
  readonly text?: string;
  readonly framework: string;
  readonly level: TestLevel;
}

function frameworkOf(text: string | undefined, fallback: string): string {
  if (text === undefined) return fallback;
  const imports = (module: string) =>
    new RegExp(
      `(?:from\\s*|require\\(\\s*|import\\(\\s*|import\\s+)["']${module.replace(/[/.]/g, "\\$&")}["']`,
    ).test(text);
  if (imports("@playwright/test")) return "playwright";
  if (imports("vitest")) return "vitest";
  if (imports("@jest/globals")) return "jest";
  if (imports("node:test")) return "node-test";
  if (imports("mocha")) return "mocha";
  return fallback;
}

function levelOf(path: string, text: string | undefined, framework: string): TestLevel {
  if (framework === "playwright" || /(^|\/)e2e\//.test(path) || path.includes(".e2e.")) {
    return "e2e";
  }
  if (/(^|\/)integration\//.test(path) || /\.(int|integration)\.(test|spec)\./.test(path)) {
    return "integration";
  }
  if (text !== undefined && /["'](?:supertest|testcontainers)["']/.test(text)) return "integration";
  return "unit";
}

/** Playwright's `testDir` from its configuration file, when it is a plain string. */
async function playwrightTestDir(
  repo: RepositoryView,
  profile: ModuleProfile,
): Promise<string | undefined> {
  if (!profile.testFrameworks.some((d) => d.id === "playwright")) return undefined;
  const config = await readModuleFile(
    repo,
    profile.root,
    ["ts", "js", "mjs", "cjs", "mts", "cts"].map((ext) => `playwright.config.${ext}`),
  );
  const dir =
    config === undefined ? undefined : /\btestDir\s*:\s*["'`]([^"'`]+)["'`]/.exec(config.text)?.[1];
  return dir === undefined ? undefined : resolveRepoPath(profile.root, dir);
}

/**
 * The module's test files: `*.test.*`, `*.spec.*` and files in `__tests__` (and `test/` when
 * Mocha is used), outside nested modules. A readable file must declare a test or a suite.
 */
export async function scanTests(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<ScannedTest[]> {
  const nested = await nestedModuleRoots(repo, profile.root);
  const mocha = profile.testFrameworks.some((d) => d.id === "mocha");
  const paths = await scanTestPaths(repo, profile.root, nested, mocha);
  const e2eDir = await playwrightTestDir(repo, profile);
  const primary = primaryTestFramework(profile);
  const out: ScannedTest[] = [];
  for (const path of paths) {
    const text = await readTextIfPresent(repo, path, MAX_TEST_FILE_BYTES);
    if (text !== undefined && !TEST_CALL.test(text)) continue;
    const inE2eDir = e2eDir !== undefined && path.startsWith(`${e2eDir}/`);
    const framework = frameworkOf(text, inE2eDir ? "playwright" : primary);
    out.push({
      path,
      ...(text === undefined ? {} : { text }),
      framework,
      level: inE2eDir ? "e2e" : levelOf(path, text, framework),
    });
  }
  return out;
}

function namingPattern(path: string): string {
  const suffix = TEST_SUFFIX.exec(baseName(path));
  if (suffix !== null) return `**/*.${suffix[1] ?? "test"}.${suffix[2] ?? "js"}`;
  if (path.includes("__tests__/")) return "**/__tests__/**";
  return "test/**";
}

export async function discoverJavaScriptTests(
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

// ---- Conventions ----------------------------------------------------------------------------

const MIN_SHARE = 0.6;
const MIN_FILES = 2;
const MAX_CONVENTION_EVIDENCE = 5;

function convention(
  id: string,
  description: string,
  appliesTo: readonly string[],
  matching: readonly ScannedTest[],
  total: number,
  pattern?: RegExp,
): InferredConvention | undefined {
  if (matching.length < MIN_FILES || total === 0 || matching.length / total < MIN_SHARE) {
    return undefined;
  }
  const evidence: Evidence[] = matching.slice(0, MAX_CONVENTION_EVIDENCE).map((test) => {
    const hit =
      pattern === undefined || test.text === undefined ? undefined : findLine(test.text, pattern);
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

function bestOf(
  options: readonly {
    readonly id: string;
    readonly description: (n: number, total: number) => string;
    readonly matching: readonly ScannedTest[];
    readonly pattern?: RegExp;
  }[],
  total: number,
  appliesTo: readonly string[],
): InferredConvention | undefined {
  for (const option of [...options].sort((a, b) => b.matching.length - a.matching.length)) {
    const found = convention(
      option.id,
      option.description(option.matching.length, total),
      appliesTo,
      option.matching,
      total,
      option.pattern,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

const IT_CALL = /\bit\s*(?:\.\s*[A-Za-z]+\s*)*\(/;
const TEST_FN_CALL = /\btest\s*(?:\.\s*[A-Za-z]+\s*)*\(/;
const EXPLICIT_IMPORT = /(?:from\s*|require\(\s*)["'](?:vitest|@jest\/globals)["']/;
const AC_TITLE = /\b(?:it|test|describe)\s*(?:\.\s*[A-Za-z]+\s*)*\(\s*["'`]AC-[1-9][0-9]*\b/;

export async function inferJavaScriptConventions(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<InferredConvention[]> {
  const tests = await scanTests(profile, repo);
  const readable = tests.filter((test) => test.text !== undefined);
  const has = (pattern: RegExp) => (test: ScannedTest) =>
    test.text !== undefined && pattern.test(test.text);
  const everywhere = [joinRepoPath(profile.root, "**")];
  const out: (InferredConvention | undefined)[] = [];

  // End-to-end tests often use their own suffix (Playwright's .spec); new tests are unit tests.
  const suffixed = tests.filter(
    (test) => test.level !== "e2e" && TEST_SUFFIX.test(baseName(test.path)),
  );
  out.push(
    bestOf(
      (["test", "spec"] as const).map((suffix) => ({
        id: `js.test-file-suffix.${suffix}`,
        description: (n, total) =>
          `${String(n)} of ${String(total)} test files are named *.${suffix}.*`,
        matching: suffixed.filter((test) => TEST_SUFFIX.exec(baseName(test.path))?.[1] === suffix),
      })),
      suffixed.length,
      [joinRepoPath(profile.root, "**/*.test.*"), joinRepoPath(profile.root, "**/*.spec.*")],
    ),
  );

  const unitTests = tests.filter((test) => test.level !== "e2e");
  out.push(
    bestOf(
      [
        {
          id: "js.test-location.colocated",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files sit next to the code they test`,
          matching: unitTests.filter((test) => !TEST_DIR_SEGMENT.test(test.path)),
        },
        {
          id: "js.test-location.test-directory",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files live in a test directory (test/, tests/, __tests__/)`,
          matching: unitTests.filter((test) => TEST_DIR_SEGMENT.test(test.path)),
        },
      ],
      unitTests.length,
      everywhere,
    ),
  );

  const unitReadable = readable.filter((test) => test.framework !== "playwright");
  const usesIt = unitReadable.filter((test) => has(IT_CALL)(test) && !has(TEST_FN_CALL)(test));
  const usesTest = unitReadable.filter((test) => has(TEST_FN_CALL)(test) && !has(IT_CALL)(test));
  out.push(
    bestOf(
      [
        {
          id: "js.test-function.it",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files declare tests with it(...)`,
          matching: usesIt,
          pattern: IT_CALL,
        },
        {
          id: "js.test-function.test",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files declare tests with test(...)`,
          matching: usesTest,
          pattern: TEST_FN_CALL,
        },
      ],
      usesIt.length + usesTest.length,
      everywhere,
    ),
  );

  const runnerFiles = readable.filter(
    (test) => test.framework === "vitest" || test.framework === "jest",
  );
  const runnerLabel = primaryTestFramework(profile) === "jest" ? "@jest/globals" : "vitest";
  out.push(
    bestOf(
      [
        {
          id: "js.test-imports.explicit",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files import describe/it/expect from "${runnerLabel}"`,
          matching: runnerFiles.filter(has(EXPLICIT_IMPORT)),
          pattern: EXPLICIT_IMPORT,
        },
        {
          id: "js.test-imports.globals",
          description: (n, total) =>
            `${String(n)} of ${String(total)} test files use the runner's global describe/it/expect`,
          matching: runnerFiles.filter((test) => !has(EXPLICIT_IMPORT)(test)),
        },
      ],
      runnerFiles.length,
      everywhere,
    ),
  );

  const marked = readable.filter(has(AC_TITLE));
  out.push(
    convention(
      "js.ac-title-marker",
      `${String(marked.length)} of ${String(readable.length)} test files start test titles with an acceptance criterion (AC-n)`,
      everywhere,
      marked,
      readable.length,
      AC_TITLE,
    ),
  );

  return out.filter((item): item is InferredConvention => item !== undefined);
}

// ---- Authoring guide ------------------------------------------------------------------------

export function javaScriptTestAuthoringGuide(profile: ModuleProfile): TestAuthoringGuide {
  const framework = primaryTestFramework(profile);
  const typescript = profile.languages.some((language) => language.id === "typescript");
  const extension = typescript ? "ts" : "js";
  const testRoot = profile.testRoots[0] ?? joinRepoPath(profile.root, "test");
  const playwrightOnly = framework === "playwright";
  const notes = [
    'Start each test title with the acceptance criterion it covers ("AC-1: ..."). The title reaches the JSON test report, which is how DevFlow links results to criteria; a describe block titled "AC-2" marks every test inside it.',
    "Follow the module's inferred conventions for the file suffix (.test or .spec), the location and the imports.",
  ];
  switch (framework) {
    case "vitest":
      notes.push(
        'Vitest runs the tests. Import describe, it and expect from "vitest" unless the module enables globals.',
      );
      break;
    case "jest":
      notes.push(
        'Jest runs the tests. describe, it and expect are globals; they can also be imported from "@jest/globals".',
      );
      break;
    case "mocha":
      notes.push(
        "Mocha is used. DevFlow has no Mocha command, so a verification gate does not run these tests.",
      );
      break;
    case "playwright":
      notes.push(
        "Only Playwright was detected. DevFlow lists end-to-end tests but does not run them.",
      );
      break;
    default:
      notes.push(
        "No test runner was detected; this guide assumes Vitest, which needs the vitest dev dependency. DevFlow runs tests with Vitest or Jest only.",
      );
  }
  if (!playwrightOnly && profile.testFrameworks.some((d) => d.id === "playwright")) {
    notes.push("Playwright end-to-end tests are listed but not run by DevFlow.");
  }
  return {
    framework: framework === "unknown" ? "vitest" : framework,
    testRoot,
    fileNamePattern: playwrightOnly ? `{name}.spec.${extension}` : `{name}.test.${extension}`,
    acMarker: {
      style: "title-prefix",
      example: playwrightOnly
        ? 'test("AC-1: returns the second page", async ({ page }) => { ... })'
        : 'it("AC-1: returns the second page", () => { ... })',
    },
    notes,
  };
}
