import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandPolicy,
  Executor,
  PathGuard,
  SecretRedactor,
  TrustStore,
  fileEvidence,
  freshReportFiles,
  runGates,
  unparseable,
  validatedAdapter,
  type CommandPolicyOptions,
  type CommandSpec,
  type GateDefinition,
  type ParsedCommandResults,
  type RepositoryEntry,
  type RepositoryView,
  type VerificationOptions,
  type WorkspaceModule,
} from "../../src/index.js";
import { StaticToolchainProbe } from "../../src/testing/index.js";
import { toyAdapter } from "../adapters/toy-adapter.js";

/**
 * The engine with the real command policy, trust store and executor: a node script stands in
 * for a test runner and writes a report the adapter reads.
 */

const CONFIG = "c".repeat(64);
const SECRET = "tok-1a2b3c4d5e6f7a8b";
const LOG_DIR = ".devflow/runs/verify/run-1/logs";

let base: string;
let root: string;
let guard: PathGuard;
let trust: TrustStore;

/** A read-only view of a directory on disk, enough for the toy adapter. */
class DiskRepository implements RepositoryView {
  constructor(readonly root: string) {}
  private absolute(relative: string): string {
    return path.join(this.root, ...relative.split("/"));
  }
  async exists(relative: string): Promise<boolean> {
    return stat(this.absolute(relative)).then(
      () => true,
      () => false,
    );
  }
  readText(relative: string): Promise<string> {
    return readFile(this.absolute(relative), "utf8");
  }
  async list(directory: string): Promise<readonly RepositoryEntry[]> {
    const entries = await readdir(this.absolute(directory), { withFileTypes: true });
    return Promise.all(
      entries.map(async (entry): Promise<RepositoryEntry> => {
        const relative = directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (entry.isDirectory()) return { path: relative, kind: "directory" };
        const info = await stat(this.absolute(relative));
        return { path: relative, kind: "file", sizeBytes: info.size, modifiedMs: info.mtimeMs };
      }),
    );
  }
  glob(): Promise<readonly string[]> {
    return Promise.resolve([]);
  }
}

const command: CommandSpec = {
  id: "app:test",
  purpose: "test",
  executable: "node",
  args: ["run-tests.mjs"],
  cwd: "app",
  env: {},
  timeoutMs: 30_000,
  network: "none",
  parameters: [],
  results: { parser: "script-report", reportGlobs: ["report.json"] },
  origin: "adapter",
};

const adapter = toyAdapter({
  commandCatalog: () => Promise.resolve([command]),
  async parseResults(spec, execution, repo): Promise<ParsedCommandResults> {
    const [report] = await freshReportFiles(repo, spec.cwd, {
      name: /^report\.json$/,
      startedAt: execution.startedAt,
    });
    if (report === undefined) return unparseable("no report.json was written by this run");
    const data = JSON.parse(await repo.readText(report.path)) as {
      id: string;
      ok: boolean;
      message?: string;
    }[];
    return {
      parse: "parsed",
      tests: data.map((test) => ({
        id: test.id,
        name: test.id,
        outcome: test.ok ? "passed" : "assertion_failure",
        status: test.ok ? "passed" : "failed",
        markers: [],
        ...(test.message === undefined ? {} : { message: test.message }),
      })),
      diagnostics: [],
      evidence: [fileEvidence(report.path, "test report")],
    };
  },
});

const gate: GateDefinition = { id: "app-test", module: "app", use: "test", required: true };

async function writeRunner(
  tests: { id: string; ok: boolean; message?: string }[] | null,
  exitCode: number,
) {
  const lines = [
    'import { writeFileSync } from "node:fs";',
    tests === null ? "" : `writeFileSync("report.json", ${JSON.stringify(JSON.stringify(tests))});`,
    `console.log("runner token ${SECRET}");`,
    `process.exit(${String(exitCode)});`,
    "",
  ];
  await writeFile(path.join(root, "app", "run-tests.mjs"), lines.join("\n"));
}

async function verification(
  policy: Partial<CommandPolicyOptions> = {},
): Promise<VerificationOptions> {
  const repo = new DiskRepository(guard.root);
  const validated = validatedAdapter(adapter);
  const candidate = {
    adapterId: "toy",
    root: "app",
    confidence: 1,
    evidence: [fileEvidence("app/toy.json", "toy manifest")],
  };
  const module: WorkspaceModule = {
    adapter: validated,
    candidate,
    profile: await validated.analyzeModule(candidate, repo),
  };
  const redactor = new SecretRedactor({ knownSecrets: [SECRET] });
  return {
    repo,
    modules: [module],
    policy: new CommandPolicy({ guard, trust, configSha256: CONFIG, ...policy }),
    executor: new Executor({ guard, redactor, env: process.env }),
    toolchain: new StaticToolchainProbe(["node"]),
    redactor,
    logDir: LOG_DIR,
  };
}

const approveOnce: Partial<CommandPolicyOptions> = {
  approver: () => Promise.resolve("approve-once"),
  approvedBy: "dev",
};

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "devflow-verify-"));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "app"), { recursive: true });
  await writeFile(path.join(root, "app", "toy.json"), '{ "runner": "toy" }\n');
  guard = await PathGuard.create(root);
  trust = await TrustStore.open(path.join(base, "home", "trust.json"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("verification with the real policy and executor", () => {
  it("runs an approved command, keeps redacted logs and reads the fresh report", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    await writeRunner([{ id: "AC-1 adds", ok: true }], 0);
    const run = await runGates([gate], await verification(approveOnce));
    const [result] = run.gates;
    expect(run.denials).toEqual([]);
    expect(result).toMatchObject({
      gateId: "app-test",
      commandId: "app:test",
      status: "passed",
      execution: { exitCode: 0, approval: { via: "interactive", approvedBy: "dev" }, cwd: "app" },
    });
    const stdoutPath = result?.execution?.stdoutPath ?? "";
    expect(stdoutPath.startsWith(`${LOG_DIR}/`)).toBe(true);
    const stdout = await readFile(path.join(root, ...stdoutPath.split("/")), "utf8");
    expect(stdout).toContain("runner token");
    expect(stdout).not.toContain(SECRET);
  });

  it("reports a failing test as failed, with its message redacted", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    await writeRunner(
      [
        { id: "AC-1 adds", ok: true },
        { id: "AC-2 subtracts", ok: false, message: `expected ${SECRET}` },
      ],
      1,
    );
    const [result] = (await runGates([gate], await verification(approveOnce))).gates;
    expect(result).toMatchObject({ status: "failed", reason: "exit code 1: 1 failed test" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("does not read a report left by an earlier run", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const stale = path.join(root, "app", "report.json");
    await writeFile(stale, JSON.stringify([{ id: "old", ok: true }]));
    const anHourAgo = new Date(Date.now() - 3_600_000);
    await utimes(stale, anHourAgo, anHourAgo);
    await writeRunner(null, 0);
    const [result] = (await runGates([gate], await verification(approveOnce))).gates;
    expect(result).toMatchObject({
      status: "unverified",
      reason:
        "exit code 0, but the results could not be read (no report.json was written by this run)",
    });
    expect(result?.tests).toEqual([]);
  });

  it("runs nothing in an untrusted workspace", async () => {
    await writeRunner([{ id: "AC-1 adds", ok: true }], 0);
    const run = await runGates([gate], await verification(approveOnce));
    expect(run.gates[0]).toMatchObject({ status: "not_executed" });
    expect(run.denials).toMatchObject([{ gateId: "app-test", reason: "workspace-untrusted" }]);
    await expect(stat(path.join(root, ".devflow"))).rejects.toThrow();
  });

  it("needs an approval, which an allowlisted fingerprint gives", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    await writeRunner([{ id: "AC-1 adds", ok: true }], 0);
    const denied = await runGates([gate], await verification());
    const [denial] = denied.denials;
    expect(denial).toMatchObject({ reason: "approval-required" });
    expect(denial?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const allowed = await runGates(
      [gate],
      await verification({ allowlist: [denial?.fingerprint ?? ""] }),
    );
    expect(allowed.gates[0]).toMatchObject({
      status: "passed",
      execution: { approval: { via: "allowlist-flag" } },
    });

    await writeRunner(
      [
        { id: "AC-1 adds", ok: true },
        { id: "extra", ok: true },
      ],
      0,
    );
    const changed = await runGates(
      [gate],
      await verification({ allowlist: [denial?.fingerprint ?? ""] }),
    );
    expect(changed.denials).toMatchObject([{ reason: "approval-required" }]);
  });
});
