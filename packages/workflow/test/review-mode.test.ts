import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { FakeProvider } from "@devflow/ai";
import {
  EngineeringReport,
  ErrorCode,
  type GateDefinition,
  type GateResult,
  type GitDiff,
  type GitInspection,
  type GitWorkspace,
  type LlmRequest,
  type TestCaseResult,
} from "@devflow/core";
import { describe, expect, it } from "vitest";
import {
  ReviewDiff,
  ReviewRecord,
  RunStore,
  type TestRunner,
  listRuns,
  startRun,
} from "../src/index.js";
import {
  SECRET,
  analysisAnswer,
  isAnalysis,
  services,
  settings,
  task,
  userText,
  workspace,
} from "./helpers.js";

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);

const ORDERS_PATCH = [
  "diff --git a/src/orders.ts b/src/orders.ts",
  "index 1111111..2222222 100644",
  "--- a/src/orders.ts",
  "+++ b/src/orders.ts",
  "@@ -1,5 +1,5 @@",
  " export interface Order { id: string; total: number }",
  " ",
  "-export function listOrders(orders: Order[]): Order[] {",
  "-  return orders;",
  "+export function listOrders(orders: Order[], page = 1, size = orders.length): Order[] {",
  "+  return orders.slice((page - 1) * size, page * size);",
  " }",
  "",
].join("\n");

const TEST_FILE = "src/pagination.test.ts";
const TEST_CONTENT = [
  'import { listOrders } from "./orders";',
  'it("AC-1: page 2 with size 10 returns orders 11 to 20", () => {});',
  "",
].join("\n");

type DiffFile = GitDiff["files"][number];

const modified = (file: string, additions = 2, deletions = 2): DiffFile => ({
  path: file,
  change: "modified",
  additions,
  deletions,
  binary: false,
  tracked: true,
});
const untracked = (file: string): DiffFile => ({
  path: file,
  change: "added",
  additions: null,
  deletions: null,
  binary: false,
  tracked: false,
});

/** A repository whose diff is given: what a review sees. */
class DiffGit implements GitWorkspace {
  readonly bases: string[] = [];
  unavailable: string | undefined;

  constructor(
    private readonly files: DiffFile[],
    private readonly patch: string,
  ) {}

  inspect(): Promise<GitInspection> {
    return Promise.resolve(
      this.unavailable === undefined
        ? {
            kind: "repository",
            head: HEAD,
            branch: "feature",
            changes: this.files.map((f) => f.path),
          }
        : { kind: "unavailable", reason: this.unavailable },
    );
  }
  currentBranch(): Promise<string | null> {
    return Promise.resolve("feature");
  }
  freeBranchName(base: string): Promise<string> {
    return Promise.resolve(base);
  }
  createBranch(): Promise<void> {
    return Promise.reject(new Error("a review never creates a branch"));
  }
  commit(): Promise<string> {
    return Promise.reject(new Error("a review never commits"));
  }
  mergeBase(ref: string): Promise<string> {
    this.bases.push(ref);
    return Promise.resolve(BASE);
  }
  diff(base: string): Promise<GitDiff> {
    expect(base).toBe(BASE);
    return Promise.resolve({
      base,
      head: HEAD,
      files: this.files,
      patch: this.patch,
      patchTruncated: false,
    });
  }
  remoteUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
}

function testResult(
  id: string,
  outcome: "passed" | "assertion_failure",
  markers: string[],
): TestCaseResult {
  return {
    id,
    name: id,
    file: TEST_FILE,
    outcome,
    status: outcome === "passed" ? "passed" : "failed",
    markers,
    ...(outcome === "passed" ? {} : { message: `${id} failed` }),
  };
}

function gate(id: string, tests: TestCaseResult[], required = true): GateResult {
  const failed = tests.some((test) => test.status === "failed");
  return {
    gateId: id,
    commandId: "vitest",
    required,
    status: failed ? "failed" : "passed",
    execution: {
      commandId: "vitest",
      argv: ["node", "vitest.mjs"],
      cwd: ".",
      invocation: "direct",
      approval: { via: "allowlist-flag", approvedBy: "mohamed" },
      startedAt: "2026-11-07T10:00:00.000Z",
      durationMs: 900,
      exitCode: failed ? 1 : 0,
      signal: null,
      timedOut: false,
      stdoutPath: ".devflow/runs/x/logs/commands/vitest.out",
      stderrPath: ".devflow/runs/x/logs/commands/vitest.err",
      outputTruncated: false,
    },
    tests,
    diagnostics: [],
    evidence: [],
  };
}

const TEST_GATE: GateDefinition = { id: "test-shop", module: "shop", use: "test", required: true };

function runner(gates: GateResult[]) {
  const ran: string[][] = [];
  const testRunner: TestRunner = {
    modules: [],
    gates: () => Promise.resolve([TEST_GATE]),
    run: (definitions) => {
      ran.push(definitions.map((definition) => definition.id));
      return Promise.resolve({ gates, denials: [] });
    },
  };
  return { testRunner, ran };
}

const isReview = (request: LlmRequest) => request.system.includes("code reviewer");

/** The one review request a run made. */
function onlyRequest(requests: readonly LlmRequest[]): LlmRequest {
  const [request, ...rest] = requests;
  if (request === undefined || rest.length > 0) {
    throw new Error(`expected one review request, got ${String(requests.length)}`);
  }
  return request;
}

function reviewer(answer: object) {
  const requests: LlmRequest[] = [];
  const provider = new FakeProvider((request) => {
    if (isAnalysis(request)) return analysisAnswer();
    if (!isReview(request)) throw new Error(`unexpected request: ${request.system.slice(0, 60)}`);
    requests.push(request);
    return JSON.stringify(answer);
  });
  return { provider, requests };
}

async function review(
  root: string,
  git: DiffGit,
  provider: FakeProvider,
  gates: GateResult[],
  base?: string,
) {
  const { testRunner, ran } = runner(gates);
  const svc = await services(root, provider, {
    git,
    testRunner: () => Promise.resolve(testRunner),
  });
  const outcome = await startRun(
    {
      task: task(),
      taskFile: "tasks/TASK-7.yaml",
      mode: "review",
      goal: "review",
      settings: settings(),
      ...(base === undefined ? {} : { review: { base } }),
    },
    svc,
  );
  const store = await RunStore.open(root, outcome.runId);
  const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
  return { outcome, store, report, ran };
}

describe("review mode", () => {
  it("reviews the local change: gates once, deterministic checks, unverified AI findings", async () => {
    const root = await workspace();
    await writeFile(path.join(root, TEST_FILE), TEST_CONTENT);
    const before = await readFile(path.join(root, "src", "orders.ts"), "utf8");
    const git = new DiffGit([modified("src/orders.ts"), untracked(TEST_FILE)], ORDERS_PATCH);
    const { provider, requests } = reviewer({
      summary: "Pagination is added; the page size is not validated.",
      findings: [
        {
          title: "A page size of 0 returns nothing",
          severity: "medium",
          category: "requirement",
          path: "src/orders.ts",
          line: 3,
          description: "size = 0 slices an empty page instead of rejecting the input.",
          recommendation: "Reject a size below 1.",
          confidence: 0.6,
          acIds: ["AC-1", "AC-9"],
        },
        {
          title: "The client is not updated",
          severity: "low",
          category: "compatibility",
          path: "src/client.ts",
          line: null,
          description: "Callers still expect every order.",
          recommendation: "Check the callers.",
          confidence: 0.3,
          acIds: [],
        },
      ],
    });
    const { outcome, store, report, ran } = await review(
      root,
      git,
      provider,
      [gate("test-shop", [testResult(`${TEST_FILE} > AC-1: page 2`, "passed", ["AC-1"])])],
      "main",
    );

    expect(outcome).toMatchObject({ mode: "review", state: "COMPLETED", status: "completed" });
    expect(git.bases).toEqual(["main"]);
    expect(ran).toEqual([["test-shop"]]);
    // A review changes nothing.
    expect(await readFile(path.join(root, "src", "orders.ts"), "utf8")).toBe(before);

    expect(report.verdict).toBe("verified");
    expect(report.run).toMatchObject({ mode: "review", baseCommit: BASE, headCommit: HEAD });
    expect(report.filesChanged).toEqual([
      { path: "src/orders.ts", change: "modified" },
      { path: TEST_FILE, change: "added" },
    ]);
    expect(report.acceptanceMatrix).toMatchObject([
      {
        acId: "AC-1",
        status: "verified",
        tests: [{ testId: `${TEST_FILE} > AC-1: page 2`, status: "passed" }],
      },
      { acId: "AC-2", status: "manual" },
    ]);
    expect(report.findings.map((f) => [f.id, f.source, f.verification, f.title])).toEqual([
      [
        "F-1",
        "deterministic",
        "unverified",
        "The public declaration listOrders changed in src/orders.ts",
      ],
      ["F-2", "ai", "unverified", "A page size of 0 returns nothing"],
      ["F-3", "ai", "unverified", "The client is not updated"],
    ]);
    expect(report.findings[1]).toMatchObject({
      confidence: 0.6,
      location: { path: "src/orders.ts", line: 3 },
      evidence: [
        {
          kind: "note",
          deterministic: false,
          description: "size = 0 slices an empty page instead of rejecting the input.",
        },
        { kind: "note", deterministic: false, description: "related criteria: AC-1" },
      ],
    });
    expect(report.findings[2]).not.toHaveProperty("location");
    expect(report.findings[2]?.evidence.at(-1)?.description).toBe(
      "the model named src/client.ts, which is not in the diff",
    );
    expect(report.manualChecks.join("\n")).toContain("the AI findings are a model's suggestions");

    // The untracked test file is reviewed like the rest of the change.
    const prompt = userText(onlyRequest(requests));
    expect(prompt).toContain("+export function listOrders(orders: Order[], page = 1");
    expect(prompt).toContain(`+++ b/${TEST_FILE}`);
    expect(prompt).toContain('+it("AC-1: page 2 with size 10 returns orders 11 to 20"');
    expect(prompt).toContain("- modified `src/orders.ts` (+2 -2)");
    expect(prompt).toContain("- test-shop (required): passed");
    expect(prompt).toContain("The public declaration listOrders changed in src/orders.ts");

    const recorded = ReviewRecord.parse(JSON.parse(await store.readText("artifacts/review.json")));
    expect(recorded).toMatchObject({ deterministicFindings: 1, aiFindings: 2, dropped: 0 });
    const markdown = await store.readText("report.md");
    expect(markdown).toContain(`against base commit \`${BASE.slice(0, 12)}\``);
    expect(markdown).toContain("Review mode reviews a local change: it changed no file");
  });

  it("confirms facts: a failing gate, an untested criterion, a secret, a CI workflow, a manifest", async () => {
    const root = await workspace();
    await mkdir(path.join(root, ".github", "workflows"), { recursive: true });
    await writeFile(path.join(root, ".github", "workflows", "ci.yml"), "on: push\n");
    await writeFile(path.join(root, ".env"), "TOKEN=hunter2-very-secret\n");
    const patch = [
      "diff --git a/src/settings.ts b/src/settings.ts",
      "--- a/src/settings.ts",
      "+++ b/src/settings.ts",
      "@@ -1,1 +1,2 @@",
      " // settings",
      `+export const apiKey = "${SECRET}";`,
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
      "--- a/.github/workflows/ci.yml",
      "+++ b/.github/workflows/ci.yml",
      "@@ -1,1 +1,2 @@",
      " on: push",
      "+permissions: write-all",
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1,1 +1,1 @@",
      '-{ "name": "shop", "type": "module" }',
      '+{ "name": "shop", "type": "module", "dependencies": { "left-pad": "1.0.0" } }',
      "",
    ].join("\n");
    const git = new DiffGit(
      [
        untracked(".env"),
        modified(".github/workflows/ci.yml", 1, 0),
        modified("package.json", 1, 1),
        modified("src/settings.ts", 1, 0),
      ],
      patch,
    );
    const { provider, requests } = reviewer({ summary: "Nothing to add.", findings: [] });
    const { report, store } = await review(root, git, provider, [
      gate("test-shop", [testResult("src/orders.test.ts > lists orders", "assertion_failure", [])]),
    ]);

    expect(git.bases).toEqual(["HEAD"]);
    expect(report.verdict).toBe("failed_verification");
    const facts = report.findings.map((f) => [f.severity, f.category, f.verification, f.title]);
    expect(facts).toEqual([
      ["high", "quality", "confirmed", "Gate test-shop failed on the change"],
      ["medium", "test-gap", "confirmed", "No test that ran is linked to AC-1"],
      ["high", "security", "confirmed", "The change adds what looks like a secret"],
      ["medium", "scope", "confirmed", "The change touches a protected file: .env"],
      [
        "high",
        "security",
        "confirmed",
        "The change modifies a CI workflow: .github/workflows/ci.yml",
      ],
      ["low", "test-gap", "unverified", "Source files changed without any test change"],
      ["info", "compatibility", "confirmed", "A dependency manifest changed: package.json"],
    ]);
    expect(report.findings[2]?.location).toEqual({ path: "src/settings.ts", line: 2 });
    expect(report.acceptanceMatrix[0]).toMatchObject({ acId: "AC-1", status: "not_executed" });

    // Secrets and sensitive files never reach the model or the stored patch.
    const diff = ReviewDiff.parse(JSON.parse(await store.readText("artifacts/review-diff.json")));
    expect(diff.withheld).toEqual([".env"]);
    const stored = await store.readText("artifacts/review-diff.patch");
    const prompt = userText(onlyRequest(requests));
    for (const text of [stored, prompt, JSON.stringify(report)]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("hunter2");
    }
    expect(prompt).toContain("Not shown (sensitive files): .env");
    expect(report.manualChecks.join("\n")).toContain(
      "These changed files were not shown to the model (sensitive): .env",
    );
  });

  it("refuses to start without a change or a repository, and creates no run", async () => {
    const root = await workspace();
    const { provider } = reviewer({ summary: "-", findings: [] });
    const { testRunner } = runner([]);
    const start = (git: DiffGit) =>
      services(root, provider, { git, testRunner: () => Promise.resolve(testRunner) }).then((svc) =>
        startRun(
          { task: task(), taskFile: null, mode: "review", goal: "review", settings: settings() },
          svc,
        ),
      );
    await expect(start(new DiffGit([], ""))).rejects.toMatchObject({
      code: ErrorCode.ReviewNoChanges,
    });
    const outside = new DiffGit([modified("src/orders.ts")], ORDERS_PATCH);
    outside.unavailable = "the workspace is not in a git repository";
    await expect(start(outside)).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
      message: expect.stringContaining("review mode needs a git repository") as string,
    });
    expect(await listRuns(root)).toEqual([]);
  });
});
