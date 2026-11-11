import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { guidanceFor } from "./next-steps.js";
import { type McpTool, type ToolContext, type ToolResult, defineTool } from "./tool.js";

/** What running a DevFlow command line in-process returns. */
export interface CommandResult {
  readonly exitCode: number;
  /** The command's stdout: its `--json` outcome. */
  readonly stdout: string;
  /** The command's stderr: usage errors and diagnostics. */
  readonly stderr: string;
}

/**
 * Runs `devflow <args>` in `cwd` without a terminal: no prompt, so nothing can be approved
 * interactively, and the signal stops the command when the client cancels the call.
 */
export type CommandRunner = (
  args: readonly string[],
  options: { readonly cwd: string; readonly signal: AbortSignal },
) => Promise<CommandResult>;

export interface DevflowToolsOptions {
  readonly run: CommandRunner;
  /** The workspace used when a call gives none: the server's working directory. */
  readonly defaultWorkspace: string;
}

/**
 * The tools a coding agent may call. Deliberately absent: `trust`, `approve`, `reject`,
 * `resume`, `cancel`, `pr create`, `--publish`, `--allow`, `--run-fork-code` and every
 * interactive approval. Those decisions stay with the developer, in a terminal (ADR 0026).
 */
export const DEVFLOW_TOOL_NAMES = [
  "devflow_task_validate",
  "devflow_analyze",
  "devflow_plan",
  "devflow_answer",
  "devflow_status",
  "devflow_report",
  "devflow_verify",
  "devflow_review",
  "devflow_contracts_diff",
] as const;

const argument = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !value.includes("\0"), "must not contain NUL characters");

const workspace = argument
  .refine((value) => path.isAbsolute(value), "must be an absolute path")
  .optional()
  .describe(
    "Absolute path of the workspace (the repository root). Default: the directory the MCP server was started in.",
  );

const runId = argument.describe(
  "Run id, as returned by devflow_plan, devflow_analyze or devflow_status.",
);

const modelFields = {
  provider: argument
    .optional()
    .describe(
      "Model provider: anthropic, or replay with cassette. Default: ai.provider of a trusted configuration.",
    ),
  model: argument
    .optional()
    .describe(
      "Model id for every step. Default: ai.models of a trusted configuration, or DEVFLOW_MODEL.",
    ),
  cassette: argument
    .optional()
    .describe("Recorded responses for the replay provider (a file path)."),
  maxInputTokens: z.number().int().positive().optional().describe("Input token budget of the run."),
  maxOutputTokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Output token budget of the run."),
  maxCallsPerStep: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Model call budget of each step."),
};

const taskFields = {
  task: argument
    .optional()
    .describe("Task file (YAML, JSON or Markdown), relative to the workspace."),
  issue: argument
    .optional()
    .describe(
      "GitHub issue as the task: a number, owner/name#number or its URL (read with GITHUB_TOKEN).",
    ),
  repo: argument
    .optional()
    .describe("GitHub repository owner/name of issue (default: the origin remote)."),
};

const backend = z
  .enum(["local", "container"])
  .optional()
  .describe("Where gate commands run: local, or container (Docker, no network).");

function exactlyOneTaskSource(value: {
  task?: string | undefined;
  issue?: string | undefined;
}): boolean {
  return (value.task === undefined) !== (value.issue === undefined);
}

const ANALYZE_INPUT = z
  .strictObject({ workspace, ...taskFields, ...modelFields })
  .refine(exactlyOneTaskSource, "give exactly one of task or issue");

const ANSWER_INPUT = z.strictObject({
  workspace,
  run: runId,
  answers: z
    .record(
      z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, "must be a question id such as Q-1"),
      z.string().min(1).max(20_000),
    )
    .refine((answers) => Object.keys(answers).length > 0, "give at least one answer")
    .describe('The developer\'s answers by question id, for example {"Q-1": "Pages start at 1"}.'),
  ...modelFields,
});

const REVIEW_INPUT = z
  .strictObject({
    workspace,
    ...taskFields,
    base: argument
      .optional()
      .describe(
        "Compare the working tree with the merge base of this branch or commit and HEAD (default: HEAD).",
      ),
    pr: argument
      .optional()
      .describe(
        "Review a pull request whose head is checked out: a number, owner/name#number or its URL.",
      ),
    backend,
    ...modelFields,
  })
  .refine(exactlyOneTaskSource, "give exactly one of task or issue")
  .refine(
    (value) => value.base === undefined || value.pr === undefined,
    "give base or pr, not both",
  );

const APPROVAL_NOTE =
  "Approvals stay with the developer: this tool never approves anything, and the developer approves in a terminal.";

/** The DevFlow tools, each running the matching CLI command with `--json`. */
export function devflowTools(options: DevflowToolsOptions): McpTool[] {
  const execute = async (
    tool: string,
    workspaceArg: string | undefined,
    args: readonly string[],
    context: ToolContext,
  ): Promise<ToolResult> => {
    const cwd = workspaceArg ?? options.defaultWorkspace;
    if (!(await isDirectory(cwd))) {
      return failure(`The workspace ${cwd} is not an existing directory.`, "WORKSPACE_NOT_FOUND");
    }
    const result = await options.run(args, { cwd, signal: context.signal });
    return toolResult(tool, cwd, result);
  };

  return [
    defineTool({
      name: "devflow_task_validate",
      title: "Validate a DevFlow task file",
      description:
        "Validates a task file (YAML, JSON or Markdown) and returns its problems and the normalized task. " +
        "Read-only. Runs `devflow task validate <path> --json`.",
      input: z.strictObject({
        workspace,
        path: argument.describe("Task file, relative to the workspace or absolute."),
        strict: z.boolean().optional().describe("Treat warnings as errors."),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      call: (args, context) =>
        execute(
          "devflow_task_validate",
          args.workspace,
          [
            "task",
            "validate",
            "--json",
            ...(args.strict === true ? ["--strict"] : []),
            "--",
            args.path,
          ],
          context,
        ),
    }),
    defineTool({
      name: "devflow_analyze",
      title: "Analyse a task (assist mode)",
      description:
        "Starts an assist-mode run that analyses a task's requirements against the repository with a model. " +
        "Writes only the run directory under .devflow/runs; changes no file and runs no command. " +
        "When it returns blocking questions, ask the developer and relay their answers with devflow_answer. " +
        "Runs `devflow analyze --json`.",
      input: ANALYZE_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, context) =>
        execute(
          "devflow_analyze",
          args.workspace,
          ["analyze", "--json", ...taskArgs(args), ...modelArgs(args)],
          context,
        ),
    }),
    defineTool({
      name: "devflow_plan",
      title: "Analyse a task and write a plan (assist mode)",
      description:
        "Starts an assist-mode run that analyses a task and writes an implementation plan for review. " +
        "Writes only the run directory; changes no file and runs no command. " +
        "The run then waits for plan approval: the plan must be reviewed and approved by the developer in a terminal " +
        "(devflow approve <run>, or devflow reject <run> --feedback ...). " +
        APPROVAL_NOTE +
        " Runs `devflow plan --json`.",
      input: ANALYZE_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, context) =>
        execute(
          "devflow_plan",
          args.workspace,
          ["plan", "--json", ...taskArgs(args), ...modelArgs(args)],
          context,
        ),
    }),
    defineTool({
      name: "devflow_answer",
      title: "Relay the developer's answers to clarification questions",
      description:
        "Records answers to the blocking clarification questions of a run, then the analysis continues. " +
        "Only relay answers the developer gave you: never invent them. The answers are recorded as given by the developer via MCP. " +
        "A plan written afterwards still needs the developer's approval in a terminal (devflow approve <run>). " +
        "Runs `devflow answer <run> --answer <id>=<text> --json`.",
      input: ANSWER_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, context) =>
        execute(
          "devflow_answer",
          args.workspace,
          [
            "answer",
            "--json",
            ...Object.entries(args.answers).map(([id, answer]) => `--answer=${id}=${answer}`),
            ...modelArgs(args),
            "--",
            args.run,
          ],
          context,
        ),
    }),
    defineTool({
      name: "devflow_status",
      title: "Show DevFlow runs",
      description:
        "Lists the runs of the workspace, or shows one run: its state, what it waits for and the developer's next step. " +
        "Read-only. Runs `devflow status [run] --json`.",
      input: z.strictObject({ workspace, run: runId.optional() }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      call: (args, context) =>
        execute(
          "devflow_status",
          args.workspace,
          ["status", "--json", ...(args.run === undefined ? [] : ["--", args.run])],
          context,
        ),
    }),
    defineTool({
      name: "devflow_report",
      title: "Read the report of a finished run",
      description:
        "Returns report.json of a finished run (completed, failed or cancelled): the verdict and the evidence. " +
        "Read-only; never publishes. Runs `devflow report <run> --json`.",
      input: z.strictObject({ workspace, run: runId }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      call: (args, context) =>
        execute("devflow_report", args.workspace, ["report", "--json", "--", args.run], context),
    }),
    defineTool({
      name: "devflow_verify",
      title: "Run the verification gates",
      description:
        "Runs the workspace's verification gates (tests, lint, type checks) through the command policy and saves verification.json. " +
        "Only commands the developer already approved run: the workspace must be trusted (devflow trust) and each command approved " +
        '"always" or with --allow in a terminal. Commands not yet approved are returned as denials with their fingerprints, never approved by this tool. ' +
        "Runs `devflow verify --json`.",
      input: z.strictObject({
        workspace,
        gates: z.array(argument).max(50).optional().describe("Run only these gate ids."),
        baseline: argument
          .optional()
          .describe("Compare with the verification.json of an earlier run."),
        backend,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, context) =>
        execute(
          "devflow_verify",
          args.workspace,
          [
            "verify",
            "--json",
            ...(args.gates ?? []).map((gate) => `--gate=${gate}`),
            ...(args.baseline === undefined ? [] : [`--baseline=${args.baseline}`]),
            ...(args.backend === undefined ? [] : [`--backend=${args.backend}`]),
          ],
          context,
        ),
    }),
    defineTool({
      name: "devflow_review",
      title: "Review the local change (review mode)",
      description:
        "Reviews the working tree against a base (or a checked-out pull request) for a task: gates, deterministic checks and an AI review. " +
        "Changes no file. Gates run only for commands the developer already approved; others are reported as needing approval. " +
        "Never publishes, never runs code of a fork. Runs `devflow review --json`.",
      input: REVIEW_INPUT,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      call: (args, context) =>
        execute(
          "devflow_review",
          args.workspace,
          [
            "review",
            "--json",
            ...taskArgs(args),
            ...(args.base === undefined ? [] : [`--base=${args.base}`]),
            ...(args.pr === undefined ? [] : [`--pr=${args.pr}`]),
            ...(args.backend === undefined ? [] : [`--backend=${args.backend}`]),
            ...modelArgs(args),
          ],
          context,
        ),
    }),
    defineTool({
      name: "devflow_contracts_diff",
      title: "Compare OpenAPI or Protobuf contracts",
      description:
        "Compares two versions of an OpenAPI or Protobuf contract with the built-in rules and reports breaking changes. " +
        "Give two files (base, head), or base with the working-tree files to compare with their version at the merge base. " +
        "Read-only; runs no external tool. Runs `devflow contracts diff --json`.",
      input: z.strictObject({
        workspace,
        files: z
          .array(argument)
          .min(1)
          .max(50)
          .describe("<base-file> <head-file>, or with base the files to compare."),
        base: argument
          .optional()
          .describe("Compare the files with their version at the merge base of this ref and HEAD."),
        kind: z
          .enum(["openapi", "protobuf"])
          .optional()
          .describe("The contract kind, when the file name does not tell."),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      call: (args, context) =>
        execute(
          "devflow_contracts_diff",
          args.workspace,
          [
            "contracts",
            "diff",
            "--json",
            ...(args.base === undefined ? [] : [`--base=${args.base}`]),
            ...(args.kind === undefined ? [] : [`--kind=${args.kind}`]),
            "--",
            ...args.files,
          ],
          context,
        ),
    }),
  ];
}

// Option values are passed as `--name=value`, and positional arguments after `--`, so that no
// value given by the client can be read as another option (`--publish`, `--allow`, ...).

function taskArgs(args: {
  task?: string | undefined;
  issue?: string | undefined;
  repo?: string | undefined;
}): string[] {
  return [
    ...(args.task === undefined ? [] : [`--task=${args.task}`]),
    ...(args.issue === undefined ? [] : [`--issue=${args.issue}`]),
    ...(args.repo === undefined ? [] : [`--repo=${args.repo}`]),
  ];
}

function modelArgs(args: {
  provider?: string | undefined;
  model?: string | undefined;
  cassette?: string | undefined;
  maxInputTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  maxCallsPerStep?: number | undefined;
}): string[] {
  return [
    ...(args.provider === undefined ? [] : [`--provider=${args.provider}`]),
    ...(args.model === undefined ? [] : [`--model=${args.model}`]),
    ...(args.cassette === undefined ? [] : [`--cassette=${args.cassette}`]),
    ...(args.maxInputTokens === undefined
      ? []
      : [`--max-input-tokens=${String(args.maxInputTokens)}`]),
    ...(args.maxOutputTokens === undefined
      ? []
      : [`--max-output-tokens=${String(args.maxOutputTokens)}`]),
    ...(args.maxCallsPerStep === undefined
      ? []
      : [`--max-calls-per-step=${String(args.maxCallsPerStep)}`]),
  ];
}

async function isDirectory(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

/** Exit codes that mean DevFlow could not do what was asked (usage error, internal error). */
const ERROR_EXIT_CODES = new Set([2, 70]);

function toolResult(tool: string, workspaceRoot: string, result: CommandResult): ToolResult {
  let outcome: unknown;
  try {
    outcome = JSON.parse(result.stdout);
  } catch {
    outcome = undefined;
  }
  if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
    const message = (result.stderr.trim() || result.stdout.trim() || "no output").slice(0, 4000);
    return failure(
      `DevFlow did not return a result (exit code ${String(result.exitCode)}): ${message}`,
      "NO_RESULT",
      {
        exitCode: result.exitCode,
      },
    );
  }
  const json = outcome as Record<string, unknown>;
  const guidance = guidanceFor(tool, json);
  const structured = {
    workspace: workspaceRoot,
    exitCode: result.exitCode,
    summary: guidance.summary,
    nextSteps: guidance.nextSteps,
    result: json,
  };
  const isError =
    ERROR_EXIT_CODES.has(result.exitCode) ||
    (typeof json.error === "object" && json.status === undefined);
  return { text: render(guidance.summary, guidance.nextSteps, structured), structured, isError };
}

function failure(message: string, code: string, extra: Record<string, unknown> = {}): ToolResult {
  const structured = {
    ...extra,
    summary: message,
    nextSteps: [],
    result: { error: { code, message } },
  };
  return { text: render(message, [], structured), structured, isError: true };
}

function render(summary: string, nextSteps: readonly string[], structured: unknown): string {
  return [
    summary,
    ...(nextSteps.length === 0
      ? []
      : [
          "",
          "Next steps:",
          ...nextSteps.map((step) => (step.startsWith("  ") ? step : `- ${step}`)),
        ]),
    "",
    "Result (JSON):",
    JSON.stringify(structured, null, 2),
  ].join("\n");
}
