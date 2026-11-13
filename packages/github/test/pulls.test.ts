import { ErrorCode } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import { GitHubClient, getPullRequest, parsePullRequestReference } from "../src/index.js";
import { fixture, scriptedFetch } from "./helpers.js";

const ACME = { owner: "acme", name: "shop" };
const PULL = fixture("pulls-57.json") as Record<string, unknown>;

function withHead(repo: { full_name: string } | null): Record<string, unknown> {
  return { ...PULL, head: { ...(PULL.head as object), repo } };
}

describe("pull request references", () => {
  it("accepts a number, #number, owner/name#number and the pull request URL", () => {
    expect(parsePullRequestReference("57", ACME)).toEqual({ repository: ACME, number: 57 });
    expect(parsePullRequestReference("#57", ACME)).toEqual({ repository: ACME, number: 57 });
    expect(parsePullRequestReference("other/lib#3", undefined)).toEqual({
      repository: { owner: "other", name: "lib" },
      number: 3,
    });
    expect(parsePullRequestReference("https://github.com/other/lib/pull/3", undefined)).toEqual({
      repository: { owner: "other", name: "lib" },
      number: 3,
    });
  });

  it("refuses other text, and a bare number without a repository", () => {
    expect(() => parsePullRequestReference("57", undefined)).toThrow(
      expect.objectContaining({ code: ErrorCode.GitHubRepositoryUnknown }),
    );
    for (const text of ["0", "abc", "https://github.com/a/b/issues/3", "a/b#x"]) {
      expect(() => parsePullRequestReference(text, ACME), text).toThrow(
        expect.objectContaining({ code: ErrorCode.GitHubPullRequestInvalid }),
      );
    }
  });
});

describe("getPullRequest", () => {
  it("reads the head and base commits of a pull request from the same repository", async () => {
    const { fetch, requests } = scriptedFetch({ json: PULL });
    const pull = await getPullRequest(new GitHubClient({ fetch }), "57", ACME);
    expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/shop/pulls/57");
    expect(pull).toEqual({
      repository: ACME,
      number: 57,
      title: "Add pagination",
      url: "https://github.com/acme/shop/pull/57",
      headSha: "c".repeat(40),
      baseSha: "a".repeat(40),
      baseRef: "main",
      headRepository: "acme/shop",
      fromFork: false,
      warnings: [],
    });
  });

  it("recognises forks, deleted forks, and closed, merged or draft pull requests", async () => {
    const fork = scriptedFetch({ json: withHead({ full_name: "someone/shop" }) });
    expect(await getPullRequest(new GitHubClient({ fetch: fork.fetch }), "57", ACME)).toMatchObject(
      { fromFork: true, headRepository: "someone/shop" },
    );
    const deleted = scriptedFetch({ json: withHead(null) });
    expect(
      await getPullRequest(new GitHubClient({ fetch: deleted.fetch }), "57", ACME),
    ).toMatchObject({ fromFork: true, headRepository: null });

    const merged = scriptedFetch({ json: { ...PULL, state: "closed", merged: true, draft: true } });
    expect(
      (await getPullRequest(new GitHubClient({ fetch: merged.fetch }), "57", ACME)).warnings,
    ).toEqual(["acme/shop#57 is already merged", "acme/shop#57 is a draft"]);
  });

  it("refuses an answer for another number or with a malformed commit", async () => {
    const other = scriptedFetch({ json: PULL });
    await expect(
      getPullRequest(new GitHubClient({ fetch: other.fetch }), "58", ACME),
    ).rejects.toMatchObject({ code: ErrorCode.GitHubRequestFailed });
    const bad = scriptedFetch({ json: { ...PULL, head: { ...(PULL.head as object), sha: "x" } } });
    await expect(
      getPullRequest(new GitHubClient({ fetch: bad.fetch }), "57", ACME),
    ).rejects.toMatchObject({ code: ErrorCode.GitHubRequestFailed });
  });
});
