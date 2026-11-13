import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

/**
 * Static checks of the npm publish workflow (ADR 0029). It is not run by this test suite.
 */
const { parse } = createRequire(path.join(repoRoot, "packages", "core", "package.json"))(
  "yaml",
) as { parse: (text: string) => unknown };

type Node = Record<string, unknown>;

const FILE = ".github/workflows/publish.yml";
const text = readFileSync(path.join(repoRoot, FILE), "utf8");
const workflow = parse(text) as Node;
const job = (workflow.jobs as Record<string, Node | undefined>).publish ?? {};
const steps = job.steps as Node[];
const runOf = (step: Node): string => (typeof step.run === "string" ? step.run : "");

describe("npm publish workflow", () => {
  it("runs only for a pushed release tag", () => {
    expect(workflow.on).toEqual({ push: { tags: ["v[0-9]+.[0-9]+.[0-9]+"] } });
  });

  it("grants the OIDC token to the publish job only, and nothing else to write", () => {
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toEqual({ contents: "read", "id-token": "write" });
  });

  it("runs in the npm environment, where the maintainer can require an approval", () => {
    expect(job.environment).toBe("npm");
  });

  it("pins every action to a full commit SHA and does not keep git credentials", () => {
    const uses = steps.map((step) => step.uses).filter((value) => typeof value === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    const checkout = steps.find((step) => String(step.uses).startsWith("actions/checkout@"));
    expect((checkout?.with as Node | undefined)?.["persist-credentials"]).toBe(false);
  });

  it("tests, checks the tag against the version and stages the release with provenance, without a token", () => {
    const runs = steps.map(runOf);
    expect(runs).toContain("pnpm test");
    expect(runs.some((run) => run.includes("does not match version"))).toBe(true);
    expect(runs).toContain("node scripts/pack-cli.mjs --pack");
    const publish = runs.find((run) => run.includes(" publish "));
    expect(publish).toContain(" stage publish ");
    expect(publish).toContain("--provenance");
    expect(text).not.toMatch(/NODE_AUTH_TOKEN|NPM_TOKEN|secrets\./);
  });

  it("passes the tag to the script through the environment, not an expression", () => {
    for (const step of steps) expect(runOf(step)).not.toContain("${{");
  });
});
