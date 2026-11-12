import { ErrorCode } from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GitHubClient, apiPath, githubToken } from "../src/index.js";
import { scriptedFetch } from "./helpers.js";

// Assembled at runtime so that the file never holds a token-shaped literal.
const TOKEN = ["ghp", "0123456789abcdefghijklmnopqrstuvwxyzAB"].join("_");
const Thing = z.object({ id: z.number() });

describe("GitHubClient", () => {
  it("sends versioned JSON requests with the token, and never follows redirects", async () => {
    const { fetch, requests } = scriptedFetch({ json: { id: 7, extra: true } });
    const client = new GitHubClient({ token: TOKEN, fetch });
    expect(await client.request({ path: "/repos/acme/shop", schema: Thing })).toEqual({ id: 7 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://api.github.com/repos/acme/shop",
      method: "GET",
      redirect: "manual",
      headers: {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        authorization: `Bearer ${TOKEN}`,
      },
    });
    expect(client.authenticated).toBe(true);
  });

  it("sends no authorization header without a token", async () => {
    const { fetch, requests } = scriptedFetch({ json: { id: 1 } });
    const client = new GitHubClient({ token: "  ", fetch });
    await client.request({ path: "/x", schema: Thing });
    expect(requests[0]?.headers.authorization).toBeUndefined();
    expect(client.authenticated).toBe(false);
  });

  it("encodes path segments so that values cannot add segments or queries", () => {
    expect(apiPath("repos", "acme", "../x?y=1", "issues", 3)).toBe(
      "/repos/acme/..%2Fx%3Fy%3D1/issues/3",
    );
  });

  it("explains failures by status, without the token", async () => {
    const cases: [number, Record<string, string>, unknown, RegExp][] = [
      [401, {}, { message: `Bad credentials ${TOKEN}` }, /GitHub rejected the token \(401/],
      [404, {}, { message: "Not Found" }, /not found \(404\): it does not exist or the token/],
      [403, { "x-ratelimit-remaining": "0" }, { message: "API rate limit exceeded" }, /rate limit/],
      [403, {}, { message: "Resource not accessible by integration" }, /lack a permission/],
      [500, {}, { message: "Server Error" }, /GitHub answered 500: Server Error/],
    ];
    for (const [status, headers, json, expected] of cases) {
      const { fetch } = scriptedFetch({ status, headers, json });
      const client = new GitHubClient({ token: TOKEN, fetch });
      const error = await client.request({ path: "/x", schema: Thing }).catch((e: unknown) => e);
      expect(error).toMatchObject({ code: ErrorCode.GitHubRequestFailed });
      expect((error as Error).message).toMatch(expected);
      expect((error as Error).message).not.toContain(TOKEN);
      expect(JSON.stringify(error)).not.toContain(TOKEN);
    }
  });

  it("suggests a token when the anonymous rate limit is reached or a private repository is hidden", async () => {
    const limited = scriptedFetch({
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      json: { message: "API rate limit exceeded" },
    });
    await expect(
      new GitHubClient({ fetch: limited.fetch }).request({ path: "/x", schema: Thing }),
    ).rejects.toThrow(/set GITHUB_TOKEN/);
    const hidden = scriptedFetch({ status: 404, json: { message: "Not Found" } });
    await expect(
      new GitHubClient({ fetch: hidden.fetch }).request({ path: "/x", schema: Thing }),
    ).rejects.toThrow(/private and GITHUB_TOKEN is not set/);
  });

  it("refuses redirects, answers of the wrong shape, oversized answers and network errors", async () => {
    const redirect = scriptedFetch({
      status: 301,
      headers: { location: "https://elsewhere.example/" },
      text: "",
    });
    await expect(
      new GitHubClient({ fetch: redirect.fetch }).request({ path: "/x", schema: Thing }),
    ).rejects.toThrow(/redirect, which DevFlow does not follow/);

    const shape = scriptedFetch({ json: { id: "seven" } });
    await expect(
      new GitHubClient({ fetch: shape.fetch }).request({ path: "/x", schema: Thing }),
    ).rejects.toThrow(/expected shape \(id:/);

    const big = scriptedFetch({ text: JSON.stringify({ id: 1, pad: "x".repeat(2000) }) });
    await expect(
      new GitHubClient({ fetch: big.fetch, maxResponseBytes: 1000 }).request({
        path: "/x",
        schema: Thing,
      }),
    ).rejects.toThrow(/larger than 1000 bytes/);

    const network = scriptedFetch({ error: new Error(`connect ECONNREFUSED ${TOKEN}`) });
    const error = await new GitHubClient({ token: TOKEN, fetch: network.fetch })
      .request({ path: "/x", schema: Thing })
      .then(
        () => new Error("no error"),
        (e: unknown) => e as Error,
      );
    expect(error.message).toMatch(/the request failed \(connect ECONNREFUSED/);
    expect(error.message).not.toContain(TOKEN);
  });

  it("reports an interruption as cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { fetch } = scriptedFetch({ error: new DOMException("aborted", "AbortError") });
    await expect(
      new GitHubClient({ fetch }).request({
        path: "/x",
        schema: Thing,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.Cancelled });
  });

  it("only talks to an https API", () => {
    expect(() => new GitHubClient({ apiUrl: "http://api.github.com" })).toThrow(/https/);
  });
});

describe("githubToken", () => {
  it("prefers GITHUB_TOKEN, then GH_TOKEN, and ignores empty values", () => {
    expect(githubToken({ GITHUB_TOKEN: "a-token", GH_TOKEN: "b" })).toBe("a-token");
    expect(githubToken({ GITHUB_TOKEN: " ", GH_TOKEN: "b-token" })).toBe("b-token");
    expect(githubToken({})).toBeUndefined();
  });
});
