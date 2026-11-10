import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliIo } from "../src/index.js";

/**
 * `devflow verify` end to end: the JavaScript adapter, the command policy, the executor and
 * the Jest/Vitest report parser, on a workspace whose `vitest` package is a small stand-in
 * that writes a report in Vitest's JSON format.
 */

let base: string;
let workspace: string;
let home: string;

const FAKE_VITEST = `import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const scenario = JSON.parse(readFileSync("devflow-fake.json", "utf8"));
const prefix = "--outputFile.json=";
const output = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
const assertionResults = scenario.tests.map((test) => ({
  ancestorTitles: ["sum"],
  title: test.title,
  fullName: "sum " + test.title,
  status: test.status,
  failureMessages: test.message === undefined ? [] : [test.message],
  duration: 1,
}));
if (output !== undefined) {
  writeFileSync(output, JSON.stringify({
    numTotalTests: assertionResults.length,
    success: scenario.exitCode === 0,
    testResults: [{ name: path.resolve("src/sum.test.js"), message: "", assertionResults }],
  }));
}
console.log("fake vitest ran " + assertionResults.length + " tests");
process.exit(scenario.exitCode);
`;

interface Scenario {
  readonly exitCode: number;
  readonly tests: readonly { title: string; status: string; message?: string }[];
}

const PASSING: Scenario = {
  exitCode: 0,
  tests: [
    { title: "AC-1: adds", status: "passed" },
    { title: "AC-2: subtracts", status: "passed" },
  ],
};

const FAILING: Scenario = {
  exitCode: 1,
  tests: [
    { title: "AC-1: adds", status: "passed" },
    { title: "AC-2: subtracts", status: "failed", message: "AssertionError: expected 1 to be 2" },
  ],
};

async function write(relative: string, text: string): Promise<void> {
  const file = path.join(workspace, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

async function scenario(value: Scenario): Promise<void> {
  await write("devflow-fake.json", JSON.stringify(value));
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "devflow-verify-cli-")));
  workspace = path.join(base, "repo");
  home = path.join(base, "home");
  await mkdir(workspace, { recursive: true });
  await write(
    "package.json",
    JSON.stringify({ name: "shop", type: "module", devDependencies: { vitest: "^5.1.0" } }),
  );
  await write("src/sum.test.js", 'import { it } from "vitest";\nit("AC-1: adds", () => {});\n');
  await write(
    "node_modules/vitest/package.json",
    JSON.stringify({
      name: "vitest",
      version: "5.1.0",
      type: "module",
      bin: { vitest: "vitest.mjs" },
    }),
  );
  await write("node_modules/vitest/vitest.mjs", FAKE_VITEST);
  await scenario(PASSING);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly questions: readonly string[];
}

async function run(
  args: string[],
  options: { answers?: string[]; env?: Record<string, string | undefined> } = {},
): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const answers = options.answers === undefined ? undefined : [...options.answers];
  const io: CliIo = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd: workspace,
    env: {
      ...process.env,
      DEVFLOW_HOME: home,
      DEVFLOW_USER: "tester",
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
      ...options.env,
    },
    ...(answers === undefined
      ? {}
      : {
          prompt: (question: string) => {
            questions.push(question);
            return Promise.resolve(answers.shift() ?? "");
          },
        }),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr, questions };
}

interface VerifyJson {
  outcome: string;
  verification: string | null;
  modules: { id: string; adapter: string; root: string }[];
  warnings: string[];
  gates: {
    gateId: string;
    commandId: string;
    status: string;
    reason?: string;
    required: boolean;
    tests: { id: string; status: string; markers: string[]; message?: string }[];
    execution?: { exitCode: number | null; approval: { via: string }; stdoutPath: string };
  }[];
  denials: { gateId: string; reason: string; fingerprint?: string; argv: string[]; cwd: string }[];
  comparison: { regressions: { testId: string }[]; fixed: unknown[] } | null;
}

async function verifyJson(args: string[] = []): Promise<{ code: number; result: VerifyJson }> {
  const captured = await run(["verify", "--json", ...args]);
  return { code: captured.code, result: JSON.parse(captured.stdout) as VerifyJson };
}

async function trust(): Promise<void> {
  expect((await run(["trust", "--yes"])).code).toBe(ExitCode.Success);
}

async function fingerprint(): Promise<string> {
  const { result } = await verifyJson();
  const value = result.denials[0]?.fingerprint;
  if (value === undefined) throw new Error("no fingerprint in the denial");
  return value;
}

describe("devflow verify", () => {
  it("runs nothing in an untrusted workspace and exits 5", async () => {
    const human = await run(["verify"]);
    expect(human.code).toBe(ExitCode.PolicyDenied);
    expect(human.stdout).toContain("NOT EXECUTED  javascript-test (javascript:test)");
    expect(human.stdout).toContain("The workspace is not trusted.");
    expect(human.stdout).toMatch(
      /Result: DENIED BY POLICY \(0 of 1 gate passed; not allowed to run: javascript-test\)/,
    );
    expect(human.stderr).toContain("no gates are configured");

    const { code, result } = await verifyJson();
    expect(code).toBe(ExitCode.PolicyDenied);
    expect(result.outcome).toBe("denied");
    expect(result.modules).toEqual([{ id: "javascript", adapter: "javascript", root: "." }]);
    expect(result.denials).toMatchObject([
      { gateId: "javascript-test", reason: "workspace-untrusted" },
    ]);
    expect(result.gates[0]?.execution).toBeUndefined();
  });

  it("needs each command approved: without a terminal it shows the fingerprint to allow", async () => {
    await trust();
    const human = await run(["verify"]);
    expect(human.code).toBe(ExitCode.PolicyDenied);
    expect(human.stdout).toContain("Commands need approval.");
    expect(human.stdout).toMatch(/--allow [0-9a-f]{64}/);
    expect(human.stdout).toContain("node node_modules/vitest/vitest.mjs run");

    const { result } = await verifyJson();
    expect(result.denials[0]).toMatchObject({
      reason: "approval-required",
      cwd: ".",
      argv: expect.arrayContaining(["node", "node_modules/vitest/vitest.mjs"]) as string[],
    });
  });

  it("runs an allowed command, reads its report and saves the verification", async () => {
    await trust();
    const allow = await fingerprint();
    const human = await run(["verify", "--allow", allow]);
    expect(human.stderr).toContain("Running gate javascript-test (javascript:test)...");
    expect(human.stdout).toMatch(/PASSED {8}javascript-test \(javascript:test, \d+\.\d s\)/);
    expect(human.stdout).toContain("2 tests: 2 passed");
    expect(human.stdout).toMatch(/Result: PASSED \(1 of 1 gate passed\)/);
    expect(human.code).toBe(ExitCode.Success);

    const { code, result } = await verifyJson(["--allow", allow]);
    expect(code).toBe(ExitCode.Success);
    const [gate] = result.gates;
    expect(gate).toMatchObject({
      status: "passed",
      execution: { exitCode: 0, approval: { via: "allowlist-flag" } },
    });
    expect(gate?.tests.map((test) => [test.id, test.markers])).toEqual([
      ["src/sum.test.js#sum > AC-1: adds", ["AC-1"]],
      ["src/sum.test.js#sum > AC-2: subtracts", ["AC-2"]],
    ]);

    const saved = JSON.parse(
      await readFile(path.join(workspace, ...(result.verification ?? "").split("/")), "utf8"),
    ) as { version: number; gates: unknown[] };
    expect(saved.version).toBe(1);
    expect(saved.gates).toHaveLength(1);
    const stdoutLog = await readFile(
      path.join(workspace, ...(gate?.execution?.stdoutPath ?? "").split("/")),
      "utf8",
    );
    expect(stdoutLog).toContain("fake vitest ran 2 tests");
    const runDir = path.dirname(path.join(workspace, ...(result.verification ?? "").split("/")));
    expect(await readdir(runDir)).toEqual(
      expect.arrayContaining(["audit.jsonl", "logs", "verification.json"]),
    );
  });

  it("asks on a terminal, and remembers an approval for always", async () => {
    await trust();
    const first = await run(["verify"], { answers: ["a"] });
    expect(first.questions).toEqual(["Run it? [o]nce, [a]lways in this workspace, [N]o: "]);
    expect(first.stderr).toContain("Command approval: javascript:test");
    expect(first.stderr).toMatch(
      /Executes: {4}node_modules\/vitest\/vitest\.mjs \(file, sha256 [0-9a-f]{12}\.\.\.\)/,
    );
    expect(first.code).toBe(ExitCode.Success);

    const second = await run(["verify"], { answers: [] });
    expect(second.questions).toEqual([]);
    expect(second.code).toBe(ExitCode.Success);
  });

  it("denies a command the user rejects", async () => {
    await trust();
    const rejected = await run(["verify"], { answers: ["n"] });
    expect(rejected.code).toBe(ExitCode.PolicyDenied);
    expect(rejected.stdout).toContain("denied by the command policy: the command was rejected");
  });

  it("reports failed tests, exits 1, and finds the regression against a baseline", async () => {
    await trust();
    const allow = await fingerprint();
    const passing = await verifyJson(["--allow", allow]);
    expect(passing.code).toBe(ExitCode.Success);

    await scenario(FAILING);
    const human = await run(["verify", "--allow", allow]);
    expect(human.code).toBe(ExitCode.Failure);
    expect(human.stdout).toContain("FAILED");
    expect(human.stdout).toContain("exit code 1: 1 failed test");
    expect(human.stdout).toContain(
      "- src/sum.test.js#sum > AC-2: subtracts: AssertionError: expected 1 to be 2",
    );

    const baseline = passing.result.verification ?? "";
    const compared = await verifyJson(["--allow", allow, "--baseline", baseline]);
    expect(compared.code).toBe(ExitCode.Failure);
    expect(compared.result.comparison?.regressions).toEqual([
      expect.objectContaining({ testId: "src/sum.test.js#sum > AC-2: subtracts" }),
    ]);
    const text = await run(["verify", "--allow", allow, "--baseline", baseline]);
    expect(text.stdout).toContain("1 regression, 0 fixed");
    expect(text.stdout).toContain(
      "regression javascript-test: src/sum.test.js#sum > AC-2: subtracts",
    );
  });

  it("runs configured gates; optional gates do not decide the result", async () => {
    await write(
      ".devflow/config.yaml",
      [
        "version: 1",
        "verification:",
        "  gates:",
        "    - id: unit",
        "      module: javascript",
        "      use: test",
        "    - id: style",
        "      module: javascript",
        "      use: lint",
        "      required: false",
        "",
      ].join("\n"),
    );
    await trust();
    const allow = await fingerprint();
    const { code, result } = await verifyJson(["--allow", allow]);
    expect(code).toBe(ExitCode.Success);
    expect(result.warnings).toEqual([]);
    expect(result.gates.map((gate) => [gate.gateId, gate.status, gate.required])).toEqual([
      ["unit", "passed", true],
      ["style", "not_executed", false],
    ]);
    expect(result.gates[1]?.reason).toBe('module javascript has no "lint" command (it has: test)');

    const only = await verifyJson(["--allow", allow, "--gate", "style"]);
    expect(only.code).toBe(ExitCode.Failure);
    expect(only.result.gates.map((gate) => gate.gateId)).toEqual(["style"]);
  });

  it("rejects unknown gates, malformed fingerprints and unusable baselines before running", async () => {
    await trust();
    const unknown = await run(["verify", "--gate", "nope"]);
    expect(unknown.code).toBe(ExitCode.UsageError);
    expect(unknown.stderr).toContain('no gate "nope" (gates: javascript-test) [GATE_NOT_FOUND]');

    const malformed = await run(["verify", "--allow", "abc"]);
    expect(malformed.code).toBe(ExitCode.UsageError);
    expect(malformed.stderr).toContain("expected a command fingerprint");

    await write("old.json", '{"version": 1}');
    const baseline = await run(["verify", "--json", "--baseline", "old.json"]);
    expect(baseline.code).toBe(ExitCode.UsageError);
    expect(JSON.parse(baseline.stdout)).toMatchObject({
      error: { code: "VERIFICATION_BASELINE_INVALID" },
    });
    const missing = await run(["verify", "--baseline", "missing.json"]);
    expect(missing.code).toBe(ExitCode.UsageError);
    expect(missing.stderr).toContain("the baseline missing.json cannot be read");
    await expect(readdir(path.join(workspace, ".devflow", "runs"))).rejects.toThrow();
  });

  it("runs in a container only with an image and its own approval, and never falls back to the host", async () => {
    const noImage = await run(["verify", "--backend", "container"]);
    expect(noImage.code).toBe(ExitCode.UsageError);
    expect(noImage.stderr).toContain("[CONTAINER_IMAGE_UNAVAILABLE]");
    const unknown = await run(["verify", "--backend", "vm"]);
    expect(unknown.code).toBe(ExitCode.UsageError);

    await write(
      ".devflow/config.yaml",
      "version: 1\nexecution:\n  container:\n    image: node:22-alpine\n",
    );
    await trust();
    const local = await fingerprint();
    const { result: denied } = await verifyJson(["--backend", "container"]);
    const container = denied.denials[0]?.fingerprint;
    expect(denied.denials[0]?.reason).toBe("approval-required");
    expect(container).toMatch(/^[0-9a-f]{64}$/);
    expect(container).not.toBe(local);

    // The local approval does not let the command run in a container, nor the reverse.
    const crossed = await verifyJson(["--backend", "container", "--allow", local]);
    expect(crossed.result.denials[0]?.reason).toBe("approval-required");

    // Approved for the container, but Docker cannot be found: not executed, never run locally.
    const noDocker = await run(
      ["verify", "--json", "--backend", "container", "--allow", container ?? ""],
      { env: { PATH: path.join(base, "empty-path"), Path: undefined } },
    );
    const result = JSON.parse(noDocker.stdout) as VerifyJson;
    expect(noDocker.code).toBe(ExitCode.Failure);
    expect(result.gates[0]).toMatchObject({ status: "not_executed" });
    expect(result.gates[0]?.reason).toContain("Docker was not found on PATH");
    expect(result.gates[0]?.execution).toBeUndefined();
  });

  it("has nothing to verify in an empty workspace", async () => {
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    const human = await run(["verify"]);
    expect(human.code).toBe(ExitCode.Failure);
    expect(human.stdout).toBe(
      "Nothing to verify: no module was found, and no gate is configured.\n",
    );
  });
});
