import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  dockerMountSource,
  readAuditLog,
  resolveExecutionSettings,
  type ApprovedCommand,
  type CommandApprovalRequest,
  type CommandSpec,
  type ExecutionSettings,
  type ExecutorOptions,
  type LaunchOptions,
  type LaunchResult,
  type Launcher,
} from "../../src/index.js";

/**
 * The container backend with a fake launcher: no process starts, so these tests check the
 * `docker` invocations the executor makes, the approvals it requires and what it records,
 * on every platform and without Docker.
 */

const DOCKER = path.resolve("/opt/docker/bin/docker");
const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const CONFIG = "c".repeat(64);
const KNOWN_SECRET = "plain-known-secret-value-42";
const parentEnv: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  LANG: "C.UTF-8",
  CI: "true",
  DOCKER_HOST: "unix:///run/user/1000/docker.sock",
  MY_SERVICE_TOKEN: KNOWN_SECRET,
  NODE_OPTIONS: "--inspect",
};

let base: string;
let root: string;
let guard: PathGuard;
let trust: TrustStore;

const container: ExecutionSettings = resolveExecutionSettings({
  flag: "container",
  config: {
    backend: "local",
    container: {
      image: "node:22-alpine",
      moduleImages: { backend: "eclipse-temurin:21" },
      cpus: 2,
      memory: "2g",
      pidsLimit: 512,
      network: "none",
      readOnlyRootFilesystem: true,
    },
  },
});

function spec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "web:test",
    purpose: "test",
    executable: "node",
    args: ["scripts/probe.mjs", "run"],
    cwd: "web",
    env: { FORCE_COLOR: "0" },
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
  execution: ExecutionSettings = container,
  module?: string,
): Promise<ApprovedCommand> {
  const policy = new CommandPolicy({
    guard,
    trust,
    configSha256: CONFIG,
    execution,
    approver: () => Promise.resolve("approve-once"),
  });
  const decision = await policy.evaluate({
    spec: command,
    ...(module === undefined ? {} : { module }),
  });
  if (!decision.allowed) throw new Error(`not allowed: ${decision.reason} ${decision.message}`);
  return decision.command;
}

interface FakeDocker {
  readonly calls: LaunchOptions[];
  readonly launcher: Launcher;
}

function result(overrides: Partial<LaunchResult> = {}): LaunchResult {
  return {
    startedAt: new Date(),
    durationMs: 5,
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    outputTruncated: false,
    ...overrides,
  };
}

/** A fake `docker`: answers `image inspect`, `run` and `kill` as told. */
function fakeDocker(
  behaviour: {
    inspect?: (options: LaunchOptions) => Promise<LaunchResult>;
    run?: (options: LaunchOptions) => Promise<LaunchResult>;
  } = {},
): FakeDocker {
  const calls: LaunchOptions[] = [];
  const launcher: Launcher = (options) => {
    calls.push(options);
    const [verb, sub] = options.args;
    if (verb === "image" && sub === "inspect") {
      return (
        behaviour.inspect?.(options) ??
        Promise.resolve(result({ stdout: Buffer.from(`${IMAGE_ID}\n`) }))
      );
    }
    if (verb === "run") {
      return behaviour.run?.(options) ?? Promise.resolve(result({ stdout: Buffer.from("ok\n") }));
    }
    return Promise.resolve(result());
  };
  return { calls, launcher };
}

function executor(fake: FakeDocker, options: Partial<ExecutorOptions> = {}): Executor {
  return new Executor({
    guard,
    redactor: new SecretRedactor({ knownSecrets: credentialValuesFromEnv(parentEnv) }),
    env: parentEnv,
    launcher: fake.launcher,
    container: { docker: DOCKER, user: null },
    ...options,
  });
}

const run = { logDir: ".devflow/runs/test/logs" };

function optionValue(args: readonly string[], option: string): string | undefined {
  const index = args.indexOf(option);
  return index === -1 ? undefined : args[index + 1];
}

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "devflow-container-"));
  root = path.join(base, "workspace");
  await mkdir(path.join(root, "web", "scripts"), { recursive: true });
  await writeFile(path.join(root, "web", "scripts", "probe.mjs"), "console.log('probe');\n");
  await mkdir(path.join(root, "backend"), { recursive: true });
  await writeFile(path.join(root, "backend", "mvnw"), "#!/bin/sh\n");
  guard = await PathGuard.create(root);
  trust = await TrustStore.open(path.join(base, "home", "trust.json"));
  await trust.trustWorkspace(guard.root, CONFIG, "dev");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("Executor with the container backend", () => {
  it("checks the image, then runs the command as the entry point of docker run", async () => {
    const fake = fakeDocker();
    const command = await approve(spec());
    const executed = await executor(fake).run(command, run);

    expect(fake.calls.map((call) => call.file)).toEqual([DOCKER, DOCKER]);
    expect(fake.calls[0]?.args).toEqual([
      "image",
      "inspect",
      "--format",
      "{{.Id}}",
      "node:22-alpine",
    ]);
    const args = fake.calls[1]?.args ?? [];
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--pull", "never"]);
    expect(optionValue(args, "--network")).toBe("none");
    expect(optionValue(args, "--memory")).toBe("2g");
    expect(optionValue(args, "--pids-limit")).toBe("512");
    expect(optionValue(args, "--cap-drop")).toBe("ALL");
    expect(optionValue(args, "--security-opt")).toBe("no-new-privileges");
    expect(optionValue(args, "--mount")).toBe(
      `type=bind,source=${dockerMountSource(guard.root, process.platform)},target=/workspace`,
    );
    expect(optionValue(args, "--workdir")).toBe("/workspace/web");
    expect(optionValue(args, "--entrypoint")).toBe("node");
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--user");
    expect(args.slice(args.indexOf("node:22-alpine"))).toEqual([
      "node:22-alpine",
      "scripts/probe.mjs",
      "run",
    ]);
    expect(fake.calls[1]).toMatchObject({
      cwd: guard.root,
      windowsVerbatimArguments: false,
      timeoutMs: 60_000,
    });

    expect(executed.invocation).toMatchObject({ strategy: "container", file: DOCKER });
    expect(executed.stdout).toBe("ok\n");
    expect(executed.record).toMatchObject({
      commandId: "web:test",
      argv: ["node", "scripts/probe.mjs", "run"],
      cwd: "web",
      invocation: "container",
      container: { image: "node:22-alpine", imageId: IMAGE_ID },
      exitCode: 0,
    });
  });

  it("passes variables by name only, and never credentials or code-loading variables", async () => {
    const fake = fakeDocker();
    await executor(fake).run(await approve(spec()), run);
    const runCall = fake.calls[1];
    const args = runCall?.args ?? [];
    const envNames = args.flatMap((arg, index) => (args[index - 1] === "--env" ? [arg] : []));
    expect(envNames).toEqual(["HOME=/tmp", "LANG", "CI", "FORCE_COLOR"]);
    expect(args.join(" ")).not.toContain(KNOWN_SECRET);
    const keys = Object.keys(runCall?.env ?? {}).map((key) => key.toUpperCase());
    expect(keys).toContain("DOCKER_HOST");
    expect(keys).not.toContain("MY_SERVICE_TOKEN");
    expect(keys).not.toContain("NODE_OPTIONS");
    expect(Object.values(runCall?.env ?? {})).not.toContain(KNOWN_SECRET);
  });

  it("runs a wrapper by its path in the workspace, with the module's image and the user", async () => {
    const fake = fakeDocker();
    const command = await approve(
      spec({ id: "backend:test", executable: "./mvnw", args: ["test"], cwd: "backend", env: {} }),
      container,
      "backend",
    );
    await executor(fake, { container: { docker: DOCKER, user: "1000:1000" } }).run(command, run);
    const args = fake.calls[1]?.args ?? [];
    expect(optionValue(args, "--entrypoint")).toBe("/workspace/backend/mvnw");
    expect(optionValue(args, "--workdir")).toBe("/workspace/backend");
    expect(optionValue(args, "--user")).toBe("1000:1000");
    expect(args.slice(-2)).toEqual(["eclipse-temurin:21", "test"]);
  });

  it("kills the container by name on timeout", async () => {
    const fake = fakeDocker({
      run: (options) => {
        options.onKill?.();
        return Promise.resolve(result({ exitCode: null, signal: "SIGKILL", timedOut: true }));
      },
    });
    const executed = await executor(fake).run(await approve(spec({ timeoutMs: 1_000 })), run);
    const name = optionValue(fake.calls[1]?.args ?? [], "--name");
    expect(name).toMatch(/^devflow-web-test-[0-9a-f]{12}$/);
    expect(fake.calls[2]?.args).toEqual(["kill", name]);
    expect(fake.calls[2]?.file).toBe(DOCKER);
    expect(executed.record.timedOut).toBe(true);
  });

  it("kills the container when the run is cancelled", async () => {
    const controller = new AbortController();
    const fake = fakeDocker({
      run: (options) => {
        controller.abort();
        if (options.signal?.aborted === true) options.onKill?.();
        return Promise.resolve(result({ exitCode: null, aborted: true }));
      },
    });
    await executor(fake).run(await approve(spec()), { ...run, signal: controller.signal });
    expect(fake.calls[2]?.args[0]).toBe("kill");
  });

  it("checks an image once per executor", async () => {
    const fake = fakeDocker();
    const runner = executor(fake);
    const command = await approve(spec());
    await runner.run(command, run);
    await runner.run(command, run);
    expect(fake.calls.filter((call) => call.args[0] === "image")).toHaveLength(1);
    expect(fake.calls.filter((call) => call.args[0] === "run")).toHaveLength(2);
  });

  it("refuses to run without Docker, and does not fall back to the host", async () => {
    const fake = fakeDocker();
    const runner = executor(fake, { container: { user: null }, env: { PATH: "" } });
    await expect(runner.run(await approve(spec()), run)).rejects.toMatchObject({
      code: ErrorCode.ContainerRuntimeUnavailable,
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses an image that is not present locally, without pulling it", async () => {
    const fake = fakeDocker({
      inspect: () =>
        Promise.resolve(
          result({
            exitCode: 1,
            stderr: Buffer.from("Error response from daemon: No such image: node:22-alpine\n"),
          }),
        ),
    });
    await expect(executor(fake).run(await approve(spec()), run)).rejects.toMatchObject({
      code: ErrorCode.ContainerImageUnavailable,
    });
    expect(fake.calls.map((call) => call.args[0])).toEqual(["image"]);
  });

  it("reports a daemon that does not answer", async () => {
    const fake = fakeDocker({
      inspect: () =>
        Promise.resolve(
          result({ exitCode: 1, stderr: Buffer.from("Docker Desktop is unable to start\n") }),
        ),
    });
    await expect(executor(fake).run(await approve(spec()), run)).rejects.toMatchObject({
      code: ErrorCode.ContainerRuntimeUnavailable,
      message: expect.stringContaining("Docker Desktop is unable to start") as unknown,
    });
  });

  it("reports a container that did not start as not started, not as a failed command", async () => {
    const fake = fakeDocker({
      run: () =>
        Promise.resolve(
          result({
            exitCode: 127,
            stderr: Buffer.from(
              'docker: Error response from daemon: failed to create task: exec: "node": executable file not found in $PATH\n',
            ),
          }),
        ),
    });
    await expect(executor(fake).run(await approve(spec()), run)).rejects.toMatchObject({
      code: ErrorCode.ProcessStartFailed,
    });
  });

  it("returns a failing command's exit code as a result", async () => {
    const fake = fakeDocker({
      run: () => Promise.resolve(result({ exitCode: 1, stderr: Buffer.from("1 test failed\n") })),
    });
    const executed = await executor(fake).run(await approve(spec()), run);
    expect(executed.record.exitCode).toBe(1);
    expect(executed.stderr).toBe("1 test failed\n");
  });

  it("records the container invocation in the audit log", async () => {
    const audit = await AuditLog.open(path.join(base, "audit-container.jsonl"), {
      redactor: new SecretRedactor(),
    });
    await executor(fakeDocker(), { audit }).run(await approve(spec()), run);
    const entries = await readAuditLog(audit.file);
    expect(entries.at(-1)).toMatchObject({ type: "command", invocation: "container" });
    const log = await readFile(audit.file, "utf8");
    expect(log).not.toContain(KNOWN_SECRET);
  });
});

describe("CommandPolicy with an execution backend", () => {
  it("binds the backend and image into the approval", async () => {
    const requests: CommandApprovalRequest[] = [];
    const policy = new CommandPolicy({
      guard,
      trust,
      configSha256: CONFIG,
      execution: container,
      approver: (request) => {
        requests.push(request);
        return Promise.resolve("approve-once");
      },
    });
    const decision = await policy.evaluate({ spec: spec() });
    expect(decision.allowed).toBe(true);
    expect(requests[0]?.target).toMatchObject({ backend: "container", image: "node:22-alpine" });
    if (decision.allowed) {
      expect(decision.command.target).toMatchObject({ backend: "container" });
      expect(Object.isFrozen(decision.command.target)).toBe(true);
    }
  });

  it("does not let an approval for the host approve the container command, or the reverse", async () => {
    const local = await approve(spec(), { backend: "local" });
    const inContainer = await approve(spec());
    expect(local.target).toEqual({ backend: "local" });
    expect(local.fingerprint).not.toBe(inContainer.fingerprint);

    await trust.approveCommand(guard.root, CONFIG, {
      fingerprint: local.fingerprint,
      commandId: "web:test",
      summary: "node scripts/probe.mjs run",
      approvedBy: "dev",
    });
    const policy = (execution: ExecutionSettings) =>
      new CommandPolicy({ guard, trust, configSha256: CONFIG, execution });
    expect(await policy({ backend: "local" }).evaluate({ spec: spec() })).toMatchObject({
      allowed: true,
    });
    expect(await policy(container).evaluate({ spec: spec() })).toMatchObject({
      allowed: false,
      reason: "approval-required",
      fingerprint: inContainer.fingerprint,
    });
    expect(await policy(container).evaluate({ spec: spec(), module: "backend" })).not.toMatchObject(
      { fingerprint: inContainer.fingerprint },
    );
  });

  it("still applies the hard deny list in a container", async () => {
    const policy = new CommandPolicy({
      guard,
      trust,
      configSha256: CONFIG,
      execution: container,
      approver: () => Promise.resolve("approve-once"),
    });
    expect(
      await policy.evaluate({ spec: spec({ executable: "sh", args: ["-c", "id"] }) }),
    ).toMatchObject({ allowed: false, reason: "hard-deny" });
    expect(
      await policy.evaluate({ spec: spec({ env: { DOCKER_HOST: "tcp://example:2375" } }) }),
    ).toMatchObject({ allowed: false, reason: "invalid-spec" });
  });
});
