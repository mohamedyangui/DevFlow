import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DevflowError, ErrorCode, isDevflowError } from "../errors.js";
import { ExecutionRecord } from "../schemas/command.js";
import type { AuditLog } from "./audit-log.js";
import { isApprovedCommand, type ApprovedCommand } from "./command-policy.js";
import { childEnvironment } from "./environment.js";
import {
  containerEnvNames,
  containerName,
  containerWorkdir,
  dockerClientEnvironment,
  dockerImageInspectArgs,
  dockerKillArgs,
  dockerMountSource,
  dockerRunArgs,
  dockerStartFailure,
  imageInspectOutcome,
  type ContainerTarget,
} from "./execution-backend.js";
import { findOnPath, resolveInvocation, type Invocation } from "./invocation.js";
import type { PathGuard } from "./path-guard.js";
import {
  launchProcess,
  type LaunchOptions,
  type LaunchResult,
  type Launcher,
} from "./process-launcher.js";
import type { SecretRedactor } from "./secrets.js";

/**
 * Runs approved commands (docs/specs/security-model.md, section 5):
 *
 * - only {@link ApprovedCommand}s created by the command policy, never a shell;
 * - with an allowlisted, credential-free environment;
 * - with a timeout that kills the whole process tree;
 * - keeping the tail of the output (5 MB per stream by default), redacted before it is
 *   returned, written to the run's logs, or recorded;
 * - on the host, or in a container when the command was approved for the container backend
 *   (ADR 0020). There is no fallback from one to the other.
 */

/** The launcher's types, for a fake launcher in tests (only this module imports the launcher). */
export type { LaunchOptions, LaunchResult, Launcher };

export const DEFAULT_MAX_OUTPUT_BYTES = 5 * 1024 * 1024;

export interface ExecutorOptions {
  readonly guard: PathGuard;
  readonly redactor: SecretRedactor;
  readonly audit?: AuditLog;
  /** DevFlow's own environment, filtered for the child. Defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Node.js binary for the `node-script` strategy. Defaults to `process.execPath`. */
  readonly nodePath?: string;
  readonly maxOutputBytes?: number;
  /** Starts processes. Defaults to {@link launchProcess}; tests pass a fake. */
  readonly launcher?: Launcher;
  readonly container?: ContainerRuntimeOptions;
}

export interface ContainerRuntimeOptions {
  /** Absolute path of the `docker` binary. Looked up on the absolute entries of PATH by default. */
  readonly docker?: string;
  /**
   * `--user` for the container. Defaults to the current `uid:gid` on POSIX hosts and to none on
   * Windows (Docker Desktop maps file ownership itself). `null` omits it.
   */
  readonly user?: string | null;
}

/** Time allowed for `docker image inspect` and `docker kill`. */
const DOCKER_CONTROL_TIMEOUT_MS = 60_000;
/** Output kept from `docker image inspect` and `docker kill`. */
const DOCKER_CONTROL_OUTPUT_BYTES = 64 * 1024;

export interface ExecuteOptions {
  /** Repository-relative directory for the output logs, e.g. `.devflow/runs/<id>/logs`. */
  readonly logDir: string;
  readonly signal?: AbortSignal;
}

export interface ExecutionResult {
  readonly record: ExecutionRecord;
  /** Redacted tail of standard output. */
  readonly stdout: string;
  /** Redacted tail of standard error. */
  readonly stderr: string;
  readonly invocation: Invocation;
}

export class Executor {
  private readonly options: ExecutorOptions;
  private sequence = 0;
  /** Image ids by image reference, checked once per executor. */
  private readonly images = new Map<string, Promise<string>>();

  constructor(options: ExecutorOptions) {
    this.options = options;
  }

  /**
   * Runs an approved command and waits for it. A non-zero exit code is a result, not an error.
   *
   * @throws DevflowError `COMMAND_NOT_APPROVED` for anything that did not come from the
   * command policy; `EXECUTABLE_NOT_FOUND`, `COMMAND_ARGUMENT_REJECTED` or
   * `PROCESS_START_FAILED` when the command cannot be started; for the container backend,
   * `CONTAINER_RUNTIME_UNAVAILABLE` (no Docker, or its daemon does not answer),
   * `CONTAINER_IMAGE_UNAVAILABLE` (the image is not present locally) or `PROCESS_START_FAILED`
   * (the container did not start). Nothing has run in these cases.
   */
  async run(command: ApprovedCommand, options: ExecuteOptions): Promise<ExecutionResult> {
    if (!isApprovedCommand(command)) {
      throw new DevflowError(
        ErrorCode.CommandNotApproved,
        "the executor only runs commands approved by the command policy",
      );
    }
    const platform = this.options.platform ?? process.platform;
    const { guard, redactor } = this.options;

    let invocation: Invocation;
    let launched: LaunchResult;
    let container: ExecutionRecord["container"];
    if (command.target.backend === "container") {
      ({ invocation, launched, container } = await this.runInContainer(
        command,
        command.target,
        platform,
        options,
      ));
    } else {
      const env = childEnvironment(this.options.env ?? process.env, command.spec.env, platform);
      invocation = await resolveInvocation(command, {
        platform,
        env,
        nodePath: this.options.nodePath ?? process.execPath,
      });
      launched = await this.launch({
        file: invocation.file,
        args: invocation.args,
        cwd: command.cwd.absolute,
        env,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        timeoutMs: command.spec.timeoutMs,
        maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
        platform,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    }

    this.sequence += 1;
    const stem = `${command.commandId.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}-${this.sequence}`;
    const logDir = options.logDir.replace(/\/+$/, "");
    const stdoutPath = `${logDir}/${stem}.stdout.log`;
    const stderrPath = `${logDir}/${stem}.stderr.log`;
    const internal = { access: "write", origin: "internal" } as const;
    const stdoutFile = await guard.check(stdoutPath, internal);
    const stderrFile = await guard.check(stderrPath, internal);

    const stdout = redactor.redactText(decodeTail(launched.stdout));
    const stderr = redactor.redactText(decodeTail(launched.stderr));
    await mkdir(path.dirname(stdoutFile.absolute), { recursive: true });
    await writeFile(stdoutFile.absolute, stdout, "utf8");
    await writeFile(stderrFile.absolute, stderr, "utf8");

    const record = ExecutionRecord.parse({
      commandId: command.commandId,
      argv: redactor.redactValue([command.spec.executable, ...command.args]),
      cwd: command.cwd.relative,
      invocation: invocation.strategy,
      approval: command.approval,
      startedAt: launched.startedAt.toISOString(),
      durationMs: launched.durationMs,
      exitCode: launched.exitCode,
      signal: launched.signal,
      timedOut: launched.timedOut,
      stdoutPath,
      stderrPath,
      outputTruncated: launched.outputTruncated,
      ...(container === undefined ? {} : { container }),
    });

    await this.options.audit?.append({
      type: "command",
      commandId: record.commandId,
      argv: record.argv,
      cwd: record.cwd,
      decision: "allowed",
      approval: record.approval.via,
      ...(record.approval.approvedBy === undefined
        ? {}
        : { approvedBy: record.approval.approvedBy }),
      invocation: record.invocation,
      exitCode: record.exitCode,
      durationMs: record.durationMs,
      timedOut: record.timedOut,
      ...(launched.aborted ? { reason: "cancelled" } : {}),
    });
    return { record, stdout, stderr, invocation };
  }

  private launch(options: LaunchOptions): Promise<LaunchResult> {
    return (this.options.launcher ?? launchProcess)(options);
  }

  /**
   * Runs an approved command in a container (ADR 0020): checks that Docker answers and that
   * the image is present (it is never pulled), then runs `docker run` with the command as the
   * entry point. On timeout or cancellation the container is killed by name, as well as the
   * `docker` client's process tree.
   */
  private async runInContainer(
    command: ApprovedCommand,
    target: ContainerTarget,
    platform: NodeJS.Platform,
    options: ExecuteOptions,
  ): Promise<{
    invocation: Invocation;
    launched: LaunchResult;
    container: NonNullable<ExecutionRecord["container"]>;
  }> {
    const { guard, redactor } = this.options;
    const env = dockerClientEnvironment(
      this.options.env ?? process.env,
      command.spec.env,
      platform,
    );
    const docker = this.options.container?.docker ?? (await findOnPath("docker", env, platform));
    if (docker === undefined) {
      throw new DevflowError(
        ErrorCode.ContainerRuntimeUnavailable,
        "Docker was not found on PATH; the container backend needs it (DevFlow does not fall back to running the command on the host)",
        { details: { backend: "container" } },
      );
    }
    const imageId = await this.imageId(docker, target.image, env, platform);

    const name = containerName(command.commandId);
    const configuredUser = this.options.container?.user;
    const args = dockerRunArgs({
      target,
      name,
      mountSource: dockerMountSource(guard.root, platform),
      workdir: containerWorkdir(command.cwd.relative),
      envNames: containerEnvNames(env, command.spec.env, platform),
      user:
        configuredUser === undefined
          ? defaultContainerUser(platform)
          : (configuredUser ?? undefined),
      entrypoint:
        command.executable.kind === "tool"
          ? command.executable.name
          : containerWorkdir(command.executable.relative),
      args: command.args,
    });

    const kills: Promise<unknown>[] = [];
    const launched = await this.launch({
      file: docker,
      args,
      cwd: guard.root,
      env,
      windowsVerbatimArguments: false,
      timeoutMs: command.spec.timeoutMs,
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      platform,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onKill: () => {
        kills.push(
          this.launch({
            file: docker,
            args: dockerKillArgs(name),
            cwd: guard.root,
            env,
            windowsVerbatimArguments: false,
            timeoutMs: DOCKER_CONTROL_TIMEOUT_MS,
            maxOutputBytes: DOCKER_CONTROL_OUTPUT_BYTES,
            platform,
          }).catch(() => undefined),
        );
      },
    });
    await Promise.allSettled(kills);

    const failure = dockerStartFailure(launched.exitCode, decodeTail(launched.stderr));
    if (failure !== undefined && !launched.timedOut && !launched.aborted) {
      throw new DevflowError(
        ErrorCode.ProcessStartFailed,
        `the container did not start: ${redactor.redactText(failure)}`,
        { details: { image: target.image } },
      );
    }
    return {
      invocation: { strategy: "container", file: docker, args, windowsVerbatimArguments: false },
      launched,
      container: { image: target.image, imageId },
    };
  }

  /** The id of a local image, checked once per executor. */
  private imageId(
    docker: string,
    image: string,
    env: Readonly<Record<string, string>>,
    platform: NodeJS.Platform,
  ): Promise<string> {
    let found = this.images.get(image);
    if (found === undefined) {
      found = this.inspectImage(docker, image, env, platform);
      this.images.set(image, found);
    }
    return found;
  }

  private async inspectImage(
    docker: string,
    image: string,
    env: Readonly<Record<string, string>>,
    platform: NodeJS.Platform,
  ): Promise<string> {
    let result: LaunchResult;
    try {
      result = await this.launch({
        file: docker,
        args: dockerImageInspectArgs(image),
        cwd: this.options.guard.root,
        env,
        windowsVerbatimArguments: false,
        timeoutMs: DOCKER_CONTROL_TIMEOUT_MS,
        maxOutputBytes: DOCKER_CONTROL_OUTPUT_BYTES,
        platform,
      });
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      throw new DevflowError(
        ErrorCode.ContainerRuntimeUnavailable,
        `Docker cannot be started: ${error.message}`,
        { details: { docker }, cause: error },
      );
    }
    const outcome = imageInspectOutcome(image, {
      exitCode: result.timedOut ? null : result.exitCode,
      stdout: decodeTail(result.stdout),
      stderr: this.options.redactor.redactText(decodeTail(result.stderr)),
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.imageId;
  }
}

/** The current `uid:gid` on POSIX hosts; none on Windows. */
function defaultContainerUser(platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") return undefined;
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  return uid === undefined || gid === undefined ? undefined : `${String(uid)}:${String(gid)}`;
}

/**
 * Decodes the kept tail of a stream as UTF-8. When the start was cut off in the middle of a
 * multi-byte character, the leftover continuation bytes are skipped.
 */
export function decodeTail(buffer: Buffer): string {
  let start = 0;
  while (start < buffer.length && start < 3) {
    const byte = buffer[start] ?? 0;
    if ((byte & 0xc0) !== 0x80) break;
    start += 1;
  }
  return buffer.subarray(start).toString("utf8");
}
