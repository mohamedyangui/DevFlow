import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { DevflowError, ErrorCode } from "../errors.js";
import { ExecutionRecord } from "../schemas/command.js";
import type { AuditLog } from "./audit-log.js";
import { isApprovedCommand, type ApprovedCommand } from "./command-policy.js";
import { childEnvironment } from "./environment.js";
import { resolveInvocation, type Invocation } from "./invocation.js";
import type { PathGuard } from "./path-guard.js";
import { launchProcess } from "./process-launcher.js";
import type { SecretRedactor } from "./secrets.js";

/**
 * Runs approved commands (docs/specs/security-model.md, section 5):
 *
 * - only {@link ApprovedCommand}s created by the command policy, never a shell;
 * - with an allowlisted, credential-free environment;
 * - with a timeout that kills the whole process tree;
 * - keeping the tail of the output (5 MB per stream by default), redacted before it is
 *   returned, written to the run's logs, or recorded.
 */

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
}

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

  constructor(options: ExecutorOptions) {
    this.options = options;
  }

  /**
   * Runs an approved command and waits for it. A non-zero exit code is a result, not an error.
   *
   * @throws DevflowError `COMMAND_NOT_APPROVED` for anything that did not come from the
   * command policy; `EXECUTABLE_NOT_FOUND`, `COMMAND_ARGUMENT_REJECTED` or
   * `PROCESS_START_FAILED` when the command cannot be started. Nothing has run in these cases.
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
    const env = childEnvironment(this.options.env ?? process.env, command.spec.env, platform);
    const invocation = await resolveInvocation(command, {
      platform,
      env,
      nodePath: this.options.nodePath ?? process.execPath,
    });

    this.sequence += 1;
    const stem = `${command.commandId.replace(/[^A-Za-z0-9._-]/g, "_")}-${Date.now()}-${this.sequence}`;
    const logDir = options.logDir.replace(/\/+$/, "");
    const stdoutPath = `${logDir}/${stem}.stdout.log`;
    const stderrPath = `${logDir}/${stem}.stderr.log`;
    const internal = { access: "write", origin: "internal" } as const;
    const stdoutFile = await guard.check(stdoutPath, internal);
    const stderrFile = await guard.check(stderrPath, internal);

    const launched = await launchProcess({
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
