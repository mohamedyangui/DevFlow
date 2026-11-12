import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

/**
 * Security properties of the GitHub Action (`action.yml`) and of the example workflows
 * (docs/specs/github-action.md). These are static checks of the files: the action and the
 * workflows are not run on GitHub by this test suite.
 */

// `yaml` is a dependency of @devflow-ai/core, not of the repository root: load it from there.
const { parse } = createRequire(path.join(repoRoot, "packages", "core", "package.json"))(
  "yaml",
) as { parse: (text: string) => unknown };

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function load(relativePath: string): Node {
  const value = parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
  if (!isNode(value)) throw new Error(`${relativePath} is not a YAML mapping`);
  return value;
}

function child(node: Node, key: string): Node {
  const value = node[key];
  if (!isNode(value)) throw new Error(`missing mapping "${key}"`);
  return value;
}

function steps(node: Node): Node[] {
  const value = node.steps;
  if (!Array.isArray(value)) throw new Error("missing steps");
  return value.filter(isNode);
}

const ACTION = "action.yml";
const VERIFY = "docs/examples/github-actions/devflow-verify.yml";
const REVIEW = "docs/examples/github-actions/devflow-review.yml";
/** The examples cannot know the SHA of the DevFlow commit that will contain the action. */
const DEVFLOW_ACTION = "mohamedyangui/DevFlow@DEVFLOW_COMMIT_SHA";

const action = load(ACTION);
const actionSteps = steps(child(action, "runs"));
const workflows = { [VERIFY]: load(VERIFY), [REVIEW]: load(REVIEW) };

function jobs(workflow: Node): Node[] {
  return Object.values(child(workflow, "jobs")).filter(isNode);
}

function allSteps(file: string): Node[] {
  return file === ACTION ? actionSteps : jobs(load(file)).flatMap(steps);
}

const files = [ACTION, VERIFY, REVIEW];

/** Event names of a workflow's `on:` (a string, a list or a mapping). */
function events(workflow: Node): string[] {
  const on = workflow.on;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  return isNode(on) ? Object.keys(on) : [];
}

describe("GitHub Action and example workflows", () => {
  it("action.yml is a composite action", () => {
    expect(child(action, "runs").using).toBe("composite");
  });

  it.each(files)("%s pins every action to a full commit SHA", (file) => {
    const uses = allSteps(file)
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string");
    expect(uses.length).toBeGreaterThan(0);
    for (const reference of uses) {
      if (reference === DEVFLOW_ACTION && file !== ACTION) continue;
      expect(reference, reference).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
    }
  });

  it.each(files)("%s puts no ${{ }} expression inside a run script", (file) => {
    const scripts = allSteps(file)
      .map((step) => step.run)
      .filter((value): value is string => typeof value === "string");
    for (const script of scripts) expect(script).not.toContain("${{");
  });

  it.each(files)("%s never uses pull_request_target", (file) => {
    if (file !== ACTION) expect(events(load(file))).not.toContain("pull_request_target");
    // Not even as a list item or key outside `on:` (comments may name it, to warn).
    const lines = readFileSync(path.join(repoRoot, file), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"));
    expect(lines.filter((line) => line.includes("pull_request_target"))).toEqual([]);
  });

  it("action.yml gives credentials only to the step that runs DevFlow", () => {
    const credentialSteps = actionSteps.filter((step) =>
      Object.values(isNode(step.env) ? step.env : {}).some(
        (value) =>
          typeof value === "string" && /github-token|api-key|secrets\.|github\.token/.test(value),
      ),
    );
    expect(credentialSteps.map((step) => step.id)).toEqual(["run"]);
    // Inputs reach the scripts through env only, and the inputs are checked before any
    // installation.
    expect(actionSteps[0]?.name).toBe("Check the inputs");
  });

  it("action.yml builds DevFlow from its own source and runs the real CLI entry point", () => {
    const cli = readFileSync(path.join(repoRoot, "packages", "cli", "package.json"), "utf8");
    const bin = (JSON.parse(cli) as { bin: { devflow: string } }).bin.devflow;
    const scripts = actionSteps.map((step) => (typeof step.run === "string" ? step.run : ""));
    expect(scripts.join("\n")).toContain('cd "$GITHUB_ACTION_PATH"');
    expect(scripts.join("\n")).toContain(
      `"$GITHUB_ACTION_PATH/packages/cli/${bin.replace(/^\.\//, "")}"`,
    );
  });

  it("action.yml installs the pnpm version of the repository's packageManager", () => {
    const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      packageManager: string;
    };
    const pnpm = actionSteps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("pnpm/action-setup@"),
    );
    expect(pnpm && isNode(pnpm.with) ? `pnpm@${String(pnpm.with.version)}` : "").toBe(
      manifest.packageManager,
    );
  });

  it.each([VERIFY, REVIEW])("%s checks out without persisting credentials", (file) => {
    const checkouts = allSteps(file).filter(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(isNode(step.with) ? step.with["persist-credentials"] : undefined).toBe(false);
    }
  });

  it("the verify workflow is fork-safe: pull_request, read-only, no secrets", () => {
    const workflow = workflows[VERIFY];
    expect(events(workflow)).toEqual(["pull_request"]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    for (const job of jobs(workflow)) expect(job.permissions).toEqual({ contents: "read" });
    const text = readFileSync(path.join(repoRoot, VERIFY), "utf8");
    expect(text).not.toMatch(/secrets\.|github\.token|api-key|github-token/);
    const devflow = allSteps(VERIFY).find((step) => step.uses === DEVFLOW_ACTION);
    expect(isNode(devflow?.with) ? devflow.with.command : undefined).toBe("verify");
  });

  it("the review workflow is gated on same-repository + label, or a manual dispatch", () => {
    const workflow = workflows[REVIEW];
    expect(events(workflow).sort()).toEqual(["pull_request", "workflow_dispatch"]);
    const [job, ...others] = jobs(workflow);
    expect(others).toEqual([]);
    const condition = typeof job?.if === "string" ? job.if.replace(/\s+/g, " ") : "";
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain(
      "github.event.pull_request.head.repo.full_name == github.repository",
    );
    expect(condition).toContain("'devflow-review'");
    expect(isNode(workflow.concurrency) ? String(workflow.concurrency.group) : "").toContain(
      "github.event.pull_request.number",
    );
  });

  it("the review workflow has minimal permissions for what it publishes", () => {
    const workflow = workflows[REVIEW];
    expect(workflow.permissions).toEqual({ contents: "read" });
    const job = jobs(workflow)[0];
    const devflow = allSteps(REVIEW).find((step) => step.uses === DEVFLOW_ACTION);
    const inputs = isNode(devflow?.with) ? devflow.with : {};
    const expected: Record<string, string> = {
      none: "read",
      comment: "write",
      check: "read",
    };
    const publish = typeof inputs.publish === "string" ? inputs.publish : "none";
    expect(job?.permissions).toEqual({
      contents: "read",
      "pull-requests": expected[publish],
      ...(publish === "check" ? { checks: "write" } : {}),
    });
    // The review job runs no repository code.
    expect(inputs["trust-workspace"] ?? "false").toBe("false");
    expect(inputs["run-fork-code"] ?? "false").toBe("false");
    expect(allSteps(REVIEW).filter((step) => step.run !== undefined)).toEqual([]);
  });
});

/** Runs the input check of action.yml with bash, when a working bash is on PATH. */
const checkScript = actionSteps.find((step) => step.name === "Check the inputs")?.run;

function bashWorks(): boolean {
  try {
    return execFileSync("bash", ["-c", "[[ x =~ ^x$ ]] && echo ok"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).startsWith("ok");
  } catch {
    return false;
  }
}

const defaults: Record<string, string> = {
  IN_COMMAND: "verify",
  IN_TASK: "",
  IN_ISSUE: "",
  IN_PR: "",
  IN_PUBLISH: "none",
  IN_MODEL: "",
  IN_PROVIDER: "",
  IN_ALLOW: "",
  IN_TRUST: "false",
  IN_RUN_FORK_CODE: "false",
  IN_WORKING_DIRECTORY: ".",
};

function check(inputs: Record<string, string>): number {
  try {
    execFileSync("bash", ["-c", String(checkScript)], {
      env: { ...process.env, ...defaults, ...inputs },
      stdio: "ignore",
    });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

describe.skipIf(!bashWorks())("action.yml input check (bash)", () => {
  const fingerprint = "a".repeat(64);
  const review = { IN_COMMAND: "review", IN_PR: "57", IN_TASK: "tasks/t.md" };

  it.each([
    ["verify", {}],
    ["verify with fingerprints", { IN_ALLOW: `${fingerprint}\n${fingerprint}` }],
    ["review", review],
    ["review with an issue", { ...review, IN_TASK: "", IN_ISSUE: "142" }],
    ["review with a model", { ...review, IN_MODEL: "model-1.5", IN_PROVIDER: "openai" }],
    ["review published as a check", { ...review, IN_PUBLISH: "check" }],
  ])("accepts %s", (_name, inputs) => {
    expect(check(inputs)).toBe(0);
  });

  it.each([
    ["an unknown command", { IN_COMMAND: "implement" }],
    ["shell in the command", { IN_COMMAND: "verify; id" }],
    ["a fingerprint with shell", { IN_ALLOW: "$(id)" }],
    ["a short fingerprint", { IN_ALLOW: "abc" }],
    ["a working directory outside the workspace", { IN_WORKING_DIRECTORY: "../other" }],
    ["an absolute working directory", { IN_WORKING_DIRECTORY: "/etc" }],
    ["a task outside the workspace", { ...review, IN_TASK: "a/../../b.md" }],
    ["a task that looks like an option", { ...review, IN_TASK: "--help" }],
    ["a pull request that is not a number", { ...review, IN_PR: "57 --run-fork-code" }],
    ["an unknown publish target", { ...review, IN_PUBLISH: "approve" }],
    ["an unknown provider", { ...review, IN_PROVIDER: "local" }],
    ["a model with spaces", { ...review, IN_MODEL: "m --cassette x" }],
    ["review without a pull request", { ...review, IN_PR: "" }],
    ["review with a task and an issue", { ...review, IN_ISSUE: "1" }],
    ["verify with review inputs", { IN_PR: "57" }],
    ["verify that publishes", { IN_PUBLISH: "comment" }],
    ["a trust value that is not a boolean", { IN_TRUST: "yes" }],
  ])("rejects %s", (_name, inputs) => {
    expect(check(inputs)).toBe(2);
  });
});
