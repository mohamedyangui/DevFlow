import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FakeProvider } from "@devflow/ai";
import { GitClient, type LlmRequest } from "@devflow/core";
import { beforeAll, describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/**
 * `devflow pr create` (Phase 5) end to end: a real implement-mode run commits on its DevFlow
 * branch in a real git repository whose `origin` is a local bare repository, and GitHub
 * answers from fixtures through an injected `fetch`. No gate runs: PATH holds only git, so
 * node is not found and the run reports what did not run.
 */

// Assembled at runtime so that the file never holds a token-shaped literal.
const TOKEN = ["ghp", "PRCREATETESTTOKEN0123456789abcdefghij"].join("_");
const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "github",
  "test",
  "fixtures",
);
const BRANCH = "devflow/TASK-7";

const TASK_YAML = `schemaVersion: 1
id: TASK-7
title: Paginate the order list
description: listOrders must return one page of orders.
requirements:
  functional:
    - id: FR-1
      text: listOrders accepts page and size
acceptanceCriteria:
  - id: AC-1
    statement: Page 2 with size 10 returns orders 11 to 20
    covers: [FR-1]
testing:
  levels: [unit]
`;

const REPO: Readonly<Record<string, string>> = {
  ".gitignore": ".devflow/\nnode_modules/\n",
  "package.json": JSON.stringify(
    {
      name: "shop",
      type: "module",
      scripts: { test: "vitest run" },
      devDependencies: { vitest: "^3.2.0", typescript: "^5.8.0" },
    },
    null,
    2,
  ),
  "src/orders.ts": [
    "export interface Order { id: string; total: number }",
    "",
    "export function listOrders(orders: Order[]): Order[] {",
    "  return orders;",
    "}",
    "",
  ].join("\n"),
  "src/orders.test.ts": [
    'import { expect, it } from "vitest";',
    'import { listOrders } from "./orders";',
    "",
    'it("returns every order", () => {',
    "  expect(listOrders([])).toEqual([]);",
    "});",
    "",
  ].join("\n"),
  "tasks/TASK-7.yaml": TASK_YAML,
  "node_modules/vitest/vitest.mjs": "throw new Error('must not run');\n",
};

const TEST_FILE = "src/pagination.test.ts";

function provider(): FakeProvider {
  return new FakeProvider((request: LlmRequest) => {
    if (request.system.includes("requirements analyst")) {
      return JSON.stringify({
        summary: "Add page and size to listOrders.",
        requirementNotes: [],
        questions: [],
        assumptions: [],
        risks: [],
        edgeCases: [],
        contradictions: [],
        dependencies: [],
        affectedFiles: [{ path: "src/orders.ts", reason: "Defines listOrders." }],
      });
    }
    if (request.system.includes("test engineer")) {
      return JSON.stringify({
        summary: "A feature test for the second page.",
        tests: [
          {
            acIds: ["AC-1"],
            module: null,
            path: TEST_FILE,
            action: "create",
            content: [
              'import { expect, it } from "vitest";',
              'import { listOrders } from "./orders";',
              "",
              'it("AC-1: page 2 with size 10 returns orders 11 to 20", () => {',
              "  const orders = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), total: 1 }));",
              "  expect(listOrders(orders, 2, 10)).toHaveLength(10);",
              "});",
              "",
            ].join("\n"),
            edits: [],
            description: "Second page.",
          },
        ],
      });
    }
    if (request.system.includes("implementer")) {
      return JSON.stringify({
        summary: "Slice the orders to one page.",
        changes: [
          {
            path: "src/orders.ts",
            action: "modify",
            content: null,
            edits: [
              {
                search: "export function listOrders(orders: Order[]): Order[] {\n  return orders;",
                replace:
                  "export function listOrders(orders: Order[], page = 1, size = orders.length): Order[] {\n" +
                  "  return orders.slice((page - 1) * size, page * size);",
              },
            ],
            changeId: "CH-1",
            description: "Add page and size.",
          },
        ],
      });
    }
    return JSON.stringify({
      summary: "Paginate listOrders.",
      approach: "Slice the array.",
      relevantFiles: [],
      changes: [
        {
          module: null,
          path: "src/orders.ts",
          action: "modify",
          description: "Add page and size.",
          satisfies: ["FR-1", "AC-1"],
        },
      ],
      interfaceChanges: [],
      testStrategy: [
        {
          acId: "AC-1",
          level: "unit",
          intent: "feature",
          approach: "Call listOrders with 25 orders.",
          targetFile: TEST_FILE,
        },
      ],
      risks: [],
      regressionWatch: [],
      openQuestions: [],
    });
  });
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

/** The directory of the git executable only: git runs, node (the gates) is not found. */
const GIT_ONLY_PATH = path.resolve(git(process.cwd(), "--exec-path"));

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

async function fixture(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

/** A git client whose push URLs are github.com/acme/shop while the push goes to the bare origin. */
class GitHubOrigin extends GitClient {
  override pushUrls(): Promise<string[]> {
    return Promise.resolve(["https://github.com/acme/shop.git"]);
  }
}
const asGitHub: CliIo["gitClient"] = (options) => new GitHubOrigin(options);

async function cli(
  cwd: string,
  args: string[],
  extra: Partial<CliIo> = {},
  token: string | null = TOKEN,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const model = provider();
  const code = await runCli(args, {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd,
    env: {
      PATH: GIT_ONLY_PATH,
      SystemRoot: process.env.SystemRoot,
      HOME: `${cwd}-home`,
      USERPROFILE: `${cwd}-home`,
      DEVFLOW_HOME: `${cwd}-home`,
      DEVFLOW_USER: "mohamed",
      ...(token === null ? {} : { GITHUB_TOKEN: token }),
    },
    createProvider: () => Promise.resolve(model),
    ...extra,
  });
  return { code, stdout, stderr };
}

/** A repository on main with a bare `origin`, and a finished implement run on its branch. */
async function implemented(): Promise<{ root: string; origin: string; runId: string }> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-pr-create-")));
  for (const [relative, content] of Object.entries(REPO)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  await mkdir(`${root}-home`);
  git(root, "init", "--quiet", "--initial-branch=main");
  git(root, "config", "user.name", "DevFlow Test");
  git(root, "config", "user.email", "test@example.invalid");
  git(root, "config", "core.autocrlf", "false");
  git(root, "config", "commit.gpgSign", "false");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "base");
  const origin = `${root}-origin.git`;
  await mkdir(origin);
  git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "--quiet", "origin", "main");

  const started = await cli(root, ["run", "--task", "tasks/TASK-7.yaml", "--model", "m", "--json"]);
  const runId = (JSON.parse(started.stdout) as { runId: string }).runId;
  const plan = await cli(root, ["approve", runId, "--json"]);
  expect(plan.code, plan.stdout + plan.stderr).toBe(ExitCode.WaitingForInput);
  const tests = await cli(root, ["approve", runId, "--json"]);
  expect(tests.code, tests.stdout + tests.stderr).toBe(ExitCode.WaitingForInput);
  const done = await cli(root, ["approve", runId, "--json"]);
  expect(done.code, done.stdout + done.stderr).toBe(ExitCode.Success);
  expect(JSON.parse(done.stdout)).toMatchObject({ status: "completed", branch: BRANCH });
  return { root, origin, runId };
}

function refs(origin: string): string[] {
  return git(origin, "for-each-ref", "--format=%(refname)").split(/\r?\n/);
}

describe("devflow pr create", { timeout: 60_000 }, () => {
  let root: string;
  let origin: string;
  let runId: string;

  beforeAll(async () => {
    ({ root, origin, runId } = await implemented());
  }, 120_000);

  it("prints the plan and does nothing without --yes", async () => {
    const api = github({ json: await fixture("repo-shop.json") });
    const result = await cli(root, ["pr", "create", runId, "--repo", "acme/shop"], {
      fetch: api.fetch,
      gitClient: asGitHub,
    });
    expect(result.code, result.stdout + result.stderr).toBe(ExitCode.UsageError);
    expect(result.stdout).toContain(`1. push branch ${BRANCH}`);
    expect(result.stdout).toContain("2 DevFlow commits) to origin (github.com/acme/shop)");
    expect(result.stdout).toContain(`open a draft pull request in acme/shop: ${BRANCH} -> main`);
    expect(result.stdout).toContain("Title: DevFlow TASK-7: Paginate the order list");
    expect(result.stdout).toContain("Nothing was pushed or created");
    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/shop",
    ]);
    expect(refs(origin)).toEqual(["refs/heads/main"]);

    const json = await cli(root, ["pr", "create", runId, "--repo", "acme/shop", "--json"], {
      fetch: github({ json: await fixture("repo-shop.json") }).fetch,
      gitClient: asGitHub,
    });
    expect(json.code).toBe(ExitCode.UsageError);
    expect(JSON.parse(json.stdout)).toMatchObject({
      runId,
      done: false,
      plan: { repository: "acme/shop", branch: BRANCH, base: "main", draft: true, commits: 2 },
    });
    expect(refs(origin)).toEqual(["refs/heads/main"]);
  });

  it("needs a token, and calls nothing without one", async () => {
    const api = github();
    const result = await cli(
      root,
      ["pr", "create", runId, "--repo", "acme/shop", "--yes"],
      { fetch: api.fetch, gitClient: asGitHub },
      null,
    );
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("needs a GitHub token");
    expect(result.stderr).toContain("OPTIONS_INVALID");
    expect(api.calls).toEqual([]);
    expect(refs(origin)).toEqual(["refs/heads/main"]);
  });

  it("refuses an origin that is not the target repository", async () => {
    // The real push URL of origin is a local path, not github.com/acme/shop.
    const local = await cli(root, ["pr", "create", runId, "--repo", "acme/shop", "--yes"], {
      fetch: github().fetch,
    });
    expect(local.code).toBe(ExitCode.UsageError);
    expect(local.stderr).toContain("PULL_REQUEST_TARGET_INVALID");
    expect(local.stderr).toContain("not to github.com/acme/shop");

    const other = await cli(root, ["pr", "create", runId, "--repo", "someone/fork", "--yes"], {
      fetch: github().fetch,
      gitClient: asGitHub,
    });
    expect(other.code).toBe(ExitCode.UsageError);
    expect(other.stderr).toContain("origin pushes to https://github.com/acme/shop.git");
    expect(refs(origin)).toEqual(["refs/heads/main"]);
  });

  it("refuses a branch that is the base or the default branch", async () => {
    const asBase = await cli(
      root,
      ["pr", "create", runId, "--repo", "acme/shop", "--base", BRANCH, "--yes"],
      { fetch: github({ json: await fixture("repo-shop.json") }).fetch, gitClient: asGitHub },
    );
    expect(asBase.code).toBe(ExitCode.UsageError);
    expect(asBase.stderr).toContain(`the run's branch ${BRANCH} is the base of acme/shop`);

    const repo = { ...(await fixture("repo-shop.json")), default_branch: BRANCH };
    const asDefault = await cli(
      root,
      ["pr", "create", runId, "--repo", "acme/shop", "--base", "main", "--yes"],
      { fetch: github({ json: repo }).fetch, gitClient: asGitHub },
    );
    expect(asDefault.code).toBe(ExitCode.UsageError);
    expect(asDefault.stderr).toContain("is the default branch of acme/shop");
    expect(asDefault.stderr).toContain("PULL_REQUEST_TARGET_INVALID");

    const option = await cli(
      root,
      ["pr", "create", runId, "--repo", "acme/shop", "--base", "--force", "--yes"],
      { fetch: github({ json: await fixture("repo-shop.json") }).fetch, gitClient: asGitHub },
    );
    expect(option.code).toBe(ExitCode.UsageError);
    expect(refs(origin)).toEqual(["refs/heads/main"]);
  });

  it("refuses a run that is not a finished implement run", async () => {
    const analysed = await cli(root, ["analyze", "--task", "tasks/TASK-7.yaml", "--model", "m"]);
    expect(analysed.code, analysed.stdout + analysed.stderr).toBe(ExitCode.Success);
    const status = await cli(root, ["status", "--json"]);
    const runs = (JSON.parse(status.stdout) as { runs: { id: string; mode: string }[] }).runs;
    const assist = runs.find((run) => run.mode === "assist");
    expect(assist).toBeDefined();
    const result = await cli(root, ["pr", "create", assist?.id ?? "", "--yes"], {
      fetch: github().fetch,
      gitClient: asGitHub,
    });
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("is a assist-mode run");
    expect(result.stderr).toContain("PULL_REQUEST_RUN_INVALID");

    const missing = await cli(root, ["pr", "create", "no-such-run", "--yes"]);
    expect(missing.code).toBe(ExitCode.UsageError);
  });

  it("with --yes pushes only the run's branch and opens a draft pull request", async () => {
    const api = github(
      { json: await fixture("repo-shop.json") },
      { status: 201, json: await fixture("pull-created-58.json") },
    );
    const result = await cli(root, ["pr", "create", runId, "--repo", "acme/shop", "--yes"], {
      fetch: api.fetch,
      gitClient: asGitHub,
    });
    expect(result.code, result.stdout + result.stderr).toBe(ExitCode.Success);
    expect(result.stdout).toContain(
      `Pushed ${BRANCH} and opened draft pull request #58: https://github.com/acme/shop/pull/58`,
    );
    expect(result.stderr).toContain(`Pushing ${BRANCH} to origin...`);

    // Exactly the branch, at the run's last commit; main is unchanged and no tag was pushed.
    const tip = git(root, "rev-parse", `refs/heads/${BRANCH}`);
    expect(git(origin, "rev-parse", `refs/heads/${BRANCH}`)).toBe(tip);
    expect(refs(origin).sort()).toEqual([`refs/heads/${BRANCH}`, "refs/heads/main"]);
    expect(git(origin, "rev-parse", "refs/heads/main")).toBe(git(root, "rev-parse", "main"));

    expect(api.calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/shop",
      "POST https://api.github.com/repos/acme/shop/pulls",
    ]);
    const sent = JSON.parse(api.calls[1]?.body ?? "{}") as Record<string, string | boolean>;
    expect(sent).toMatchObject({
      head: BRANCH,
      base: "main",
      draft: true,
      title: "DevFlow TASK-7: Paginate the order list",
    });
    expect(sent.body).toContain("<!-- devflow-draft -->");
    expect(sent.body).toContain("**Verdict:** not_verified");
    expect(sent.body).toContain("DevFlow TASK-7: add tests");
    expect(sent.body).toContain("a person must review the change");
    expect(api.calls[1]?.body).not.toContain(TOKEN);
    // The token is used only for the API: git's configuration does not hold it.
    expect(git(root, "config", "--list", "--local")).not.toContain(TOKEN);
  });
});
