import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FakeProvider } from "@devflowai/ai";
import type { LlmRequest } from "@devflowai/core";
import { afterEach, describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/**
 * `devflow review --seek-evidence` (ADR 0025) end to end: a real git repository with an
 * uncommitted change, a scripted model, the JavaScript adapter, the command policy and the
 * executor. The installed `vitest` is a small stand-in that really imports and runs the test
 * files (with `node:assert`) and writes a report in Vitest's JSON format.
 */

const FAKE_VITEST_INDEX = `import assert from "node:assert";
export function it(title, fn) {
  globalThis.__devflowTests.push({ title, fn });
}
export const test = it;
export function expect(actual) {
  return {
    toBe: (expected) => assert.strictEqual(actual, expected),
    toEqual: (expected) => assert.deepStrictEqual(actual, expected),
  };
}
`;

const FAKE_VITEST = `import { readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const prefix = "--outputFile.json=";
const output = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
const at = process.argv.indexOf("--testNamePattern");
const pattern = at === -1 ? undefined : new RegExp(process.argv[at + 1]);
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if ([".git", ".devflow", "node_modules"].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(file));
    else if (entry.name.endsWith(".test.js")) found.push(file);
  }
  return found;
}
const testResults = [];
let failed = false;
let total = 0;
for (const file of walk(process.cwd()).sort()) {
  globalThis.__devflowTests = [];
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    failed = true;
    testResults.push({ name: file, message: String(error?.stack ?? error), assertionResults: [] });
    continue;
  }
  const assertionResults = [];
  for (const { title, fn } of globalThis.__devflowTests) {
    const base = { ancestorTitles: [], title, fullName: title, duration: 1 };
    if (pattern !== undefined && !pattern.test(title)) {
      assertionResults.push({ ...base, status: "pending", failureMessages: [] });
      continue;
    }
    total += 1;
    try {
      await fn();
      assertionResults.push({ ...base, status: "passed", failureMessages: [] });
    } catch (error) {
      failed = true;
      assertionResults.push({ ...base, status: "failed", failureMessages: [String(error?.stack ?? error)] });
    }
  }
  testResults.push({ name: file, message: "", assertionResults });
}
if (output !== undefined) {
  writeFileSync(output, JSON.stringify({ numTotalTests: total, success: !failed, testResults }));
}
console.log("stand-in vitest ran " + total + " tests in " + process.cwd());
process.exit(failed ? 1 : 0);
`;

const TASK = `schemaVersion: 1
id: TASK-9
title: Sum the cart
description: sum returns the total of every value.
requirements:
  functional:
    - id: FR-1
      text: sum adds every value
acceptanceCriteria:
  - id: AC-1
    statement: sum of 1, 2 and 3 is 6
    covers: [FR-1]
testing:
  levels: [unit]
`;

const SUM_BEFORE = [
  "export function sum(values) {",
  "  let total = 0;",
  "  for (let i = 0; i < values.length; i++) total += values[i];",
  "  return total;",
  "}",
  "",
].join("\n");

// The reviewed change: an off-by-one that drops the last value.
const SUM_AFTER = SUM_BEFORE.replace("i < values.length;", "i < values.length - 1;");

const EXISTING_TEST = [
  'import { expect, it } from "vitest";',
  'import { sum } from "./sum.js";',
  "",
  'it("sum of nothing is zero", () => {',
  "  expect(sum([])).toBe(0);",
  "});",
  "",
].join("\n");

const probeFile = (name: string, body: string): string =>
  [
    'import { expect, it } from "vitest";',
    'import { sum } from "./sum.js";',
    "",
    `it("${name}", () => {`,
    `  ${body}`,
    "});",
    "",
  ].join("\n");

/** One AI finding per scenario; each probe answer is keyed by the finding's title. */
const FINDINGS = {
  confirmed: {
    title: "The loop drops the last value",
    probe: {
      feasible: true,
      path: "src/sum-last-value.test.js",
      testName: "sum adds the last value",
      content: probeFile("sum adds the last value", "expect(sum([1, 2, 3])).toBe(6);"),
      explanation: "Summing three values shows whether the last one is dropped.",
    },
  },
  notReproduced: {
    title: "An empty list may not sum to zero",
    probe: {
      feasible: true,
      path: "src/sum-empty.test.js",
      testName: "sum of an empty list is zero",
      content: probeFile("sum of an empty list is zero", "expect(sum([])).toBe(0);"),
      explanation: "An empty list must sum to zero.",
    },
  },
  syntaxError: {
    title: "A single value may be lost",
    probe: {
      feasible: true,
      path: "src/sum-single.test.js",
      testName: "sum keeps a single value",
      content: probeFile("sum keeps a single value", "expect(sum([5]).toBe(5);"),
      explanation: "A single value must be kept.",
    },
  },
  existing: {
    title: "Overwrites the existing test",
    probe: {
      feasible: true,
      path: "src/sum.test.js",
      testName: "sum of nothing is zero",
      content: probeFile("sum of nothing is zero", "expect(sum([])).toBe(0);"),
      explanation: "Replaces the existing test.",
    },
  },
  escape: {
    title: "Writes outside the workspace",
    probe: {
      feasible: true,
      path: "../outside.test.js",
      testName: "outside",
      content: probeFile("outside", "expect(1).toBe(1);"),
      explanation: "Escapes.",
    },
  },
  notATest: {
    title: "Writes a source file",
    probe: {
      feasible: true,
      path: "src/helper.js",
      testName: "helper",
      content: probeFile("helper", "expect(1).toBe(1);"),
      explanation: "Not a test file.",
    },
  },
} as const;

type Scenario = keyof typeof FINDINGS;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-home`, { recursive: true, force: true });
  }
});

async function put(root: string, relative: string, content: string): Promise<void> {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** A committed repository with an uncommitted change to src/sum.js: what the review sees. */
async function repository(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-evidence-")));
  roots.push(root);
  await put(root, ".gitignore", ".devflow/\nnode_modules/\n");
  await put(
    root,
    "package.json",
    JSON.stringify({ name: "cart", type: "module", devDependencies: { vitest: "^5.1.0" } }),
  );
  await put(root, "task.yaml", TASK);
  await put(root, "src/sum.js", SUM_BEFORE);
  await put(root, "src/sum.test.js", EXISTING_TEST);
  await put(
    root,
    "node_modules/vitest/package.json",
    JSON.stringify({
      name: "vitest",
      version: "5.1.0",
      type: "module",
      bin: { vitest: "vitest.mjs" },
      exports: "./index.mjs",
    }),
  );
  await put(root, "node_modules/vitest/vitest.mjs", FAKE_VITEST);
  await put(root, "node_modules/vitest/index.mjs", FAKE_VITEST_INDEX);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  await put(root, "src/sum.js", SUM_AFTER);
  return root;
}

function model(scenarios: readonly Scenario[]): { provider: FakeProvider; probed: string[] } {
  const probed: string[] = [];
  const provider = new FakeProvider((request: LlmRequest) => {
    const user = request.messages.map((message) => message.content).join("\n");
    if (request.system.includes("requirements analyst")) {
      return JSON.stringify({
        summary: "Sum every value.",
        requirementNotes: [{ id: "FR-1", interpretation: "Add all values.", concerns: [] }],
        questions: [],
        assumptions: [],
        risks: [],
        edgeCases: [],
        contradictions: [],
        dependencies: [],
        affectedFiles: [{ path: "src/sum.js", reason: "Defines sum." }],
      });
    }
    if (request.system.includes("code reviewer")) {
      return JSON.stringify({
        summary: "The loop bound changed.",
        findings: scenarios.map((scenario) => ({
          title: FINDINGS[scenario].title,
          severity: "high",
          category: "regression",
          path: "src/sum.js",
          line: 3,
          description: `Suspected: ${FINDINGS[scenario].title}.`,
          recommendation: "Restore the loop bound.",
          confidence: 0.7,
          acIds: ["AC-1"],
        })),
      });
    }
    if (request.system.includes("suspected the defect")) {
      const scenario = scenarios.find((candidate) => user.includes(FINDINGS[candidate].title));
      if (scenario === undefined) throw new Error("probe for an unknown finding");
      probed.push(scenario);
      return JSON.stringify(FINDINGS[scenario].probe);
    }
    throw new Error(`unexpected request: ${request.system.slice(0, 80)}`);
  });
  return { provider, probed };
}

async function cli(
  cwd: string,
  args: string[],
  provider?: FakeProvider,
): Promise<{ code: number; stdout: string; stderr: string; questions: string[] }> {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const io: CliIo = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd,
    env: {
      ...process.env,
      DEVFLOW_HOME: `${cwd}-home`,
      DEVFLOW_USER: "mohamed",
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    },
    // Every command is approved once, for always: the review's gate and the probe command.
    prompt: (question: string) => {
      questions.push(question);
      return Promise.resolve("a");
    },
    ...(provider === undefined ? {} : { createProvider: () => Promise.resolve(provider) }),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr, questions };
}

/** Every file of the working tree outside `.git`, `.devflow` and `node_modules`, with content. */
async function snapshot(root: string, dir = root): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if ([".git", ".devflow", "node_modules"].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, await snapshot(root, file));
    else files[path.relative(root, file).replace(/\\/g, "/")] = await readFile(file, "utf8");
  }
  return files;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

interface Probe {
  findingId: string;
  outcome: string;
  reason: string;
  testFile?: string;
  sha256?: string;
  artifact?: string;
  commandId?: string;
}
interface Report {
  findings: {
    id: string;
    title: string;
    source: string;
    verification: string;
    evidence: { kind: string; description: string; deterministic: boolean; sha256?: string }[];
  }[];
  evidenceProbes?: { skipped?: string; probes: Probe[] };
}

// Not --json: the approvals are asked on the (scripted) terminal.
const REVIEW = ["review", "--task", "task.yaml", "--model", "m"];

async function review(
  root: string,
  scenarios: readonly Scenario[],
  extra: string[] = [],
): Promise<{ report: Report; markdown: string; run: string; probed: string[] }> {
  expect((await cli(root, ["trust", "--yes"])).code).toBe(ExitCode.Success);
  const { provider, probed } = model(scenarios);
  const result = await cli(root, [...REVIEW, ...extra], provider);
  expect(result.code, result.stdout + result.stderr).toBe(ExitCode.Success);
  const [runId, ...others] = await readdir(path.join(root, ".devflow", "runs"));
  expect(others).toEqual([]);
  const run = path.join(root, ".devflow", "runs", runId ?? "");
  const report = JSON.parse(await readFile(path.join(run, "report.json"), "utf8")) as Report;
  const markdown = await readFile(path.join(run, "report.md"), "utf8");
  return { report, markdown, run, probed };
}

const byTitle = (report: Report, scenario: Scenario) => {
  const finding = report.findings.find((candidate) => candidate.title === FINDINGS[scenario].title);
  if (finding === undefined) throw new Error(`no finding ${FINDINGS[scenario].title}`);
  return finding;
};
const probeOf = (report: Report, findingId: string): Probe => {
  const probe = report.evidenceProbes?.probes.find(
    (candidate) => candidate.findingId === findingId,
  );
  if (probe === undefined) throw new Error(`no probe of ${findingId}`);
  return probe;
};

describe("devflow review --seek-evidence", () => {
  it("confirms a finding whose probe fails on an assertion, and leaves the others unverified", async () => {
    const root = await repository();
    const before = await snapshot(root);
    const status = git(root, "status", "--porcelain");
    const { report, markdown, run, probed } = await review(
      root,
      ["confirmed", "notReproduced", "syntaxError"],
      ["--seek-evidence"],
    );

    expect(probed.sort()).toEqual(["confirmed", "notReproduced", "syntaxError"]);
    const confirmed = byTitle(report, "confirmed");
    expect(confirmed.verification).toBe("confirmed");
    const probe = probeOf(report, confirmed.id);
    expect(probe).toMatchObject({
      outcome: "confirmed",
      testFile: "src/sum-last-value.test.js",
      commandId: "javascript:test-filter",
    });
    expect(probe.sha256).toMatch(/^[0-9a-f]{64}$/);
    const deterministic = confirmed.evidence.filter((item) => item.deterministic);
    expect(deterministic.map((item) => item.kind)).toEqual(["file", "execution", "test-report"]);
    expect(deterministic[0]?.sha256).toBe(probe.sha256);
    expect(deterministic[1]?.description).toContain("--testNamePattern");
    expect(deterministic[2]?.description).toContain("sum adds the last value");

    const passed = byTitle(report, "notReproduced");
    expect(passed.verification).toBe("unverified");
    expect(probeOf(report, passed.id)).toMatchObject({
      outcome: "not_reproduced",
      reason: "probe passed: not reproduced",
    });

    const broken = byTitle(report, "syntaxError");
    expect(broken.verification).toBe("unverified");
    const inconclusive = probeOf(report, broken.id);
    expect(inconclusive.outcome).toBe("inconclusive");
    expect(inconclusive.reason).toContain("compile error");

    // The probes are kept as run artifacts, never in the working tree, never committed.
    const kept = path.join(
      run,
      "artifacts",
      "probes",
      confirmed.id,
      "src",
      "sum-last-value.test.js",
    );
    expect(await readFile(kept, "utf8")).toBe(FINDINGS.confirmed.probe.content);
    expect(await snapshot(root)).toEqual(before);
    expect(git(root, "status", "--porcelain")).toBe(status);
    expect(git(root, "rev-list", "--count", "HEAD")).toBe("1");

    // The worktree is gone, and git no longer lists it.
    expect(await exists(path.join(root, ".devflow", "probes", "worktree"))).toBe(false);
    expect(git(root, "worktree", "list").split("\n")).toHaveLength(1);

    expect(markdown).toContain("## Evidence probes");
    expect(markdown).toContain(`**${confirmed.id}** confirmed`);
    expect(markdown).toContain(`**${passed.id}** not reproduced`);
    expect(markdown).toContain("except those a probe test confirmed");
  }, 60_000);

  it("refuses probes that overwrite a file, leave the workspace or are not tests", async () => {
    const root = await repository();
    const before = await snapshot(root);
    const { report } = await review(
      root,
      ["existing", "escape", "notATest"],
      ["--seek-evidence", "--max-probes", "5"],
    );
    for (const [scenario, reason] of [
      ["existing", "already exists"],
      ["escape", "path guard refused"],
      ["notATest", "is not a test file"],
    ] as const) {
      const finding = byTitle(report, scenario);
      expect(finding.verification).toBe("unverified");
      const probe = probeOf(report, finding.id);
      expect(probe.outcome, scenario).toBe("refused");
      expect(probe.reason, scenario).toContain(reason);
      expect(probe.commandId).toBeUndefined();
    }
    expect(await snapshot(root)).toEqual(before);
    expect(await exists(path.join(root, "..", "outside.test.js"))).toBe(false);
    expect(await exists(path.join(root, ".devflow", "probes", "worktree"))).toBe(false);
  }, 60_000);

  it("probes at most --max-probes findings and lists the others as not probed", async () => {
    const root = await repository();
    const { report, run, probed } = await review(
      root,
      ["confirmed", "notReproduced"],
      ["--seek-evidence", "--max-probes", "1"],
    );
    expect(probed).toEqual(["confirmed"]);
    expect(report.evidenceProbes?.probes).toHaveLength(1);
    const record = JSON.parse(
      await readFile(path.join(run, "artifacts", "probes.json"), "utf8"),
    ) as { notProbed: string[] };
    expect(record.notProbed).toEqual([byTitle(report, "notReproduced").id]);
  }, 60_000);

  it("runs no probe without --seek-evidence, and refuses --max-probes alone", async () => {
    const root = await repository();
    const { report, probed } = await review(root, ["confirmed"]);
    expect(probed).toEqual([]);
    expect(report.evidenceProbes).toBeUndefined();
    expect(byTitle(report, "confirmed").verification).toBe("unverified");

    const alone = await cli(root, [...REVIEW, "--max-probes", "2"]);
    expect(alone.code).toBe(ExitCode.UsageError);
    expect(alone.stderr).toContain("--max-probes needs --seek-evidence");
    const tooMany = await cli(root, [...REVIEW, "--seek-evidence", "--max-probes", "11"]);
    expect(tooMany.code).toBe(ExitCode.UsageError);
  }, 60_000);
});
