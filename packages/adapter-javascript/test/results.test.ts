import { validatedAdapter, type CommandSpec, type ExecutionRecord } from "@devflow/core";
import {
  checkAdapterConformance,
  MemoryRepository,
  StaticToolchainProbe,
} from "@devflow/core/testing";
import { describe, expect, it } from "vitest";
import {
  acceptanceMarkers,
  failureOutcome,
  javascriptAdapter,
  parseEslintJson,
  parseJestJson,
  parseTscOutput,
  stripAnsi,
} from "../src/index.js";
import { expressRepo, mochaRepo, monorepoRepo } from "./fixtures.js";

const adapter = validatedAdapter(javascriptAdapter);
const ROOT = "/memory/repo";
const ESC = String.fromCharCode(27);

const toFile = (reported: string) =>
  reported.startsWith(`${ROOT}/`) ? reported.slice(ROOT.length + 1) : undefined;

/** What the Vitest `json` reporter writes (Vitest 2). */
const vitestReport = {
  numTotalTestSuites: 3,
  numTotalTests: 4,
  numFailedTests: 1,
  numPassedTests: 2,
  numPendingTests: 1,
  success: false,
  testResults: [
    {
      name: `${ROOT}/src/orders.test.ts`,
      status: "failed",
      message: "",
      assertionResults: [
        {
          ancestorTitles: ["orders"],
          fullName: "orders AC-1: returns the second page",
          title: "AC-1: returns the second page",
          status: "passed",
          duration: 3.4,
          failureMessages: [],
        },
        {
          ancestorTitles: ["orders"],
          fullName: "orders AC-2: rejects a negative page",
          title: "AC-2: rejects a negative page",
          status: "failed",
          duration: 1.2,
          failureMessages: [
            `${ESC}[31mAssertionError: expected 200 to be 400 // Object.is equality${ESC}[39m\n    at ${ROOT}/src/orders.test.ts:12:5`,
          ],
        },
        {
          ancestorTitles: ["AC-3", "paging"],
          fullName: "AC-3 paging keeps the filter",
          title: "keeps the filter",
          status: "skipped",
          duration: null,
          failureMessages: [],
        },
      ],
    },
    {
      name: `${ROOT}/src/app.test.ts`,
      status: "passed",
      message: "",
      assertionResults: [
        {
          ancestorTitles: [],
          fullName: "starts",
          title: "starts",
          status: "passed",
          duration: 10,
          failureMessages: [],
        },
      ],
    },
    {
      name: `${ROOT}/src/missing.test.ts`,
      status: "failed",
      message:
        "Failed to load url ./not-yet-written (resolved id: ./not-yet-written) in /memory/repo/src/missing.test.ts. Does the file exist?",
      assertionResults: [],
    },
  ],
};

/** What `jest --json` writes (Jest 29). */
const jestReport = {
  numTotalTests: 3,
  numFailedTests: 2,
  numRuntimeErrorTestSuites: 1,
  success: false,
  testResults: [
    {
      name: `${ROOT}/packages/api/test/orders.service.test.ts`,
      status: "failed",
      message: "  ● OrdersService › AC-1: lists orders\n\n    expect(received).toBe(expected)",
      assertionResults: [
        {
          ancestorTitles: ["OrdersService"],
          fullName: "OrdersService AC-1: lists orders",
          title: "AC-1: lists orders",
          status: "failed",
          duration: 5,
          failureMessages: [
            "Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 2\nReceived: 1\n    at Object.<anonymous> (test/orders.service.test.ts:3:5)",
          ],
        },
        {
          ancestorTitles: ["OrdersService"],
          fullName: "OrdersService AC-2: throws",
          title: "AC-2: throws",
          status: "failed",
          duration: 2,
          failureMessages: [
            "TypeError: Cannot read properties of undefined (reading 'id')\n    at OrdersService.list",
          ],
        },
        {
          ancestorTitles: [],
          fullName: "waits",
          title: "waits",
          status: "failed",
          duration: 5001,
          failureMessages: [
            'thrown: "Exceeded timeout of 5000 ms for a test.\nAdd a timeout value to this test to increase the timeout"',
          ],
        },
        {
          ancestorTitles: [],
          fullName: "later",
          title: "later",
          status: "todo",
          failureMessages: [],
        },
      ],
    },
    {
      name: `${ROOT}/packages/api/test/broken.test.ts`,
      status: "failed",
      message:
        "  ● Test suite failed to run\n\n    ReferenceError: process.env.DB is not defined\n\n      at Object.<anonymous> (test/setup.ts:1:1)",
      assertionResults: [],
    },
  ],
};

describe("parseJestJson", () => {
  it("reads Vitest's JSON report, with markers from test and describe titles", () => {
    const report = parseJestJson(JSON.stringify(vitestReport), toFile);
    expect(report?.success).toBe(false);
    expect(report?.tests.map((t) => [t.id, t.outcome, t.status, t.markers, t.durationMs])).toEqual([
      [
        "src/orders.test.ts#orders > AC-1: returns the second page",
        "passed",
        "passed",
        ["AC-1"],
        3,
      ],
      [
        "src/orders.test.ts#orders > AC-2: rejects a negative page",
        "assertion_failure",
        "failed",
        ["AC-2"],
        1,
      ],
      [
        "src/orders.test.ts#AC-3 > paging > keeps the filter",
        "skipped",
        "skipped",
        ["AC-3"],
        undefined,
      ],
      ["src/app.test.ts#starts", "passed", "passed", [], 10],
      ["src/missing.test.ts", "compile_error", "not_executed", [], undefined],
    ]);
    expect(report?.tests[1]).toMatchObject({
      file: "src/orders.test.ts",
      name: "orders AC-2: rejects a negative page",
      message: expect.stringMatching(/^AssertionError: expected 200 to be 400/) as unknown,
    });
    expect(report?.tests[1]?.message).not.toContain(ESC);
  });

  it("reads Jest's report: failed expectations, thrown errors, timeouts and suites that did not run", () => {
    const report = parseJestJson(JSON.stringify(jestReport), toFile);
    expect(report?.tests.map((t) => [t.name, t.outcome, t.status])).toEqual([
      ["OrdersService AC-1: lists orders", "assertion_failure", "failed"],
      ["OrdersService AC-2: throws", "runtime_error", "failed"],
      ["waits", "timeout", "unverified"],
      ["later", "skipped", "skipped"],
      ["broken.test.ts (test file)", "infrastructure_error", "unverified"],
    ]);
  });

  it("keeps the worst outcome of a test reported twice and refuses incomplete reports", () => {
    const twice = {
      numTotalTests: 2,
      testResults: [
        {
          name: `${ROOT}/a.test.js`,
          assertionResults: [
            { ancestorTitles: [], title: "x", status: "passed", failureMessages: [] },
            { ancestorTitles: [], title: "x", status: "failed", failureMessages: ["Error: boom"] },
          ],
        },
      ],
    };
    expect(parseJestJson(JSON.stringify(twice), toFile)?.tests).toMatchObject([
      { id: "a.test.js#x", outcome: "runtime_error" },
    ]);
    const text = JSON.stringify(vitestReport);
    expect(parseJestJson(text.slice(0, text.length - 20), toFile)).toBeUndefined();
    expect(parseJestJson("[]", toFile)).toBeUndefined();
    expect(parseJestJson('{"testResults": []}', toFile)).toBeUndefined();
  });

  it("does not trust a status it does not know", () => {
    const odd = {
      numTotalTests: 1,
      testResults: [
        { name: `${ROOT}/a.test.js`, assertionResults: [{ title: "x", status: "focused" }] },
      ],
    };
    expect(parseJestJson(JSON.stringify(odd), toFile)?.tests).toMatchObject([
      { outcome: "infrastructure_error", status: "unverified" },
    ]);
  });
});

describe("failureOutcome and markers", () => {
  it("tells failed assertions from thrown errors and timeouts", () => {
    expect(failureOutcome(["AssertionError [ERR_ASSERTION]: 1 == 2"])).toBe("assertion_failure");
    expect(failureOutcome(["AssertionError: expected 'a' to equal 'b'"])).toBe("assertion_failure");
    expect(failureOutcome(["Error: expect(received).toEqual(expected)"])).toBe("assertion_failure");
    expect(failureOutcome(["Error: Snapshot `x 1` mismatched"])).toBe("assertion_failure");
    expect(failureOutcome(["Error: Test timed out in 5000ms."])).toBe("timeout");
    expect(failureOutcome(["Error: connect ECONNREFUSED 127.0.0.1:5432"])).toBe("runtime_error");
    expect(failureOutcome([])).toBe("runtime_error");
  });

  it("finds AC markers in titles and strips terminal colors", () => {
    expect(acceptanceMarkers("AC-2", "AC-10: and AC-1")).toEqual(["AC-1", "AC-2", "AC-10"]);
    expect(acceptanceMarkers("BAC-1", "AC-0")).toEqual([]);
    expect(stripAnsi(`${ESC}[1m${ESC}[31mred${ESC}[39m${ESC}[22m`)).toBe("red");
  });
});

describe("parseEslintJson", () => {
  it("turns messages into diagnostics with repository locations", () => {
    const report = [
      {
        filePath: `${ROOT}/src/app.ts`,
        messages: [
          {
            ruleId: "no-unused-vars",
            severity: 2,
            message: "'x' is unused.",
            line: 3,
            column: 7,
            endLine: 3,
          },
          { ruleId: "eqeqeq", severity: 1, message: "Expected '==='.", line: 5, column: 9 },
          {
            ruleId: null,
            fatal: true,
            severity: 2,
            message: "Parsing error: Unexpected token",
            line: 9,
            column: 1,
          },
        ],
        errorCount: 2,
        warningCount: 1,
      },
      {
        filePath: "/elsewhere/x.js",
        messages: [{ ruleId: "semi", severity: 2, message: "Missing semicolon." }],
      },
    ];
    expect(parseEslintJson(JSON.stringify(report), ROOT)).toEqual([
      {
        tool: "eslint",
        severity: "error",
        message: "'x' is unused.",
        ruleId: "no-unused-vars",
        location: { path: "src/app.ts", line: 3, column: 7, endLine: 3 },
      },
      {
        tool: "eslint",
        severity: "warning",
        message: "Expected '==='.",
        ruleId: "eqeqeq",
        location: { path: "src/app.ts", line: 5, column: 9 },
      },
      {
        tool: "eslint",
        severity: "error",
        message: "Parsing error: Unexpected token",
        location: { path: "src/app.ts", line: 9, column: 1 },
      },
      { tool: "eslint", severity: "error", message: "Missing semicolon.", ruleId: "semi" },
    ]);
    expect(parseEslintJson('{"not": "eslint"}', ROOT)).toBeUndefined();
    expect(parseEslintJson('[{"filePath": "/x"', ROOT)).toBeUndefined();
  });
});

describe("parseTscOutput", () => {
  it("reads located and global errors, resolving paths against the working directory", () => {
    const output = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "../shared/b.ts(10,1): error TS2304: Cannot find name 'foo'.",
      "  The expected type comes from property 'x'.",
      `${ROOT}/apps/web/src/c.tsx(1,1): warning TS6133: 'React' is declared but never used.`,
      "error TS5058: The specified path does not exist: 'tsconfig.json'.",
      "Found 3 errors.",
    ].join("\n");
    expect(parseTscOutput(output, ROOT, "apps/web")).toEqual([
      {
        tool: "tsc",
        severity: "error",
        message: "Type 'string' is not assignable to type 'number'.",
        ruleId: "TS2322",
        location: { path: "apps/web/src/a.ts", line: 3, column: 7 },
      },
      {
        tool: "tsc",
        severity: "error",
        message: "Cannot find name 'foo'.\nThe expected type comes from property 'x'.",
        ruleId: "TS2304",
        location: { path: "apps/shared/b.ts", line: 10, column: 1 },
      },
      {
        tool: "tsc",
        severity: "warning",
        message: "'React' is declared but never used.",
        ruleId: "TS6133",
        location: { path: "apps/web/src/c.tsx", line: 1, column: 1 },
      },
      {
        tool: "tsc",
        severity: "error",
        message: "The specified path does not exist: 'tsconfig.json'.",
        ruleId: "TS5058",
      },
    ]);
  });
});

// ---- parseResults ---------------------------------------------------------------------------

const STARTED = "2026-03-01T10:00:00.000Z";
const FRESH = Date.parse("2026-03-01T10:00:05.000Z");
const STALE = Date.parse("2026-02-01T00:00:00.000Z");

async function catalogOf(repo: MemoryRepository, root: string): Promise<CommandSpec[]> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  const profile = await adapter.analyzeModule(candidate, repo);
  return [...(await adapter.commandCatalog(profile, new StaticToolchainProbe([]), repo))];
}

function commandOf(catalog: readonly CommandSpec[], suffix: string): CommandSpec {
  const command = catalog.find((c) => c.id.endsWith(`:${suffix}`));
  if (command === undefined) throw new Error(`no ${suffix} command`);
  return command;
}

function execution(command: CommandSpec, exitCode: number | null): ExecutionRecord {
  return {
    commandId: command.id,
    argv: [command.executable, ...command.args],
    cwd: command.cwd,
    invocation: "direct",
    approval: { via: "interactive", approvedBy: "dev" },
    startedAt: STARTED,
    durationMs: 9000,
    exitCode,
    signal: null,
    timedOut: false,
    stdoutPath: "logs/stdout.log",
    stderrPath: "logs/stderr.log",
    outputTruncated: false,
  };
}

describe("parseResults", () => {
  it("reads the fresh test report the command wrote, and ignores an old one", async () => {
    const base = expressRepo();
    const test = commandOf(await catalogOf(base, "."), "test");
    const report = "node_modules/.devflow-javascript-vitest.json";
    const fresh = base.with({
      [report]: { text: JSON.stringify(vitestReport), modifiedMs: FRESH },
    });
    const parsed = await adapter.parseResults(test, execution(test, 1), fresh);
    expect(parsed).toMatchObject({ parse: "parsed" });
    expect(parsed.tests).toHaveLength(5);
    expect(parsed.evidence.map((e) => [e.kind, e.path])).toEqual([
      ["execution", undefined],
      ["test-report", report],
    ]);

    const stale = base.with({
      [report]: { text: JSON.stringify(vitestReport), modifiedMs: STALE },
    });
    expect(await adapter.parseResults(test, execution(test, 0), stale)).toMatchObject({
      parse: "unparseable",
      tests: [],
      note: "no fresh JSON test report was written by this run",
    });
  });

  it("never reads a truncated report as complete", async () => {
    const base = expressRepo();
    const test = commandOf(await catalogOf(base, "."), "test");
    const text = JSON.stringify(vitestReport);
    const repo = base.with({
      "node_modules/.devflow-javascript-vitest.json": {
        text: text.slice(0, 200),
        modifiedMs: FRESH,
      },
    });
    expect(await adapter.parseResults(test, execution(test, 1), repo)).toMatchObject({
      parse: "unparseable",
      tests: [],
    });
  });

  it("notes an empty run and a failure outside the tests", async () => {
    const base = expressRepo();
    const test = commandOf(await catalogOf(base, "."), "test");
    const empty = { numTotalTests: 0, success: true, testResults: [] };
    const unhandled = {
      numTotalTests: 1,
      success: false,
      testResults: [
        {
          name: `${ROOT}/src/app.test.ts`,
          status: "passed",
          message: "",
          assertionResults: [
            { ancestorTitles: [], title: "starts", status: "passed", failureMessages: [] },
          ],
        },
      ],
    };
    const report = "node_modules/.devflow-javascript-vitest.json";
    const parse = (value: unknown) =>
      adapter.parseResults(
        test,
        execution(test, 0),
        base.with({ [report]: { text: JSON.stringify(value), modifiedMs: FRESH } }),
      );
    expect(await parse(empty)).toMatchObject({
      parse: "parsed",
      note: "the test report contains no tests",
    });
    expect((await parse(unhandled)).note).toContain("outside the individual tests");
    // A file that failed to load is itself the reported failure: no extra note.
    const loadFailure = {
      numTotalTests: 0,
      success: false,
      testResults: [
        {
          name: `${ROOT}/src/missing.test.ts`,
          status: "failed",
          message: "Failed to load url ./x (resolved id: ./x). Does the file exist?",
          assertionResults: [],
        },
      ],
    };
    const loaded = await parse(loadFailure);
    expect(loaded.tests).toMatchObject([{ outcome: "compile_error" }]);
    expect(loaded.note).toBeUndefined();
  });

  it("reads the ESLint report of a workspace root", async () => {
    const base = monorepoRepo();
    const lint = commandOf(await catalogOf(base, "."), "lint");
    expect(lint.results.reportGlobs).toEqual(["node_modules/.devflow-javascript-eslint.json"]);
    const report = [
      {
        filePath: `${ROOT}/apps/web/src/App.tsx`,
        messages: [
          { ruleId: "semi", severity: 2, message: "Missing semicolon.", line: 1, column: 5 },
        ],
      },
    ];
    const repo = base.with({
      "node_modules/.devflow-javascript-eslint.json": {
        text: JSON.stringify(report),
        modifiedMs: FRESH,
      },
    });
    expect(await adapter.parseResults(lint, execution(lint, 1), repo)).toMatchObject({
      parse: "parsed",
      diagnostics: [
        { tool: "eslint", ruleId: "semi", location: { path: "apps/web/src/App.tsx", line: 1 } },
      ],
      evidence: [{ kind: "execution" }, { kind: "tool-report" }],
    });
    expect(await adapter.parseResults(lint, execution(lint, 2), base)).toMatchObject({
      parse: "unparseable",
    });
  });

  it("decides tsc results from the output and the exit code", async () => {
    const base = monorepoRepo();
    const typecheck = commandOf(await catalogOf(base, "packages/api"), "typecheck");
    const withOutput = (stdout: string) =>
      base.with({ "logs/stdout.log": stdout, "logs/stderr.log": "" });
    const failed = await adapter.parseResults(
      typecheck,
      execution(typecheck, 2),
      withOutput("src/orders.service.ts(1,14): error TS2564: Property 'x' has no initializer.\n"),
    );
    expect(failed).toMatchObject({
      parse: "parsed",
      diagnostics: [
        { ruleId: "TS2564", location: { path: "packages/api/src/orders.service.ts", line: 1 } },
      ],
    });
    expect(
      await adapter.parseResults(typecheck, execution(typecheck, 0), withOutput("")),
    ).toMatchObject({
      parse: "parsed",
      diagnostics: [],
    });
    expect(await adapter.parseResults(typecheck, execution(typecheck, 0), base)).toMatchObject({
      parse: "parsed",
      note: "the compiler output could not be read; the result is the exit code",
    });
    expect(
      await adapter.parseResults(typecheck, execution(typecheck, 1), withOutput("Killed\n")),
    ).toMatchObject({
      parse: "unparseable",
      note: "the compiler failed, but its output names no error",
    });
    expect(await adapter.parseResults(typecheck, execution(typecheck, null), base)).toMatchObject({
      parse: "unparseable",
    });
  });

  it("reports exit-code tools and unknown parsers honestly", async () => {
    const base = expressRepo();
    const format = commandOf(await catalogOf(base, "."), "format-check");
    expect(await adapter.parseResults(format, execution(format, 1), base)).toMatchObject({
      parse: "parsed",
      note: "this tool reports its result through the exit code only",
    });
    expect(await adapter.parseResults(format, execution(format, null), base)).toMatchObject({
      parse: "unparseable",
    });
    const unknown = { ...format, results: { parser: "tap", reportGlobs: [] } };
    expect(await adapter.parseResults(unknown, execution(unknown, 0), base)).toMatchObject({
      parse: "unparseable",
    });
  });

  it("expands report globs from project configuration", async () => {
    const base = expressRepo();
    const test = commandOf(await catalogOf(base, "."), "test");
    const configured = {
      ...test,
      results: { parser: "jest-json", reportGlobs: ["reports/*.json"] },
    };
    const repo = base.with({
      "reports/unit.json": { text: JSON.stringify(vitestReport), modifiedMs: FRESH },
      "reports/old.json": { text: "{}", modifiedMs: STALE },
    });
    const parsed = await adapter.parseResults(configured, execution(configured, 1), repo);
    expect(parsed.evidence.map((e) => e.path)).toEqual([undefined, "reports/unit.json"]);
    expect(parsed.tests).toHaveLength(5);
  });
});

describe("conformance", () => {
  it("passes the shared adapter conformance checks on every fixture", async () => {
    const report = await checkAdapterConformance(javascriptAdapter, [
      { name: "express", repo: expressRepo(), expectedRoots: ["."] },
      {
        name: "monorepo",
        repo: monorepoRepo(),
        expectedRoots: [".", "apps/web", "packages/api", "packages/proto"],
      },
      { name: "mocha", repo: mochaRepo(), expectedRoots: ["."] },
      {
        name: "empty",
        repo: new MemoryRepository({ "README.md": "# nothing" }),
        expectedRoots: [],
      },
    ]);
    expect(report.failures).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(60);
  });
});
