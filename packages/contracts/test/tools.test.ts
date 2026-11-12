import { readFileSync } from "node:fs";
import {
  CommandSpec,
  DevflowError,
  ErrorCode,
  StaticToolchainProbe,
  substituteParameters,
  type ApprovedCommand,
  type CommandRequest,
  type ExecuteOptions,
  type ExecutionRecord,
  type ExecutionResult,
  type PolicyDecision,
} from "@devflow-ai/core";
import { describe, expect, it, vi } from "vitest";
import {
  BUF_COMMAND,
  CONTRACT_PATH_PATTERN,
  ContractDiff,
  OASDIFF_COMMAND,
  compareContract,
  parseBufOutput,
  parseOasdiffOutput,
  runContractTool,
  type ContractToolset,
} from "../src/index.js";

/**
 * oasdiff and buf are not installed where these tests run: the tool path is tested with a
 * fake policy and a fake executor that returns recorded output (test/fixtures/tools).
 */

const recorded = (name: string) =>
  readFileSync(new URL(`./fixtures/tools/${name}`, import.meta.url), "utf8");
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function record(
  exitCode: number | null,
  overrides: Partial<ExecutionRecord> = {},
): ExecutionRecord {
  return {
    commandId: "contracts:tool",
    argv: ["tool", "breaking"],
    cwd: ".",
    invocation: "direct",
    approval: { via: "allowlist-flag" },
    startedAt: "2026-11-10T10:00:00.000Z",
    durationMs: 10,
    exitCode,
    signal: null,
    timedOut: false,
    stdoutPath: ".devflow/runs/x/logs/tool.stdout.log",
    stderrPath: ".devflow/runs/x/logs/tool.stderr.log",
    outputTruncated: false,
    ...overrides,
  };
}

/** Allows every command, as the policy would after an approval, substituting parameters. */
function allowingPolicy() {
  return vi.fn((request: CommandRequest): Promise<PolicyDecision> => {
    const spec = CommandSpec.parse(request.spec);
    const args = substituteParameters(spec, request.params ?? {});
    if (typeof args === "string") {
      return Promise.resolve({ allowed: false, reason: "invalid-parameter", message: args });
    }
    return Promise.resolve({
      allowed: true,
      command: {
        commandId: spec.id,
        spec,
        args,
        approval: { via: "allowlist-flag" },
      } as unknown as ApprovedCommand,
    });
  });
}

function toolset(
  options: {
    available?: readonly string[];
    result?: Partial<ExecutionResult> & { record: ExecutionRecord };
    policy?: ContractToolset["policy"]["evaluate"];
    run?: (command: ApprovedCommand, options: ExecuteOptions) => Promise<ExecutionResult>;
  } = {},
) {
  const evaluate = options.policy ?? allowingPolicy();
  const run = vi.fn(
    options.run ??
      ((command: ApprovedCommand) =>
        Promise.resolve<ExecutionResult>({
          stdout: "",
          stderr: "",
          invocation: {
            strategy: "direct",
            file: command.spec.executable,
            args: [...command.args],
            windowsVerbatimArguments: false,
          },
          ...(options.result ?? { record: record(0) }),
        })),
  );
  const set: ContractToolset = {
    toolchain: new StaticToolchainProbe(options.available ?? ["oasdiff", "buf"]),
    policy: { evaluate },
    executor: { run },
    logDir: ".devflow/runs/x/logs/contracts",
  };
  return { set, run, evaluate };
}

describe("tool commands", () => {
  it("are valid command specs with parameters for the two files", () => {
    expect(OASDIFF_COMMAND.args).toEqual(["breaking", "{base}", "{head}", "--format", "json"]);
    expect(BUF_COMMAND.args).toEqual([
      "breaking",
      "{head}",
      "--against",
      "{base}",
      "--error-format",
      "json",
    ]);
    for (const spec of [OASDIFF_COMMAND, BUF_COMMAND]) {
      expect(spec.network).toBe("none");
      expect(spec.cwd).toBe(".");
    }
  });

  it("accept workspace-relative paths only", () => {
    const pattern = new RegExp(CONTRACT_PATH_PATTERN, "u");
    for (const ok of ["api/openapi.yaml", ".devflow/runs/r1/contracts/base/api/openapi.yaml"]) {
      expect(pattern.test(ok)).toBe(true);
    }
    for (const bad of [
      "/etc/passwd",
      "../outside.yaml",
      "a/../../b",
      "-x",
      "C:\\a",
      "a b",
      "a\\b",
    ]) {
      expect(pattern.test(bad)).toBe(false);
    }
  });
});

describe("oasdiff output", () => {
  it("maps levels to compatibility and keeps the location", () => {
    const changes = parseOasdiffOutput(recorded("oasdiff-breaking.json"), "api/openapi.yaml");
    if (typeof changes === "string") throw new Error(changes);
    expect(changes.map((change) => [change.rule, change.compatibility])).toEqual([
      ["api-removed-without-deprecation", "breaking"],
      ["response-property-removed", "breaking"],
      ["response-property-enum-value-added", "unknown"],
    ]);
    expect(changes[0]).toEqual({
      kind: "openapi",
      rule: "api-removed-without-deprecation",
      compatibility: "breaking",
      decidedBy: "tool:oasdiff",
      location: { file: "api/openapi.yaml", path: "/pets/{id}", method: "delete" },
      message: "DELETE /pets/{id}: api removed without deprecation",
    });
  });

  it("accepts string levels and empty output", () => {
    const changes = parseOasdiffOutput(
      JSON.stringify([
        { id: "a", level: "info", text: "x" },
        { id: "b", level: "error" },
      ]),
      "f",
    );
    if (typeof changes === "string") throw new Error(changes);
    expect(changes.map((change) => change.compatibility)).toEqual(["non-breaking", "breaking"]);
    expect(changes[1]?.message).toBe("b");
    expect(parseOasdiffOutput("", "f")).toEqual([]);
    expect(parseOasdiffOutput("null\n", "f")).toEqual([]);
    expect(parseOasdiffOutput("[]", "f")).toEqual([]);
  });

  it("refuses output it cannot read", () => {
    expect(parseOasdiffOutput("Error: boom", "f")).toBe("the output of oasdiff is not JSON");
    expect(parseOasdiffOutput('{"id":"x"}', "f")).toBe(
      "the output of oasdiff does not have the expected shape",
    );
  });
});

describe("buf output", () => {
  it("maps every annotation to a breaking change", () => {
    const changes = parseBufOutput(recorded("buf-breaking.jsonl"), "proto/orders.proto");
    if (typeof changes === "string") throw new Error(changes);
    expect(
      changes.map((change) => [change.rule, change.compatibility, change.location.line]),
    ).toEqual([
      ["FIELD_NO_DELETE", "breaking", 10],
      ["FIELD_SAME_TYPE", "breaking", 19],
      ["SERVICE_NO_DELETE", "breaking", undefined],
    ]);
    expect(changes.every((change) => change.decidedBy === "tool:buf")).toBe(true);
  });

  it("refuses output it cannot read", () => {
    expect(parseBufOutput("orders.proto:1:1:boom", "f")).toBe(
      "the output of buf is not JSON lines",
    );
    expect(parseBufOutput('{"path":"x"}', "f")).toBe(
      "the output of buf does not have the expected shape",
    );
  });
});

describe("running a tool", () => {
  const files = { base: ".devflow/base/api.yaml", head: "api.yaml", file: "api.yaml" };

  it("does not run a tool that is not installed", async () => {
    const { set, run, evaluate } = toolset({ available: [] });
    expect(await runContractTool("oasdiff", files, set)).toEqual({
      ran: false,
      tool: "oasdiff",
      reason: "oasdiff is not installed (not found on PATH)",
    });
    expect(evaluate).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs only what the command policy allows", async () => {
    const { set, run } = toolset({
      policy: () =>
        Promise.resolve({
          allowed: false,
          reason: "approval-required",
          message: "approval required: command contracts:oasdiff-breaking (fingerprint abc)",
          fingerprint: "abc",
        }),
    });
    const result = await runContractTool("oasdiff", files, set);
    expect(result).toMatchObject({
      ran: false,
      denial: { reason: "approval-required", fingerprint: "abc" },
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("passes the files as parameters and maps oasdiff's output", async () => {
    const { set, run, evaluate } = toolset({
      result: { record: record(0), stdout: recorded("oasdiff-breaking.json") },
    });
    const result = await runContractTool("oasdiff", files, set);
    expect(evaluate).toHaveBeenCalledWith({
      spec: OASDIFF_COMMAND,
      params: { base: files.base, head: files.head },
    });
    expect(run.mock.calls[0]?.[0].args).toEqual([
      "breaking",
      files.base,
      files.head,
      "--format",
      "json",
    ]);
    expect(run.mock.calls[0]?.[1]).toEqual({ logDir: ".devflow/runs/x/logs/contracts" });
    expect(result.ran && result.changes).toHaveLength(3);
  });

  it("reads buf's exit codes: 0 is no change, 100 is changes, anything else a failure", async () => {
    const clean = await runContractTool(
      "buf",
      files,
      toolset({ result: { record: record(0) } }).set,
    );
    expect(clean).toMatchObject({ ran: true, changes: [] });
    const breaking = await runContractTool(
      "buf",
      files,
      toolset({ result: { record: record(100), stdout: recorded("buf-breaking.jsonl") } }).set,
    );
    expect(breaking.ran && breaking.changes).toHaveLength(3);
    const failed = await runContractTool(
      "buf",
      files,
      toolset({ result: { record: record(1), stderr: "Failure: import not found\n" } }).set,
    );
    expect(failed).toMatchObject({
      ran: false,
      reason: "buf exited with 1: Failure: import not found",
    });
    const empty = await runContractTool(
      "buf",
      files,
      toolset({ result: { record: record(100) } }).set,
    );
    expect(empty).toMatchObject({
      ran: false,
      reason: "buf reported breaking changes but printed none",
    });
  });

  it("reports timeouts, truncated output, start failures and a failing oasdiff", async () => {
    const timeout = await runContractTool(
      "oasdiff",
      files,
      toolset({ result: { record: record(null, { timedOut: true }) } }).set,
    );
    expect(timeout).toMatchObject({ ran: false, reason: "oasdiff did not finish in time" });
    const truncated = await runContractTool(
      "oasdiff",
      files,
      toolset({ result: { record: record(0, { outputTruncated: true }) } }).set,
    );
    expect(truncated).toMatchObject({
      ran: false,
      reason: "the output of oasdiff was too long to read",
    });
    const failing = await runContractTool(
      "oasdiff",
      files,
      toolset({ result: { record: record(1), stderr: "Error: failed to load base spec\n" } }).set,
    );
    expect(failing).toMatchObject({
      ran: false,
      reason: "oasdiff exited with 1: Error: failed to load base spec",
    });
    const notStarted = await runContractTool(
      "oasdiff",
      files,
      toolset({
        run: () =>
          Promise.reject(new DevflowError(ErrorCode.ExecutableNotFound, "oasdiff was not found")),
      }).set,
    );
    expect(notStarted).toMatchObject({
      ran: false,
      reason: "oasdiff could not be started: oasdiff was not found",
    });
  });
});

describe("compareContract with tools", () => {
  const base = fixture("openapi/petstore.base.yaml");
  const head = fixture("openapi/petstore.head.json");
  const paths = { basePath: ".devflow/base/openapi.yaml", headPath: "openapi.json" };

  it("uses the tool's decision when it ran", async () => {
    const { set } = toolset({
      result: { record: record(0), stdout: recorded("oasdiff-breaking.json") },
    });
    const result = await compareContract(
      { file: "openapi.json", base, head },
      { toolset: set, ...paths },
    );
    expect(ContractDiff.safeParse(result).success).toBe(true);
    expect(result.decidedBy).toBe("tool:oasdiff");
    expect(result.summary).toEqual({ breaking: 2, nonBreaking: 0, unknown: 1 });
    expect(result.notes[0]).toMatch(/^decided by oasdiff/);
  });

  it("falls back to the built-in rules and says why", async () => {
    const { set } = toolset({ available: [] });
    const result = await compareContract(
      { file: "openapi.json", base, head },
      { toolset: set, ...paths },
    );
    expect(result.decidedBy).toBe("builtin-rules");
    expect(result.notes[0]).toBe(
      "oasdiff did not decide: oasdiff is not installed (not found on PATH); the built-in rules were used",
    );
    expect(result.summary.breaking).toBeGreaterThan(0);
  });

  it("never runs oasdiff on documents with external references (it would fetch them)", async () => {
    const { set, evaluate } = toolset();
    const external = base.replace(
      '$ref: "#/components/schemas/NewPet"',
      '$ref: "https://example.com/new-pet.yaml"',
    );
    const result = await compareContract(
      { file: "openapi.json", base: external, head },
      { toolset: set, ...paths },
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(result.decidedBy).toBe("builtin-rules");
    expect(result.notes[0]).toContain("external references (https://example.com/new-pet.yaml)");
  });

  it("uses buf for Protobuf files and the built-in rules for an added or deleted file", async () => {
    const { set, run } = toolset({
      result: { record: record(100), stdout: recorded("buf-breaking.jsonl") },
    });
    const proto = {
      file: "orders.proto",
      base: fixture("protobuf/orders.base.proto"),
      head: fixture("protobuf/orders.head.proto"),
    };
    const result = await compareContract(proto, { toolset: set, ...paths });
    expect(result).toMatchObject({ kind: "protobuf", decidedBy: "tool:buf" });
    const added = await compareContract({ ...proto, base: null }, { toolset: set, ...paths });
    expect(added.decidedBy).toBe("builtin-rules");
    expect(run).toHaveBeenCalledTimes(1);
  });
});
