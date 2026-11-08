import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  CommandPolicy,
  PathGuard,
  SecretRedactor,
  TrustStore,
  hardDenyReason,
  isApprovedCommand,
  readAuditLog,
  type CommandApprovalAnswer,
  type CommandApprovalRequest,
  type CommandPolicyOptions,
  type CommandSpec,
} from "../../src/index.js";

let base: string;
let root: string;
let guard: PathGuard;
let trust: TrustStore;
const CONFIG = "c".repeat(64);

function spec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "web:test",
    purpose: "test",
    executable: "node",
    args: ["scripts/test.mjs", "{filter}"],
    cwd: ".",
    env: {},
    timeoutMs: 60_000,
    network: "none",
    parameters: [
      {
        name: "filter",
        description: "test name filter",
        pattern: "^[A-Za-z0-9_.]+$",
        maxLength: 64,
      },
    ],
    results: { parser: "none", reportGlobs: [] },
    origin: "adapter",
    ...overrides,
  };
}

function policy(options: Partial<CommandPolicyOptions> = {}): CommandPolicy {
  return new CommandPolicy({ guard, trust, configSha256: CONFIG, ...options });
}

beforeEach(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "devflow-policy-"));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "gradle", "wrapper"), { recursive: true });
  await writeFile(path.join(root, "scripts", "test.mjs"), "console.log('ok')\n");
  await writeFile(path.join(root, "gradlew"), "#!/bin/sh\necho gradle\n");
  await writeFile(path.join(root, "gradlew.bat"), "@echo gradle\r\n");
  await writeFile(path.join(root, "gradle", "wrapper", "gradle-wrapper.jar"), "jar-v1");
  await writeFile(path.join(root, "README.md"), "readme");
  guard = await PathGuard.create(root);
  trust = await TrustStore.open(path.join(base, "home", "trust.json"));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("hard deny list", () => {
  it.each([
    ["bash", ["-c", "echo hi"]],
    ["sh", []],
    ["cmd", ["/c", "dir"]],
    ["cmd.exe", ["/c", "dir"]],
    ["powershell", ["-Command", "Get-Item"]],
    ["pwsh", []],
    ["curl", ["https://example.com"]],
    ["wget", ["https://example.com"]],
    ["rm", ["-rf", "."]],
    ["sudo", ["mvn", "test"]],
    ["npx", ["some-package"]],
    ["git", ["push"]],
    ["git", ["status"]],
    ["env", ["node", "x.js"]],
    ["npm", ["publish"]],
    ["npm", ["install"]],
    ["npm", ["--prefix", "web", "publish"]],
    ["pnpm", ["dlx", "create-app"]],
    ["pnpm", ["add", "left-pad"]],
    ["yarn", ["npm", "publish"]],
    ["mvn", ["deploy"]],
    ["mvn", ["release:perform"]],
    ["./mvnw", ["clean", "deploy"]],
    ["gradle", ["publish"]],
    ["./gradlew", [":lib:publishToMavenCentral"]],
    ["./gradlew.bat", ["uploadArchives"]],
    ["node", ["-e", "process.exit(0)"]],
    ["node", ["--eval=1"]],
    ["node", ["--require", "./hook.js", "app.js"]],
    ["node", ["--inspect-brk", "app.js"]],
    ["python", ["-c", "print(1)"]],
    ["./deploy.ps1", []],
  ])("denies %s %j", (executable, args) => {
    expect(hardDenyReason(executable, args)).toBeDefined();
  });

  it.each([
    ["mvn", ["-q", "test"]],
    ["./mvnw", ["verify"]],
    ["./gradlew", ["test", "--tests", "com.example.OrderTest"]],
    ["npm", ["test"]],
    ["npm", ["run", "lint"]],
    ["pnpm", ["test", "--", "--grep", "publish"]],
    ["node", ["scripts/test.mjs", "-e"]],
    ["node", ["--max-old-space-size=4096", "scripts/build.mjs"]],
    ["java", ["-version"]],
  ])("allows %s %j", (executable, args) => {
    expect(hardDenyReason(executable, args)).toBeUndefined();
  });
});

describe("structural validation", () => {
  it("rejects specs that do not match the schema", async () => {
    const decision = await policy().evaluate({ spec: { ...spec(), executable: "/bin/sh" } });
    expect(decision).toMatchObject({ allowed: false, reason: "invalid-spec" });
  });

  it.each([
    "PATH",
    "Path",
    "NODE_OPTIONS",
    "JAVA_TOOL_OPTIONS",
    "LD_PRELOAD",
    "npm_config_script_shell",
    "GIT_SSH_COMMAND",
  ])("rejects commands that set %s", async (name) => {
    const decision = await policy().evaluate({
      spec: spec({ env: { [name]: "x" } }),
      params: { filter: "a" },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "invalid-spec" });
  });

  it.each<[Record<string, string>, string]>([
    [{}, "missing value"],
    [{ filter: "a", extra: "b" }, "unknown parameter"],
    [{ filter: "a b" }, "does not match"],
    [{ filter: "-Dexec=calc" }, 'must not start with "-"'],
    [{ filter: "a".repeat(65) }, "longer than"],
    [{ filter: "a\nb" }, "control characters"],
  ])("rejects parameter values %j", async (params, message) => {
    const decision = await policy().evaluate({ spec: spec(), params });
    expect(decision).toMatchObject({ allowed: false, reason: "invalid-parameter" });
    expect(decision.allowed ? "" : decision.message).toContain(message);
  });

  it("rejects a working directory that is missing or not a directory", async () => {
    expect(
      await policy().evaluate({ spec: spec({ cwd: "missing" }), params: { filter: "a" } }),
    ).toMatchObject({
      reason: "cwd-rejected",
    });
    expect(
      await policy().evaluate({ spec: spec({ cwd: "README.md" }), params: { filter: "a" } }),
    ).toMatchObject({
      reason: "cwd-rejected",
    });
  });

  it("rejects a wrapper that does not exist", async () => {
    const decision = await policy().evaluate({
      spec: spec({ executable: "./mvnw", args: ["test"], parameters: [] }),
    });
    expect(decision).toMatchObject({ allowed: false, reason: "executable-rejected" });
  });

  it("rejects a node script that is missing, outside the workspace or not a relative path", async () => {
    const cases: [string[], string][] = [
      [["node_modules/vitest/vitest.mjs", "run"], "install the project's dependencies first"],
      [["../outside.mjs"], "outside the workspace"],
      [["scripts\\test.mjs"], "relative path with forward slashes"],
      [["/abs/test.mjs"], "relative path with forward slashes"],
      [["--max-old-space-size=64", "scripts"], "is not a file"],
    ];
    for (const [args, message] of cases) {
      const decision = await policy().evaluate({ spec: spec({ args, parameters: [] }) });
      expect(decision, args.join(" ")).toMatchObject({
        allowed: false,
        reason: "executable-rejected",
        message: expect.stringContaining(message) as unknown,
      });
    }
  });

  it("accepts node without a script, and a script reached from a subdirectory", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const approver = () => Promise.resolve<CommandApprovalAnswer>("approve-once");
    const version = await policy({ approver }).evaluate({
      spec: spec({ args: ["--version"], parameters: [] }),
    });
    expect(version.allowed && version.command.bindings).toEqual([]);
    const nested = await policy({ approver }).evaluate({
      spec: spec({ cwd: "scripts", args: ["../scripts/test.mjs"], parameters: [] }),
    });
    expect(nested.allowed && nested.command.bindings.map((b) => b.path)).toEqual([
      "scripts/test.mjs",
    ]);
  });
});

describe("trust and approval", () => {
  it("runs nothing in an untrusted workspace and records the denial", async () => {
    const audit = await AuditLog.open(path.join(base, "audit.jsonl"), {
      redactor: new SecretRedactor(),
    });
    const decision = await policy({ audit }).evaluate({
      spec: spec(),
      params: { filter: "OrderTest" },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "workspace-untrusted" });
    expect(await readAuditLog(audit.file)).toEqual([
      expect.objectContaining({
        type: "command",
        decision: "denied",
        argv: ["node", "scripts/test.mjs", "OrderTest"],
        reason: expect.stringContaining("workspace not trusted") as unknown,
      }),
    ]);
  });

  it("requires approval for an unknown command when nobody can be asked", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const decision = await policy().evaluate({ spec: spec(), params: { filter: "a" } });
    expect(decision).toMatchObject({ allowed: false, reason: "approval-required" });
    expect(decision.allowed ? undefined : decision.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("allows a command pre-approved by an explicit allowlist", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const first = await policy().evaluate({ spec: spec(), params: { filter: "a" } });
    const fingerprint = first.allowed ? "" : (first.fingerprint ?? "");
    const decision = await policy({ allowlist: [fingerprint] }).evaluate({
      spec: spec(),
      params: { filter: "b" },
    });
    expect(decision).toMatchObject({
      allowed: true,
      command: { approval: { via: "allowlist-flag" }, args: ["scripts/test.mjs", "b"] },
    });
  });

  it("asks interactively, remembers an approval and records the decision", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const audit = await AuditLog.open(path.join(base, "audit.jsonl"), {
      redactor: new SecretRedactor(),
    });
    const asked: CommandApprovalRequest[] = [];
    const approver = (request: CommandApprovalRequest): Promise<CommandApprovalAnswer> => {
      asked.push(request);
      return Promise.resolve("approve-always");
    };
    const first = await policy({ approver, approvedBy: "dev", audit }).evaluate({
      spec: spec(),
      params: { filter: "a" },
    });
    expect(first).toMatchObject({
      allowed: true,
      command: { approval: { via: "interactive", approvedBy: "dev" } },
    });
    expect(asked).toEqual([
      expect.objectContaining({
        commandId: "web:test",
        argv: ["node", "scripts/test.mjs", "a"],
        cwd: ".",
      }),
    ]);

    const second = await policy({ approver }).evaluate({
      spec: spec(),
      params: { filter: "other" },
    });
    expect(second).toMatchObject({ allowed: true, command: { approval: { via: "trust-store" } } });
    expect(asked).toHaveLength(1);
    expect(
      (await readAuditLog(audit.file)).map((e) => e.type === "decision" && e.decision),
    ).toEqual(["approved"]);
  });

  it("does not remember a one-time approval, and honours a rejection", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const once = await policy({ approver: () => Promise.resolve("approve-once") }).evaluate({
      spec: spec(),
      params: { filter: "a" },
    });
    expect(once.allowed).toBe(true);
    expect(await policy().evaluate({ spec: spec(), params: { filter: "a" } })).toMatchObject({
      reason: "approval-required",
    });
    const rejected = await policy({ approver: () => Promise.resolve("reject") }).evaluate({
      spec: spec(),
      params: { filter: "a" },
    });
    expect(rejected).toMatchObject({ allowed: false, reason: "rejected-by-user" });
  });

  it("asks again when the wrapper or its JAR changes", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const gradle = spec({ executable: "./gradlew", args: ["test"], parameters: [] });
    const approveAlways = {
      approver: () => Promise.resolve<CommandApprovalAnswer>("approve-always"),
    };
    const first = await policy(approveAlways).evaluate({ spec: gradle });
    expect(first.allowed && first.command.bindings.map((b) => b.path).sort()).toEqual([
      "gradle/wrapper/gradle-wrapper.jar",
      "gradlew",
      "gradlew.bat",
    ]);
    expect(await policy().evaluate({ spec: gradle })).toMatchObject({ allowed: true });

    await writeFile(path.join(root, "gradle", "wrapper", "gradle-wrapper.jar"), "jar-v2");
    expect(await policy().evaluate({ spec: gradle })).toMatchObject({
      allowed: false,
      reason: "approval-required",
    });
  });

  it("asks again when the node script changes", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    await policy({ approver: () => Promise.resolve("approve-always") }).evaluate({
      spec: spec(),
      params: { filter: "a" },
    });
    expect(await policy().evaluate({ spec: spec(), params: { filter: "a" } })).toMatchObject({
      allowed: true,
    });
    await writeFile(path.join(root, "scripts", "test.mjs"), "console.log('changed')\n");
    expect(await policy().evaluate({ spec: spec(), params: { filter: "a" } })).toMatchObject({
      allowed: false,
      reason: "approval-required",
    });
  });

  it("asks again when a bound script body changes", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const script = (body: string) => [
      { kind: "script" as const, path: "package.json", name: "test", body },
    ];
    await policy({ approver: () => Promise.resolve("approve-always") }).evaluate({
      spec: spec(),
      params: { filter: "a" },
      bindings: script("vitest run"),
    });
    expect(
      await policy().evaluate({
        spec: spec(),
        params: { filter: "a" },
        bindings: script("vitest run"),
      }),
    ).toMatchObject({ allowed: true });
    expect(
      await policy().evaluate({
        spec: spec(),
        params: { filter: "a" },
        bindings: script("vitest run && curl evil"),
      }),
    ).toMatchObject({ allowed: false, reason: "approval-required" });
  });

  it("treats a changed configuration as untrusted", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const decision = await policy({ configSha256: "d".repeat(64) }).evaluate({
      spec: spec(),
      params: { filter: "a" },
    });
    expect(decision).toMatchObject({ allowed: false, reason: "workspace-untrusted" });
  });
});

describe("approved commands", () => {
  it("are frozen and cannot be forged or copied", async () => {
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    const decision = await policy({ approver: () => Promise.resolve("approve-once") }).evaluate({
      spec: spec(),
      params: { filter: "a" },
    });
    if (!decision.allowed) throw new Error("expected an approval");
    const command = decision.command;
    expect(isApprovedCommand(command)).toBe(true);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.args)).toBe(true);
    expect(() => {
      (command.args as string[]).push("--evil");
    }).toThrow();
    expect(isApprovedCommand({ ...command })).toBe(false);
    expect(isApprovedCommand(JSON.parse(JSON.stringify(command)))).toBe(false);
  });
});
