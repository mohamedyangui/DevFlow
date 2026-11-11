import { describe, expect, it, vi } from "vitest";
import {
  DevflowError,
  ErrorCode,
  SecretRedactor,
  decideGate,
  defaultGates,
  runGate,
  runGates,
  validatedAdapter,
  verificationOutcome,
  withExecutionLogs,
  type ApprovedCommand,
  type CommandSpec,
  type ExecutionRecord,
  type ExecuteOptions,
  type ExecutionResult,
  type GateDefinition,
  type GateEvent,
  type GateResult,
  type LanguageAdapter,
  type ParsedCommandResults,
  type PolicyDecision,
  type TestCaseResult,
  type VerificationOptions,
  type WorkspaceModule,
} from "../../src/index.js";
import { MemoryRepository, StaticToolchainProbe } from "../../src/testing/index.js";
import { toyAdapter } from "../adapters/toy-adapter.js";

const STARTED_AT = "2026-03-01T10:00:00.000Z";
const SECRET = "tok-9f8e7d6c5b4a3210";

function testCommand(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "toy:test",
    purpose: "test",
    executable: "toy",
    args: ["test"],
    cwd: "toy",
    env: {},
    timeoutMs: 60_000,
    network: "none",
    parameters: [],
    results: { parser: "toy-report", reportGlobs: ["toy-report.json"] },
    origin: "adapter",
    ...overrides,
  };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    commandId: "toy:test",
    argv: ["toy", "test"],
    cwd: "toy",
    invocation: "direct",
    approval: { via: "allowlist-flag" },
    startedAt: STARTED_AT,
    durationMs: 12,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdoutPath: ".devflow/runs/verify/x/logs/toy_test.stdout.log",
    stderrPath: ".devflow/runs/verify/x/logs/toy_test.stderr.log",
    outputTruncated: false,
    ...overrides,
  };
}

function test(id: string, outcome: TestCaseResult["outcome"]): TestCaseResult {
  const status = {
    passed: "passed",
    assertion_failure: "failed",
    runtime_error: "failed",
    skipped: "skipped",
    compile_error: "not_executed",
    not_found: "not_executed",
    not_executed: "not_executed",
    infrastructure_error: "unverified",
    timeout: "unverified",
  } as const;
  return { id, name: id, outcome, status: status[outcome], markers: [] };
}

function parsed(overrides: Partial<ParsedCommandResults> = {}): ParsedCommandResults {
  return { parse: "parsed", tests: [], diagnostics: [], evidence: [], ...overrides };
}

const repo = new MemoryRepository({
  "toy/toy.json": '{ "runner": "toy" }',
  "toy/toy-report.json": { text: '["a", "b"]', modifiedMs: Date.parse(STARTED_AT) + 500 },
});

async function moduleFor(adapter: LanguageAdapter): Promise<WorkspaceModule> {
  const validated = validatedAdapter(adapter);
  const [candidate] = await validated.detectModules(repo);
  if (candidate === undefined) throw new Error("no toy module");
  const profile = await validated.analyzeModule(candidate, repo);
  return { adapter: validated, candidate, profile };
}

const allow: VerificationOptions["policy"] = {
  evaluate: (request) => {
    const spec = request.spec as CommandSpec;
    return Promise.resolve({
      allowed: true,
      command: {
        commandId: spec.id,
        spec,
        approval: { via: "allowlist-flag" },
      } as unknown as ApprovedCommand,
    });
  },
};

const invocation: ExecutionResult["invocation"] = {
  strategy: "direct",
  file: "toy",
  args: ["test"],
  windowsVerbatimArguments: false,
};

function fakeExecutor(result: Partial<ExecutionResult> = {}) {
  const run = vi.fn<
    (command: ApprovedCommand, options: ExecuteOptions) => Promise<ExecutionResult>
  >(() =>
    Promise.resolve<ExecutionResult>({
      record: record(),
      stdout: "",
      stderr: "",
      invocation,
      ...result,
    }),
  );
  return { executor: { run }, run };
}

async function options(overrides: Partial<VerificationOptions> = {}): Promise<VerificationOptions> {
  return {
    repo,
    modules: [await moduleFor(toyAdapter())],
    policy: allow,
    executor: fakeExecutor().executor,
    toolchain: new StaticToolchainProbe(["toy"]),
    redactor: new SecretRedactor({ knownSecrets: [SECRET] }),
    logDir: ".devflow/runs/verify/x/logs",
    ...overrides,
  };
}

const gate: GateDefinition = { id: "toy-test", module: "toy", use: "test", required: true };

describe("decideGate", () => {
  const cases: [
    string,
    Partial<ExecutionRecord>,
    Partial<ParsedCommandResults>,
    string,
    RegExp?,
  ][] = [
    ["a timeout", { timedOut: true, exitCode: null }, {}, "unverified", /timed out after 60 s/],
    ["an end by signal", { exitCode: null, signal: "SIGTERM" }, {}, "unverified", /SIGTERM/],
    ["no exit code", { exitCode: null }, {}, "unverified", /did not exit normally/],
    [
      "a non-zero exit code with failed tests",
      { exitCode: 1 },
      { tests: [test("a", "passed"), test("b", "assertion_failure")] },
      "failed",
      /^exit code 1: 1 failed test$/,
    ],
    [
      "a non-zero exit code with tests that did not load",
      { exitCode: 1 },
      { tests: [test("a", "compile_error"), test("b", "compile_error")] },
      "failed",
      /^exit code 1: 2 tests without a trustworthy result$/,
    ],
    [
      "a non-zero exit code and unreadable results",
      { exitCode: 2 },
      { parse: "unparseable", note: "no report" },
      "failed",
      /^exit code 2; the results could not be read \(no report\)$/,
    ],
    [
      "a non-zero exit code even when every test passed",
      { exitCode: 1 },
      { tests: [test("a", "passed")] },
      "failed",
      /^exit code 1$/,
    ],
    [
      "exit code 0 and unreadable results",
      {},
      { parse: "unparseable", note: "the report is truncated" },
      "unverified",
      /exit code 0, but the results could not be read \(the report is truncated\)/,
    ],
    [
      "exit code 0 with a failed test",
      {},
      { tests: [test("a", "runtime_error")] },
      "failed",
      /exit code 0, but 1 test failed/,
    ],
    [
      "exit code 0 with an error diagnostic",
      {},
      { diagnostics: [{ tool: "toy", severity: "error", message: "bad" }] },
      "failed",
      /reported 1 error/,
    ],
    [
      "exit code 0 with a timed-out test",
      {},
      { tests: [test("a", "passed"), test("b", "timeout")] },
      "unverified",
      /1 test ran without a trustworthy result/,
    ],
    ["a test command that ran no tests", {}, {}, "unverified", /the test command ran no tests/],
    [
      "a test command whose tests were all skipped",
      {},
      { tests: [test("a", "skipped"), test("b", "skipped")] },
      "skipped",
      /all 2 tests were skipped/,
    ],
    [
      "passed and skipped tests",
      {},
      { tests: [test("a", "passed"), test("b", "skipped")] },
      "passed",
    ],
  ];

  it.each(cases)("decides %s", (_name, execution, results, status, reason) => {
    const decided = decideGate(testCommand(), record(execution), parsed(results));
    expect(decided.status).toBe(status);
    if (reason === undefined) expect(decided.reason).toBeUndefined();
    else expect(decided.reason).toMatch(reason);
  });

  it("passes a lint command with only warnings and no tests", () => {
    const lint = testCommand({ id: "toy:lint", purpose: "lint" });
    const decided = decideGate(
      lint,
      record(),
      parsed({ diagnostics: [{ tool: "toy", severity: "warning", message: "style" }] }),
    );
    expect(decided).toEqual({ status: "passed" });
  });
});

describe("runGate", () => {
  it("runs the module's command and reads its results", async () => {
    const events: GateEvent[] = [];
    const { executor, run } = fakeExecutor();
    const outcome = await runGate(
      gate,
      await options({ executor, onEvent: (e) => events.push(e) }),
    );
    expect(outcome.denial).toBeUndefined();
    expect(outcome.result).toMatchObject({
      gateId: "toy-test",
      commandId: "toy:test",
      required: true,
      status: "passed",
      execution: { exitCode: 0 },
    });
    expect(outcome.result.tests.map((t) => t.id)).toEqual(["a", "b"]);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ commandId: "toy:test" }), {
      logDir: ".devflow/runs/verify/x/logs",
    });
    expect(events.map((e) => e.type)).toEqual(["gate-started", "gate-finished"]);
    expect(events[0]).toMatchObject({ commandId: "toy:test" });
  });

  it("does not execute a gate for an unknown module", async () => {
    const outcome = await runGate({ ...gate, module: "nope" }, await options());
    expect(outcome.result).toMatchObject({
      commandId: "nope:test",
      status: "not_executed",
      reason: 'no module "nope" (known modules: toy)',
    });
    expect(outcome.result.execution).toBeUndefined();
  });

  it("does not execute a gate whose module has no such command", async () => {
    const outcome = await runGate({ ...gate, use: "lint" }, await options());
    expect(outcome.result).toMatchObject({
      status: "not_executed",
      reason: 'module toy has no "lint" command (it has: test)',
    });
  });

  it("does not execute a gate whose tool is missing", async () => {
    const adapter = toyAdapter({ commandCatalog: () => Promise.resolve([testCommand()]) });
    const { executor, run } = fakeExecutor();
    const outcome = await runGate(
      gate,
      await options({
        modules: [await moduleFor(adapter)],
        executor,
        toolchain: new StaticToolchainProbe({ toy: { available: false } }),
      }),
    );
    expect(outcome.result).toMatchObject({
      status: "not_executed",
      reason: "toy was not found on PATH, so toy:test could not run",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("records a policy denial and runs nothing", async () => {
    const fingerprint = "f".repeat(64);
    const { executor, run } = fakeExecutor();
    const deny = {
      evaluate: () =>
        Promise.resolve<PolicyDecision>({
          allowed: false,
          reason: "approval-required",
          message: `approval required: command toy:test (fingerprint ${fingerprint})`,
          fingerprint,
        }),
    };
    const outcome = await runGate(gate, await options({ policy: deny, executor }));
    expect(outcome.result).toMatchObject({
      status: "not_executed",
      reason: expect.stringMatching(/^denied by the command policy: approval required/) as string,
    });
    expect(outcome.denial).toEqual({
      gateId: "toy-test",
      commandId: "toy:test",
      argv: ["toy", "test"],
      cwd: "toy",
      reason: "approval-required",
      message: `approval required: command toy:test (fingerprint ${fingerprint})`,
      fingerprint,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not execute a gate whose command could not be started", async () => {
    const executor = {
      run: () =>
        Promise.reject(
          new DevflowError(ErrorCode.ExecutableNotFound, 'executable "toy" was not found on PATH'),
        ),
    };
    const outcome = await runGate(gate, await options({ executor }));
    expect(outcome.result).toMatchObject({
      status: "not_executed",
      reason: 'toy:test could not be started: executable "toy" was not found on PATH',
    });
  });

  it("lets unexpected errors through", async () => {
    const executor = { run: () => Promise.reject(new TypeError("bug")) };
    await expect(runGate(gate, await options({ executor }))).rejects.toThrow("bug");
  });

  it("is unverified when the parser fails, even with exit code 0", async () => {
    const adapter = toyAdapter({
      parseResults: () =>
        Promise.reject(new DevflowError(ErrorCode.AdapterInvalid, "parser broke")),
    });
    const outcome = await runGate(gate, await options({ modules: [await moduleFor(adapter)] }));
    expect(outcome.result).toMatchObject({
      status: "unverified",
      reason: expect.stringContaining("the results could not be read: ") as string,
      execution: { exitCode: 0 },
    });
  });

  it("is not executed when cancelled before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const { executor, run } = fakeExecutor();
    const outcome = await runGate(gate, await options({ executor, signal: controller.signal }));
    expect(outcome.result).toMatchObject({
      status: "not_executed",
      reason: "cancelled before the gate ran",
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("redacts secrets in test messages, diagnostics, evidence and notes", async () => {
    const adapter = toyAdapter({
      parseResults: () =>
        Promise.resolve({
          parse: "parsed" as const,
          tests: [{ ...test("a", "assertion_failure"), message: `expected ${SECRET}` }],
          diagnostics: [{ tool: "toy", severity: "warning" as const, message: SECRET }],
          evidence: [
            {
              kind: "log-excerpt" as const,
              path: "toy/out.txt",
              description: `log ${SECRET}`,
              deterministic: true,
              excerpt: SECRET,
            },
          ],
          note: `note ${SECRET}`,
        }),
    });
    const outcome = await runGate(
      gate,
      await options({
        modules: [await moduleFor(adapter)],
        executor: fakeExecutor({ record: record({ exitCode: 1 }) }).executor,
      }),
    );
    const text = JSON.stringify(outcome.result);
    expect(text).not.toContain(SECRET);
    expect(outcome.result.status).toBe("failed");
    expect(outcome.result.tests[0]?.message).toMatch(/^expected \S+/);
  });
});

describe("runGate with a test selection", () => {
  const filtered = testCommand({
    id: "toy:test-filter",
    args: ["test", "{name}"],
    parameters: [
      { name: "name", description: "a test name", pattern: "^[A-Za-z0-9_=#.*]+$", maxLength: 64 },
    ],
  });
  const catalogWith = (adapter: LanguageAdapter): LanguageAdapter => ({
    ...adapter,
    commandCatalog: () => Promise.resolve([testCommand(), filtered]),
  });
  function recordingPolicy() {
    const params: unknown[] = [];
    const policy: VerificationOptions["policy"] = {
      evaluate: (request) => {
        params.push(request.params);
        return allow.evaluate(request);
      },
    };
    return { policy, params };
  }

  it("passes the test name as the parameter when the adapter has no testSelection", async () => {
    const { policy, params } = recordingPolicy();
    const module = await moduleFor(catalogWith(toyAdapter()));
    const outcome = await runGate(gate, await options({ modules: [module], policy }), {
      filter: "returnsPage",
      testFile: "toy/PageTest.toy",
    });
    expect(outcome.result.commandId).toBe("toy:test-filter");
    expect(params).toEqual([{ name: "returnsPage" }]);
  });

  it("uses the adapter's testSelection with the test file and name", async () => {
    const { policy, params } = recordingPolicy();
    const testSelection = vi.fn(
      (_profile: unknown, test: { file: string; name: string }) => `sel=${test.name}#file`,
    );
    const module = await moduleFor(catalogWith(toyAdapter({ testSelection })));
    await runGate(gate, await options({ modules: [module], policy }), {
      filter: "returnsPage",
      testFile: "toy/PageTest.toy",
    });
    expect(testSelection).toHaveBeenCalledWith(expect.objectContaining({ moduleId: "toy" }), {
      file: "toy/PageTest.toy",
      name: "returnsPage",
    });
    expect(params).toEqual([{ name: "sel=returnsPage#file" }]);
  });

  it("falls back to the name when testSelection returns undefined", async () => {
    const { policy, params } = recordingPolicy();
    const module = await moduleFor(catalogWith(toyAdapter({ testSelection: () => undefined })));
    await runGate(gate, await options({ modules: [module], policy }), {
      filter: "returnsPage",
      testFile: "toy/PageTest.toy",
    });
    expect(params).toEqual([{ name: "returnsPage" }]);
  });

  it("does not execute the gate when testSelection throws", async () => {
    const { executor, run } = fakeExecutor();
    const module = await moduleFor(
      catalogWith(
        toyAdapter({
          testSelection: () => {
            throw new Error("boom");
          },
        }),
      ),
    );
    const outcome = await runGate(gate, await options({ modules: [module], executor }), {
      filter: "returnsPage",
      testFile: "toy/PageTest.toy",
    });
    expect(outcome.result.status).toBe("not_executed");
    expect(outcome.result.reason).toMatch(/could not select the test/);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("withExecutionLogs", () => {
  it("serves the command's logs from the executor's output", async () => {
    const executed = {
      record: record(),
      stdout: "redacted out",
      stderr: "redacted err",
      invocation: { strategy: "direct", file: "toy", args: [], windowsVerbatimArguments: false },
    } as ExecutionResult;
    const view = withExecutionLogs(repo, executed);
    expect(await view.readText(executed.record.stdoutPath)).toBe("redacted out");
    expect(await view.readText(executed.record.stderrPath)).toBe("redacted err");
    expect(await view.exists(executed.record.stdoutPath)).toBe(true);
    expect(await view.readText("toy/toy.json")).toBe('{ "runner": "toy" }');
    expect(await view.exists("toy/missing.txt")).toBe(false);
  });
});

describe("runGates and defaultGates", () => {
  it("proposes one required test gate per module with a test command", async () => {
    const opts = await options();
    expect(await defaultGates(opts.modules, repo, opts.toolchain)).toEqual([
      { id: "toy-test", module: "toy", use: "test", required: true },
    ]);
    expect(await defaultGates(opts.modules, repo, new StaticToolchainProbe([]))).toEqual([]);
  });

  it("runs every gate in order and collects the denials", async () => {
    let calls = 0;
    const policy = {
      evaluate: async (request: Parameters<VerificationOptions["policy"]["evaluate"]>[0]) => {
        calls += 1;
        if (calls === 2) {
          return {
            allowed: false as const,
            reason: "rejected-by-user" as const,
            message: "the command was rejected",
          };
        }
        return allow.evaluate(request);
      },
    };
    const run = await runGates(
      [gate, { ...gate, id: "again" }, { ...gate, id: "lint", use: "lint", required: false }],
      await options({ policy }),
    );
    expect(run.gates.map((g) => [g.gateId, g.status])).toEqual([
      ["toy-test", "passed"],
      ["again", "not_executed"],
      ["lint", "not_executed"],
    ]);
    expect(run.denials.map((d) => [d.gateId, d.reason])).toEqual([["again", "rejected-by-user"]]);
  });
});

describe("verificationOutcome", () => {
  const result = (gateId: string, status: GateResult["status"], required = true): GateResult => ({
    gateId,
    commandId: `${gateId}:cmd`,
    required,
    status,
    ...(status === "passed" || status === "failed" || status === "skipped"
      ? { execution: record() }
      : {}),
    ...(status === "not_executed" || status === "unverified" ? { reason: "why" } : {}),
    tests: [],
    diagnostics: [],
    evidence: [],
  });
  const denial = (gateId: string) => ({
    gateId,
    commandId: `${gateId}:cmd`,
    argv: ["cmd"],
    cwd: ".",
    reason: "approval-required" as const,
    message: "approval required",
  });

  it("passes only when every required gate passed", () => {
    expect(
      verificationOutcome({
        gates: [result("a", "passed"), result("b", "failed", false)],
        denials: [],
      }),
    ).toBe("passed");
    expect(
      verificationOutcome({ gates: [result("a", "passed"), result("b", "skipped")], denials: [] }),
    ).toBe("failed");
    expect(verificationOutcome({ gates: [result("a", "unverified")], denials: [] })).toBe("failed");
  });

  it("is denied when the only required gates that did not pass were denied", () => {
    expect(
      verificationOutcome({
        gates: [result("a", "passed"), result("b", "not_executed")],
        denials: [denial("b")],
      }),
    ).toBe("denied");
    expect(
      verificationOutcome({
        gates: [result("a", "failed"), result("b", "not_executed")],
        denials: [denial("b")],
      }),
    ).toBe("failed");
  });

  it("fails when no gate ran, and counts optional gates when they are all that ran", () => {
    expect(verificationOutcome({ gates: [], denials: [] })).toBe("failed");
    expect(verificationOutcome({ gates: [result("a", "passed", false)], denials: [] })).toBe(
      "passed",
    );
    expect(verificationOutcome({ gates: [result("a", "failed", false)], denials: [] })).toBe(
      "failed",
    );
  });
});
