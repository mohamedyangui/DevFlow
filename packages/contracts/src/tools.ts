import {
  type ApprovedCommand,
  type CommandRequest,
  CommandSpec,
  type ExecuteOptions,
  type ExecutionRecord,
  type ExecutionResult,
  type PolicyDecision,
  type ToolchainProbe,
  isDevflowError,
} from "@devflow/core";
import { z } from "zod";
import type { ContractChange, ContractCompatibility } from "./schemas.js";

/**
 * Optional external tools (ADR 0021): `oasdiff` for OpenAPI and `buf` for Protobuf. They are
 * used only when the toolchain probe finds them on PATH, and they run like any other command:
 * through the command policy (workspace trust and an approval of the command's fingerprint)
 * and the executor. Their JSON output is mapped to the same {@link ContractChange} shape.
 * When a tool is missing, denied, fails or prints something unexpected, the built-in rules
 * decide instead and the diff says why.
 */

export type ContractTool = "oasdiff" | "buf";

/** What running a tool needs: the probe, the command policy and the executor of the caller. */
export interface ContractToolset {
  readonly toolchain: ToolchainProbe;
  readonly policy: { evaluate(request: CommandRequest): Promise<PolicyDecision> };
  readonly executor: {
    run(command: ApprovedCommand, options: ExecuteOptions): Promise<ExecutionResult>;
  };
  /** Workspace-relative directory for the command logs. */
  readonly logDir: string;
  readonly signal?: AbortSignal;
}

/**
 * Contract file arguments: workspace-relative, forward slashes, no `..` segment, not absolute,
 * no leading dash (the policy refuses those too).
 */
export const CONTRACT_PATH_PATTERN =
  "^(?!.*(?:^|/)\\.\\.(?:/|$))[A-Za-z0-9._@+][A-Za-z0-9._@+/-]{0,511}$";

const parameters = [
  {
    name: "base",
    description: "the base version of the contract file, relative to the workspace",
    pattern: CONTRACT_PATH_PATTERN,
    maxLength: 512,
  },
  {
    name: "head",
    description: "the head version of the contract file, relative to the workspace",
    pattern: CONTRACT_PATH_PATTERN,
    maxLength: 512,
  },
];

/** `oasdiff breaking <base> <head> --format json`, run in the workspace root. */
export const OASDIFF_COMMAND: CommandSpec = CommandSpec.parse({
  id: "contracts:oasdiff-breaking",
  purpose: "static-analysis",
  executable: "oasdiff",
  args: ["breaking", "{base}", "{head}", "--format", "json"],
  cwd: ".",
  env: {},
  timeoutMs: 120_000,
  network: "none",
  parameters,
  results: { parser: "oasdiff-json", reportGlobs: [] },
  origin: "adapter",
});

/** `buf breaking <head> --against <base> --error-format json`, run in the workspace root. */
export const BUF_COMMAND: CommandSpec = CommandSpec.parse({
  id: "contracts:buf-breaking",
  purpose: "static-analysis",
  executable: "buf",
  args: ["breaking", "{head}", "--against", "{base}", "--error-format", "json"],
  cwd: ".",
  env: {},
  timeoutMs: 120_000,
  network: "none",
  parameters,
  results: { parser: "buf-json", reportGlobs: [] },
  origin: "adapter",
});

export type ToolRun =
  | {
      readonly ran: true;
      readonly tool: ContractTool;
      readonly changes: ContractChange[];
      readonly execution: ExecutionRecord;
    }
  | {
      readonly ran: false;
      readonly tool: ContractTool;
      /** Why the tool did not decide: not installed, denied, failed, unreadable output. */
      readonly reason: string;
      /** Set when the command policy refused the command. */
      readonly denial?: { readonly reason: string; readonly fingerprint?: string };
      readonly execution?: ExecutionRecord;
    };

/**
 * Runs `oasdiff` or `buf` on two versions of a contract, when it is installed and the command
 * policy allows it, and maps its findings. Never throws for a tool problem: the result says
 * why the tool did not decide.
 */
export async function runContractTool(
  tool: ContractTool,
  files: { readonly base: string; readonly head: string; readonly file: string },
  toolset: ContractToolset,
): Promise<ToolRun> {
  const availability = await toolset.toolchain.probe(tool);
  if (!availability.available) {
    return { ran: false, tool, reason: `${tool} is not installed (not found on PATH)` };
  }
  const spec = tool === "oasdiff" ? OASDIFF_COMMAND : BUF_COMMAND;
  const decision = await toolset.policy.evaluate({
    spec,
    params: { base: files.base, head: files.head },
  });
  if (!decision.allowed) {
    return {
      ran: false,
      tool,
      reason: `denied by the command policy (${decision.reason}): ${decision.message}`,
      denial: {
        reason: decision.reason,
        ...(decision.fingerprint === undefined ? {} : { fingerprint: decision.fingerprint }),
      },
    };
  }
  let result: ExecutionResult;
  try {
    result = await toolset.executor.run(decision.command, {
      logDir: toolset.logDir,
      ...(toolset.signal === undefined ? {} : { signal: toolset.signal }),
    });
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    return { ran: false, tool, reason: `${tool} could not be started: ${error.message}` };
  }
  const execution = result.record;
  const failed = (reason: string): ToolRun => ({ ran: false, tool, reason, execution });
  if (execution.timedOut) return failed(`${tool} did not finish in time`);
  if (execution.outputTruncated) return failed(`the output of ${tool} was too long to read`);
  const parsed =
    tool === "oasdiff"
      ? oasdiffResult(execution.exitCode, result.stdout, result.stderr, files.file)
      : bufResult(execution.exitCode, result.stdout, result.stderr, files.file);
  if (typeof parsed === "string") return failed(parsed);
  return { ran: true, tool, changes: parsed, execution };
}

// ---- oasdiff ----------------------------------------------------------------------------------

/** One entry of `oasdiff breaking --format json` (fields this mapping does not use are kept out). */
export const OasdiffEntry = z.looseObject({
  id: z.string().min(1),
  text: z.string().optional(),
  /** 3 (or "error"): breaking; 2 ("warning"): potentially breaking; 1 ("info"). */
  level: z.union([z.number(), z.string()]),
  operation: z.string().optional(),
  operationId: z.string().optional(),
  path: z.string().optional(),
  source: z.string().optional(),
});
export type OasdiffEntry = z.infer<typeof OasdiffEntry>;

function oasdiffLevel(level: number | string): ContractCompatibility {
  const text = String(level).toLowerCase();
  if (text === "3" || text === "err" || text === "error") return "breaking";
  if (text === "1" || text === "info") return "non-breaking";
  return "unknown";
}

/** Maps the JSON output of `oasdiff breaking` to changes, or says why it cannot. */
export function parseOasdiffOutput(stdout: string, file: string): ContractChange[] | string {
  const text = stdout.trim();
  if (text === "" || text === "null") return [];
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "the output of oasdiff is not JSON";
  }
  const entries = z.array(OasdiffEntry).safeParse(value);
  if (!entries.success) return "the output of oasdiff does not have the expected shape";
  return entries.data.map((entry): ContractChange => {
    const method = entry.operation?.toLowerCase();
    const where = [entry.operation?.toUpperCase(), entry.path].filter((part) => part !== undefined);
    const description = entry.text?.trim() ?? entry.id;
    return {
      kind: "openapi",
      rule: entry.id,
      compatibility: oasdiffLevel(entry.level),
      decidedBy: "tool:oasdiff",
      location: {
        file,
        ...(entry.path === undefined || entry.path === "" ? {} : { path: entry.path }),
        ...(method === undefined || method === "" ? {} : { method }),
      },
      message: `${where.length > 0 ? `${where.join(" ")}: ` : ""}${description === "" ? entry.id : description}`,
    };
  });
}

function oasdiffResult(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  file: string,
): ContractChange[] | string {
  // Without --fail-on, oasdiff exits 0 whatever it finds; anything else is a failure.
  if (exitCode !== 0) {
    return `oasdiff exited with ${String(exitCode ?? "no exit code")}${firstLine(stderr)}`;
  }
  return parseOasdiffOutput(stdout, file);
}

// ---- buf --------------------------------------------------------------------------------------

/** One line of `buf breaking --error-format json`. */
export const BufAnnotation = z.looseObject({
  path: z.string().optional(),
  start_line: z.int().nonnegative().optional(),
  start_column: z.int().nonnegative().optional(),
  type: z.string().min(1),
  message: z.string().min(1),
});
export type BufAnnotation = z.infer<typeof BufAnnotation>;

/** buf's exit code when it found file annotations (breaking changes). */
export const BUF_ANNOTATIONS_EXIT_CODE = 100;

/** Maps the JSON lines of `buf breaking` to changes, or says why it cannot. */
export function parseBufOutput(stdout: string, file: string): ContractChange[] | string {
  const changes: ContractChange[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return "the output of buf is not JSON lines";
    }
    const annotation = BufAnnotation.safeParse(value);
    if (!annotation.success) return "the output of buf does not have the expected shape";
    const { type, message, start_line: lineNumber } = annotation.data;
    changes.push({
      kind: "protobuf",
      rule: type,
      // Every rule of `buf breaking` reports a breaking change.
      compatibility: "breaking",
      decidedBy: "tool:buf",
      location: {
        file,
        ...(lineNumber === undefined || lineNumber === 0 ? {} : { line: lineNumber }),
      },
      message,
    });
  }
  return changes;
}

function bufResult(
  exitCode: number | null,
  stdout: string,
  stderr: string,
  file: string,
): ContractChange[] | string {
  if (exitCode === 0) return [];
  if (exitCode !== BUF_ANNOTATIONS_EXIT_CODE) {
    return `buf exited with ${String(exitCode ?? "no exit code")}${firstLine(stderr)}`;
  }
  const changes = parseBufOutput(stdout, file);
  if (typeof changes !== "string" && changes.length === 0) {
    return "buf reported breaking changes but printed none";
  }
  return changes;
}

function firstLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line === undefined ? "" : `: ${line.slice(0, 300)}`;
}
