import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { type AuditEntry, type SecretRedactor, readAuditLog } from "@devflow-ai/core";
import { z } from "zod";
import type { RunStore } from "./run-store.js";
import type { RunEvent, RunRecord } from "./schemas.js";

/**
 * The trace of a run (ADR 0024): one root span for the run, a child span per workflow step,
 * and under the step that was running, a span per model call and per command.
 *
 * The trace is built after the fact from what the run store already records (`run.json`,
 * `events.jsonl`, `audit.jsonl` and the gate artifacts), so a finished run can be exported at
 * any time and the export never changes how a run behaves.
 *
 * It holds metadata only. Attributes are added one by one from a fixed list below; nothing
 * copies a whole record. There is never a prompt, a model answer, a file content, a command
 * argument (beyond the executable's name), a command output or an error message: errors are
 * reported by their code. Every string goes through the redactor.
 *
 * Ids are deterministic: the trace id is derived from the run id, and each span id from the
 * run id and the record the span comes from, so exporting the same run twice gives the same
 * ids (a collector can deduplicate them).
 */

export type TraceAttributeValue = string | number | boolean;

export interface TraceSpan {
  /** 16 hexadecimal characters. */
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: "internal" | "client";
  /** Milliseconds since the Unix epoch. */
  readonly startMs: number;
  readonly endMs: number;
  readonly attributes: Readonly<Record<string, TraceAttributeValue>>;
  readonly status: { readonly code: "unset" | "ok" | "error"; readonly message?: string };
}

export interface RunTrace {
  /** 32 hexadecimal characters. */
  readonly traceId: string;
  /** Resource attributes (`service.name`, `service.version`). */
  readonly resource: Readonly<Record<string, TraceAttributeValue>>;
  readonly spans: readonly TraceSpan[];
}

/** What a trace is built from: the records a run directory keeps. */
export interface RunTraceInput {
  readonly record: RunRecord;
  readonly events: readonly RunEvent[];
  readonly audit: readonly AuditEntry[];
  /** Gate ids by command id, from the run's gate artifacts. */
  readonly gates: ReadonlyMap<string, readonly string[]>;
}

/** The instrumentation scope name of DevFlow's spans. */
export const TRACE_SCOPE = "devflow";

/** Builds the trace of a run. Pure: the same input gives the same trace. */
export function buildRunTrace(input: RunTraceInput, redactor: SecretRedactor): RunTrace {
  const { record } = input;
  const runId = record.id;
  const text = (value: string): string => redactor.redactText(value);
  const spanId = (key: string): string => hex(`${runId}\u0000${key}`, 16);
  const rootId = spanId("run");

  const times = [
    ...input.events.map((event) => Date.parse(event.at)),
    ...input.audit.map((entry) => Date.parse(entry.at)),
    Date.parse(record.updatedAt),
  ].filter((value) => Number.isFinite(value));
  const runStart = Date.parse(record.createdAt);
  const runEnd =
    record.finishedAt === null ? Math.max(runStart, ...times) : Date.parse(record.finishedAt);

  // Steps: a step-started event opens a span; step-completed (same step) or step-failed (the
  // step that was running) closes it. A step still open at the end is "incomplete".
  const steps: (TraceSpan & { readonly step: string })[] = [];
  const open: { step: string; startMs: number; seq: number }[] = [];
  const close = (
    index: number,
    endMs: number,
    outcome: "completed" | "failed" | "incomplete",
    errorCode?: string,
  ): void => {
    const [entry] = open.splice(index, 1);
    if (entry === undefined) return;
    steps.push({
      step: entry.step,
      spanId: spanId(`step:${String(entry.seq)}`),
      parentSpanId: rootId,
      name: text(`step ${entry.step}`),
      kind: "internal",
      startMs: entry.startMs,
      endMs: Math.max(entry.startMs, endMs),
      attributes: {
        "devflow.step.name": text(entry.step),
        "devflow.step.outcome": outcome,
        ...(errorCode === undefined ? {} : { "error.type": text(errorCode) }),
      },
      status:
        outcome === "completed"
          ? { code: "ok" }
          : outcome === "failed"
            ? { code: "error", ...(errorCode === undefined ? {} : { message: text(errorCode) }) }
            : { code: "unset" },
    });
  };
  for (const event of input.events) {
    const at = Date.parse(event.at);
    if (event.type === "step-started" && event.step !== undefined) {
      open.push({ step: event.step, startMs: at, seq: event.seq });
    } else if (event.type === "step-completed" && event.step !== undefined) {
      const index = open.map((entry) => entry.step).lastIndexOf(event.step);
      if (index !== -1) close(index, at, "completed");
    } else if (event.type === "step-failed" && open.length > 0) {
      close(open.length - 1, at, "failed", errorCodeOf(event.detail));
    }
  }
  while (open.length > 0) close(open.length - 1, runEnd, "incomplete");
  steps.sort((a, b) => a.startMs - b.startMs);

  const parentOf = (startMs: number, step?: string): string => {
    const containing = steps.filter((span) => span.startMs <= startMs && startMs <= span.endMs);
    const named = step === undefined ? [] : containing.filter((span) => span.step === step);
    const chosen = (named.length > 0 ? named : containing).at(-1);
    return chosen?.spanId ?? rootId;
  };

  const children: TraceSpan[] = [];
  for (const entry of input.audit) {
    if (entry.type === "llm-call") {
      children.push(modelCallSpan(entry, spanId(`audit:${String(entry.seq)}`), parentOf, text));
    } else if (entry.type === "command") {
      children.push(
        commandSpan(entry, spanId(`audit:${String(entry.seq)}`), parentOf, text, input.gates),
      );
    }
  }

  const usage = record.budgetUsage;
  const state = record.state;
  const root: TraceSpan = {
    spanId: rootId,
    name: text(`devflow ${record.mode}`),
    kind: "internal",
    startMs: runStart,
    endMs: Math.max(runStart, runEnd),
    attributes: {
      "devflow.run.id": text(runId),
      "devflow.run.mode": record.mode,
      "devflow.run.goal": record.goal,
      "devflow.run.state": state,
      "devflow.task.id": text(record.task.id),
      "devflow.workspace.trusted": record.settings.workspaceTrusted,
      "gen_ai.provider.name": text(record.settings.provider),
      "devflow.gen_ai.calls": usage.calls,
      "gen_ai.usage.input_tokens": usage.inputTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      ...(usage.costUsd === undefined ? {} : { "devflow.gen_ai.cost.usd": usage.costUsd }),
      ...(usage.unpricedCalls === undefined
        ? {}
        : { "devflow.gen_ai.unpriced_calls": usage.unpricedCalls }),
      ...(record.lastError === null ? {} : { "error.type": text(record.lastError.code) }),
    },
    status:
      state === "COMPLETED"
        ? { code: "ok" }
        : state === "FAILED"
          ? {
              code: "error",
              ...(record.lastError === null ? {} : { message: text(record.lastError.code) }),
            }
          : { code: "unset" },
  };

  return {
    traceId: hex(`devflow-trace\u0000${runId}`, 32),
    resource: {
      "service.name": "devflow",
      "service.version": text(record.devflowVersion),
    },
    spans: [root, ...steps.map(({ step: _step, ...span }) => span), ...children],
  };
}

function modelCallSpan(
  entry: Extract<AuditEntry, { type: "llm-call" }>,
  spanId: string,
  parentOf: (startMs: number, step?: string) => string,
  text: (value: string) => string,
): TraceSpan {
  const endMs = Date.parse(entry.at);
  const startMs = endMs - (entry.durationMs ?? 0);
  const model = text(entry.model);
  return {
    spanId,
    parentSpanId: parentOf(startMs, entry.step),
    name: `chat ${model}`,
    kind: "client",
    startMs,
    endMs,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": text(entry.provider),
      // The audit keeps the model that answered, or the requested one when there is no answer.
      [entry.outcome === "error" ? "gen_ai.request.model" : "gen_ai.response.model"]: model,
      "gen_ai.usage.input_tokens": entry.inputTokens,
      "gen_ai.usage.output_tokens": entry.outputTokens,
      ...(entry.costUsd === null ? {} : { "devflow.gen_ai.cost.usd": entry.costUsd }),
      "devflow.gen_ai.outcome": entry.outcome,
      ...(entry.attempts === undefined
        ? {}
        : {
            "devflow.gen_ai.attempts": entry.attempts,
            "devflow.gen_ai.retries": entry.attempts - 1,
          }),
      ...(entry.step === undefined ? {} : { "devflow.step.name": text(entry.step) }),
      "devflow.prompt.template.id": text(entry.templateId),
      "devflow.prompt.template.version": text(entry.templateVersion),
      "devflow.prompt.files.count": entry.files.length,
      ...(entry.outcome === "ok" ? {} : { "error.type": entry.outcome }),
    },
    status: entry.outcome === "ok" ? { code: "ok" } : { code: "error", message: entry.outcome },
  };
}

function commandSpan(
  entry: Extract<AuditEntry, { type: "command" }>,
  spanId: string,
  parentOf: (startMs: number, step?: string) => string,
  text: (value: string) => string,
  gates: ReadonlyMap<string, readonly string[]>,
): TraceSpan {
  const endMs = Date.parse(entry.at);
  const startMs = endMs - (entry.durationMs ?? 0);
  const gateIds = gates.get(entry.commandId) ?? [];
  const purpose =
    gateIds.length > 0
      ? "gate"
      : entry.commandId.startsWith("contracts:")
        ? "contract-tool"
        : "command";
  const status = commandStatus(entry);
  const commandId = text(entry.commandId);
  return {
    spanId,
    parentSpanId: parentOf(startMs),
    name: `${purpose} ${commandId}`,
    kind: "internal",
    startMs,
    endMs,
    attributes: {
      "devflow.command.id": commandId,
      "devflow.command.purpose": purpose,
      ...(gateIds.length === 0 ? {} : { "devflow.gate.id": text(gateIds.join(",")) }),
      "process.executable.name": text(executableName(entry.argv[0] ?? "")),
      "devflow.command.decision": entry.decision,
      "devflow.command.status": status,
      ...(entry.exitCode === undefined || entry.exitCode === null
        ? {}
        : { "process.exit.code": entry.exitCode }),
      ...(entry.durationMs === undefined
        ? {}
        : { "devflow.command.duration_ms": entry.durationMs }),
      ...(entry.timedOut === undefined ? {} : { "devflow.command.timed_out": entry.timedOut }),
      ...(entry.backend === undefined ? {} : { "devflow.command.backend": entry.backend }),
      ...(entry.invocation === undefined ? {} : { "devflow.command.invocation": entry.invocation }),
      ...(entry.approval === undefined ? {} : { "devflow.command.approval": entry.approval }),
      ...(status === "denied" && entry.reason !== undefined
        ? { "devflow.command.denial": text(denialReason(entry.reason)) }
        : {}),
      ...(status === "ok" ? {} : { "error.type": status }),
    },
    status: status === "ok" ? { code: "ok" } : { code: "error", message: status },
  };
}

function commandStatus(
  entry: Extract<AuditEntry, { type: "command" }>,
): "ok" | "failed" | "timed-out" | "denied" | "cancelled" {
  if (entry.decision === "denied") return "denied";
  if (entry.reason === "cancelled") return "cancelled";
  if (entry.timedOut === true) return "timed-out";
  return entry.exitCode === 0 ? "ok" : "failed";
}

/** The executable's file name, without its directory: `/usr/bin/node` gives `node`. */
export function executableName(executable: string): string {
  return executable.split(/[\\/]/).at(-1) ?? "";
}

/** The reason code of a denial (`approval-required: ...` gives `approval-required`). */
function denialReason(reason: string): string {
  const code = reason.split(":", 1)[0]?.trim() ?? "";
  return /^[a-z][a-z0-9-]{0,63}$/.test(code) ? code : "denied";
}

/** The error code of a step-failed event's detail (`CODE: message`), never the message. */
function errorCodeOf(detail: string | undefined): string | undefined {
  const code = detail?.split(":", 1)[0]?.trim();
  return code !== undefined && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

function hex(value: string, length: number): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, length);
}

/** The part of a gate artifact the trace reads. */
const GateArtifact = z.object({
  gates: z.array(z.object({ gateId: z.string().min(1), commandId: z.string().min(1) })),
});

const GATE_ARTIFACT = /^(?:baseline|after|review-gates|verification-\d+)\.json$/;

/** Reads a run's records and builds its trace. */
export async function readRunTrace(store: RunStore, redactor: SecretRedactor): Promise<RunTrace> {
  const record = await store.readRecord();
  const events = await store.readEvents();
  const audit = (await store.exists("audit.jsonl"))
    ? await readAuditLog(store.path("audit.jsonl"))
    : [];
  const gates = new Map<string, string[]>();
  let names: string[] = [];
  try {
    names = await readdir(store.path("artifacts"));
  } catch {
    // A run without artifacts ran no gate.
  }
  for (const name of names.filter((file) => GATE_ARTIFACT.test(file)).sort()) {
    const artifact = await store.readJson(`artifacts/${name}`, GateArtifact);
    for (const gate of artifact.gates) {
      const ids = gates.get(gate.commandId) ?? [];
      if (!ids.includes(gate.gateId)) ids.push(gate.gateId);
      gates.set(gate.commandId, ids);
    }
  }
  return buildRunTrace({ record, events, audit, gates }, redactor);
}
