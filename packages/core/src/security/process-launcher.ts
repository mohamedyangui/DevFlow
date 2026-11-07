// This is the only module in DevFlow that may start processes. ESLint allows `child_process`
// here and nowhere else, and tests/repo/process-boundary.test.ts checks that it stays so. It is
// called only by the executor, with an invocation built from an approved command.
import { spawn } from "node:child_process";
import path from "node:path";
import { DevflowError, ErrorCode } from "../errors.js";

export interface LaunchOptions {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly windowsVerbatimArguments: boolean;
  readonly timeoutMs: number;
  /** Bytes kept per stream; earlier output is dropped (the tail is kept). */
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
  readonly platform: NodeJS.Platform;
}

export interface LaunchResult {
  readonly startedAt: Date;
  readonly durationMs: number;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly outputTruncated: boolean;
}

/** Keeps the last `max` bytes of a stream. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max) {
      const first = this.chunks[0];
      if (first === undefined) break;
      const excess = this.size - this.max;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
      this.truncated = true;
    }
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/** Time allowed for output to drain after the process exited (or was killed). */
const DRAIN_GRACE_MS = 2_000;
/** Time between the polite and the forced termination on POSIX. */
const KILL_GRACE_MS = 2_000;

/**
 * Starts a process with an argv array and no shell, collects the tail of its output, and
 * enforces a timeout by killing the whole process tree (`taskkill /T /F` on Windows, the
 * process group on POSIX).
 */
export function launchProcess(options: LaunchOptions): Promise<LaunchResult> {
  return new Promise((resolve, reject) => {
    const startedAt = new Date();
    const started = performance.now();
    const stdout = new TailBuffer(options.maxOutputBytes);
    const stderr = new TailBuffer(options.maxOutputBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(options.file, [...options.args], {
      cwd: options.cwd,
      env: { ...options.env },
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      // A new process group on POSIX, so the whole tree can be signalled.
      detached: options.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killTree = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      if (options.platform === "win32") {
        const systemRoot =
          Object.entries(options.env).find(([k]) => k.toUpperCase() === "SYSTEMROOT")?.[1] ??
          "C:\\Windows";
        const killer = spawn(
          path.win32.join(systemRoot, "System32", "taskkill.exe"),
          ["/pid", String(pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", shell: false },
        );
        killer.on("error", () => undefined);
        return;
      }
      const signalGroup = (signal: NodeJS.Signals): void => {
        try {
          process.kill(-pid, signal);
        } catch {
          // The group is already gone.
        }
      };
      signalGroup("SIGTERM");
      setTimeout(() => {
        signalGroup("SIGKILL");
      }, KILL_GRACE_MS).unref();
    };

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        startedAt,
        durationMs: Math.round(performance.now() - started),
        exitCode,
        signal,
        timedOut,
        aborted,
        stdout: stdout.toBuffer(),
        stderr: stderr.toBuffer(),
        outputTruncated: stdout.truncated || stderr.truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, options.timeoutMs);
    let drainTimer: NodeJS.Timeout | undefined;

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.push(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      if (child.pid === undefined) {
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        reject(
          new DevflowError(
            ErrorCode.ProcessStartFailed,
            `cannot start ${options.file}: ${error.message}`,
            {
              details: { file: options.file },
              cause: error,
            },
          ),
        );
      }
    });

    // A grandchild that inherited the output pipes can keep them open after the process exited.
    // Wait briefly for the output to drain, then stop waiting.
    child.on("exit", (code, signal) => {
      if (timedOut && options.platform !== "win32") killTree();
      drainTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code, signal);
      }, DRAIN_GRACE_MS);
    });

    child.on("close", (code, signal) => {
      finish(code, signal);
    });
  });
}
