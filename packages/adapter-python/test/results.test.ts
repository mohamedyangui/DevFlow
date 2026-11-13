import { readFileSync } from "node:fs";
import { validatedAdapter, type CommandSpec, type ExecutionRecord } from "@devflowai/core";
import {
  checkAdapterConformance,
  MemoryRepository,
  StaticToolchainProbe,
} from "@devflowai/core/testing";
import { describe, expect, it } from "vitest";
import {
  parseFlake8Output,
  parseMypyOutput,
  parsePytestJUnitXml,
  parseRuffJson,
  parseUnittestOutput,
  pythonAdapter,
} from "../src/index.js";
import { monorepoRepo, poetryRepo, unittestRepo, uvRepo } from "./fixtures.js";

const adapter = validatedAdapter(pythonAdapter);
const ROOT = "/memory/repo";
const output = (name: string) => readFileSync(new URL(`./output/${name}`, import.meta.url), "utf8");

/**
 * The JUnit XML pytest writes with --junitxml (xunit2), written by hand after pytest's format:
 * a passed test, an assertion failure, a setup error, a skip, an xfail, a pytest-timeout
 * failure, a parameterized test and a module that failed to collect.
 */
const PYTEST_REPORT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="pytest tests"><testsuite name="pytest" errors="2" failures="2" skipped="2" tests="8" time="0.120" timestamp="2026-11-10T10:00:00.000000+00:00" hostname="ci">
<testcase classname="tests.test_api" name="test_ac1_returns_the_second_page" time="0.010" />
<testcase classname="tests.test_api.TestOrders" name="test_ac2_ac3_totals" time="0.002"><failure message="assert 3 == 4&#10; +  where 3 = total()">def test_ac2_ac3_totals():
&gt;       assert total() == 4
E       assert 3 == 4</failure></testcase>
<testcase classname="tests.test_api" name="test_uses_db" time="0.001"><error message="failed on setup with &quot;RuntimeError: no database&quot;">RuntimeError: no database</error></testcase>
<testcase classname="tests.test_api" name="test_later" time="0.000"><skipped type="pytest.skip" message="not yet">tests/test_api.py:20: not yet</skipped></testcase>
<testcase classname="tests.test_api" name="test_known_bug" time="0.001"><skipped type="pytest.xfail" message="bug 12" /></testcase>
<testcase classname="tests.test_api" name="test_slow" time="5.001"><failure message="Failed: Timeout &gt;5.0s">Timeout</failure></testcase>
<testcase classname="tests.test_api" name="test_page[AC-4-2]" time="0.001" />
<testcase classname="" name="tests.test_broken" time="0.000"><error message="collection failure">ImportError while importing test module</error></testcase>
</testsuite></testsuites>
`;

function execution(
  command: CommandSpec,
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    commandId: command.id,
    argv: [command.executable, ...command.args],
    cwd: command.cwd,
    invocation: "direct",
    approval: { via: "allowlist-flag" },
    startedAt: "2026-11-10T10:00:00.000Z",
    durationMs: 1000,
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdoutPath: ".devflow/runs/r/logs/out.log",
    stderrPath: ".devflow/runs/r/logs/err.log",
    outputTruncated: false,
    ...overrides,
  };
}

const AFTER = Date.parse("2026-11-10T10:00:05.123Z");
const BEFORE = Date.parse("2026-11-10T09:00:00.123Z");

async function catalogOf(repo: MemoryRepository, root = ".") {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error("no module");
  const profile = await adapter.analyzeModule(candidate, repo);
  return adapter.commandCatalog(profile, new StaticToolchainProbe(["python3"], "linux"), repo);
}

function commandOf(catalog: readonly CommandSpec[], purpose: string): CommandSpec {
  const command = catalog.find((c) => c.purpose === purpose && c.parameters.length === 0);
  if (command === undefined) throw new Error(`no ${purpose} command`);
  return command;
}

describe("pytest JUnit XML", () => {
  it("reads outcomes, messages and durations", () => {
    const cases = parsePytestJUnitXml(PYTEST_REPORT);
    expect(cases?.map((c) => [c.name, c.outcome])).toEqual([
      ["test_ac1_returns_the_second_page", "passed"],
      ["test_ac2_ac3_totals", "assertion_failure"],
      ["test_uses_db", "runtime_error"],
      ["test_later", "skipped"],
      ["test_known_bug", "skipped"],
      ["test_slow", "timeout"],
      ["test_page[AC-4-2]", "passed"],
      ["tests.test_broken", "compile_error"],
    ]);
    expect(cases?.[1]).toMatchObject({
      durationMs: 2,
      message: "assert 3 == 4\n +  where 3 = total()",
    });
  });

  it("refuses truncated documents, other XML and entity declarations", () => {
    expect(parsePytestJUnitXml(PYTEST_REPORT.slice(0, 400))).toBeUndefined();
    expect(parsePytestJUnitXml("<checkstyle/>")).toBeUndefined();
    expect(
      parsePytestJUnitXml(
        '<!DOCTYPE x [<!ENTITY a "b">]><testsuite><testcase name="&a;"/></testsuite>',
      ),
    ).toBeUndefined();
  });

  it("parses only a report written by this run, with ids, files and markers", async () => {
    const base = uvRepo();
    const test = commandOf(await catalogOf(base), "test");
    const report = ".pytest_cache/devflow-python-junit.xml";
    const fresh = base.with({ [report]: { text: PYTEST_REPORT, modifiedMs: AFTER } });
    const parsed = await adapter.parseResults(test, execution(test), fresh);
    expect(parsed.parse).toBe("parsed");
    expect(parsed.tests.slice(0, 2)).toEqual([
      {
        id: "tests.test_api#test_ac1_returns_the_second_page",
        name: "test_ac1_returns_the_second_page",
        file: "tests/test_api.py",
        outcome: "passed",
        status: "passed",
        markers: ["AC-1"],
        durationMs: 10,
      },
      expect.objectContaining({
        id: "tests.test_api.TestOrders#test_ac2_ac3_totals",
        file: "tests/test_api.py",
        status: "failed",
        markers: ["AC-2", "AC-3"],
      }),
    ]);
    expect(parsed.tests.find((t) => t.name === "test_page[AC-4-2]")?.markers).toEqual(["AC-4"]);
    expect(parsed.tests.at(-1)).toMatchObject({
      id: "tests.test_broken",
      outcome: "compile_error",
    });
    expect(parsed.evidence.map((e) => e.path)).toContain(report);

    const stale = base.with({ [report]: { text: PYTEST_REPORT, modifiedMs: BEFORE } });
    expect(await adapter.parseResults(test, execution(test), stale)).toMatchObject({
      parse: "unparseable",
      tests: [],
    });
    const usage = await adapter.parseResults(test, execution(test, { exitCode: 4 }), fresh);
    expect(usage).toMatchObject({
      parse: "unparseable",
      note: expect.stringContaining("usage error") as unknown,
    });
  });
});

describe("unittest output", () => {
  it("reads the verbose output of Python 3.10 (captured from a real run)", () => {
    const cases = parseUnittestOutput(output("unittest-py310.txt"));
    expect(cases?.map((c) => [c.classname, c.name, c.outcome])).toEqual([
      ["unittest.loader._FailedTest", "tests.test_broken", "compile_error"],
      ["tests.test_calc.TestCalc", "test_ac1_adds", "passed"],
      ["tests.test_calc.TestCalc", "test_doc", "passed"],
      ["tests.test_calc.TestCalc", "test_errors", "runtime_error"],
      ["tests.test_calc.TestCalc", "test_fails", "assertion_failure"],
      ["tests.test_calc.TestCalc", "test_skipped", "skipped"],
      ["tests.test_calc.TestCalc", "test_sub", "assertion_failure"],
      ["tests.test_calc.TestCalc", "test_xfail", "passed"],
    ]);
    expect(cases?.[0]?.message).toBe("ModuleNotFoundError: No module named 'nope'");
    expect(cases?.[4]?.message).toBe("AssertionError: 3 != 4");
  });

  it("reads the Python 3.11+ format, fixtures errors and unexpected successes", () => {
    const text = [
      "test_ac1_ok (tests.test_x.TestX.test_ac1_ok) ... ok",
      "test_odd (tests.test_x.TestX.test_odd) ... unexpected success",
      "setUpClass (tests.test_y.TestY) ... ERROR",
      "",
      "======================================================================",
      "ERROR: setUpClass (tests.test_y.TestY)",
      "----------------------------------------------------------------------",
      "Traceback (most recent call last):",
      "OSError: no fixture",
      "",
      "----------------------------------------------------------------------",
      "Ran 2 tests in 0.001s",
      "",
      "FAILED (errors=1, unexpected successes=1)",
    ].join("\n");
    expect(
      parseUnittestOutput(text)?.map((c) => [c.classname, c.name, c.outcome, c.message]),
    ).toEqual([
      ["tests.test_x.TestX", "test_ac1_ok", "passed", undefined],
      [
        "tests.test_x.TestX",
        "test_odd",
        "assertion_failure",
        "the test was expected to fail but passed",
      ],
      ["tests.test_y.TestY", "setUpClass", "runtime_error", "OSError: no fixture"],
    ]);
  });

  it("refuses output it cannot fully account for", () => {
    expect(parseUnittestOutput("test_a (m.T) ... ok\n")).toBeUndefined();
    expect(
      parseUnittestOutput(`test_a (m.T) ... ok\n${"-".repeat(70)}\nRan 2 tests in 0.0s\n\nOK\n`),
    ).toBeUndefined();
    expect(parseUnittestOutput(`${"-".repeat(70)}\nRan 0 tests in 0.0s\n\nNO TESTS RAN\n`)).toEqual(
      [],
    );
  });

  it("reads the stderr log of an execution", async () => {
    const base = unittestRepo();
    const test = commandOf(await catalogOf(base), "test");
    const record = execution(test, { exitCode: 0 });
    const ok = [
      "test_low (tests.test_levels.TestLevels) ... ok",
      "test_ac1_reserves (tests.test_stock.TestStock) ... ok",
      "",
      "-".repeat(70),
      "Ran 2 tests in 0.000s",
      "",
      "OK",
    ].join("\n");
    const parsed = await adapter.parseResults(test, record, base.with({ [record.stderrPath]: ok }));
    expect(parsed.tests.map((t) => [t.id, t.file, t.status, t.markers])).toEqual([
      ["tests.test_levels.TestLevels#test_low", "tests/test_levels.py", "passed", []],
      ["tests.test_stock.TestStock#test_ac1_reserves", "tests/test_stock.py", "passed", ["AC-1"]],
    ]);
    expect(await adapter.parseResults(test, record, base)).toMatchObject({ parse: "unparseable" });
  });
});

describe("linters and type checkers", () => {
  it("reads Ruff JSON with absolute paths", () => {
    const report = JSON.stringify([
      {
        code: "F401",
        message: "`os` imported but unused",
        filename: `${ROOT}/src/shop/api.py`,
        location: { row: 1, column: 8 },
        end_location: { row: 1, column: 10 },
      },
      {
        code: null,
        message: "SyntaxError: Expected an expression",
        filename: "/elsewhere/x.py",
        location: { row: 2, column: 1 },
      },
    ]);
    expect(parseRuffJson(report, ROOT, ".")).toEqual([
      {
        tool: "ruff",
        severity: "error",
        message: "`os` imported but unused",
        ruleId: "F401",
        location: { path: "src/shop/api.py", line: 1, column: 8, endLine: 1 },
      },
      { tool: "ruff", severity: "error", message: "SyntaxError: Expected an expression" },
    ]);
    expect(parseRuffJson("[]\n", ROOT, ".")).toEqual([]);
    expect(parseRuffJson("{}", ROOT, ".")).toBeUndefined();
  });

  it("reads flake8's default format", () => {
    expect(
      parseFlake8Output(
        "books\\models.py:3:1: E302 expected 2 blank lines, found 1\n./manage.py:9:80: W291 trailing whitespace\n",
        ROOT,
        ".",
      ),
    ).toEqual([
      {
        tool: "flake8",
        severity: "error",
        message: "expected 2 blank lines, found 1",
        ruleId: "E302",
        location: { path: "books/models.py", line: 3, column: 1 },
      },
      {
        tool: "flake8",
        severity: "warning",
        message: "trailing whitespace",
        ruleId: "W291",
        location: { path: "manage.py", line: 9, column: 80 },
      },
    ]);
  });

  it("reads mypy output (captured from mypy 0.931 on Windows)", () => {
    expect(parseMypyOutput(output("mypy-0931.txt"), ROOT, "services/worker")).toEqual([
      {
        tool: "mypy",
        severity: "error",
        message: 'Cannot find implementation or library stub for module named "nope"',
        ruleId: "import",
        location: { path: "services/worker/tests/test_broken.py", line: 1, column: 1 },
      },
      {
        tool: "mypy",
        severity: "info",
        message: "See https://mypy.readthedocs.io/en/stable/running_mypy.html#missing-imports",
        location: { path: "services/worker/tests/test_broken.py", line: 1, column: 1 },
      },
      {
        tool: "mypy",
        severity: "error",
        message: 'Incompatible return value type (got "int", expected "str")',
        ruleId: "return-value",
        location: { path: "services/worker/pkg/calc.py", line: 6, column: 12 },
      },
    ]);
  });

  it("never reads a failed tool run as a pass", async () => {
    const repo = uvRepo();
    const catalog = await catalogOf(repo);
    const lint = commandOf(catalog, "lint");
    const typecheck = commandOf(catalog, "typecheck");
    const record = (exitCode: number | null) => execution(lint, { exitCode });
    const withOut = (text: string) => repo.with({ [record(0).stdoutPath]: text });
    expect(await adapter.parseResults(lint, record(1), withOut("[]"))).toMatchObject({
      parse: "unparseable",
    });
    expect(await adapter.parseResults(lint, record(2), withOut(""))).toMatchObject({
      parse: "unparseable",
    });
    expect(await adapter.parseResults(lint, record(null), withOut("[]"))).toMatchObject({
      parse: "unparseable",
    });
    expect(await adapter.parseResults(lint, record(0), withOut("[]"))).toMatchObject({
      parse: "parsed",
      diagnostics: [],
    });
    const missing = await adapter.parseResults(
      typecheck,
      execution(typecheck, { exitCode: 1 }),
      repo.with({ [record(0).stderrPath]: "C:\\Python\\python.exe: No module named mypy\n" }),
    );
    expect(missing).toMatchObject({ parse: "unparseable" });
    const failed = await adapter.parseResults(
      typecheck,
      execution(typecheck, { exitCode: 1 }),
      repo.with({ [record(0).stdoutPath]: output("mypy-0931.txt") }),
    );
    expect(failed.parse).toBe("parsed");
    expect(failed.diagnostics.filter((d) => d.severity === "error")).toHaveLength(2);
  });
});

describe("conformance", () => {
  it("passes the adapter conformance kit", async () => {
    const report = await checkAdapterConformance(pythonAdapter, [
      { name: "uv", repo: uvRepo(), expectedRoots: ["."] },
      { name: "poetry", repo: poetryRepo(), expectedRoots: ["."] },
      {
        name: "monorepo",
        repo: monorepoRepo(),
        expectedRoots: ["libs/common", "services/api", "services/worker"],
      },
      { name: "unittest", repo: unittestRepo(), expectedRoots: ["."] },
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
