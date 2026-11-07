import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  ErrorCode,
  SecretRedactor,
  createLogger,
  readAuditLog,
  silentLogger,
  type AuditEntryInput,
  type LogRecord,
} from "../../src/index.js";

// Assembled at runtime so that secret scanners never see a token-shaped literal.
const TOKEN = ["gh", "p_", "Z".repeat(30), "a1b2c3"].join("");

let dir: string;
let file: string;
const clock = () => new Date("2026-11-07T10:00:00.000Z");

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "devflow-audit-"));
  file = path.join(dir, "runs", "run-1", "audit.jsonl");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const command: AuditEntryInput = {
  type: "command",
  commandId: "web:test",
  argv: ["pnpm", "test", `--token=${TOKEN}`],
  cwd: "web",
  decision: "allowed",
  approval: "trust-store",
  invocation: "node-script",
  exitCode: 0,
  durationMs: 1200,
  timedOut: false,
};

describe("AuditLog", () => {
  it("numbers, timestamps and redacts every entry", async () => {
    const log = await AuditLog.open(file, {
      redactor: new SecretRedactor(),
      runId: "run-1",
      clock,
    });
    const written = await log.append(command);
    expect(written).toMatchObject({ seq: 0, at: "2026-11-07T10:00:00.000Z", runId: "run-1" });

    const text = await readFile(file, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("«REDACTED:github-token:");
    expect(text.endsWith("\n")).toBe(true);
    expect(await readAuditLog(file)).toEqual([written]);
  });

  it("records every kind of entry", async () => {
    const log = await AuditLog.open(file, { redactor: new SecretRedactor(), clock });
    await log.append(command);
    await log.append({
      type: "llm-call",
      provider: "replay",
      model: "fixture",
      templateId: "analysis",
      templateVersion: "1",
      promptSha256: "a".repeat(64),
      files: ["src/a.ts"],
      inputTokens: 10,
      outputTokens: 5,
      costUsd: null,
      outcome: "ok",
    });
    await log.append({
      type: "file-write",
      path: "src/a.ts",
      sha256Before: null,
      sha256After: "b".repeat(64),
      planChangeId: "C-1",
    });
    await log.append({
      type: "decision",
      subject: "plan",
      decision: "rejected",
      by: "user",
      feedback: "split it",
    });
    await log.append({
      type: "redaction",
      context: "llm-request",
      detector: "jwt",
      location: "src/a.ts:3",
    });
    const entries = await readAuditLog(file);
    expect(entries.map((e) => [e.seq, e.type])).toEqual([
      [0, "command"],
      [1, "llm-call"],
      [2, "file-write"],
      [3, "decision"],
      [4, "redaction"],
    ]);
  });

  it("refuses an entry that does not match the schema and writes nothing", async () => {
    const log = await AuditLog.open(file, { redactor: new SecretRedactor(), clock });
    const invalid = { ...command, cwd: "../outside" };
    await expect(log.append(invalid)).rejects.toMatchObject({ code: ErrorCode.AuditEntryInvalid });
    await expect(log.append(command)).resolves.toMatchObject({ seq: 0 });
    expect(await readAuditLog(file)).toHaveLength(1);
  });

  it("keeps the order of concurrent appends", async () => {
    const log = await AuditLog.open(file, { redactor: new SecretRedactor(), clock });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => log.append({ ...command, commandId: `cmd-${i}` })),
    );
    const entries = await readAuditLog(file);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i));
    expect(entries.map((e) => (e.type === "command" ? e.commandId : ""))).toEqual(
      Array.from({ length: 25 }, (_, i) => `cmd-${i}`),
    );
  });

  it("continues numbering when reopened", async () => {
    const first = await AuditLog.open(file, { redactor: new SecretRedactor(), clock });
    await first.append(command);
    const second = await AuditLog.open(file, { redactor: new SecretRedactor(), clock });
    await expect(second.append(command)).resolves.toMatchObject({ seq: 1 });
  });

  it("reports a corrupt log with its line number", async () => {
    const log = await AuditLog.open(file, { redactor: new SecretRedactor(), clock });
    await log.append(command);
    await appendFile(file, "{not json\n");
    await expect(readAuditLog(file)).rejects.toMatchObject({
      code: ErrorCode.AuditLogCorrupt,
      details: { line: 2 },
    });
    await appendFile(file, "");
    await expect(AuditLog.open(file, { redactor: new SecretRedactor() })).rejects.toMatchObject({
      code: ErrorCode.AuditLogCorrupt,
    });
  });
});

describe("createLogger", () => {
  it("filters by level and redacts messages and fields", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({
      sink: (record) => records.push(record),
      redactor: new SecretRedactor(),
      level: "info",
      clock,
    });
    logger.debug("hidden");
    logger.info(`calling with ${TOKEN}`, { header: `Bearer ${TOKEN}` });
    logger.child({ step: "analysis" }).warn("slow", { ms: 1500 });

    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain(TOKEN);
    expect(records[1]).toEqual({
      level: "warn",
      time: "2026-11-07T10:00:00.000Z",
      message: "slow",
      fields: { step: "analysis", ms: 1500 },
    });
  });

  it("has a silent variant", () => {
    expect(() => {
      silentLogger.error("nothing");
      silentLogger.child({ a: 1 }).info("nothing");
    }).not.toThrow();
  });
});
