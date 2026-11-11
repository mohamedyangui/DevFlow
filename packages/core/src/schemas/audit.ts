import { z } from "zod";
import { InvocationStrategy } from "./command.js";
import { IsoDateTime, RepoPath, Sha256 } from "./primitives.js";

/**
 * Entries of a run's `audit.jsonl` (docs/specs/security-model.md, section 8). Entries are
 * redacted before they are written; they never contain secret values, only the type and
 * location of what was redacted.
 */

const base = {
  /** Position in the log, starting at 0. */
  seq: z.int().nonnegative(),
  at: IsoDateTime,
  runId: z.string().min(1).max(128).optional(),
};

/** One call to a model provider. */
export const LlmCallAuditEntry = z.strictObject({
  ...base,
  type: z.literal("llm-call"),
  provider: z.string().min(1),
  model: z.string().min(1),
  templateId: z.string().min(1),
  templateVersion: z.string().min(1),
  promptSha256: Sha256,
  files: z.array(RepoPath),
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  costUsd: z.number().nonnegative().nullable(),
  outcome: z.enum(["ok", "error", "refused"]),
  /** The workflow step of the call. Absent in entries written before Phase 6. */
  step: z.string().min(1).optional(),
  /** Time from the first attempt to the answer or the final failure, retries included. */
  durationMs: z.int().nonnegative().optional(),
  /** Provider attempts for this call, the first included (transport retries). */
  attempts: z.int().positive().optional(),
});

/** A command policy decision and, when it ran, the execution result. */
export const CommandAuditEntry = z.strictObject({
  ...base,
  type: z.literal("command"),
  commandId: z.string().min(1),
  argv: z.array(z.string()).min(1),
  cwd: RepoPath,
  decision: z.enum(["allowed", "denied"]),
  reason: z.string().min(1).optional(),
  approval: z.enum(["trust-store", "interactive", "allowlist-flag"]).optional(),
  approvedBy: z.string().min(1).optional(),
  invocation: InvocationStrategy.optional(),
  exitCode: z.int().nullable().optional(),
  durationMs: z.int().nonnegative().optional(),
  timedOut: z.boolean().optional(),
  /** Where the command ran (ADR 0020). Absent in entries written before Phase 6. */
  backend: z.enum(["local", "container"]).optional(),
});

/** A file written or deleted by a workflow. */
export const FileWriteAuditEntry = z.strictObject({
  ...base,
  type: z.literal("file-write"),
  path: RepoPath,
  /** Null when the file did not exist before. */
  sha256Before: Sha256.nullable(),
  /** Null when the file was deleted. */
  sha256After: Sha256.nullable(),
  planChangeId: z.string().min(1).nullable(),
});

/**
 * A human decision: trust, command approval, plan or test approval or rejection, clarification
 * answer.
 */
export const DecisionAuditEntry = z.strictObject({
  ...base,
  type: z.literal("decision"),
  subject: z.enum(["workspace-trust", "command", "plan", "clarification", "tests", "changes"]),
  decision: z.enum(["approved", "rejected", "revoked", "answered"]),
  by: z.string().min(1),
  reference: z.string().min(1).optional(),
  feedback: z.string().max(20_000).optional(),
});

/** A value redacted from outbound content (a model request, a report, a log). */
export const RedactionAuditEntry = z.strictObject({
  ...base,
  type: z.literal("redaction"),
  context: z.string().min(1),
  detector: z.string().min(1),
  location: z.string().min(1),
});

export const AuditEntry = z.discriminatedUnion("type", [
  LlmCallAuditEntry,
  CommandAuditEntry,
  FileWriteAuditEntry,
  DecisionAuditEntry,
  RedactionAuditEntry,
]);
export type AuditEntry = z.infer<typeof AuditEntry>;
