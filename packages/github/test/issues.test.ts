import { ErrorCode, parseTaskText } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import {
  GitHubClient,
  GitHubIssueSource,
  parseIssueReference,
  parseRepository,
  repositoryFromRemote,
} from "../src/index.js";
import { fixture, scriptedFetch } from "./helpers.js";

const ACME = { owner: "acme", name: "shop" };
const signal = new AbortController().signal;

describe("repositories", () => {
  it("reads github.com remotes in their usual forms, without credentials", () => {
    for (const url of [
      "https://github.com/acme/shop.git",
      "https://github.com/acme/shop",
      "https://user:secret@github.com/acme/shop.git",
      "git@github.com:acme/shop.git",
      "ssh://git@github.com/acme/shop.git",
      "git://github.com/acme/shop",
    ]) {
      expect(repositoryFromRemote(url), url).toEqual(ACME);
    }
    for (const url of [
      "https://gitlab.com/acme/shop.git",
      "https://github.com.evil.example/acme/shop",
      "https://github.com/acme/shop/extra",
      "https://github.com/acme",
      "file:///srv/shop.git",
      "../shop",
      "https://github.com/-acme/shop",
      "https://github.com/acme/..",
    ]) {
      expect(repositoryFromRemote(url), url).toBeUndefined();
    }
  });

  it("parses owner/name and refuses anything else", () => {
    expect(parseRepository("acme/shop")).toEqual(ACME);
    expect(parseRepository("acme/shop.git")).toEqual(ACME);
    for (const text of ["acme", "acme/shop/x", "ac me/shop", "acme/..", "-acme/shop", "a--b/c"]) {
      expect(() => parseRepository(text), text).toThrow(
        expect.objectContaining({ code: ErrorCode.GitHubRepositoryUnknown }),
      );
    }
  });
});

describe("issue references", () => {
  it("accepts a number, #number, owner/name#number and the issue URL", () => {
    expect(parseIssueReference("142", ACME)).toEqual({ repository: ACME, number: 142 });
    expect(parseIssueReference("#142", ACME)).toEqual({ repository: ACME, number: 142 });
    expect(parseIssueReference("other/lib#7", ACME)).toEqual({
      repository: { owner: "other", name: "lib" },
      number: 7,
    });
    expect(parseIssueReference("https://github.com/other/lib/issues/7", undefined)).toEqual({
      repository: { owner: "other", name: "lib" },
      number: 7,
    });
  });

  it("needs a repository for a bare number and refuses other text", () => {
    expect(() => parseIssueReference("142", undefined)).toThrow(
      expect.objectContaining({ code: ErrorCode.GitHubRepositoryUnknown }),
    );
    for (const text of ["0", "-1", "abc", "142a", "acme/shop#", "99999999999", "x/..#1"]) {
      expect(() => parseIssueReference(text, ACME), text).toThrow(
        expect.objectContaining({
          code: expect.stringMatching(/^GITHUB_(ISSUE_INVALID|REPOSITORY_UNKNOWN)$/) as unknown,
        }),
      );
    }
  });
});

describe("GitHubIssueSource", () => {
  it("reads an issue as an external Markdown task with GH-<number> and its title as defaults", async () => {
    const { fetch, requests } = scriptedFetch({ json: fixture("issue-142.json") });
    const source = new GitHubIssueSource(new GitHubClient({ fetch }), ACME);
    const document = await source.fetch("142", signal);
    expect(requests[0]?.url).toBe("https://api.github.com/repos/acme/shop/issues/142");
    expect(document).toMatchObject({
      format: "markdown",
      source: { kind: "github-issue", ref: "acme/shop#142", trust: "external" },
      defaults: { id: "GH-142", title: "Paginate the order list" },
      warnings: [],
    });

    const task = parseTaskText(document.text, document.format, document.source, {
      ...(document.defaults === undefined ? {} : { defaults: document.defaults }),
    });
    expect(task.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(task.contract).toMatchObject({
      id: "GH-142",
      title: "Paginate the order list",
      description: "The order list returns every order at once.",
      source: { kind: "github-issue", ref: "acme/shop#142", trust: "external" },
    });
    expect(task.contract?.requirements.functional.map((fr) => fr.id)).toEqual(["FR-1", "FR-2"]);
    expect(task.contract?.acceptanceCriteria.map((ac) => [ac.id, ac.covers])).toEqual([
      ["AC-1", ["FR-1", "FR-2"]],
      ["AC-2", ["FR-1"]],
    ]);
  });

  it("lets the issue text define its own id and title", async () => {
    const issue = {
      ...(fixture("issue-142.json") as object),
      body: "---\nid: SHOP-9\n---\n# Paged orders\n\n## Acceptance Criteria\n\n- Pages hold 20 orders\n",
    };
    const { fetch } = scriptedFetch({ json: issue });
    const document = await new GitHubIssueSource(new GitHubClient({ fetch }), ACME).fetch(
      "#142",
      signal,
    );
    const task = parseTaskText(document.text, document.format, document.source, {
      ...(document.defaults === undefined ? {} : { defaults: document.defaults }),
    });
    expect(task.contract).toMatchObject({ id: "SHOP-9", title: "Paged orders" });
  });

  it("refuses pull requests and oversized bodies, and warns about closed issues", async () => {
    const pull = scriptedFetch({ json: fixture("pull-57.json") });
    await expect(
      new GitHubIssueSource(new GitHubClient({ fetch: pull.fetch }), ACME).fetch("57", signal),
    ).rejects.toMatchObject({
      code: ErrorCode.GitHubIssueInvalid,
      message: "acme/shop#57 is a pull request, not an issue; a task comes from an issue",
    });

    const big = scriptedFetch({
      json: { ...(fixture("issue-142.json") as object), body: "x".repeat(1024 * 1024 + 1) },
    });
    await expect(
      new GitHubIssueSource(new GitHubClient({ fetch: big.fetch }), ACME).fetch("142", signal),
    ).rejects.toMatchObject({ code: ErrorCode.GitHubIssueInvalid });

    const closed = scriptedFetch({
      json: { ...(fixture("issue-142.json") as object), state: "closed", body: null },
    });
    const document = await new GitHubIssueSource(
      new GitHubClient({ fetch: closed.fetch }),
      ACME,
    ).fetch("142", signal);
    expect(document.text).toBe("");
    expect(document.warnings).toEqual(["acme/shop#142 is closed"]);
  });

  it("refuses an answer for another issue number", async () => {
    const { fetch } = scriptedFetch({ json: fixture("issue-142.json") });
    await expect(
      new GitHubIssueSource(new GitHubClient({ fetch }), ACME).fetch("143", signal),
    ).rejects.toMatchObject({ code: ErrorCode.GitHubRequestFailed });
  });
});
