import { EngineeringReport, ErrorCode } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import {
  DRAFT_MARKER,
  GitHubClient,
  createDraftPullRequest,
  draftTitle,
  getRepositoryInfo,
  renderDraftBody,
} from "../src/index.js";
import { fixture, scriptedFetch } from "./helpers.js";

// Assembled at runtime so that the file never holds a token-shaped literal.
const TOKEN = ["ghp", "DRAFTTESTTOKEN0123456789abcdefghijklm"].join("_");
const SHOP = { owner: "acme", name: "shop" };

function report(overrides: Partial<EngineeringReport> = {}): EngineeringReport {
  return EngineeringReport.parse({
    schemaVersion: 1,
    run: {
      id: "2026-11-10T10-00-00Z_TASK-7",
      devflowVersion: "0.0.0",
      mode: "implement",
      state: "COMPLETED",
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: "2026-11-10T10:01:00.000Z",
      baseCommit: "a".repeat(40),
      headCommit: "c".repeat(40),
      branch: "devflow/TASK-7",
    },
    verdict: "partially_verified",
    task: {
      id: "TASK-7",
      title: "Paginate @acme/owners <b>now</b>",
      source: { kind: "file", ref: "tasks/TASK-7.yaml", trust: "user" },
    },
    filesChanged: [{ path: "src/orders`x.ts", change: "modified" }],
    acceptanceMatrix: [
      {
        acId: "AC-1",
        requirementIds: ["FR-1"],
        verification: "automated",
        tests: [{ testId: "t1", gateId: "test-shop", status: "passed" }],
        status: "verified",
      },
    ],
    gates: [],
    findings: [
      {
        id: "F-1",
        title: "See [this](https://evil.example)",
        severity: "low",
        category: "quality",
        source: "ai",
        verification: "unverified",
        confidence: 0.5,
        evidence: [{ kind: "note", description: "a suspicion", deterministic: false }],
        recommendation: `Use ${TOKEN}`,
      },
    ],
    risks: [],
    assumptions: [],
    manualChecks: [],
    ...overrides,
  });
}

const BODY_INPUT = {
  report: report(),
  repository: SHOP,
  branch: "devflow/TASK-7",
  base: "main",
  commits: [
    { sha: "b".repeat(40), subject: "DevFlow TASK-7: add tests" },
    { sha: "c".repeat(40), subject: "DevFlow TASK-7: implement the change" },
  ],
};

describe("renderDraftBody", () => {
  it("renders the verdict, commits, files and evidence, and asks for a human review", () => {
    const body = renderDraftBody(BODY_INPUT);
    expect(body.startsWith(DRAFT_MARKER)).toBe(true);
    expect(body).toContain(
      "**Verdict:** partially_verified · **Branch:** `devflow/TASK-7` → `main`",
    );
    expect(body).toContain("- `bbbbbbbbbbbb` DevFlow TASK-7: add tests");
    expect(body).toContain("### Files changed (1)");
    expect(body).toContain("- modified: `src/orders'x.ts`");
    expect(body).toContain("| AC-1 | verified | 1 passed |");
    expect(body).toContain("### AI findings (unverified suggestions) (1)");
    expect(body).toContain("a person must review the change");
    expect(body).toContain("Prepared by DevFlow AI 0.0.0");
  });

  it("neutralises mentions, HTML and links from the task and the model", () => {
    const body = renderDraftBody(BODY_INPUT);
    expect(body).not.toMatch(/@acme/);
    expect(body).toContain("\\<b\\>now\\</b\\>");
    expect(body).not.toContain("](https://evil.example)");
  });
});

describe("draftTitle", () => {
  it("keeps one line of at most 200 characters", () => {
    expect(draftTitle("  a\n b  ")).toBe("a b");
    expect(draftTitle(`red${String.fromCharCode(27)}[31m text`)).toBe("red [31m text");
    expect(draftTitle("x".repeat(300))).toHaveLength(200);
  });
});

describe("getRepositoryInfo", () => {
  it("reads the default branch", async () => {
    const { fetch, requests } = scriptedFetch({ json: fixture("repo-shop.json") });
    const info = await getRepositoryInfo(new GitHubClient({ token: TOKEN, fetch }), SHOP);
    expect(info).toMatchObject({ full_name: "acme/shop", default_branch: "main" });
    expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/shop");
  });
});

describe("createDraftPullRequest", () => {
  it("posts a redacted draft pull request and nothing else", async () => {
    const { fetch, requests } = scriptedFetch({
      status: 201,
      json: fixture("pull-created-58.json"),
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    const created = await createDraftPullRequest(client, {
      repository: SHOP,
      head: "devflow/TASK-7",
      base: "main",
      title: `DevFlow TASK-7: Paginate ${TOKEN}`,
      body: renderDraftBody(BODY_INPUT),
      knownSecrets: [TOKEN],
    });
    expect(created).toEqual({
      number: 58,
      url: "https://github.com/acme/shop/pull/58",
      draft: true,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/shop/pulls",
    });
    const sent = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(["base", "body", "draft", "head", "title"]);
    expect(sent).toMatchObject({ head: "devflow/TASK-7", base: "main", draft: true });
    expect(requests[0]?.body).not.toContain(TOKEN);
  });

  it("refuses an answer for another branch, and a branch that is its own base", async () => {
    const pull = fixture("pull-created-58.json") as Record<string, unknown>;
    const { fetch } = scriptedFetch({
      status: 201,
      json: { ...pull, head: { ref: "main", sha: "c".repeat(40) } },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    const input = { repository: SHOP, head: "devflow/TASK-7", base: "main", title: "t", body: "b" };
    await expect(createDraftPullRequest(client, input)).rejects.toMatchObject({
      code: ErrorCode.GitHubRequestFailed,
    });
    await expect(createDraftPullRequest(client, { ...input, head: "main" })).rejects.toMatchObject({
      code: ErrorCode.PullRequestTargetInvalid,
    });
  });

  it("needs a token, and reports GitHub's refusal without the token", async () => {
    const empty = scriptedFetch();
    await expect(
      createDraftPullRequest(new GitHubClient({ fetch: empty.fetch }), {
        repository: SHOP,
        head: "devflow/TASK-7",
        base: "main",
        title: "t",
        body: "b",
      }),
    ).rejects.toMatchObject({ code: ErrorCode.GitHubRequestFailed });
    expect(empty.requests).toEqual([]);

    const { fetch } = scriptedFetch({
      status: 422,
      json: { message: `Validation Failed: A pull request already exists ${TOKEN}` },
    });
    const failure = createDraftPullRequest(new GitHubClient({ token: TOKEN, fetch }), {
      repository: SHOP,
      head: "devflow/TASK-7",
      base: "main",
      title: "t",
      body: "b",
    });
    await expect(failure).rejects.toMatchObject({
      code: ErrorCode.GitHubRequestFailed,
      message: expect.stringContaining("A pull request already exists") as unknown,
    });
    await expect(failure).rejects.not.toMatchObject({
      message: expect.stringContaining(TOKEN) as unknown,
    });
  });
});
