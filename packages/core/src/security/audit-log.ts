import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DevflowError, ErrorCode } from "../errors.js";
import { AuditEntry } from "../schemas/audit.js";
import type { SecretRedactor } from "./secrets.js";

/** An audit entry as supplied by a caller; the log assigns `seq`, `at` and `runId`. */
export type AuditEntryInput = AuditEntry extends infer E
  ? E extends AuditEntry
    ? Omit<E, "seq" | "at" | "runId">
    : never
  : never;

export interface AuditLogOptions {
  readonly redactor: SecretRedactor;
  readonly runId?: string;
  readonly clock?: () => Date;
}

/**
 * Append-only JSON Lines audit trail (docs/specs/security-model.md, section 8).
 *
 * Every entry is redacted, then validated against {@link AuditEntry}, then appended as one
 * line. Appends are serialized, so concurrent callers cannot interleave lines. An entry that
 * does not match the schema is refused and nothing is written.
 */
export class AuditLog {
  readonly file: string;
  private readonly options: AuditLogOptions;
  private seq: number;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(file: string, options: AuditLogOptions, nextSeq: number) {
    this.file = file;
    this.options = options;
    this.seq = nextSeq;
  }

  /** Opens (and creates if needed) an audit log. Existing entries are kept and validated. */
  static async open(file: string, options: AuditLogOptions): Promise<AuditLog> {
    await mkdir(path.dirname(file), { recursive: true });
    let existing: readonly AuditEntry[] = [];
    try {
      existing = await readAuditLog(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return new AuditLog(file, options, existing.length);
  }

  /** Redacts, validates and appends one entry. Resolves to the entry as written. */
  append(input: AuditEntryInput): Promise<AuditEntry> {
    const write = this.queue.then(async () => {
      const at = (this.options.clock?.() ?? new Date()).toISOString();
      const candidate = this.options.redactor.redactValue({
        seq: this.seq,
        at,
        ...(this.options.runId === undefined ? {} : { runId: this.options.runId }),
        ...input,
      });
      const parsed = AuditEntry.safeParse(candidate);
      if (!parsed.success) {
        throw new DevflowError(
          ErrorCode.AuditEntryInvalid,
          "audit entry does not match its schema",
          {
            details: {
              type: input.type,
              issues: parsed.error.issues.map((issue) => issue.message),
            },
          },
        );
      }
      await appendFile(this.file, `${JSON.stringify(parsed.data)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      this.seq += 1;
      return parsed.data;
    });
    // Keep the chain alive after a failed append; the caller still sees the failure.
    this.queue = write.catch(() => undefined);
    return write;
  }
}

/** Reads and validates every entry of an audit log. */
export async function readAuditLog(file: string): Promise<AuditEntry[]> {
  const text = await readFile(file, "utf8");
  const entries: AuditEntry[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new DevflowError(ErrorCode.AuditLogCorrupt, `${file}:${index + 1}: not valid JSON`, {
        details: { file, line: index + 1 },
        cause: error,
      });
    }
    const parsed = AuditEntry.safeParse(json);
    if (!parsed.success) {
      throw new DevflowError(
        ErrorCode.AuditLogCorrupt,
        `${file}:${index + 1}: not a valid audit entry`,
        {
          details: { file, line: index + 1 },
        },
      );
    }
    entries.push(parsed.data);
  });
  return entries;
}
