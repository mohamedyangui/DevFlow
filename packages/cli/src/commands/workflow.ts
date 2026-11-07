import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DevflowError,
  ErrorCode,
  type WorkflowMode,
  formatIssuePath,
  isDevflowError,
  loadTaskFile,
} from "@devflow/core";
import {
  type ProgressEvent,
  type RunBudgets,
  type RunOutcome,
  type RunRecord,
  RunStore,
  STEP,
  answerQuestions,
  approvePlan,
  cancelRun,
  getRun,
  listRuns,
  rejectPlan,
  resolveRunSettings,
  resumeRun,
  startRun,
} from "@devflow/workflow";
import { parse as parseYaml } from "yaml";
import { ExitCode } from "../exit-codes.js";
import { type CliIo, type Colors, type Interruption, colorsFor } from "../io.js";
import {
  type ServiceOptions,
  type Workspace,
  currentUser,
  openWorkspace,
  workflowServices,
} from "../workspace.js";

/** Options shared by the commands that call a model. */
export interface ModelOptions {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly cassette?: string | undefined;
  readonly maxInputTokens?: number | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly maxCallsPerStep?: number | undefined;
  readonly json: boolean;
}

export interface StartOptions extends ModelOptions {
  readonly task: string;
  readonly mode: WorkflowMode;
}

const STEP_MESSAGES: Readonly<Record<string, string>> = {
  [STEP.context]: "Loading the repository context...",
  [STEP.analysis]: "Analysing the requirements...",
  [STEP.planning]: "Planning the implementation...",
};

/** `devflow analyze` and `devflow plan`: start a run in assist mode. */
export async function startCommand(
  goal: "analyze" | "plan",
  options: StartOptions,
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    const loaded = await loadTaskFile(options.task, { cwd: io.cwd });
    if (!loaded.valid || loaded.contract === undefined) {
      const errors = loaded.issues.filter((issue) => issue.severity === "error");
      const first = errors[0];
      throw new DevflowError(
        ErrorCode.TaskInvalid,
        `${options.task} is not a valid task (${String(errors.length)} error(s)` +
          `${first === undefined ? "" : `, first: ${formatIssuePath(first.path) || "(task)"}: ${first.message}`}); ` +
          `run \`devflow task validate ${options.task}\` for details`,
        { details: { file: options.task } },
      );
    }
    const { settings, warnings } = settingsFor(workspace, options, io);
    const allWarnings = [...workspace.warnings, ...warnings];
    if (!options.json) printWarnings(io, allWarnings);
    const services = workflowServices(workspace, io, serviceOptions(io, options, interruption));
    // A provider that cannot be created (unknown name, no API key, no cassette) is a usage
    // error: it is reported before a run is created.
    await services.provider(settings.provider);
    const outcome = await startRun(
      {
        task: loaded.contract,
        taskFile: displayPath(workspace, loaded.path),
        mode: options.mode,
        goal,
        settings,
        warnings: allWarnings,
      },
      services,
    );
    return report(io, options.json, outcome);
  });
}

function settingsFor(workspace: Workspace, options: StartOptions, io: CliIo) {
  try {
    return resolveRunSettings({
      config: workspace.config,
      configExists: workspace.configExists,
      configSha256: workspace.configSha256,
      trusted: workspace.trusted,
      env: io.env,
      overrides: {
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.model === undefined ? {} : { model: options.model }),
        budgets: budgetOverrides(options),
      },
    });
  } catch (error) {
    if (
      isDevflowError(error) &&
      error.code === ErrorCode.LlmProviderNotConfigured &&
      workspace.configExists &&
      !workspace.trusted
    ) {
      throw new DevflowError(
        error.code,
        `${error.message} (the ai settings of .devflow/config.yaml are ignored until the ` +
          "workspace is trusted: run `devflow trust`)",
        { details: { ...error.details }, cause: error },
      );
    }
    throw error;
  }
}

/** `devflow approve <run>` */
export async function approveCommand(
  runId: string,
  options: { planSha?: string | undefined; json: boolean },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    const outcome = await approvePlan(
      runId,
      {
        by: currentUser(io.env),
        ...(options.planSha === undefined ? {} : { planSha256: options.planSha.toLowerCase() }),
      },
      workflowServices(workspace, io, { interruption }),
    );
    return report(io, options.json, outcome);
  });
}

/** `devflow reject <run> --feedback <text>` */
export async function rejectCommand(
  runId: string,
  options: ModelOptions & { feedback?: string | undefined; feedbackFile?: string | undefined },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    if ((options.feedback === undefined) === (options.feedbackFile === undefined)) {
      throw new DevflowError(
        ErrorCode.DecisionInputInvalid,
        "give the reason for the rejection with --feedback <text> or --feedback-file <file>",
      );
    }
    const feedback =
      options.feedback ?? (await readInputFile(io, options.feedbackFile ?? "", "feedback"));
    const workspace = await openWorkspace(io);
    const outcome = await rejectPlan(
      runId,
      { by: currentUser(io.env), feedback },
      workflowServices(workspace, io, serviceOptions(io, options, interruption)),
    );
    return report(io, options.json, outcome);
  });
}

/** `devflow answer <run> (--answer Q-1=text ... | --file answers.yaml)` */
export async function answerCommand(
  runId: string,
  options: ModelOptions & { answer: readonly string[]; file?: string | undefined },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const answers: Record<string, string> = {};
    if (options.file !== undefined) {
      Object.assign(answers, parseAnswerFile(await readInputFile(io, options.file, "answers")));
    }
    for (const entry of options.answer) {
      const separator = entry.indexOf("=");
      const id = entry.slice(0, separator).trim();
      if (separator <= 0 || id === "") {
        throw new DevflowError(
          ErrorCode.DecisionInputInvalid,
          `--answer expects <question-id>=<answer>, for example --answer "Q-1=Pages start at 1"`,
        );
      }
      answers[id] = entry.slice(separator + 1);
    }
    const workspace = await openWorkspace(io);
    const outcome = await answerQuestions(
      runId,
      { by: currentUser(io.env), answers },
      workflowServices(workspace, io, serviceOptions(io, options, interruption)),
    );
    return report(io, options.json, outcome);
  });
}

/** `devflow resume <run>`: continue an interrupted run, optionally with higher limits. */
export async function resumeCommand(
  runId: string,
  options: ModelOptions,
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    const services = workflowServices(workspace, io, serviceOptions(io, options, interruption));
    if (options.provider !== undefined) await services.provider(options.provider);
    const outcome = await resumeRun(runId, services, {
      budgets: budgetOverrides(options),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    });
    return report(io, options.json, outcome);
  });
}

/** `devflow cancel <run>` */
export async function cancelCommand(
  runId: string,
  options: { reason?: string | undefined; json: boolean },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async () => {
    const workspace = await openWorkspace(io);
    const outcome = await cancelRun(
      runId,
      {
        by: currentUser(io.env),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      workflowServices(workspace, io),
    );
    report(io, options.json, outcome);
    return ExitCode.Success;
  });
}

/** `devflow status [run]`: list runs, or show one. */
export async function statusCommand(
  runId: string | undefined,
  options: { json: boolean },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async () => {
    const workspace = await openWorkspace(io);
    if (runId === undefined) {
      const runs = await listRuns(workspace.root);
      if (options.json) {
        writeJson(io, {
          runs: runs.map((run) => ({
            id: run.id,
            task: run.task.id,
            mode: run.mode,
            goal: run.goal,
            state: run.state,
            createdAt: run.createdAt,
            updatedAt: run.updatedAt,
          })),
        });
      } else if (runs.length === 0) {
        io.stdout.write(
          "No runs in this workspace. Start one with devflow analyze or devflow plan.\n",
        );
      } else {
        const c = colorsFor(io.stdout, io.env);
        for (const run of runs) {
          io.stdout.write(
            `${run.id}  ${stateLabel(run.state, c)}  ${run.mode}/${run.goal}  ${run.task.title}\n`,
          );
        }
      }
      return ExitCode.Success;
    }
    const { record, outcome } = await getRun(workspace.root, runId);
    if (options.json) {
      writeJson(io, { ...outcome, record });
    } else {
      renderStatus(io, record, outcome);
    }
    return ExitCode.Success;
  });
}

/** `devflow report <run>`: print the report of a finished run. */
export async function reportCommand(
  runId: string,
  options: { json: boolean },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async () => {
    const workspace = await openWorkspace(io);
    const store = await RunStore.open(workspace.root, runId);
    if (!(await store.exists("report.json"))) {
      const record = await store.readRecord();
      const message =
        `run ${runId} is in state ${record.state}; a report is written when the run finishes ` +
        "(completed, failed or cancelled)";
      if (options.json) {
        writeJson(io, { runId, state: record.state, report: null, message });
      } else {
        io.stderr.write(`devflow: ${message}\n`);
      }
      return ExitCode.Failure;
    }
    io.stdout.write(await store.readText(options.json ? "report.json" : "report.md"));
    return ExitCode.Success;
  });
}

// ---------------------------------------------------------------------------------------------

/**
 * Runs a command body with Ctrl+C handling and maps DevFlow errors to messages and exit codes.
 * Other errors are bugs: they propagate to the binary, which prints them (exit 70).
 */
async function guarded(
  io: CliIo,
  json: boolean,
  body: (interruption: Interruption | undefined) => Promise<ExitCode>,
): Promise<ExitCode> {
  const interruption = io.interrupts?.();
  try {
    return await body(interruption);
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    if (json) {
      writeJson(io, { error: { code: error.code, message: error.message } });
    } else {
      io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    }
    return exitCodeForError(error.code);
  } finally {
    interruption?.dispose();
  }
}

function exitCodeForError(code: string): ExitCode {
  switch (code) {
    case ErrorCode.RunLocked:
    case ErrorCode.RunCorrupt:
      return ExitCode.Failure;
    case ErrorCode.BudgetExceeded:
      return ExitCode.BudgetExceeded;
    case ErrorCode.Cancelled:
      return ExitCode.Interrupted;
    default:
      return ExitCode.UsageError;
  }
}

function exitCodeFor(outcome: RunOutcome): ExitCode {
  switch (outcome.status) {
    case "completed":
      return ExitCode.Success;
    case "waiting":
      return ExitCode.WaitingForInput;
    case "interrupted":
      if (outcome.error?.code === ErrorCode.BudgetExceeded) return ExitCode.BudgetExceeded;
      if (outcome.error?.code === ErrorCode.Cancelled) return ExitCode.Interrupted;
      return ExitCode.Failure;
    case "failed":
    case "cancelled":
      return ExitCode.Failure;
  }
}

function serviceOptions(
  io: CliIo,
  options: ModelOptions,
  interruption: Interruption | undefined,
): ServiceOptions {
  return {
    cassette: options.cassette,
    interruption,
    ...(options.json
      ? {}
      : {
          onProgress: (event: ProgressEvent) => {
            progress(io, event);
          },
        }),
  };
}

function progress(io: CliIo, event: ProgressEvent): void {
  if (event.kind !== "step" || event.phase !== "started") return;
  const message = STEP_MESSAGES[event.step];
  if (message !== undefined) io.stderr.write(`${message}\n`);
}

function budgetOverrides(options: ModelOptions): Partial<RunBudgets> {
  return {
    ...(options.maxInputTokens === undefined ? {} : { maxInputTokens: options.maxInputTokens }),
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.maxCallsPerStep === undefined ? {} : { maxCallsPerStep: options.maxCallsPerStep }),
  };
}

function displayPath(workspace: Workspace, absolute: string): string {
  const relative = path.relative(workspace.root, absolute);
  return relative.startsWith("..") || path.isAbsolute(relative)
    ? absolute
    : relative.split(path.sep).join("/");
}

const MAX_INPUT_FILE_BYTES = 1024 * 1024;

async function readInputFile(io: CliIo, file: string, what: string): Promise<string> {
  let buffer: Buffer;
  try {
    buffer = await readFile(path.resolve(io.cwd, file));
  } catch (error) {
    throw new DevflowError(
      ErrorCode.DecisionInputInvalid,
      `cannot read the ${what} file ${file} (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      { details: { file } },
    );
  }
  if (buffer.length > MAX_INPUT_FILE_BYTES) {
    throw new DevflowError(
      ErrorCode.DecisionInputInvalid,
      `the ${what} file ${file} is larger than 1 MiB`,
      {
        details: { file },
      },
    );
  }
  return buffer.toString("utf8");
}

/** An answers file maps question ids to answers, in YAML or JSON: `Q-1: Pages start at 1`. */
function parseAnswerFile(text: string): Record<string, string> {
  let value: unknown;
  try {
    value = parseYaml(text, { maxAliasCount: 0 }) as unknown;
  } catch (error) {
    throw new DevflowError(
      ErrorCode.DecisionInputInvalid,
      `the answers file is not valid YAML or JSON: ${(error as Error).message}`,
    );
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DevflowError(
      ErrorCode.DecisionInputInvalid,
      "the answers file must map question ids to answers, for example `Q-1: Pages start at 1`",
    );
  }
  const answers: Record<string, string> = {};
  for (const [id, answer] of Object.entries(value)) {
    if (typeof answer !== "string" && typeof answer !== "number" && typeof answer !== "boolean") {
      throw new DevflowError(ErrorCode.DecisionInputInvalid, `the answer to ${id} must be text`);
    }
    answers[id] = String(answer);
  }
  return answers;
}

// ---------------------------------------------------------------------------------------------
// Output

function report(io: CliIo, json: boolean, outcome: RunOutcome): ExitCode {
  const code = exitCodeFor(outcome);
  if (json) {
    writeJson(io, { ...outcome, exitCode: code });
    return code;
  }
  const c = colorsFor(io.stdout, io.env);
  const out = [
    `${c.bold("Run:")}    ${outcome.runId}`,
    `${c.bold("State:")}  ${stateLabel(outcome.state, c)}`,
  ];
  out.push(...nextSteps(outcome, c));
  io.stdout.write(`${out.join("\n")}\n`);
  return code;
}

function nextSteps(outcome: RunOutcome, c: Colors): string[] {
  const id = outcome.runId;
  const out: string[] = [];
  switch (outcome.status) {
    case "completed":
      out.push(`${c.bold("Report:")} ${outcome.reportPath ?? `${outcome.runDir}/report.md`}`);
      out.push(
        "",
        "Assist mode analysed and planned only: no file was changed and nothing was executed or verified.",
      );
      break;
    case "waiting":
      if (outcome.waitingFor === "plan-approval") {
        out.push(`${c.bold("Plan:")}   ${outcome.planPath ?? ""}`);
        out.push(
          "",
          "Review the plan, then approve it or ask for changes:",
          `  devflow approve ${id}`,
          `  devflow reject ${id} --feedback "what to change"`,
        );
      } else {
        out.push("", c.bold("Blocking questions:"));
        for (const question of outcome.questions ?? []) {
          out.push(`  ${question.id}: ${question.question}`);
        }
        out.push(
          "",
          "Answer them, then the analysis continues:",
          `  devflow answer ${id} --answer "${outcome.questions?.[0]?.id ?? "Q-1"}=your answer"`,
          `  devflow answer ${id} --file answers.yaml   (Q-1: your answer)`,
        );
      }
      break;
    case "interrupted": {
      const error = outcome.error;
      out.push(
        `${c.bold("Stopped:")} ${error === undefined ? "the run was interrupted" : `${error.message} [${error.code}]`}`,
      );
      if (error?.code === ErrorCode.BudgetExceeded) {
        out.push(
          "",
          "Raise the limit and continue:",
          `  devflow resume ${id} --max-input-tokens <n> --max-output-tokens <n> --max-calls-per-step <n>`,
        );
      } else {
        out.push("", "Continue from the interrupted step:", `  devflow resume ${id}`);
      }
      break;
    }
    case "failed":
      out.push(
        `${c.bold("Failed:")} ${outcome.error === undefined ? "" : `${outcome.error.message} [${outcome.error.code}]`}`,
      );
      if (outcome.reportPath !== undefined) out.push(`${c.bold("Report:")} ${outcome.reportPath}`);
      break;
    case "cancelled":
      out.push("The run was cancelled.");
      if (outcome.reportPath !== undefined) out.push(`${c.bold("Report:")} ${outcome.reportPath}`);
      break;
  }
  return out;
}

function renderStatus(io: CliIo, record: RunRecord, outcome: RunOutcome): void {
  const c = colorsFor(io.stdout, io.env);
  const { settings, budgetUsage } = record;
  const out = [
    `${c.bold("Run:")}      ${record.id}`,
    `${c.bold("Task:")}     ${record.task.id} - ${record.task.title}${record.task.file === null ? "" : ` (${record.task.file})`}`,
    `${c.bold("Mode:")}     ${record.mode}, goal ${record.goal}`,
    `${c.bold("State:")}    ${stateLabel(record.state, c)}`,
    `${c.bold("Started:")}  ${record.createdAt}`,
    `${c.bold("Updated:")}  ${record.updatedAt}`,
    `${c.bold("Model:")}    ${settings.provider}; analysis ${settings.models.analysis}, planning ${settings.models.planning}`,
    `${c.bold("Usage:")}    ${String(budgetUsage.calls)} call(s), ${String(budgetUsage.inputTokens)} input and ${String(budgetUsage.outputTokens)} output tokens ` +
      `(limits ${String(settings.budgets.maxInputTokens)} / ${String(settings.budgets.maxOutputTokens)}, ${String(settings.budgets.maxCallsPerStep)} calls per step)`,
    `${c.bold("Trusted:")}  ${settings.workspaceTrusted ? "yes" : "no"}`,
  ];
  for (const warning of record.warnings) out.push(`${c.yellow("Warning:")}  ${warning}`);
  out.push(...nextSteps(outcome, c));
  io.stdout.write(`${out.join("\n")}\n`);
}

function stateLabel(state: RunRecord["state"], c: Colors): string {
  if (state === "COMPLETED") return c.green(state);
  if (state === "FAILED" || state === "CANCELLED") return c.red(state);
  if (state === "AWAITING_PLAN_APPROVAL" || state === "CLARIFICATION_REQUIRED") {
    return c.yellow(state);
  }
  return state;
}

function printWarnings(io: CliIo, warnings: readonly string[]): void {
  for (const warning of warnings) io.stderr.write(`devflow: warning: ${warning}\n`);
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
