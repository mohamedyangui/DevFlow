import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  ProjectConfig,
  containerEnvNames,
  containerName,
  containerWorkdir,
  dockerClientEnvironment,
  dockerMountSource,
  dockerRunArgs,
  dockerStartFailure,
  executionTarget,
  fingerprintCommand,
  imageInspectOutcome,
  parseConfigText,
  resolveExecutionSettings,
  type CommandSpec,
  type ContainerTarget,
} from "../../src/index.js";

const target: ContainerTarget = {
  backend: "container",
  image: "node:22-alpine",
  cpus: 2,
  memory: "4g",
  pidsLimit: 1024,
  network: "none",
  readOnlyRootFilesystem: true,
};

const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function spec(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "web:test",
    purpose: "test",
    executable: "node",
    args: ["node_modules/vitest/vitest.mjs", "run"],
    cwd: "web",
    env: {},
    timeoutMs: 60_000,
    network: "none",
    parameters: [],
    results: { parser: "none", reportGlobs: [] },
    origin: "adapter",
    ...overrides,
  };
}

function execution(input: unknown) {
  return ProjectConfig.parse({ version: 1, execution: input }).execution;
}

describe("execution settings", () => {
  it("defaults to the local backend", () => {
    expect(resolveExecutionSettings({})).toEqual({ backend: "local" });
    expect(resolveExecutionSettings({ config: execution(undefined) })).toEqual({
      backend: "local",
    });
  });

  it("uses the configured container backend with its limits", () => {
    const settings = resolveExecutionSettings({
      config: execution({
        backend: "container",
        container: { image: "node:22-alpine", cpus: 1.5, memory: "2g", pidsLimit: 256 },
      }),
    });
    expect(settings).toEqual({
      backend: "container",
      image: "node:22-alpine",
      moduleImages: {},
      cpus: 1.5,
      memory: "2g",
      pidsLimit: 256,
      network: "none",
      readOnlyRootFilesystem: true,
    });
  });

  it("lets the --backend flag of the user's invocation win in both directions", () => {
    const container = execution({ backend: "container", container: { image: "alpine:3.20" } });
    expect(resolveExecutionSettings({ flag: "local", config: container })).toEqual({
      backend: "local",
    });
    const local = execution({ container: { image: "alpine:3.20" } });
    expect(resolveExecutionSettings({ flag: "container", config: local })).toMatchObject({
      backend: "container",
      image: "alpine:3.20",
    });
  });

  it("refuses the container backend without an image instead of falling back to local", () => {
    expect(() => resolveExecutionSettings({ flag: "container" })).toThrow(
      expect.objectContaining({ code: ErrorCode.ContainerImageUnavailable }),
    );
    expect(() =>
      resolveExecutionSettings({ flag: "container", config: execution(undefined) }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.ContainerImageUnavailable }));
  });

  it("chooses a module's image override, and only an own key", () => {
    const settings = resolveExecutionSettings({
      config: execution({
        backend: "container",
        container: { image: "alpine:3.20", moduleImages: { backend: "eclipse-temurin:21" } },
      }),
    });
    expect(executionTarget(settings, "backend")).toMatchObject({ image: "eclipse-temurin:21" });
    expect(executionTarget(settings, "web")).toMatchObject({ image: "alpine:3.20" });
    expect(executionTarget(settings, "constructor")).toMatchObject({ image: "alpine:3.20" });
    expect(executionTarget(settings)).toMatchObject({ image: "alpine:3.20" });
    expect(executionTarget({ backend: "local" }, "backend")).toEqual({ backend: "local" });
  });
});

describe("execution configuration schema", () => {
  it("has safe defaults", () => {
    expect(execution(undefined)).toEqual({
      backend: "local",
      container: {
        moduleImages: {},
        cpus: 2,
        memory: "4g",
        pidsLimit: 1024,
        network: "none",
        readOnlyRootFilesystem: true,
      },
    });
  });

  it("needs an image for the container backend", () => {
    const parsed = ProjectConfig.safeParse({ version: 1, execution: { backend: "container" } });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["execution", "container", "image"]);
  });

  it("cannot give a container a network", () => {
    for (const network of ["bridge", "host", "required"]) {
      const parsed = ProjectConfig.safeParse({
        version: 1,
        execution: { container: { image: "alpine:3.20", network } },
      });
      expect(parsed.success).toBe(false);
    }
  });

  it("rejects images and limits that could become options or are out of range", () => {
    const bad = [
      { image: "--privileged" },
      { image: "-v" },
      { image: "alpine 3" },
      { image: "Alpine" },
      { image: "alpine:3.20;rm" },
      { image: "alpine@sha256:abc" },
      { cpus: 0 },
      { cpus: 1000 },
      { memory: "-1g" },
      { memory: "4" },
      { memory: "4gb" },
      { pidsLimit: 0 },
      { pidsLimit: -1 },
      { privileged: true },
      { volumes: ["/:/host"] },
    ];
    for (const container of bad) {
      const parsed = ProjectConfig.safeParse({ version: 1, execution: { container } });
      expect(parsed.success, JSON.stringify(container)).toBe(false);
    }
  });

  it("accepts registry hosts, tags and digests", () => {
    for (const image of [
      "alpine",
      "node:22-alpine",
      "eclipse-temurin:21-jdk",
      "ghcr.io/acme/build-image:1.2.3",
      "registry.local:5000/team/node:22",
      `node@sha256:${"0".repeat(64)}`,
      `node:22@sha256:${"0".repeat(64)}`,
    ]) {
      const parsed = ProjectConfig.safeParse({
        version: 1,
        execution: { container: { image } },
      });
      expect(parsed.success, image).toBe(true);
    }
  });

  it("reports a bad execution setting with its line", () => {
    const loaded = parseConfigText(
      "version: 1\nexecution:\n  backend: container\n  container:\n    image: alpine:3.20\n    network: host\n",
    );
    expect(loaded.valid).toBe(false);
    expect(loaded.issues[0]?.line).toBe(6);
  });
});

describe("dockerMountSource", () => {
  it("keeps a Windows drive path in the form Docker Desktop maps", () => {
    expect(dockerMountSource("D:\\repo", "win32")).toBe("D:\\repo");
    expect(dockerMountSource("d:\\repo\\", "win32")).toBe("D:\\repo");
    expect(dockerMountSource("D:/work/shop/", "win32")).toBe("D:\\work\\shop");
    expect(dockerMountSource("D:\\My Projects\\shop", "win32")).toBe("D:\\My Projects\\shop");
    expect(dockerMountSource("C:\\", "win32")).toBe("C:\\");
  });

  it("refuses Windows paths Docker Desktop cannot bind or --mount would split", () => {
    for (const bad of ["\\\\server\\share\\repo", "\\\\?\\D:\\repo", "repo", "D:repo", "D:\\a,b"]) {
      expect(() => dockerMountSource(bad, "win32"), bad).toThrow(
        expect.objectContaining({ code: ErrorCode.PathRejected }),
      );
    }
  });

  it("uses POSIX paths as they are", () => {
    expect(dockerMountSource("/home/me/repo/", "linux")).toBe("/home/me/repo");
    expect(dockerMountSource("/home/me/my repo", "darwin")).toBe("/home/me/my repo");
    expect(dockerMountSource("/home/me/a:b", "linux")).toBe("/home/me/a:b");
    for (const bad of ["repo", "/home/me/a,b", '/home/"me"', "/home/me/a\nb"]) {
      expect(() => dockerMountSource(bad, "linux"), bad).toThrow(
        expect.objectContaining({ code: ErrorCode.PathRejected }),
      );
    }
  });

  it("maps the working directory under /workspace", () => {
    expect(containerWorkdir(".")).toBe("/workspace");
    expect(containerWorkdir("services/web")).toBe("/workspace/services/web");
  });
});

describe("dockerRunArgs", () => {
  const input = {
    target,
    name: "devflow-web-test-0123456789ab",
    mountSource: "D:\\repo",
    workdir: "/workspace/web",
    envNames: ["LANG", "CI"],
    entrypoint: "node",
    args: ["node_modules/vitest/vitest.mjs", "run", "a b", "$HOME", "`id`;x"],
  };

  it("builds an argv with every isolation option, and never a shell", () => {
    expect(dockerRunArgs(input)).toEqual([
      "run",
      "--rm",
      "--pull",
      "never",
      "--name",
      "devflow-web-test-0123456789ab",
      "--network",
      "none",
      "--cpus",
      "2",
      "--memory",
      "4g",
      "--memory-swap",
      "4g",
      "--pids-limit",
      "1024",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev",
      "--security-opt",
      "no-new-privileges",
      "--cap-drop",
      "ALL",
      "--mount",
      "type=bind,source=D:\\repo,target=/workspace",
      "--workdir",
      "/workspace/web",
      "--env",
      "HOME=/tmp",
      "--env",
      "LANG",
      "--env",
      "CI",
      "--entrypoint",
      "node",
      "node:22-alpine",
      "node_modules/vitest/vitest.mjs",
      "run",
      "a b",
      "$HOME",
      "`id`;x",
    ]);
  });

  it("adds the user on POSIX hosts and the read-only root only when configured", () => {
    const args = dockerRunArgs({
      ...input,
      mountSource: "/home/me/repo",
      user: "1000:1000",
      target: { ...target, readOnlyRootFilesystem: false, cpus: 0.5 },
    });
    expect(args).not.toContain("--read-only");
    expect(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2)).toEqual([
      "--user",
      "1000:1000",
    ]);
    expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 2)).toEqual([
      "--cpus",
      "0.5",
    ]);
    expect(args).toContain("type=bind,source=/home/me/repo,target=/workspace");
  });

  it("always disables the network, whatever the target says", () => {
    const loose = { ...target, network: "bridge" } as unknown as ContainerTarget;
    const args = dockerRunArgs({ ...input, target: loose });
    expect(args.slice(args.indexOf("--network"), args.indexOf("--network") + 2)).toEqual([
      "--network",
      "none",
    ]);
    expect(args.filter((arg) => arg === "--network")).toHaveLength(1);
  });

  it("puts the image after every option and the command's arguments after the image", () => {
    const args = dockerRunArgs({ ...input, args: ["--privileged", "-v", "/:/host"] });
    const image = args.indexOf("node:22-alpine");
    expect(args.slice(image + 1)).toEqual(["--privileged", "-v", "/:/host"]);
    expect(args.slice(0, image)).not.toContain("--privileged");
  });
});

describe("container environment", () => {
  const parent = {
    PATH: "/usr/bin",
    HOME: "/home/me",
    LANG: "C.UTF-8",
    CI: "true",
    DOCKER_HOST: "unix:///run/user/1000/docker.sock",
    DOCKER_AUTH_CONFIG: "{}",
    GITHUB_TOKEN: "not-a-real-token",
    AWS_SECRET_ACCESS_KEY: "not-a-real-key",
    ANTHROPIC_API_KEY: "not-a-real-key",
    NODE_OPTIONS: "--require /tmp/x.js",
  };

  it("gives the docker client the allowlist and its own variables, never credentials", () => {
    const env = dockerClientEnvironment(parent, { FORCE_COLOR: "0" }, "linux");
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      DOCKER_HOST: "unix:///run/user/1000/docker.sock",
      FORCE_COLOR: "0",
    });
    expect(Object.keys(env)).not.toContain("DOCKER_AUTH_CONFIG");
    expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(env)).not.toContain("AWS_SECRET_ACCESS_KEY");
    expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(env)).not.toContain("NODE_OPTIONS");
  });

  it("does not let a command choose the Docker daemon", () => {
    const env = dockerClientEnvironment(
      { PATH: "/usr/bin" },
      { DOCKER_HOST: "tcp://evil" },
      "linux",
    );
    expect(env.DOCKER_HOST).toBeUndefined();
  });

  it("forwards only allowlisted names and the command's additions, by name", () => {
    const additions = { FORCE_COLOR: "0" };
    const env = dockerClientEnvironment(parent, additions, "linux");
    expect(containerEnvNames(env, additions, "linux")).toEqual(["LANG", "CI", "FORCE_COLOR"]);
  });

  it("never forwards PATH, HOME, Docker or credential variables", () => {
    const env = { ...parent, MY_PASSWORD: "x" };
    const names = containerEnvNames(env, { HOME: "/x", PATH: "/x", MY_PASSWORD: "x" }, "linux");
    expect(names).toEqual(["LANG", "CI"]);
  });

  it("matches names case-insensitively on Windows", () => {
    const env = dockerClientEnvironment(
      { Path: "C:\\Windows", Lang: "en_US.UTF-8", SystemRoot: "C:\\Windows" },
      {},
      "win32",
    );
    expect(containerEnvNames(env, {}, "win32")).toEqual(["Lang"]);
  });
});

describe("container helpers", () => {
  it("names containers uniquely with characters Docker accepts", () => {
    const first = containerName("backend:test");
    const second = containerName("backend:test");
    expect(first).toMatch(/^devflow-backend-test-[0-9a-f]{12}$/);
    expect(first).not.toBe(second);
    expect(containerName("x".repeat(200))).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/);
  });

  it("reads docker image inspect", () => {
    expect(
      imageInspectOutcome("alpine", { exitCode: 0, stdout: `${IMAGE_ID}\n`, stderr: "" }),
    ).toEqual({ imageId: IMAGE_ID });
    const missing = imageInspectOutcome("alpine", {
      exitCode: 1,
      stdout: "\n",
      stderr: "Error response from daemon: No such image: alpine:latest\n",
    });
    expect("error" in missing && missing.error.code).toBe(ErrorCode.ContainerImageUnavailable);
    const down = imageInspectOutcome("alpine", {
      exitCode: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\n",
    });
    expect("error" in down && down.error.code).toBe(ErrorCode.ContainerRuntimeUnavailable);
    expect("error" in down && down.error.message).toContain("Cannot connect to the Docker daemon");
  });

  it("tells a container that did not start from a command that failed", () => {
    expect(
      dockerStartFailure(
        127,
        'docker: Error response from daemon: failed to create task: exec: "mvn": executable file not found in $PATH\n',
      ),
    ).toMatch(/^docker: Error response from daemon/);
    expect(dockerStartFailure(125, "docker: No such image: alpine\n")).toBeDefined();
    expect(dockerStartFailure(127, "sh: mvn: not found\n")).toBeUndefined();
    expect(dockerStartFailure(1, "docker: something\n")).toBeUndefined();
    expect(dockerStartFailure(null, "docker: something\n")).toBeUndefined();
  });
});

describe("fingerprints and the execution target", () => {
  it("keeps local fingerprints as they were", () => {
    expect(fingerprintCommand(spec(), [], { backend: "local" })).toBe(
      fingerprintCommand(spec(), []),
    );
  });

  it("separates the local and container backends, and images", () => {
    const local = fingerprintCommand(spec(), []);
    const node = fingerprintCommand(spec(), [], target);
    const alpine = fingerprintCommand(spec(), [], { ...target, image: "alpine:3.20" });
    expect(new Set([local, node, alpine]).size).toBe(3);
  });
});
