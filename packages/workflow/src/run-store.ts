import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DevflowError, ErrorCode } from "@devflowai/core";
import type { z } from "zod";
import { RunEvent, RunId, RunRecord } from "./schemas.js";

/** Where runs live, relative to the workspace root. `devflow init` adds it to `.gitignore`. */
export const RUNS_DIRECTORY = ".devflow/runs";

const LOCK_FILE = "lock.json";

export type RunEventInput = Omit<RunEvent, "seq" | "at">;

interface LockContent {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

/**
 * A run directory: `run.json`, `events.jsonl`, `audit.jsonl`, `artifacts/`, `logs/` and the
 * report (ADR 0004).
 *
 * JSON files are written atomically (temporary file, then rename) so a crash leaves either the
 * old or the new version, never half a file. Callers write a step's artifacts before they
 * advance the state, so a resumed run never skips work it has not saved. A lock file keeps two
 * DevFlow processes from driving the same run; a lock left by a process that no longer runs on
 * this machine is taken over.
 */
export class RunStore {
  readonly id: RunId;
  readonly workspaceRoot: string;
  readonly dir: string;
  private readonly clock: () => Date;
  private nextSeq: number;
  private eventQueue: Promise<unknown> = Promise.resolve();

  private constructor(workspaceRoot: string, id: RunId, clock: () => Date, nextSeq: number) {
    this.workspaceRoot = workspaceRoot;
    this.id = id;
    this.dir = path.join(workspaceRoot, ...RUNS_DIRECTORY.split("/"), id);
    this.clock = clock;
    this.nextSeq = nextSeq;
  }

  /** Creates a new run directory with a unique id derived from the time and the task id. */
  static async create(
    workspaceRoot: string,
    taskId: string,
    options: { clock?: () => Date } = {},
  ): Promise<RunStore> {
    const clock = options.clock ?? (() => new Date());
    const stamp = clock()
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z")
      .replace(/:/g, "-");
    const base = `${stamp}_${taskId}`;
    const runs = path.join(workspaceRoot, ...RUNS_DIRECTORY.split("/"));
    await mkdir(runs, { recursive: true });
    for (let attempt = 1; attempt <= 9999; attempt += 1) {
      const id = RunId.parse(attempt === 1 ? base : `${base}_${attempt}`);
      try {
        await mkdir(path.join(runs, id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw error;
      }
      const store = new RunStore(workspaceRoot, id, clock, 0);
      await mkdir(store.path("artifacts"), { recursive: true });
      await mkdir(store.path("logs"), { recursive: true });
      return store;
    }
    throw new Error(`cannot allocate a run id for ${base}`);
  }

  /** Opens an existing run. Throws `RUN_NOT_FOUND` for an unknown or malformed id. */
  static async open(
    workspaceRoot: string,
    id: string,
    options: { clock?: () => Date } = {},
  ): Promise<RunStore> {
    const parsed = RunId.safeParse(id);
    if (!parsed.success) {
      throw new DevflowError(ErrorCode.RunNotFound, `"${id}" is not a run id`, {
        details: { runId: id },
      });
    }
    const store = new RunStore(workspaceRoot, parsed.data, options.clock ?? (() => new Date()), 0);
    try {
      await stat(store.path("run.json"));
    } catch {
      throw new DevflowError(ErrorCode.RunNotFound, `there is no run ${id} in this workspace`, {
        details: { runId: id },
      });
    }
    store.nextSeq = (await store.readEvents()).length;
    return store;
  }

  /** Run ids in the workspace, oldest first. */
  static async list(workspaceRoot: string): Promise<RunId[]> {
    let names: string[];
    try {
      names = await readdir(path.join(workspaceRoot, ...RUNS_DIRECTORY.split("/")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names.filter((name) => RunId.safeParse(name).success).sort();
  }

  /** Absolute path of a file inside the run directory. */
  path(relative: string): string {
    return path.join(this.dir, ...relative.split("/"));
  }

  /** Path relative to the workspace root, with forward slashes. */
  workspacePath(relative: string): string {
    return `${RUNS_DIRECTORY}/${this.id}/${relative}`;
  }

  async readRecord(): Promise<RunRecord> {
    return this.readJson("run.json", RunRecord);
  }

  async writeRecord(record: RunRecord): Promise<void> {
    await this.writeJson("run.json", RunRecord.parse(record));
  }

  async exists(relative: string): Promise<boolean> {
    try {
      await stat(this.path(relative));
      return true;
    } catch {
      return false;
    }
  }

  /** Reads and validates a JSON file. A missing or invalid file is `RUN_CORRUPT`. */
  async readJson<S extends z.ZodType>(relative: string, schema: S): Promise<z.infer<S>> {
    let text: string;
    try {
      text = await readFile(this.path(relative), "utf8");
    } catch (error) {
      throw this.corrupt(relative, `cannot be read (${errorCode(error)})`, error);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw this.corrupt(relative, "is not valid JSON", error);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw this.corrupt(
        relative,
        `does not match its schema: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return parsed.data;
  }

  /** Reads a JSON file if it exists. */
  async readJsonIfExists<S extends z.ZodType>(
    relative: string,
    schema: S,
  ): Promise<z.infer<S> | undefined> {
    if (!(await this.exists(relative))) return undefined;
    return this.readJson(relative, schema);
  }

  async writeJson(relative: string, value: unknown): Promise<void> {
    await this.writeText(relative, `${JSON.stringify(value, null, 2)}\n`);
  }

  /** Writes a file atomically: a temporary file in the same directory, then a rename. */
  async writeText(relative: string, text: string): Promise<void> {
    const target = this.path(relative);
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(temporary, target);
  }

  async readText(relative: string): Promise<string> {
    return readFile(this.path(relative), "utf8");
  }

  /** Appends one event to `events.jsonl`. */
  appendEvent(input: RunEventInput): Promise<RunEvent> {
    const write = this.eventQueue.then(async () => {
      const event = RunEvent.parse({ seq: this.nextSeq, at: this.clock().toISOString(), ...input });
      await mkdir(this.dir, { recursive: true });
      const handle = await open(this.path("events.jsonl"), "a", 0o600);
      try {
        await handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
      } finally {
        await handle.close();
      }
      this.nextSeq += 1;
      return event;
    });
    this.eventQueue = write.catch(() => undefined);
    return write;
  }

  async readEvents(): Promise<RunEvent[]> {
    let text: string;
    try {
      text = await readFile(this.path("events.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: RunEvent[] = [];
    for (const [index, line] of text.split("\n").entries()) {
      if (line.trim() === "") continue;
      const parsed = RunEvent.safeParse(safeJson(line));
      if (!parsed.success) throw this.corrupt("events.jsonl", `line ${index + 1} is invalid`);
      events.push(parsed.data);
    }
    return events;
  }

  /**
   * Takes the run's lock. Returns the function that releases it. Throws `RUN_LOCKED` when
   * another live process holds it.
   */
  async lock(): Promise<() => Promise<void>> {
    const file = this.path(LOCK_FILE);
    const content: LockContent = {
      pid: process.pid,
      hostname: os.hostname(),
      acquiredAt: this.clock().toISOString(),
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(JSON.stringify(content), "utf8");
        } finally {
          await handle.close();
        }
        return async () => {
          await rm(file, { force: true });
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = await readLock(file);
      if (holder !== undefined && !isStale(holder)) {
        throw new DevflowError(
          ErrorCode.RunLocked,
          `run ${this.id} is in use by process ${holder.pid} on ${holder.hostname} since ` +
            `${holder.acquiredAt}; if no DevFlow process is running, delete ${this.workspacePath(LOCK_FILE)}`,
          { details: { runId: this.id, ...holder } },
        );
      }
      await rm(file, { force: true });
    }
    throw new DevflowError(ErrorCode.RunLocked, `cannot take the lock of run ${this.id}`, {
      details: { runId: this.id },
    });
  }

  private corrupt(relative: string, problem: string, cause?: unknown): DevflowError {
    return new DevflowError(
      ErrorCode.RunCorrupt,
      `${this.workspacePath(relative)} ${problem}`,
      cause === undefined
        ? { details: { runId: this.id, file: relative } }
        : { details: { runId: this.id, file: relative }, cause },
    );
  }
}

async function readLock(file: string): Promise<LockContent | undefined> {
  try {
    const value = JSON.parse(await readFile(file, "utf8")) as Partial<LockContent>;
    if (
      typeof value.pid === "number" &&
      typeof value.hostname === "string" &&
      typeof value.acquiredAt === "string"
    ) {
      return { pid: value.pid, hostname: value.hostname, acquiredAt: value.acquiredAt };
    }
  } catch {
    // An unreadable lock (for example, written half-way by a crash) is treated as stale.
  }
  return undefined;
}

/** A lock is stale when its process is gone. Locks from another machine are never stale. */
function isStale(holder: LockContent): boolean {
  if (holder.hostname !== os.hostname()) return false;
  if (holder.pid === process.pid) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows can briefly refuse a rename while another program (an indexer, an antivirus) has
  // the target open.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = errorCode(error);
      if ((code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") || attempt >= 5) {
        await rm(from, { force: true });
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
    }
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? "unknown";
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
}
