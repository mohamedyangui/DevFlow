import { randomBytes } from "node:crypto";
import path from "node:path";
import { DevflowError, ErrorCode } from "../errors.js";
import { ContainerSettings, type ProjectConfig } from "../schemas/config.js";
import { childEnvironment, isReservedEnvName } from "./environment.js";
import { CREDENTIAL_ENV_NAME } from "./secrets.js";

/**
 * Execution backends (ADR 0020): where an approved command runs.
 *
 * - `local` (the default): on the host, as the executor has always run commands.
 * - `container`: in a throwaway Docker container with no network, CPU, memory and process
 *   limits, no capabilities, and only the workspace mounted.
 *
 * The backend and the image are part of what a command approval covers: the command policy
 * binds them into the fingerprint and into the `ApprovedCommand`, and the executor runs the
 * command where it was approved to run. This module holds the pure parts: settings resolution
 * and the `docker run` argv. The executor starts the processes.
 */

export type ExecutionBackendKind = "local" | "container";
export const EXECUTION_BACKENDS: readonly ExecutionBackendKind[] = ["local", "container"];

/** Where one command runs. */
export type ExecutionTarget = { readonly backend: "local" } | ContainerTarget;

export interface ContainerTarget {
  readonly backend: "container";
  readonly image: string;
  readonly cpus: number;
  readonly memory: string;
  readonly pidsLimit: number;
  /** Always `none`: there is no setting that gives a container a network. */
  readonly network: "none";
  readonly readOnlyRootFilesystem: boolean;
}

/** The execution settings of one DevFlow invocation. */
export type ExecutionSettings = { readonly backend: "local" } | ContainerExecutionSettings;

export interface ContainerExecutionSettings extends Omit<ContainerTarget, "image"> {
  /** The image for every module without an override. */
  readonly image: string;
  readonly moduleImages: Readonly<Record<string, string>>;
}

export const LOCAL_EXECUTION: ExecutionSettings = Object.freeze({ backend: "local" });

/**
 * Resolves the backend of an invocation. The user's invocation takes precedence over the
 * project configuration (docs/specs/project-config.md, section 4): `--backend` wins, then
 * `execution.backend` of the trusted configuration, then `local`. The container settings
 * (image, limits) come from the configuration, which only takes effect once trusted.
 *
 * @throws DevflowError `CONTAINER_IMAGE_UNAVAILABLE` when the container backend is chosen and
 * no image is configured. There is no fallback to the local backend.
 */
export function resolveExecutionSettings(input: {
  readonly flag?: ExecutionBackendKind | undefined;
  readonly config?: ProjectConfig["execution"] | undefined;
}): ExecutionSettings {
  const backend = input.flag ?? input.config?.backend ?? "local";
  if (backend === "local") return LOCAL_EXECUTION;
  const container = input.config?.container ?? ContainerSettings.parse({});
  if (container.image === undefined) {
    throw new DevflowError(
      ErrorCode.ContainerImageUnavailable,
      "the container backend needs an image: set execution.container.image in .devflow/config.yaml (and trust the workspace again)",
      { details: { backend } },
    );
  }
  return Object.freeze({
    backend: "container",
    image: container.image,
    moduleImages: Object.freeze({ ...container.moduleImages }),
    cpus: container.cpus,
    memory: container.memory,
    pidsLimit: container.pidsLimit,
    network: "none",
    readOnlyRootFilesystem: container.readOnlyRootFilesystem,
  });
}

/** The target of a command of `moduleId` (the module's image override, else the image). */
export function executionTarget(settings: ExecutionSettings, moduleId?: string): ExecutionTarget {
  if (settings.backend === "local") return { backend: "local" };
  const override =
    moduleId !== undefined && Object.hasOwn(settings.moduleImages, moduleId)
      ? settings.moduleImages[moduleId]
      : undefined;
  return {
    backend: "container",
    image: override ?? settings.image,
    cpus: settings.cpus,
    memory: settings.memory,
    pidsLimit: settings.pidsLimit,
    network: "none",
    readOnlyRootFilesystem: settings.readOnlyRootFilesystem,
  };
}

// ---- Docker ---------------------------------------------------------------------------------

/** Where the workspace is mounted in the container. */
export const CONTAINER_WORKSPACE = "/workspace";

/** Variables forwarded into the container from the allowlisted environment (by name only). */
export const CONTAINER_ENV_ALLOWLIST: readonly string[] = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "CI",
];

/**
 * Variables the `docker` client itself needs to reach the daemon. They are given to the
 * `docker` process only, never forwarded into the container, and commands cannot set them
 * (`DOCKER_*` is reserved).
 */
export const DOCKER_CLIENT_ENV: readonly string[] = [
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "DOCKER_API_VERSION",
];

function findKey(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return Object.hasOwn(env, name) ? name : undefined;
  return Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase());
}

/**
 * The environment of the `docker` process: the child environment of the executor (an
 * allowlist without credentials, plus the command's additions), and the Docker client
 * variables. Nothing here reaches the container unless it is named with `--env NAME`.
 */
export function dockerClientEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  additions: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): Record<string, string> {
  const env = childEnvironment(parent, additions, platform);
  for (const name of DOCKER_CLIENT_ENV) {
    const key = findKey(parent, name, platform);
    const value = key === undefined ? undefined : parent[key];
    if (key !== undefined && value !== undefined && !CREDENTIAL_ENV_NAME.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Names of the variables forwarded into the container: the container allowlist and the
 * command's own additions, when present in the `docker` process environment. They are passed
 * as `--env NAME`, so values never appear on a command line. Reserved and credential-like
 * names are never forwarded.
 */
export function containerEnvNames(
  dockerEnv: Readonly<Record<string, string>>,
  additions: Readonly<Record<string, string>>,
  platform: NodeJS.Platform,
): string[] {
  const names: string[] = [];
  for (const name of [...CONTAINER_ENV_ALLOWLIST, ...Object.keys(additions)]) {
    const key = findKey(dockerEnv, name, platform);
    if (key === undefined || names.includes(key)) continue;
    if (isReservedEnvName(key) || CREDENTIAL_ENV_NAME.test(key)) continue;
    if (key.toUpperCase() === "HOME") continue;
    names.push(key);
  }
  return names;
}

/**
 * The host path of the workspace as the `source` of a `--mount`. On Windows it must be a
 * drive path (`D:\repo`), which Docker Desktop maps into its virtual machine; UNC paths are
 * refused. `--mount` is used rather than `-v`, whose `source:target` syntax collides with the
 * drive letter's colon. Characters that the `--mount` field syntax would split on are refused.
 *
 * @throws DevflowError `PATH_REJECTED` when the path cannot be mounted safely.
 */
export function dockerMountSource(root: string, platform: NodeJS.Platform): string {
  const reject = (reason: string): DevflowError =>
    new DevflowError(
      ErrorCode.PathRejected,
      `the workspace path ${root} cannot be mounted into a container: ${reason}`,
      { details: { path: root } },
    );
  // eslint-disable-next-line no-control-regex
  if (/[,"\u0000-\u001f\u007f]/.test(root)) {
    throw reject("it contains a comma, a quote or a control character");
  }
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(root)) throw reject("expected a drive path such as D:\\repo");
    const normalized = path.win32.normalize(root);
    const trimmed = normalized.length > 3 ? normalized.replace(/\\+$/, "") : normalized;
    return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  }
  if (!path.posix.isAbsolute(root)) throw reject("expected an absolute path");
  const normalized = path.posix.normalize(root);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

/** The working directory in the container for a repository-relative directory. */
export function containerWorkdir(relative: string): string {
  return relative === "." || relative === ""
    ? CONTAINER_WORKSPACE
    : `${CONTAINER_WORKSPACE}/${relative.replace(/^\.\/+/, "").replace(/\/+$/, "")}`;
}

/** A unique container name, so a timed-out container can be killed by name. */
export function containerName(commandId: string): string {
  const stem = commandId.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 40);
  return `devflow-${stem}-${randomBytes(6).toString("hex")}`;
}

export interface DockerRunInput {
  readonly target: ContainerTarget;
  readonly name: string;
  /** From {@link dockerMountSource}. */
  readonly mountSource: string;
  /** From {@link containerWorkdir}. */
  readonly workdir: string;
  /** From {@link containerEnvNames}. */
  readonly envNames: readonly string[];
  /** `uid:gid` on POSIX hosts, so files written in the workspace belong to the user. */
  readonly user?: string | undefined;
  /** The program: a tool name looked up on the image's PATH, or an absolute wrapper path. */
  readonly entrypoint: string;
  readonly args: readonly string[];
}

/**
 * The `docker` argv for one command (never a shell string). The command is the container's
 * entry point, so the image's own entry point (often a shell script) does not run. Images are
 * never pulled: a missing image fails before anything runs.
 */
export function dockerRunArgs(input: DockerRunInput): string[] {
  const { target } = input;
  return [
    "run",
    "--rm",
    "--pull",
    "never",
    "--name",
    input.name,
    "--network",
    "none",
    "--cpus",
    String(target.cpus),
    "--memory",
    target.memory,
    "--memory-swap",
    target.memory,
    "--pids-limit",
    String(target.pidsLimit),
    ...(target.readOnlyRootFilesystem ? ["--read-only"] : []),
    "--tmpfs",
    "/tmp:rw,exec,nosuid,nodev",
    "--security-opt",
    "no-new-privileges",
    "--cap-drop",
    "ALL",
    ...(input.user === undefined ? [] : ["--user", input.user]),
    "--mount",
    `type=bind,source=${input.mountSource},target=${CONTAINER_WORKSPACE}`,
    "--workdir",
    input.workdir,
    "--env",
    "HOME=/tmp",
    ...input.envNames.flatMap((name) => ["--env", name]),
    "--entrypoint",
    input.entrypoint,
    target.image,
    ...input.args,
  ];
}

/** `docker image inspect` argv that prints the image id (it also proves the daemon answers). */
export function dockerImageInspectArgs(image: string): string[] {
  return ["image", "inspect", "--format", "{{.Id}}", image];
}

/** `docker kill` argv for a container started by {@link dockerRunArgs}. */
export function dockerKillArgs(name: string): string[] {
  return ["kill", name];
}

/**
 * Reads the result of {@link dockerImageInspectArgs}: the image id, or the error to raise.
 */
export function imageInspectOutcome(
  image: string,
  result: { readonly exitCode: number | null; readonly stdout: string; readonly stderr: string },
): { readonly imageId: string } | { readonly error: DevflowError } {
  const imageId = result.stdout.trim();
  if (result.exitCode === 0 && /^sha256:[0-9a-f]{64}$/.test(imageId)) return { imageId };
  const message = firstLine(result.stderr) ?? `docker exited with code ${String(result.exitCode)}`;
  if (/no such image/i.test(result.stderr)) {
    return {
      error: new DevflowError(
        ErrorCode.ContainerImageUnavailable,
        `the image ${image} is not present locally; DevFlow never pulls images: review it and run \`docker pull ${image}\` yourself`,
        { details: { image } },
      ),
    };
  }
  return {
    error: new DevflowError(
      ErrorCode.ContainerRuntimeUnavailable,
      `Docker cannot be used for the container backend: ${message}`,
      { details: { image } },
    ),
  };
}

/**
 * When `docker run` itself failed (the container did not start: daemon error, missing
 * program in the image), the first error line; otherwise undefined. Docker reports these with
 * exit codes 125 to 127 and a `docker:` prefix on standard error.
 */
export function dockerStartFailure(exitCode: number | null, stderr: string): string | undefined {
  if (exitCode !== 125 && exitCode !== 126 && exitCode !== 127) return undefined;
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("docker: "));
}

function firstLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
}
