import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DevflowError,
  ErrorCode,
  type ExecutionBackendKind,
  type WorkflowMode,
  isDevflowError,
  isTerminalState,
} from "@devflow/core";
import {
  type ProgressEvent,
  type RunBudgets,
  type RunOutcome,
  type ReviewPullRequest,
  type RunRecord,
  RunStore,
  STEP,
  type TraceExportPlan,
  type TraceExportResult,
  answerQuestions,
  approvePlan,
  approveChanges,
  approveTests,
  cancelRun,
  DEFAULT_MAX_PROBES,
  MAX_PROBES,
  exportRunTrace,
  getRun,
  listRuns,
  rejectPlan,
  rejectChanges,
  rejectTests,
  resolveRunSettings,
  resolveTraceExport,
  resumeRun,
  startRun,
  traceRedactor,
} from "@devflow/workflow";
import { parse as parseYaml } from "yaml";
import { ExitCode } from "../exit-codes.js";
import { type CliIo, type Colors, type Interruption, colorsFor } from "../io.js";
import { type TaskSourceOptions, resolveTask } from "../task-source.js";
import { checkCanPublish, githubClient, githubRepository, publishRun } from "../github.js";
import { type PublishTarget, type Published, getPullRequest } from "@devflow/github";
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
  /** Command fingerprints approved for this invocation (`--allow`), for test and implement mode. */
  readonly allow?: readonly string[] | undefined;
  /** Where gate commands run (`--backend`); the project configuration's choice otherwise. */
  readonly backend?: ExecutionBackendKind | undefined;
  /** `--trace`: export the run's trace when it finishes (ADR 0024); else `DEVFLOW_TRACE_EXPORT`. */
  readonly trace?: string | undefined;
  readonly json: boolean;
}

export interface StartOptions extends ModelOptions, TaskSourceOptions {
  readonly mode: WorkflowMode;
  /** Review mode: the reference the local change is compared with. */
  readonly base?: string;
  /** Review mode with `--pr`: publish the finished review as a comment or a check run. */
  readonly publish?: PublishTarget | undefined;
  /** Review mode with `--pr`: run the gates even on code from a fork. */
  readonly runForkCode?: boolean;
  /** Review mode: probe the AI findings with tests (ADR 0025). */
  readonly seekEvidence?: boolean;
  /** Review mode with `--seek-evidence`: at most this many probes. */
  readonly maxProbes?: number;
}

const STEP_MESSAGES: Readonly<Record<string, string>> = {
  [STEP.context]: "Loading the repository context...",
  [STEP.analysis]: "Analysing the requirements...",
  [STEP.planning]: "Planning the implementation...",
  [STEP.testDesign]: "Writing the tests...",
  [STEP.implementation]: "Writing the code change...",
  [STEP.verification]: "Running the gates...",
  [STEP.review]: "Reviewing...",
  [STEP.probes]: "Running the evidence probes...",
};

/**
 * `devflow analyze` and `devflow plan` start a run in assist mode; `devflow test` starts one
 * in test mode; `devflow implement` (and `devflow run`) in implement mode; `devflow review` in
 * review mode.
 */
export async function startCommand(
  goal: "analyze" | "plan" | "test" | "implement" | "review",
  options: StartOptions,
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    checkReviewOptions(goal, options);
    const tracePlan = resolveTraceExport(options.trace, io.env);
    if (options.publish !== undefined) checkCanPublish(io);
    const task = await resolveTask(options, {
      io,
      root: workspace.root,
      signal: interruption?.signal,
    });
    const review =
      goal !== "review"
        ? undefined
        : options.pr === undefined
          ? ({ base: options.base ?? "HEAD", warnings: [] } satisfies ReviewSetup)
          : await pullRequestReview(options, workspace.root, io, interruption?.signal);
    const { settings, warnings } = settingsFor(workspace, options, io);
    const allWarnings = [
      ...workspace.warnings,
      ...task.warnings,
      ...(review?.warnings ?? []),
      ...warnings,
    ];
    if (!options.json) printWarnings(io, allWarnings);
    const services = workflowServices(workspace, io, serviceOptions(io, options, interruption));
    // A provider that cannot be created (unknown name, no API key, no cassette) is a usage
    // error: it is reported before a run is created.
    await services.provider(settings.provider);
    const outcome = await startRun(
      {
        task: task.contract,
        taskFile: task.taskFile,
        mode: options.mode,
        goal,
        settings,
        warnings: allWarnings,
        ...(review === undefined
          ? {}
          : {
              review: {
                base: review.base,
                ...(review.pullRequest === undefined ? {} : { pullRequest: review.pullRequest }),
                ...(review.skipGates === undefined ? {} : { skipGates: review.skipGates }),
                ...(options.seekEvidence === true
                  ? { seekEvidence: { maxProbes: options.maxProbes ?? DEFAULT_MAX_PROBES } }
                  : {}),
              },
            }),
      },
      services,
    );
    const trace = await traceRun(io, workspace, outcome, tracePlan, interruption?.signal);
    if (options.publish === undefined) return report(io, options.json, outcome, { trace });
    if (outcome.status !== "completed") {
      return report(io, options.json, outcome, {
        trace,
        note:
          `Not published: the run is ${outcome.state}. When it finishes, publish it with ` +
          `\`devflow report ${outcome.runId} --publish ${options.publish}\`.`,
      });
    }
    const store = await RunStore.open(workspace.root, outcome.runId);
    try {
      const published = await publishRun(store, options.publish, io, interruption?.signal);
      return report(io, options.json, outcome, { published, trace });
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      // The review is complete and saved; only publishing failed.
      report(io, options.json, outcome, {
        trace,
        note: `Not published: ${error.message} [${error.code}]. Retry with \`devflow report ${outcome.runId} --publish ${options.publish}\`.`,
      });
      return ExitCode.Failure;
    }
  });
}

function checkReviewOptions(goal: string, options: StartOptions): void {
  const pullRequestOnly: [boolean, string][] = [
    [options.publish !== undefined, "--publish"],
    [options.runForkCode === true, "--run-fork-code"],
  ];
  for (const [given, flag] of pullRequestOnly) {
    if (given && (goal !== "review" || options.pr === undefined)) {
      throw new DevflowError(
        ErrorCode.OptionsInvalid,
        `${flag} only applies to \`devflow review --pr\``,
      );
    }
  }
  if (options.maxProbes !== undefined && options.seekEvidence !== true) {
    throw new DevflowError(ErrorCode.OptionsInvalid, "--max-probes needs --seek-evidence");
  }
  if (options.maxProbes !== undefined && options.maxProbes > MAX_PROBES) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      `--max-probes is at most ${String(MAX_PROBES)}: each probe is a model call and a test run`,
    );
  }
  if (options.pr !== undefined && options.base !== undefined) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      "--base does not apply to --pr: the pull request's base is used",
    );
  }
}

interface ReviewSetup {
  readonly base: string;
  readonly pullRequest?: ReviewPullRequest;
  readonly skipGates?: string | undefined;
  readonly warnings: readonly string[];
}

/**
 * Reads the pull request to review (metadata only; DevFlow never fetches code). Its head must
 * be checked out; the engine checks that. Code from a fork is not run unless asked.
 */
async function pullRequestReview(
  options: StartOptions,
  root: string,
  io: CliIo,
  signal: AbortSignal | undefined,
): Promise<ReviewSetup> {
  const repository = await githubRepository(options.repo, root, io);
  const pull = await getPullRequest(githubClient(io), options.pr ?? "", repository, signal);
  const label = `${pull.repository.owner}/${pull.repository.name}#${String(pull.number)}`;
  const skipGates =
    pull.fromFork && options.runForkCode !== true
      ? `${label} comes from ${pull.headRepository ?? "a deleted fork"}, so its code was not run ` +
        "(pass --run-fork-code to run the gates on it)"
      : undefined;
  return {
    base: pull.baseSha,
    pullRequest: {
      repository: `${pull.repository.owner}/${pull.repository.name}`,
      number: pull.number,
      url: pull.url,
      headCommit: pull.headSha,
      fromFork: pull.fromFork,
    },
    skipGates,
    warnings: pull.warnings,
  };
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

/** `devflow approve <run>`: approves the plan, the tests or the code change the run waits on. */
export async function approveCommand(
  runId: string,
  options: {
    planSha?: string | undefined;
    testsSha?: string | undefined;
    changesSha?: string | undefined;
    allow?: readonly string[] | undefined;
    backend?: ExecutionBackendKind | undefined;
    trace?: string | undefined;
    json: boolean;
  },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    const tracePlan = resolveTraceExport(options.trace, io.env);
    const { record } = await getRun(workspace.root, runId);
    const by = currentUser(io.env);
    const finish = async (outcome: RunOutcome): Promise<ExitCode> =>
      report(io, options.json, outcome, {
        trace: await traceRun(io, workspace, outcome, tracePlan, interruption?.signal),
      });
    const services = workflowServices(
      workspace,
      io,
      serviceOptions(
        io,
        { json: options.json, allow: options.allow, backend: options.backend },
        interruption,
      ),
    );
    const kind = record.pending?.kind;
    const given = [
      ["plan-approval", "--plan-sha", options.planSha],
      ["test-approval", "--tests-sha", options.testsSha],
      ["change-approval", "--changes-sha", options.changesSha],
    ] as const;
    for (const [pending, flag, value] of given) {
      if (value !== undefined && kind !== pending) {
        throw new DevflowError(
          ErrorCode.DecisionInputInvalid,
          `run ${runId} is not waiting for ${pending === "plan-approval" ? "a plan" : pending === "test-approval" ? "its tests" : "its code change"} to be approved: ${flag} does not apply`,
        );
      }
    }
    if (kind === "change-approval") {
      const outcome = await approveChanges(
        runId,
        {
          by,
          ...(options.changesSha === undefined
            ? {}
            : { changesSha256: options.changesSha.toLowerCase() }),
        },
        services,
      );
      return finish(outcome);
    }
    if (kind === "test-approval") {
      const outcome = await approveTests(
        runId,
        {
          by,
          ...(options.testsSha === undefined
            ? {}
            : { testsSha256: options.testsSha.toLowerCase() }),
        },
        services,
      );
      return finish(outcome);
    }
    const outcome = await approvePlan(
      runId,
      {
        by,
        ...(options.planSha === undefined ? {} : { planSha256: options.planSha.toLowerCase() }),
      },
      services,
    );
    return finish(outcome);
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
    const tracePlan = resolveTraceExport(options.trace, io.env);
    const { record } = await getRun(workspace.root, runId);
    const kind = record.pending?.kind;
    const reject =
      kind === "change-approval"
        ? rejectChanges
        : kind === "test-approval"
          ? rejectTests
          : rejectPlan;
    const outcome = await reject(
      runId,
      { by: currentUser(io.env), feedback },
      workflowServices(workspace, io, serviceOptions(io, options, interruption)),
    );
    const trace = await traceRun(io, workspace, outcome, tracePlan, interruption?.signal);
    return report(io, options.json, outcome, { trace });
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
    const tracePlan = resolveTraceExport(options.trace, io.env);
    const outcome = await answerQuestions(
      runId,
      { by: currentUser(io.env), answers },
      workflowServices(workspace, io, serviceOptions(io, options, interruption)),
    );
    const trace = await traceRun(io, workspace, outcome, tracePlan, interruption?.signal);
    return report(io, options.json, outcome, { trace });
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
    const tracePlan = resolveTraceExport(options.trace, io.env);
    const services = workflowServices(workspace, io, serviceOptions(io, options, interruption));
    if (options.provider !== undefined) await services.provider(options.provider);
    const outcome = await resumeRun(runId, services, {
      budgets: budgetOverrides(options),
      ...(options.model === undefined ? {} : { model: options.model }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
    });
    const trace = await traceRun(io, workspace, outcome, tracePlan, interruption?.signal);
    return report(io, options.json, outcome, { trace });
  });
}

/** `devflow cancel <run>` */
export async function cancelCommand(
  runId: string,
  options: { reason?: string | undefined; trace?: string | undefined; json: boolean },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async () => {
    const workspace = await openWorkspace(io);
    const tracePlan = resolveTraceExport(options.trace, io.env);
    const outcome = await cancelRun(
      runId,
      {
        by: currentUser(io.env),
        ...(options.reason === undefined ? {} : { reason: options.reason }),
      },
      workflowServices(workspace, io),
    );
    report(io, options.json, outcome, {
      trace: await traceRun(io, workspace, outcome, tracePlan, undefined),
    });
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
          "No runs in this workspace. Start one with devflow analyze, devflow plan or devflow test.\n",
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
  options: { json: boolean; publish?: PublishTarget | undefined },
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const workspace = await openWorkspace(io);
    const store = await RunStore.open(workspace.root, runId);
    if (options.publish !== undefined) {
      checkCanPublish(io);
      const published = await publishRun(store, options.publish, io, interruption?.signal);
      if (options.json) writeJson(io, { runId, published });
      else io.stdout.write(`Published the review as a ${published.target}: ${published.url}\n`);
      return ExitCode.Success;
    }
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
export async function guarded(
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
    case ErrorCode.GitHubRequestFailed:
    case ErrorCode.GitPushFailed:
      return ExitCode.Failure;
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
      if (outcome.error?.code === ErrorCode.CommandNotApproved) return ExitCode.PolicyDenied;
      if (outcome.error?.code === ErrorCode.Cancelled) return ExitCode.Interrupted;
      return ExitCode.Failure;
    case "failed":
    case "cancelled":
      return ExitCode.Failure;
  }
}

function serviceOptions(
  io: CliIo,
  options: Pick<ModelOptions, "cassette" | "allow" | "backend" | "json">,
  interruption: Interruption | undefined,
): ServiceOptions {
  return {
    cassette: options.cassette,
    interruption,
    allow: options.allow ?? [],
    backend: options.backend,
    // Commands are approved on the terminal only when the output is for a person.
    interactiveApproval: !options.json,
    ...(options.json
      ? {}
      : {
          onProgress: (event: ProgressEvent) => {
            progress(io, event);
          },
          onGate: (gateId: string, commandId: string | undefined) => {
            io.stderr.write(
              `Running gate ${gateId}${commandId === undefined ? "" : ` (${commandId})`}...\n`,
            );
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

function report(
  io: CliIo,
  json: boolean,
  outcome: RunOutcome,
  extra: {
    readonly published?: Published;
    readonly note?: string;
    readonly trace?: RunTraceOutput | undefined;
  } = {},
): ExitCode {
  const code = exitCodeFor(outcome);
  if (json) {
    writeJson(io, {
      ...outcome,
      exitCode: code,
      ...(extra.published === undefined ? {} : { published: extra.published }),
      ...(extra.trace === undefined ? {} : { trace: extra.trace }),
      ...(extra.note === undefined ? {} : { note: extra.note }),
    });
    return code;
  }
  const c = colorsFor(io.stdout, io.env);
  const out = [
    `${c.bold("Run:")}    ${outcome.runId}`,
    `${c.bold("State:")}  ${stateLabel(outcome.state, c)}`,
  ];
  if (outcome.branch !== undefined) out.push(`${c.bold("Branch:")} ${outcome.branch}`);
  out.push(...nextSteps(outcome, c));
  if (extra.published !== undefined) {
    out.push("", `Published the review as a ${extra.published.target}: ${extra.published.url}`);
  }
  if (extra.note !== undefined) out.push("", extra.note);
  if (extra.trace !== undefined) out.push("", ...traceLines(extra.trace));
  io.stdout.write(`${out.join("\n")}\n`);
  return code;
}

/** What the trace export did, for the output of a workflow command. */
type RunTraceOutput = TraceExportResult | { readonly pending: string };

/**
 * Exports the trace of a run that has finished (completed, failed or cancelled), when the user
 * asked for it. A run waiting for input or interrupted is exported when it finishes. Export
 * problems are warnings: they never change the run or the exit code.
 */
async function traceRun(
  io: CliIo,
  workspace: Workspace,
  outcome: RunOutcome,
  plan: TraceExportPlan | undefined,
  signal: AbortSignal | undefined,
): Promise<RunTraceOutput | undefined> {
  if (plan === undefined) return undefined;
  if (!isTerminalState(outcome.state)) {
    return {
      pending:
        `the run is ${outcome.state}; its trace is exported when it finishes ` +
        `(or with \`devflow trace ${outcome.runId}\`)`,
    };
  }
  const store = await RunStore.open(workspace.root, outcome.runId);
  return exportRunTrace(store, plan, {
    redactor: traceRedactor(io.env, plan),
    ...(signal === undefined ? {} : { signal }),
  });
}

function traceLines(trace: RunTraceOutput): string[] {
  if ("pending" in trace) return [`Trace:  not exported yet: ${trace.pending}`];
  const lines: string[] = [];
  if (trace.file !== undefined) lines.push(`Trace:  ${trace.file}`);
  if (trace.sent !== undefined) {
    lines.push(`Trace:  ${String(trace.spans)} span(s) sent to ${trace.sent.endpoint}`);
  }
  for (const warning of trace.warnings) lines.push(`Trace warning: ${warning}`);
  return lines;
}

function nextSteps(outcome: RunOutcome, c: Colors): string[] {
  const id = outcome.runId;
  const out: string[] = [];
  switch (outcome.status) {
    case "completed":
      out.push(`${c.bold("Report:")} ${outcome.reportPath ?? `${outcome.runDir}/report.md`}`);
      out.push(
        "",
        outcome.mode === "implement"
          ? outcome.branch === undefined
            ? "The change was verified against the tests; the report has the verdict. The changed " +
              "files are in the working tree, not committed: review the diff before you keep it."
            : "The change was verified against the tests; the report has the verdict. The approved " +
              `changes are committed on the local branch ${outcome.branch}; nothing was pushed: ` +
              "review the commits before you merge them."
          : outcome.mode === "review"
            ? "The change was reviewed: the gates ran once on it and the report has the verdict " +
              "and the findings. AI findings are suggestions and stay unverified; no file was changed."
            : outcome.mode === "test"
              ? "The tests were written and run against the current code (red baseline). No production " +
                "code was changed, so no acceptance criterion is verified yet." +
                (outcome.branch === undefined
                  ? ""
                  : ` The approved tests are committed on the local branch ${outcome.branch}.`)
              : "Assist mode analysed and planned only: no file was changed and nothing was executed or verified.",
      );
      break;
    case "waiting":
      if (outcome.waitingFor === "change-approval") {
        out.push(`${c.bold("Change:")} ${outcome.changesPath ?? ""}`);
        for (const file of outcome.changedFiles ?? []) out.push(`  ${file}`);
        out.push(
          "",
          "The model changed these files in the workspace; the change has not run. Review it",
          "(for example with git diff): approved code runs with the tests, with your privileges.",
          "Then approve it or ask for changes (the files are restored first):",
          `  devflow approve ${id}`,
          `  devflow reject ${id} --feedback "what to change"`,
        );
      } else if (outcome.waitingFor === "test-approval") {
        out.push(`${c.bold("Tests:")}  ${outcome.testsPath ?? ""}`);
        for (const file of outcome.testFiles ?? []) out.push(`  ${file}`);
        out.push(
          "",
          "The model wrote these test files into the workspace; they have not run. Review them",
          "(for example with git diff): approved tests run against the current code, with your",
          "privileges. Then approve them or ask for changes (the files are restored first):",
          `  devflow approve ${id}`,
          `  devflow reject ${id} --feedback "what to change"`,
        );
      } else if (outcome.waitingFor === "plan-approval") {
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
      } else if (error?.code === ErrorCode.CommandNotApproved) {
        const denials = outcome.denials ?? [];
        if (denials.some((denial) => denial.reason === "workspace-untrusted")) {
          out.push(
            "",
            "Review the workspace with devflow trust, then continue:",
            `  devflow resume ${id}`,
          );
        }
        const unapproved = denials.filter(
          (denial) => denial.reason === "approval-required" || denial.reason === "rejected-by-user",
        );
        const blocked = denials.filter(
          (denial) =>
            denial.reason !== "workspace-untrusted" &&
            denial.reason !== "approval-required" &&
            denial.reason !== "rejected-by-user",
        );
        if (blocked.length > 0) {
          out.push("", "Fix the cause, then continue:");
          for (const denial of blocked) out.push(`  ${denial.commandId}: ${denial.message}`);
          if (unapproved.length === 0) out.push(`  devflow resume ${id}`);
        }
        if (unapproved.length > 0) {
          out.push("", "Review each command, then continue with its fingerprint:");
          for (const denial of unapproved) {
            out.push(`  ${denial.commandId}: ${denial.argv.join(" ")}`, `    in ${denial.cwd}`);
          }
          out.push(
            `  devflow resume ${id} ${unapproved.map((denial) => `--allow ${denial.fingerprint ?? "(no fingerprint)"}`).join(" ")}`,
          );
        }
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
    `${c.bold("Cost:")}     ${costLine(record)}`,
    `${c.bold("Trusted:")}  ${settings.workspaceTrusted ? "yes" : "no"}`,
  ];
  for (const warning of record.warnings) out.push(`${c.yellow("Warning:")}  ${warning}`);
  out.push(...nextSteps(outcome, c));
  io.stdout.write(`${out.join("\n")}\n`);
}

/** The run's cost: exact when every call was priced, a lower bound otherwise, or unknown. */
function costLine(record: RunRecord): string {
  const { budgetUsage, settings } = record;
  const limit =
    settings.budgets.maxCostUsd === undefined
      ? ""
      : ` (limit $${settings.budgets.maxCostUsd.toFixed(2)}, priced calls only)`;
  const unpriced = budgetUsage.unpricedCalls ?? 0;
  const cost = budgetUsage.costUsd;
  if (budgetUsage.calls === 0) return `none yet${limit}`;
  if (cost === undefined) return `unknown: no price is configured for the models used${limit}`;
  if (unpriced === 0) return `$${cost.toFixed(4)}${limit}`;
  return `at least $${cost.toFixed(4)}; ${String(unpriced)} call(s) to models without a price${limit}`;
}

function stateLabel(state: RunRecord["state"], c: Colors): string {
  if (state === "COMPLETED") return c.green(state);
  if (state === "FAILED" || state === "CANCELLED") return c.red(state);
  if (
    state === "AWAITING_PLAN_APPROVAL" ||
    state === "CLARIFICATION_REQUIRED" ||
    state === "TEST_DESIGN"
  ) {
    return c.yellow(state);
  }
  return state;
}

function printWarnings(io: CliIo, warnings: readonly string[]): void {
  for (const warning of warnings) io.stderr.write(`devflow: warning: ${warning}\n`);
}

export function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
