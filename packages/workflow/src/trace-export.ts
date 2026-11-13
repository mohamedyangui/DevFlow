import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DevflowError,
  ErrorCode,
  SecretRedactor,
  credentialValuesFromEnv,
  isDevflowError,
} from "@devflowai/core";
import {
  type OtlpEndpoint,
  type OtlpSendResult,
  type OtlpTraceRequest,
  type SendOtlpOptions,
  resolveOtlpEndpoint,
  sendOtlpTrace,
  toOtlpRequest,
} from "./otlp.js";
import type { RunStore } from "./run-store.js";
import { readRunTrace } from "./trace.js";

/**
 * Optional trace export of a run (ADR 0024). Off by default. It is turned on only by the
 * person running DevFlow, with `--trace` or `DEVFLOW_TRACE_EXPORT`, never by the repository's
 * configuration: a repository must not be able to make DevFlow send data somewhere.
 */

export type TraceTarget = "file" | "otlp";

/** The trace file in a run directory. */
export const TRACE_FILE = "trace.otlp.json";

/**
 * Parses a `--trace` or `DEVFLOW_TRACE_EXPORT` value: `file`, `otlp`, both separated by a
 * comma, or `off` / `none` / empty for no export.
 *
 * @throws DevflowError `TRACE_EXPORT_REFUSED` for anything else.
 */
export function parseTraceTargets(value: string, source: string): TraceTarget[] {
  const targets = new Set<TraceTarget>();
  for (const part of value.split(",")) {
    const target = part.trim().toLowerCase();
    if (target === "" || target === "off" || target === "none") continue;
    if (target !== "file" && target !== "otlp") {
      throw new DevflowError(
        ErrorCode.TraceExportRefused,
        `${source} must be file, otlp, "file,otlp" or off`,
      );
    }
    targets.add(target);
  }
  return [...targets].sort();
}

/** What to export a run's trace to, resolved before the run starts. */
export interface TraceExportPlan {
  /** Write `trace.otlp.json` in the run directory, or to this absolute path. */
  readonly file?: true | string;
  readonly otlp?: OtlpEndpoint;
}

/**
 * Resolves the trace export of a workflow command from the `--trace` flag (which wins) or the
 * `DEVFLOW_TRACE_EXPORT` variable. Returns undefined when nothing is exported.
 *
 * @throws DevflowError `TRACE_EXPORT_REFUSED` for an unknown target or an OTLP endpoint that is
 * missing or refused; this is checked before the run starts.
 */
export function resolveTraceExport(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): TraceExportPlan | undefined {
  const targets =
    flag !== undefined
      ? parseTraceTargets(flag, "--trace")
      : parseTraceTargets(env.DEVFLOW_TRACE_EXPORT ?? "", "DEVFLOW_TRACE_EXPORT");
  if (targets.length === 0) return undefined;
  return {
    ...(targets.includes("file") ? { file: true as const } : {}),
    ...(targets.includes("otlp") ? { otlp: resolveOtlpEndpoint(env) } : {}),
  };
}

/**
 * The redactor for an export: the credential-like environment values, plus the OTLP header
 * values, so that not even a header token can end up in the exported attributes.
 */
export function traceRedactor(
  env: Readonly<Record<string, string | undefined>>,
  plan?: TraceExportPlan,
): SecretRedactor {
  return new SecretRedactor({
    knownSecrets: [...credentialValuesFromEnv(env), ...Object.values(plan?.otlp?.headers ?? {})],
  });
}

export interface TraceExportResult {
  /** The file written: workspace-relative inside the run directory, else absolute. */
  readonly file?: string;
  readonly sent?: OtlpSendResult;
  readonly spans: number;
  /** What failed. An export failure never changes the run. */
  readonly warnings: readonly string[];
}

/**
 * Builds a run's trace and writes and/or sends it. Never throws for an export problem: each
 * failure is returned as a warning, so a run never fails because of its trace.
 */
export async function exportRunTrace(
  store: RunStore,
  plan: TraceExportPlan,
  options: SendOtlpOptions & { readonly redactor: SecretRedactor },
): Promise<TraceExportResult> {
  let request: OtlpTraceRequest;
  try {
    request = toOtlpRequest(await readRunTrace(store, options.redactor));
  } catch (error) {
    return {
      spans: 0,
      warnings: [`the trace of run ${store.id} could not be built: ${reason(error)}`],
    };
  }
  const spans = request.resourceSpans[0]?.scopeSpans[0]?.spans.length ?? 0;
  const warnings: string[] = [];
  let file: string | undefined;
  if (plan.file !== undefined) {
    const json = `${JSON.stringify(request, null, 2)}\n`;
    try {
      if (plan.file === true) {
        await store.writeText(TRACE_FILE, json);
        file = store.workspacePath(TRACE_FILE);
      } else {
        await mkdir(path.dirname(plan.file), { recursive: true });
        await writeFile(plan.file, json, { encoding: "utf8", mode: 0o600 });
        file = plan.file;
      }
    } catch (error) {
      warnings.push(`the trace file could not be written: ${reason(error)}`);
    }
  }
  let sent: OtlpSendResult | undefined;
  if (plan.otlp !== undefined) {
    try {
      sent = await sendOtlpTrace(request, plan.otlp, options);
      if (sent.rejectedSpans > 0) {
        warnings.push(
          `${sent.endpoint} rejected ${String(sent.rejectedSpans)} of ${String(spans)} span(s)`,
        );
      }
    } catch (error) {
      warnings.push(`the trace was not sent: ${reason(error)}`);
    }
  }
  return {
    ...(file === undefined ? {} : { file }),
    ...(sent === undefined ? {} : { sent }),
    spans,
    warnings,
  };
}

function reason(error: unknown): string {
  if (isDevflowError(error)) return `${error.message} [${error.code}]`;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code ?? (error instanceof Error ? error.name : "error");
}
