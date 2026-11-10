import { EngineeringReport, ErrorCode } from "@devflow/core";
import { describe, expect, it } from "vitest";
import {
  COMMENT_MARKER,
  GitHubClient,
  conclusionOf,
  publishReview,
  renderReview,
} from "../src/index.js";
import { scriptedFetch } from "./helpers.js";

// Assembled at runtime so that the file never holds a token-shaped literal.
const TOKEN = ["ghp", "PUBLISHTESTTOKEN0123456789abcdefghij"].join("_");
const HEAD = "c".repeat(40);

function report(overrides: Partial<EngineeringReport> = {}): EngineeringReport {
  return EngineeringReport.parse({
    schemaVersion: 1,
    run: {
      id: "2026-11-10T10-00-00Z_TASK-7",
      devflowVersion: "0.0.0",
      mode: "review",
      state: "COMPLETED",
      startedAt: "2026-11-10T10:00:00.000Z",
      finishedAt: "2026-11-10T10:01:00.000Z",
      baseCommit: "a".repeat(40),
      headCommit: HEAD,
      pullRequest: {
        repository: "acme/shop",
        number: 57,
        url: "https://github.com/acme/shop/pull/57",
      },
    },
    verdict: "partially_verified",
    task: {
      id: "TASK-7",
      title: "Paginate the order list",
      source: { kind: "file", ref: "tasks/TASK-7.yaml", trust: "user" },
    },
    filesChanged: [],
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
        title: "Gate lint did not run",
        severity: "medium",
        category: "test-gap",
        source: "deterministic",
        verification: "confirmed",
        evidence: [{ kind: "note", description: "eslint is missing", deterministic: true }],
        recommendation: "Install eslint.",
      },
      {
        id: "F-2",
        title:
          "Ping @acme/owners <img src=x onerror=alert(1)> and see [this](https://evil.example)",
        severity: "high",
        category: "security",
        source: "ai",
        verification: "unverified",
        confidence: 0.4,
        evidence: [{ kind: "note", description: "a suspicion", deterministic: false }],
        location: { path: "src/orders.ts", line: 3 },
        recommendation: `Rotate ${TOKEN} | then | check`,
      },
    ],
    risks: [],
    assumptions: [],
    manualChecks: ["Read the diff yourself before you merge it."],
    ...overrides,
  });
}

describe("renderReview", () => {
  it("renders the verdict, criteria, gates and findings, with AI findings labelled unverified", () => {
    const body = renderReview(report());
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("## DevFlow review: partially_verified");
    expect(body).toContain("| AC-1 | verified | 1 passed |");
    expect(body).toContain("No gate ran.");
    expect(body).toContain("### Deterministic findings (1)");
    expect(body).toContain("### AI findings (unverified suggestions) (1)");
    expect(body).toContain("unverified · confidence 40% · `src/orders.ts:3`");
    expect(body).toContain("AI findings are a model's suggestions and stay unverified");
  });

  it("neutralises mentions, HTML, links and table syntax from model text", () => {
    const body = renderReview(report());
    expect(body).not.toMatch(/@acme/);
    expect(body).toContain("@​acme/owners");
    // Escaped, `<` is shown as text: no unescaped tag remains.
    expect(body).not.toMatch(/(^|[^\\])<img/m);
    expect(body).toContain("\\<img");
    expect(body).not.toContain("](https://evil.example)");
    expect(body).toContain("https:​//evil.example");
    expect(body).toContain("\\| then \\|");
  });

  it("cuts a body that is too long for GitHub", () => {
    const many = Array.from({ length: 400 }, (_, index) => ({
      id: `F-${String(index + 1)}`,
      title: "x".repeat(250),
      severity: "low" as const,
      category: "quality" as const,
      source: "ai" as const,
      verification: "unverified" as const,
      confidence: 0.5,
      evidence: [{ kind: "note" as const, description: "-", deterministic: false }],
      recommendation: "y".repeat(250),
    }));
    const body = renderReview(report({ findings: many }));
    expect(body.length).toBeLessThan(65_536);
    expect(body).toContain("350 more findings are in the full report.");
  });
});

describe("publishReview", () => {
  it("posts a redacted comment on the pull request", async () => {
    const { fetch, requests } = scriptedFetch({
      status: 201,
      json: { id: 1, html_url: "https://github.com/acme/shop/pull/57#issuecomment-1" },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    const published = await publishReview(client, "comment", {
      repository: { owner: "acme", name: "shop" },
      number: 57,
      headSha: HEAD,
      report: report(),
      knownSecrets: [TOKEN],
    });
    expect(published).toEqual({
      target: "comment",
      url: "https://github.com/acme/shop/pull/57#issuecomment-1",
    });
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/acme/shop/issues/57/comments",
    });
    const sent = JSON.parse(requests[0]?.body ?? "{}") as { body: string };
    expect(sent.body).toContain("## DevFlow review");
    expect(sent.body).not.toContain(TOKEN);
  });

  it("creates a completed check run on the head commit, failing only a failed verification", async () => {
    const { fetch, requests } = scriptedFetch({
      status: 201,
      json: { id: 9, html_url: "https://github.com/acme/shop/runs/9" },
    });
    const client = new GitHubClient({ token: TOKEN, fetch });
    await publishReview(client, "check", {
      repository: { owner: "acme", name: "shop" },
      number: 57,
      headSha: HEAD,
      report: report({ verdict: "failed_verification" }),
    });
    expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/shop/check-runs");
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      name: "DevFlow review",
      head_sha: HEAD,
      status: "completed",
      conclusion: "failure",
      output: { title: "Verdict: failed_verification" },
    });
    expect(conclusionOf("verified")).toBe("success");
    expect(conclusionOf("partially_verified")).toBe("neutral");
    expect(conclusionOf("not_verified")).toBe("neutral");
  });

  it("needs a token, and sends nothing without one", async () => {
    const { fetch, requests } = scriptedFetch();
    await expect(
      publishReview(new GitHubClient({ fetch }), "comment", {
        repository: { owner: "acme", name: "shop" },
        number: 57,
        headSha: HEAD,
        report: report(),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.GitHubRequestFailed });
    expect(requests).toEqual([]);
  });
});
