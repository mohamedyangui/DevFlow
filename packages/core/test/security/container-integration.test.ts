import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CommandPolicy,
  Executor,
  PathGuard,
  SecretRedactor,
  TrustStore,
  resolveExecutionSettings,
  type ApprovedCommand,
  type CommandSpec,
  type ExecutionSettings,
} from "../../src/index.js";

/**
 * The container backend against a real Docker daemon. It runs only when Docker answers and a
 * small image is already present locally: the test never pulls an image (nor does DevFlow).
 * Otherwise it is skipped and says why.
 */

/** Images that have `cat`, `ls` and `sleep`, smallest first. */
const CANDIDATE_IMAGES = ["busybox", "alpine", "node", "eclipse-temurin", "debian", "ubuntu"];

function docker(args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30_000 });
  return { ok: result.status === 0, stdout: result.stdout };
}

function findImage(): { image?: string; reason?: string } {
  if (!docker(["version", "--format", "{{.Server.Version}}"]).ok) {
    return { reason: "Docker is not installed or its daemon does not answer" };
  }
  const listed = docker(["images", "--format", "{{.Repository}}:{{.Tag}}"]);
  const local = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes("<none>"));
  for (const candidate of CANDIDATE_IMAGES) {
    const image = local.find((name) => name.split(":")[0] === candidate);
    if (image !== undefined) return { image };
  }
  return { reason: `no local image among ${CANDIDATE_IMAGES.join(", ")} (DevFlow never pulls)` };
}

const found = findImage();
const title = `container backend with real Docker${found.reason === undefined ? ` (${found.image ?? ""})` : ` (skipped: ${found.reason})`}`;

const CONFIG = "d".repeat(64);
let base: string;
let guard: PathGuard;
let trust: TrustStore;
let settings: ExecutionSettings;

function spec(overrides: Partial<CommandSpec>): CommandSpec {
  return {
    id: "probe:container",
    purpose: "test",
    executable: "cat",
    args: [],
    cwd: "data",
    env: {},
    timeoutMs: 120_000,
    network: "none",
    parameters: [],
    results: { parser: "none", reportGlobs: [] },
    origin: "adapter",
    ...overrides,
  };
}

async function approve(command: CommandSpec): Promise<ApprovedCommand> {
  const policy = new CommandPolicy({
    guard,
    trust,
    configSha256: CONFIG,
    execution: settings,
    approver: () => Promise.resolve("approve-once"),
  });
  const decision = await policy.evaluate({ spec: command });
  if (!decision.allowed) throw new Error(`not allowed: ${decision.message}`);
  return decision.command;
}

function executor(): Executor {
  return new Executor({ guard, redactor: new SecretRedactor(), env: process.env });
}

const run = { logDir: ".devflow/runs/test/logs" };

describe.skipIf(found.image === undefined)(title, () => {
  beforeAll(async () => {
    base = await mkdtemp(path.join(os.tmpdir(), "devflow-docker-"));
    const root = path.join(base, "workspace");
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(path.join(root, "data", "hello.txt"), "hello from the workspace\n");
    guard = await PathGuard.create(root);
    trust = await TrustStore.open(path.join(base, "home", "trust.json"));
    await trust.trustWorkspace(guard.root, CONFIG, "dev");
    settings = resolveExecutionSettings({
      flag: "container",
      config: {
        backend: "container",
        container: {
          image: found.image,
          moduleImages: {},
          cpus: 1,
          memory: "256m",
          pidsLimit: 64,
          network: "none",
          readOnlyRootFilesystem: true,
        },
      },
    });
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("runs a command in the mounted workspace", { timeout: 120_000 }, async () => {
    const executed = await executor().run(await approve(spec({ args: ["hello.txt"] })), run);
    expect(executed.stdout).toBe("hello from the workspace\n");
    expect(executed.record).toMatchObject({ invocation: "container", exitCode: 0 });
    expect(executed.record.container?.imageId).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("gives the container no network but loopback", { timeout: 120_000 }, async () => {
    const executed = await executor().run(
      await approve(spec({ executable: "ls", args: ["/sys/class/net"] })),
      run,
    );
    expect(executed.stdout.trim().split(/\s+/)).toEqual(["lo"]);
  });

  it("kills the container on timeout", { timeout: 120_000 }, async () => {
    const executed = await executor().run(
      await approve(spec({ executable: "sleep", args: ["60"], timeoutMs: 2_000 })),
      run,
    );
    expect(executed.record.timedOut).toBe(true);
    const args = executed.invocation.args;
    const name = args[args.indexOf("--name") + 1] ?? "";
    expect(name).toMatch(/^devflow-/);
    // `--rm` removes the killed container asynchronously.
    let remaining = "";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      remaining = docker(["ps", "-a", "-q", "--filter", `name=${name}`]).stdout.trim();
      if (remaining === "") break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(remaining).toBe("");
  });
});
