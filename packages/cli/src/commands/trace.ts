import path from "node:path";
import { isTerminalState } from "@devflow-ai/core";
import {
  RunStore,
  type TraceExportPlan,
  exportRunTrace,
  resolveOtlpEndpoint,
  traceRedactor,
} from "@devflow-ai/workflow";
import { ExitCode } from "../exit-codes.js";
import type { CliIo } from "../io.js";
import { openWorkspace } from "../workspace.js";
import { guarded, writeJson } from "./workflow.js";

/**
 * `devflow trace <run> [--output <file>] [--otlp]`: exports the trace of a run from the run
 * store (ADR 0024). Without options it writes `trace.otlp.json` in the run directory. With
 * `--otlp` it sends it to the endpoint of `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
 * `OTEL_EXPORTER_OTLP_ENDPOINT`. Here, unlike after a run, a failed export fails the command.
 */
export async function traceCommand(
  runId: string,
  options: { output?: string | undefined; otlp: boolean; json: boolean },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    const store = await RunStore.open(workspace.root, runId);
    const record = await store.readRecord();
    const plan: TraceExportPlan = {
      ...(options.output !== undefined
        ? { file: path.resolve(io.cwd, options.output) }
        : options.otlp
          ? {}
          : { file: true as const }),
      ...(options.otlp ? { otlp: resolveOtlpEndpoint(io.env) } : {}),
    };
    const result = await exportRunTrace(store, plan, {
      redactor: traceRedactor(io.env, plan),
      ...(interruption === undefined ? {} : { signal: interruption.signal }),
    });
    const finished = isTerminalState(record.state);
    const code = result.warnings.length === 0 ? ExitCode.Success : ExitCode.Failure;
    if (options.json) {
      writeJson(io, { runId, state: record.state, finished, ...result });
      return code;
    }
    const out: string[] = [];
    if (!finished) {
      out.push(`Run ${runId} is ${record.state}: the trace covers what has run so far.`);
    }
    if (result.file !== undefined)
      out.push(`Wrote ${String(result.spans)} span(s) to ${result.file}`);
    if (result.sent !== undefined) {
      out.push(`Sent ${String(result.spans)} span(s) to ${result.sent.endpoint}`);
    }
    if (out.length > 0) io.stdout.write(`${out.join("\n")}\n`);
    for (const warning of result.warnings) io.stderr.write(`devflow: ${warning}\n`);
    return code;
  });
}
