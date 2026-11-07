import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AuditLog,
  CommandPolicy,
  ErrorCode,
  Executor,
  PathGuard,
  SecretRedactor,
  TrustStore,
  credentialValuesFromEnv,
  decodeTail,
  readAuditLog,
  resolveInvocation,
  type ApprovedCommand,
  type CommandSpec,
  type ExecutorOptions,
} from "../../src/index.js";

/**
 * Executor tests start real processes. The probe script below is the child: it prints its
 * arguments or environment, exits with a code, prints a secret it assembles at runtime, floods
 * its output, or hangs with a grandchild so that the process-tree kill can be observed.
 */
const PROBE = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const [mode, ...rest] = process.argv.slice(2);
switch (mode) {
  case "args":
    console.log(JSON.stringify(rest));
    break;
  case "env":
    console.log(JSON.stringify(Object.keys(process.env)));
    break;
  case "exit":
    console.error("failing on purpose");
    process.exit(Number(rest[0]));
    break;
  case "secret":
    console.log("token " + ["gh", "p_", "Q".repeat(30), "x1y2z3"].join(""));
    console.log("known " + process.argv[3]);
    break;
  case "flood": {
    const line = "x".repeat(1023) + "\\n";
    for (let i = 0; i < 512; i += 1) process.stdout.write(line);
    process.stdout.write("END\\n");
    break;
  }
  case "hang": {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(rest[0], String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
}
`;

let base: string;
let root: string;
let guard: PathGuard;
let trust: TrustStore;
const CONFIG = "e".repeat(64);
const KNOWN_SECRET = "plain-known-secret-value-42";
const parentEnv: Record<string, string | undefined> = {
  ...process.env,
  MY_SERVICE_TOKEN: KNOWN_SECRET,
  NODE_OPTIONS: "--inspect",
};

function spec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "probe:args",
    purpose: "test",
    executable: "node",
    args: ["scripts/probe.mjs", "args"],
    cwd: ".",
    env: {},
    timeoutMs: 60_000,
    network: "none",
    parameters: [],
    results: { parser: "none", reportGlobs: [] },
    origin: "adapter",
    ...overrides,
  };
}

async function approve(
  command: CommandSpec,
  params: Record<string, string> = {},
): Promise<ApprovedCommand> {
  const policy = new CommandPolicy({
    guard,
    trust,
    configSha256: CONFIG,
    approver: () => Promise.resolve("approve-once"),
  });
  const decision = await policy.evaluate({ spec: command, params });
  if (!decision.allowed) throw new Error(`not allowed: ${decision.reason} ${decision.message}`);
  return decision.command;
}

function executor(options: Partial<ExecutorOptions> = {}): Executor {
  return new Executor({
    guard,
    redactor: new SecretRedactor({ knownSecrets: credentialValuesFromEnv(parentEnv) }),
    env: parentEnv,
    ...options,
  });
}

const run = { logDir: ".devflow/runs/test/logs" };

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "devflow-exec-"));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await writeFile(path.join(root, "scripts", "probe.mjs"), PROBE);
  guard = await PathGuard.create(root);
  trust = await TrustStore.open(path.join(base, "home", "trust.json"));
  await trust.trustWorkspace(guard.root, CONFIG, "dev");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Executor", () => {
  it("passes arguments unchanged, without a shell", async () => {
    const args = ["a b", "x=y", "semi;colon", "$HOME", "%PATH%", "`whoami`", "a&b|c", "é", ""];
    const command = await approve(spec({ args: ["scripts/probe.mjs", "args", ...args] }));
    const result = await executor().run(command, run);
    expect(JSON.parse(result.stdout)).toEqual(args);
    expect(result.record).toMatchObject({
      commandId: "probe:args",
      argv: ["node", "scripts/probe.mjs", "args", ...args],
      cwd: ".",
      invocation: "direct",
      approval: { via: "interactive" },
      exitCode: 0,
      timedOut: false,
      outputTruncated: false,
    });
  });

  it("substitutes approved parameter values", async () => {
    const command = await approve(
      spec({
        args: ["scripts/probe.mjs", "args", "{filter}"],
        parameters: [{ name: "filter", description: "f", pattern: "^[A-Za-z.]+$", maxLength: 40 }],
      }),
      { filter: "com.example.OrderTest" },
    );
    expect(JSON.parse((await executor().run(command, run)).stdout)).toEqual([
      "com.example.OrderTest",
    ]);
  });

  it("gives the child an allowlisted environment without credentials", async () => {
    const command = await approve(
      spec({ args: ["scripts/probe.mjs", "env"], env: { DEVFLOW_PROBE: "1" } }),
    );
    const keys = JSON.parse((await executor().run(command, run)).stdout) as string[];
    const upper = keys.map((k) => k.toUpperCase());
    expect(upper).toContain("PATH");
    expect(upper).toContain("DEVFLOW_PROBE");
    expect(upper).not.toContain("MY_SERVICE_TOKEN");
    expect(upper).not.toContain("NODE_OPTIONS");
    expect(upper.filter((k) => /TOKEN|SECRET|PASSWORD|API_?KEY/.test(k))).toEqual([]);
  });

  it("returns a non-zero exit code as a result", async () => {
    const command = await approve(
      spec({ id: "probe:exit", args: ["scripts/probe.mjs", "exit", "3"] }),
    );
    const result = await executor().run(command, run);
    expect(result.record.exitCode).toBe(3);
    expect(result.stderr).toContain("failing on purpose");
  });

  it("redacts secrets from output, logs and the audit trail", async () => {
    const audit = await AuditLog.open(path.join(base, "audit-secret.jsonl"), {
      redactor: new SecretRedactor(),
    });
    const command = await approve(
      spec({ id: "probe:secret", args: ["scripts/probe.mjs", "secret", KNOWN_SECRET] }),
    );
    const result = await executor({ audit }).run(command, run);
    expect(result.stdout).toContain("«REDACTED:github-token:");
    expect(result.stdout).toContain("«REDACTED:known-secret:");
    expect(result.stdout).not.toContain(KNOWN_SECRET);
    const log = await readFile(
      path.join(guard.root, ...result.record.stdoutPath.split("/")),
      "utf8",
    );
    expect(log).toBe(result.stdout);
    expect(JSON.stringify(result.record)).not.toContain(KNOWN_SECRET);
    const entries = await readAuditLog(audit.file);
    expect(entries).toEqual([
      expect.objectContaining({
        type: "command",
        decision: "allowed",
        invocation: "direct",
        exitCode: 0,
      }),
    ]);
  });

  it("keeps only the tail of large output", async () => {
    const command = await approve(
      spec({ id: "probe:flood", args: ["scripts/probe.mjs", "flood"] }),
    );
    const result = await executor({ maxOutputBytes: 64 * 1024 }).run(command, run);
    expect(result.record.outputTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(result.stdout.trimEnd().endsWith("END")).toBe(true);
  });

  it("kills the whole process tree on timeout", async () => {
    const pidFile = path.join(base, "grandchild.pid");
    const command = await approve(
      spec({ id: "probe:hang", args: ["scripts/probe.mjs", "hang", pidFile], timeoutMs: 3_000 }),
    );
    const result = await executor().run(command, run);
    expect(result.record.timedOut).toBe(true);
    expect(result.record.exitCode === 0).toBe(false);

    const grandchild = Number(await readFile(pidFile, "utf8"));
    const deadline = Date.now() + 10_000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(grandchild, 0);
        await new Promise((resolve) => setTimeout(resolve, 200));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  }, 30_000);

  it("stops a command when the run is cancelled", async () => {
    const pidFile = path.join(base, "cancelled.pid");
    const command = await approve(
      spec({ id: "probe:cancel", args: ["scripts/probe.mjs", "hang", pidFile] }),
    );
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 2_000);
    const result = await executor().run(command, { ...run, signal: controller.signal });
    expect(result.record.timedOut).toBe(false);
    expect(result.record.exitCode === 0).toBe(false);
  }, 30_000);

  it("runs only commands approved by the policy", async () => {
    const command = await approve(spec());
    await expect(executor().run({ ...command }, run)).rejects.toMatchObject({
      code: ErrorCode.CommandNotApproved,
    });
    await expect(
      executor().run(JSON.parse(JSON.stringify(command)) as ApprovedCommand, run),
    ).rejects.toMatchObject({ code: ErrorCode.CommandNotApproved });
  });

  it("reports a tool that is not on PATH before starting anything", async () => {
    const command = await approve(spec({ executable: "devflow-no-such-tool", args: [] }));
    await expect(executor().run(command, run)).rejects.toMatchObject({
      code: ErrorCode.ExecutableNotFound,
    });
  });

  it("ignores relative PATH entries, so a repository cannot shadow a tool", async () => {
    const command = await approve(spec({ executable: "devflow-shadow", args: [] }));
    const shadow = path.join(
      root,
      process.platform === "win32" ? "devflow-shadow.cmd" : "devflow-shadow",
    );
    await writeFile(
      shadow,
      process.platform === "win32" ? "@echo shadow\r\n" : "#!/bin/sh\necho shadow\n",
    );
    if (process.platform !== "win32") await chmod(shadow, 0o755);
    const env = { ...parentEnv, PATH: `.${path.delimiter}${parentEnv.PATH ?? ""}` };
    await expect(executor({ env }).run(command, run)).rejects.toMatchObject({
      code: ErrorCode.ExecutableNotFound,
    });
  });
});

describe.runIf(process.platform !== "win32")("Executor on POSIX", () => {
  it("runs a wrapper in the working directory directly", async () => {
    const wrapper = path.join(root, "wrapper");
    await writeFile(wrapper, '#!/bin/sh\necho "wrapper:$1:$2"\n');
    await chmod(wrapper, 0o755);
    const command = await approve(
      spec({ id: "probe:wrapper", executable: "./wrapper", args: ["a b", "c"] }),
    );
    const result = await executor().run(command, run);
    expect(result.record.invocation).toBe("direct");
    expect(result.stdout.trim()).toBe("wrapper:a b:c");
  });
});

describe.runIf(process.platform === "win32")("Executor on Windows (ADR 0014)", () => {
  it("round-trips arguments through a .cmd wrapper with the windows-batch strategy", async () => {
    await writeFile(
      path.join(root, "probe.cmd"),
      '@echo off\r\nnode "%~dp0scripts\\probe.mjs" args %*\r\n',
    );
    const args = ["plain", "a b", "x=y", "1,2", "a;b", "C:\\dir\\file.txt", "é"];
    const command = await approve(spec({ id: "probe:batch", executable: "./probe.cmd", args }));
    const result = await executor().run(command, run);
    expect(result.record.invocation).toBe("windows-batch");
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.each(["a&calc", "a|b", "50%", "!x!", "a^b", "(a)", "a>b", "a<b"])(
    "rejects %j for a batch file before any process starts",
    async (value) => {
      const marker = path.join(base, "marker.txt");
      await writeFile(path.join(root, "marker.cmd"), `@echo off\r\necho ran> "${marker}"\r\n`);
      const command = await approve(
        spec({
          id: "probe:marker",
          executable: "./marker.cmd",
          args: ["{value}"],
          parameters: [{ name: "value", description: "v", pattern: "^.+$", maxLength: 20 }],
        }),
        { value },
      );
      await expect(executor().run(command, run)).rejects.toMatchObject({
        code: ErrorCode.CommandArgumentRejected,
      });
      await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("runs a node_modules/.bin shim with node directly (node-script)", async () => {
    const bin = path.join(base, "tools", "node_modules", ".bin");
    await mkdir(bin, { recursive: true });
    await mkdir(path.join(base, "tools", "node_modules", "hello"), { recursive: true });
    await writeFile(
      path.join(base, "tools", "node_modules", "hello", "cli.js"),
      "console.log(JSON.stringify(process.argv.slice(2)));\n",
    );
    await writeFile(
      path.join(bin, "devflow-hello.cmd"),
      '@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\..\\hello\\cli.js" %*\r\n) ELSE (\r\n  node  "%~dp0\\..\\hello\\cli.js" %*\r\n)\r\n',
    );
    const env = { ...parentEnv, PATH: `${bin};${parentEnv.PATH ?? parentEnv.Path ?? ""}` };
    const command = await approve(
      spec({ id: "probe:shim", executable: "devflow-hello", args: ["a&b", "50%"] }),
    );
    const result = await executor({ env }).run(command, run);
    expect(result.record.invocation).toBe("node-script");
    expect(JSON.parse(result.stdout)).toEqual(["a&b", "50%"]);
  });

  it("resolves the Gradle wrapper to the Java launcher (resolution only)", async () => {
    // Running the wrapper needs a real gradle-wrapper.jar; Phase 3 adds example builds for that.
    const project = path.join(root, "gradle-project");
    await mkdir(path.join(project, "gradle", "wrapper"), { recursive: true });
    await writeFile(path.join(project, "gradlew.bat"), "@echo off\r\n");
    await writeFile(path.join(project, "gradlew"), "#!/bin/sh\n");
    await writeFile(path.join(project, "gradle", "wrapper", "gradle-wrapper.jar"), "jar");
    const javaHome = path.join(base, "fake-jdk");
    await mkdir(path.join(javaHome, "bin"), { recursive: true });
    await writeFile(path.join(javaHome, "bin", "java.exe"), "");

    const command = await approve(
      spec({ id: "gradle:test", executable: "./gradlew", args: ["test"], cwd: "gradle-project" }),
    );
    const invocation = await resolveInvocation(command, {
      platform: "win32",
      env: { PATH: "", JAVA_HOME: javaHome, SystemRoot: "C:\\Windows" },
      nodePath: process.execPath,
    });
    expect(invocation).toEqual({
      strategy: "java-launcher",
      file: path.join(javaHome, "bin", "java.exe"),
      args: [
        "-Xmx64m",
        "-Xms64m",
        "-Dorg.gradle.appname=gradlew",
        "-classpath",
        path.join(command.cwd.absolute, "gradle", "wrapper", "gradle-wrapper.jar"),
        "org.gradle.wrapper.GradleWrapperMain",
        "test",
      ],
      windowsVerbatimArguments: false,
    });
  });
});

describe("decodeTail", () => {
  it("drops a multi-byte character cut in half at the start", () => {
    const bytes = Buffer.from("éa", "utf8");
    expect(decodeTail(bytes.subarray(1))).toBe("a");
    expect(decodeTail(Buffer.from("plain"))).toBe("plain");
  });
});
