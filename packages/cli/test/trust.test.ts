import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliIo } from "../src/index.js";

let base: string;
let workspace: string;
let home: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "devflow-trust-cli-")));
  workspace = path.join(base, "repo");
  home = path.join(base, "home");
  await mkdir(path.join(workspace, ".devflow"), { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const CONFIG = [
  "version: 1",
  "modules:",
  "  - id: web",
  "    path: packages/web",
  "    adapter: javascript",
  "verification:",
  "  gates:",
  "    - id: unit",
  "      module: web",
  "      use: test",
  "    - id: style",
  "      module: web",
  "      use: lint",
  "      required: false",
  "",
].join("\n");

async function writeConfig(text: string): Promise<void> {
  await writeFile(path.join(workspace, ".devflow", "config.yaml"), text);
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly questions: readonly string[];
}

async function run(args: string[], options: { answer?: string } = {}): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const questions: string[] = [];
  const answer = options.answer;
  const io: CliIo = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd: workspace,
    env: { DEVFLOW_HOME: home, USER: "tester" },
    ...(answer === undefined
      ? {}
      : {
          prompt: (question: string) => {
            questions.push(question);
            return Promise.resolve(answer);
          },
        }),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr, questions };
}

async function status(): Promise<string> {
  const result = await run(["trust", "--status", "--json"]);
  return (JSON.parse(result.stdout) as { status: string }).status;
}

describe("devflow trust", () => {
  it("reports an unknown workspace as untrusted", async () => {
    const result = await run(["trust", "--status"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain("UNTRUSTED");
    expect(result.stdout).toContain(path.join(home, "trust.json"));
  });

  it("shows the review and trusts nothing without a confirmation", async () => {
    await writeConfig(CONFIG);
    const result = await run(["trust"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain("unit: test in module web");
    expect(result.stdout).toContain("style: lint in module web (optional)");
    expect(result.stdout).toContain("Residual risks");
    expect(result.stdout).toContain("devflow trust --yes");
    expect(await status()).toBe("untrusted");
  });

  it("trusts the workspace with --yes, outside the repository", async () => {
    await writeConfig(CONFIG);
    const result = await run(["trust", "--yes"]);
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain("Trusted.");

    const stored = JSON.parse(await readFile(path.join(home, "trust.json"), "utf8")) as {
      workspaces: { root: string; trustedBy: string; configSha256: string }[];
    };
    expect(stored.workspaces).toEqual([
      expect.objectContaining({ root: workspace, trustedBy: "tester" }),
    ]);
    const check = await run(["trust", "--status"]);
    expect(check.code).toBe(ExitCode.Success);
    expect(check.stdout).toContain("TRUSTED since");
    expect(check.stdout).toContain("Approved commands: none");

    const again = await run(["trust", "--yes"]);
    expect(again.stdout).toContain("Already trusted");
  });

  it("asks on an interactive terminal", async () => {
    await writeConfig(CONFIG);
    const declined = await run(["trust"], { answer: "n" });
    expect(declined.code).toBe(ExitCode.Failure);
    expect(declined.questions).toEqual(["Trust this workspace for this configuration? [y/N] "]);
    expect(declined.stdout).toContain("Residual risks");
    expect(declined.stdout).toContain("Declined.");
    expect(await status()).toBe("untrusted");

    expect((await run(["trust"], { answer: "" })).code).toBe(ExitCode.Failure);
    const accepted = await run(["trust"], { answer: "yes" });
    expect(accepted.code).toBe(ExitCode.Success);
    expect(await status()).toBe("trusted");
  });

  it("trusts a workspace without configuration, until one is added", async () => {
    expect((await run(["trust", "--yes"])).code).toBe(ExitCode.Success);
    expect(await status()).toBe("trusted");
    await writeConfig(CONFIG);
    const result = await run(["trust", "--status"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain("CONFIG CHANGED");
  });

  it("requires a new review after the configuration changes", async () => {
    await writeConfig(CONFIG);
    await run(["trust", "--yes"]);
    await writeConfig(`${CONFIG}# edited\n`);
    expect(await status()).toBe("config-changed");
    const review = await run(["trust"]);
    expect(review.stdout).toContain("CONFIG CHANGED since it was last trusted");
    await run(["trust", "--yes"]);
    expect(await status()).toBe("trusted");
  });

  it("refuses to trust an invalid configuration", async () => {
    await writeConfig("version: 1\napiKey: sk-not-a-real-key\n");
    const result = await run(["trust", "--yes"]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain("Configuration problems");
    expect(result.stdout).toContain("line 2");
    expect(result.stdout).toContain("the configuration is invalid");
    expect(await status()).toBe("untrusted");
  });

  it("revokes trust", async () => {
    await run(["trust", "--yes"]);
    const result = await run(["trust", "--revoke"]);
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain("revoked");
    expect(await status()).toBe("untrusted");
    expect((await run(["trust", "--revoke"])).stdout).toContain("nothing to revoke");
  });

  it("prints JSON and never prompts in JSON mode", async () => {
    await writeConfig(CONFIG);
    const pending = await run(["trust", "--json"], { answer: "y" });
    expect(pending.code).toBe(ExitCode.Failure);
    expect(pending.questions).toEqual([]);
    const json = JSON.parse(pending.stdout) as Record<string, unknown>;
    expect(json).toMatchObject({
      workspace,
      action: "confirmation-required",
      status: "untrusted",
      config: { path: ".devflow/config.yaml", exists: true, valid: true },
      trustedAt: null,
      commands: [],
    });
    expect((json.config as { sha256: string }).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((json.config as { gates: unknown[] }).gates).toHaveLength(2);
    expect(json.residualRisks).toHaveLength(4);

    const trusted = JSON.parse((await run(["trust", "--yes", "--json"])).stdout) as Record<
      string,
      unknown
    >;
    expect(trusted).toMatchObject({ action: "trusted", status: "trusted", trustedBy: "tester" });
  });

  it("accepts the workspace as an argument", async () => {
    const other = path.join(base, "other");
    await mkdir(other);
    const result = await run(["trust", "--yes", "--json", "../other"]);
    expect(result.code).toBe(ExitCode.Success);
    expect(JSON.parse(result.stdout)).toMatchObject({ workspace: other, status: "trusted" });
    expect(await status()).toBe("untrusted");
  });

  it("returns a usage error for a missing workspace or conflicting options", async () => {
    const missing = await run(["trust", "--status", "no-such-dir"]);
    expect(missing.code).toBe(ExitCode.UsageError);
    expect(missing.stderr).toContain("WORKSPACE_INVALID");
    expect((await run(["trust", "--status", "--revoke"])).code).toBe(ExitCode.UsageError);
    expect((await run(["trust", "--yes", "--revoke"])).code).toBe(ExitCode.UsageError);
  });

  it("refuses to work with a corrupt trust store", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "trust.json"), "{ not json");
    const result = await run(["trust", "--yes"]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.stderr).toContain("TRUST_STORE_INVALID");
    expect(await readFile(path.join(home, "trust.json"), "utf8")).toBe("{ not json");
  });
});
