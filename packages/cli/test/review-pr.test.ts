import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeProvider } from "@devflowai/ai";
import type { LlmRequest } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/**
 * `devflow review --pr` (Phase 5): a pull request checked out in a real git repository,
 * GitHub answering from fixtures through an injected `fetch`, and a scripted model.
 */

// Assembled at runtime so that the file never holds a token-shaped literal.
const TOKEN = ["ghp", "REVIEWPRTESTTOKEN0123456789abcdefghi"].join("_");
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "github",
  "test",
  "fixtures",
);

const TASK = `schemaVersion: 1
id: TASK-7
title: Paginate the order list
description: listOrders must return one page of orders.
requirements:
  functional:
    - id: FR-1
      text: listOrders returns one page of orders
acceptanceCriteria:
  - id: AC-1
    statement: Page 2 with size 10 returns orders 11 to 20
    covers: [FR-1]
testing:
  levels: [unit]
`;

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

/** A repository with a base commit on main and a pull request commit checked out. */
async function repository(): Promise<{ root: string; base: string; head: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-review-pr-")));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, ".gitignore"), ".devflow/\n");
  await writeFile(path.join(root, "package.json"), '{ "name": "shop", "type": "module" }\n');
  await writeFile(path.join(root, "task.yaml"), TASK);
  await writeFile(
    path.join(root, "src", "orders.ts"),
    "export function listOrders(orders: unknown[]): unknown[] {\n  return orders;\n}\n",
  );
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "--quiet", "-b", "pr-57");
  await writeFile(
    path.join(root, "src", "orders.ts"),
    "export function listOrders(orders: unknown[], page = 1): unknown[] {\n" +
      "  return orders.slice((page - 1) * 10, page * 10);\n}\n",
  );
  git(root, "commit", "--quiet", "-am", "paginate");
  const head = git(root, "rev-parse", "HEAD");
  return { root, base, head };
}

async function pull(
  base: string,
  head: string,
  headRepository: string,
): Promise<Record<string, unknown>> {
  const fixture = JSON.parse(
    await readFile(path.join(FIXTURES, "pulls-57.json"), "utf8"),
  ) as Record<string, Record<string, unknown>>;
  return {
    ...fixture,
    head: { ...fixture.head, sha: head, repo: { full_name: headRepository } },
    base: { ...fixture.base, sha: base },
  };
}

interface Call {
  readonly method: string;
  readonly url: string;
  readonly body: string | undefined;
}

function github(...answers: { status?: number; json: unknown }[]) {
  const calls: Call[] = [];
  const fake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({
      method: init?.method ?? "GET",
      url: input instanceof Request ? input.url : input.toString(),
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const answer = answers.shift();
    if (answer === undefined) return Promise.reject(new Error("no scripted answer"));
    return Promise.resolve(
      new Response(JSON.stringify(answer.json), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { fetch: fake, calls };
}

function model(): FakeProvider {
  return new FakeProvider((request: LlmRequest) => {
    if (request.system.includes("requirements analyst")) {
      return JSON.stringify({
        summary: "Page the orders.",
        requirementNotes: [{ id: "FR-1", interpretation: "Pages of 10.", concerns: [] }],
        questions: [],
        assumptions: [],
        risks: [],
        edgeCases: [],
        contradictions: [],
        dependencies: [],
        affectedFiles: [{ path: "src/orders.ts", reason: "Defines listOrders." }],
      });
    }
    return JSON.stringify({
      summary: "The page size is fixed.",
      findings: [
        {
          title: "Page size is fixed at 10; ask @acme/owners",
          severity: "medium",
          category: "requirement",
          path: "src/orders.ts",
          line: 2,
          description: "AC-1 asks for a size parameter.",
          recommendation: "Add a size parameter.",
          confidence: 0.6,
          acIds: ["AC-1"],
        },
      ],
    });
  });
}

async function cli(
  cwd: string,
  args: string[],
  extra: Partial<CliIo>,
  token: string | null = TOKEN,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const env: Record<string, string | undefined> = {
    ...process.env,
    DEVFLOW_HOME: `${cwd}-home`,
    DEVFLOW_USER: "mohamed",
    GITHUB_TOKEN: token ?? undefined,
    GH_TOKEN: undefined,
  };
  const code = await runCli(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd,
    env,
    createProvider: () => Promise.resolve(model()),
    ...extra,
  });
  return { code, stdout, stderr };
}

const REVIEW = [
  "review",
  "--task",
  "task.yaml",
  "--pr",
  "57",
  "--repo",
  "acme/shop",
  "--model",
  "m",
];

describe("devflow review --pr", () => {
  it("reviews a checked-out fork pull request without running its code, and publishes a comment", async () => {
    const { root, base, head } = await repository();
    const { fetch, calls } = github(
      { json: await pull(base, head, "someone/shop") },
      { status: 201, json: { html_url: "https://github.com/acme/shop/pull/57#issuecomment-1" } },
    );
    const result = await cli(root, [...REVIEW, "--publish", "--json"], { fetch });
    expect(result.code, result.stdout + result.stderr).toBe(ExitCode.Success);
    const outcome = JSON.parse(result.stdout) as { runId: string; published: unknown };
    expect(outcome.published).toEqual({
      target: "comment",
      url: "https://github.com/acme/shop/pull/57#issuecomment-1",
    });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/shop/pulls/57",
      "POST https://api.github.com/repos/acme/shop/issues/57/comments",
    ]);

    const comment = (JSON.parse(calls[1]?.body ?? "{}") as { body: string }).body;
    expect(comment).toContain("## DevFlow review: ");
    expect(comment).toContain("The gates did not run on this change");
    expect(comment).toContain("### AI findings (unverified suggestions) (1)");
    expect(comment).toContain("@​acme/owners");
    expect(comment).not.toContain(TOKEN);

    const run = path.join(root, ".devflow", "runs", outcome.runId);
    const report = JSON.parse(await readFile(path.join(run, "report.json"), "utf8")) as {
      run: { pullRequest: unknown; headCommit: string; baseCommit: string };
      gates: unknown[];
    };
    expect(report.run).toMatchObject({
      pullRequest: { repository: "acme/shop", number: 57 },
      headCommit: head,
      baseCommit: base,
    });
    expect(report.gates).toEqual([]);

    // The finished review can be published again, as a check run on the head commit.
    const again = github({
      status: 201,
      json: { html_url: "https://github.com/acme/shop/runs/9" },
    });
    const check = await cli(root, ["report", outcome.runId, "--publish", "check"], {
      fetch: again.fetch,
    });
    expect(check.code, check.stderr).toBe(ExitCode.Success);
    expect(check.stdout).toContain(
      "Published the review as a check: https://github.com/acme/shop/runs/9",
    );
    expect(JSON.parse(again.calls[0]?.body ?? "{}")).toMatchObject({ head_sha: head });
  });

  it("refuses a pull request that is not the checked-out commit, and creates no run", async () => {
    const { root, base, head } = await repository();
    git(root, "checkout", "--quiet", "main");
    const { fetch, calls } = github({ json: await pull(base, head, "acme/shop") });
    const result = await cli(root, [...REVIEW, "--publish"], { fetch });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("REVIEW_PULL_REQUEST_NOT_CHECKED_OUT");
    expect(result.stderr).toContain("git fetch origin pull/57/head");
    expect(calls).toHaveLength(1);
    expect(await readdir(path.join(root, ".devflow", "runs")).catch(() => [])).toEqual([]);
  });

  it("refuses options that do not go together before calling GitHub", async () => {
    const { root } = await repository();
    const cases: [string[], string | null][] = [
      [["review", "--task", "task.yaml", "--publish", "--model", "m"], TOKEN],
      [["review", "--task", "task.yaml", "--run-fork-code", "--model", "m"], TOKEN],
      [[...REVIEW, "--base", "main"], TOKEN],
      [[...REVIEW, "--publish"], null],
    ];
    for (const [args, token] of cases) {
      const { fetch, calls } = github();
      const result = await cli(root, args, { fetch }, token);
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(ExitCode.UsageError);
      expect(result.stderr).toContain("OPTIONS_INVALID");
      expect(calls).toEqual([]);
    }
  });
});
