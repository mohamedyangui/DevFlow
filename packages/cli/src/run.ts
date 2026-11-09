import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { initCommand } from "./commands/init.js";
import { taskValidateCommand } from "./commands/task-validate.js";
import { trustCommand } from "./commands/trust.js";
import { verifyCommand } from "./commands/verify.js";
import {
  type ModelOptions,
  answerCommand,
  approveCommand,
  cancelCommand,
  rejectCommand,
  reportCommand,
  resumeCommand,
  startCommand,
  statusCommand,
} from "./commands/workflow.js";
import { ExitCode } from "./exit-codes.js";
import type { CliIo } from "./io.js";
import { readCliVersion } from "./version.js";

/**
 * Runs the `devflow` command line with the given arguments (excluding `node` and the script)
 * and returns the exit code. Nothing here calls `process.exit`, so it is testable in-process.
 */
export async function runCli(args: readonly string[], io: CliIo): Promise<ExitCode> {
  let exitCode: ExitCode = ExitCode.Success;

  const program = new Command()
    .name("devflow")
    .description("DevFlow AI: evidence-driven AI software engineering workflows.")
    .version(readCliVersion(), "-v, --version", "print the DevFlow version")
    .helpOption("-h, --help", "show help")
    .exitOverride()
    .configureOutput({
      writeOut: (text) => {
        io.stdout.write(text);
      },
      writeErr: (text) => {
        io.stderr.write(text);
      },
    })
    .showHelpAfterError("(run with --help for usage)");

  const task = program.command("task").description("work with task files");
  task
    .command("validate")
    .description("validate a task file (YAML, JSON or Markdown) and report problems")
    .argument("<file>", "path to the task file")
    .option("--json", "print a machine-readable result")
    .option("--strict", "treat warnings as errors")
    .action(async (file: string, options: { json?: boolean; strict?: boolean }) => {
      exitCode = await taskValidateCommand(
        file,
        { json: options.json === true, strict: options.strict === true },
        io,
      );
    });

  program
    .command("trust")
    .description("review the workspace configuration and trust it, show its status, or revoke it")
    .argument("[directory]", "workspace directory (default: the current directory)")
    .addOption(new Option("-y, --yes", "trust without asking, after reviewing the output"))
    .addOption(
      new Option(
        "--status",
        "show whether the workspace is trusted, and the approved commands",
      ).conflicts(["yes", "revoke"]),
    )
    .addOption(new Option("--revoke", "revoke trust and every command approval").conflicts(["yes"]))
    .option("--json", "print a machine-readable result")
    .action(
      async (
        directory: string | undefined,
        options: { yes?: boolean; status?: boolean; revoke?: boolean; json?: boolean },
      ) => {
        exitCode = await trustCommand(
          directory,
          {
            yes: options.yes === true,
            status: options.status === true,
            revoke: options.revoke === true,
            json: options.json === true,
          },
          io,
        );
      },
    );

  program
    .command("verify")
    .description("run the verification gates (tests, lint, type checks) through the command policy")
    .option("--gate <id>", "run only this gate (repeatable)", collect, [])
    .option(
      "--allow <fingerprint>",
      "approve the command with this fingerprint for this run, after reviewing it (repeatable)",
      fingerprints,
      [],
    )
    .option("--baseline <file>", "compare with the verification.json of an earlier run")
    .option("--json", "print a machine-readable result")
    .action(
      async (options: { gate: string[]; allow: string[]; baseline?: string; json?: boolean }) => {
        exitCode = await verifyCommand(
          {
            gates: options.gate,
            allow: options.allow,
            baseline: options.baseline,
            json: options.json === true,
          },
          io,
        );
      },
    );

  program
    .command("init")
    .description("write .devflow/config.yaml and a rules template, and ignore .devflow/runs/")
    .option("--json", "print a machine-readable result")
    .action(async (options: { json?: boolean }) => {
      exitCode = await initCommand({ json: options.json === true }, io);
    });

  for (const goal of ["analyze", "plan"] as const) {
    withModelOptions(
      program
        .command(goal)
        .description(
          goal === "analyze"
            ? "analyse a task's requirements against the repository (assist mode)"
            : "analyse a task and write an implementation plan for review (assist mode)",
        )
        .requiredOption("-t, --task <file>", "task file (YAML, JSON or Markdown)")
        .addOption(
          new Option(
            "--mode <mode>",
            "workflow mode (devflow test and devflow implement run the other modes)",
          )
            .choices(["assist", "review"])
            .default("assist"),
        ),
    ).action(async (options: RawModelOptions & { task: string; mode: string }) => {
      exitCode = await startCommand(
        goal,
        {
          ...modelOptions(options),
          task: options.task,
          mode: options.mode as "assist" | "review",
        },
        io,
      );
    });
  }

  for (const name of ["implement", "run"] as const) {
    withAllowOption(
      withModelOptions(
        program
          .command(name)
          .description(
            name === "implement"
              ? "implement a task test-first: tests, red run, code change, green run and repairs (implement mode)"
              : "run the full workflow for a task (the same as devflow implement)",
          )
          .requiredOption("-t, --task <file>", "task file (YAML, JSON or Markdown)"),
      ),
    ).action(async (options: RawModelOptions & { task: string; allow: string[] }) => {
      exitCode = await startCommand(
        "implement",
        { ...modelOptions(options), task: options.task, mode: "implement", allow: options.allow },
        io,
      );
    });
  }

  withAllowOption(
    withModelOptions(
      program
        .command("test")
        .description(
          "write tests for a task's acceptance criteria and run them against the current code (test mode)",
        )
        .requiredOption("-t, --task <file>", "task file (YAML, JSON or Markdown)"),
    ),
  ).action(async (options: RawModelOptions & { task: string; allow: string[] }) => {
    exitCode = await startCommand(
      "test",
      { ...modelOptions(options), task: options.task, mode: "test", allow: options.allow },
      io,
    );
  });

  withAllowOption(
    program
      .command("approve")
      .description("approve the plan, the tests or the code change a run is waiting on")
      .argument("<run>", "run id")
      .option("--plan-sha <sha256>", "approve only if the plan still has this hash")
      .option("--tests-sha <sha256>", "approve only if the written tests still have this hash")
      .option("--changes-sha <sha256>", "approve only if the code change still has this hash")
      .option("--json", "print a machine-readable result"),
  ).action(
    async (
      run: string,
      options: {
        planSha?: string;
        testsSha?: string;
        changesSha?: string;
        allow: string[];
        json?: boolean;
      },
    ) => {
      exitCode = await approveCommand(
        run,
        {
          planSha: options.planSha,
          testsSha: options.testsSha,
          changesSha: options.changesSha,
          allow: options.allow,
          json: options.json === true,
        },
        io,
      );
    },
  );

  withModelOptions(
    program
      .command("reject")
      .description(
        "reject the plan, the tests or the code change with feedback; DevFlow writes it again",
      )
      .argument("<run>", "run id")
      .option("--feedback <text>", "what to change")
      .option("--feedback-file <file>", "read the feedback from a file"),
  ).action(
    async (
      run: string,
      options: RawModelOptions & { feedback?: string; feedbackFile?: string },
    ) => {
      exitCode = await rejectCommand(
        run,
        {
          ...modelOptions(options),
          feedback: options.feedback,
          feedbackFile: options.feedbackFile,
        },
        io,
      );
    },
  );

  withModelOptions(
    program
      .command("answer")
      .description("answer clarification questions; the analysis continues once none blocks")
      .argument("<run>", "run id")
      .option(
        "--answer <id=text>",
        'an answer, for example "Q-1=Pages start at 1" (repeatable)',
        collect,
        [],
      )
      .option("--file <file>", "YAML or JSON file mapping question ids to answers"),
  ).action(async (run: string, options: RawModelOptions & { answer: string[]; file?: string }) => {
    exitCode = await answerCommand(
      run,
      { ...modelOptions(options), answer: options.answer, file: options.file },
      io,
    );
  });

  withAllowOption(
    withModelOptions(
      program
        .command("resume")
        .description(
          "continue an interrupted run; limits, model, provider and command approvals can be given",
        )
        .argument("<run>", "run id"),
    ),
  ).action(async (run: string, options: RawModelOptions & { allow: string[] }) => {
    exitCode = await resumeCommand(run, { ...modelOptions(options), allow: options.allow }, io);
  });

  program
    .command("cancel")
    .description("cancel a run that has not finished")
    .argument("<run>", "run id")
    .option("--reason <text>", "why the run is cancelled")
    .option("--json", "print a machine-readable result")
    .action(async (run: string, options: { reason?: string; json?: boolean }) => {
      exitCode = await cancelCommand(
        run,
        { reason: options.reason, json: options.json === true },
        io,
      );
    });

  program
    .command("status")
    .description("list the runs of this workspace, or show one")
    .argument("[run]", "run id")
    .option("--json", "print a machine-readable result")
    .action(async (run: string | undefined, options: { json?: boolean }) => {
      exitCode = await statusCommand(run, { json: options.json === true }, io);
    });

  program
    .command("report")
    .description("print the report of a finished run (Markdown, or JSON with --json)")
    .argument("<run>", "run id")
    .option("--json", "print report.json")
    .action(async (run: string, options: { json?: boolean }) => {
      exitCode = await reportCommand(run, { json: options.json === true }, io);
    });

  try {
    await program.parseAsync([...args], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) {
      const informational =
        error.code === "commander.helpDisplayed" || error.code === "commander.version";
      return informational ? ExitCode.Success : ExitCode.UsageError;
    }
    throw error;
  }
  return exitCode;
}

interface RawModelOptions {
  provider?: string;
  model?: string;
  cassette?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxCallsPerStep?: number;
  json?: boolean;
}

function withModelOptions(command: Command): Command {
  return command
    .option("--provider <name>", "model provider: anthropic, or replay with --cassette")
    .option("--model <id>", "model id for every step (no default: also ai.models or DEVFLOW_MODEL)")
    .option("--cassette <file>", "recorded responses for the replay provider")
    .option("--max-input-tokens <n>", "input token budget of the run", positiveInteger)
    .option("--max-output-tokens <n>", "output token budget of the run", positiveInteger)
    .option("--max-calls-per-step <n>", "model call budget of each step", positiveInteger)
    .option("--json", "print a machine-readable result");
}

function withAllowOption(command: Command): Command {
  return command.option(
    "--allow <fingerprint>",
    "approve the command with this fingerprint for this invocation, after reviewing it (repeatable)",
    fingerprints,
    [],
  );
}

function modelOptions(options: RawModelOptions): ModelOptions {
  return {
    provider: options.provider,
    model: options.model,
    cassette: options.cassette,
    maxInputTokens: options.maxInputTokens,
    maxOutputTokens: options.maxOutputTokens,
    maxCallsPerStep: options.maxCallsPerStep,
    json: options.json === true,
  };
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value.trim()) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("expected a positive integer");
  }
  return parsed;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function fingerprints(value: string, previous: string[]): string[] {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new InvalidArgumentError("expected a command fingerprint (64 hexadecimal characters)");
  }
  return [...previous, value];
}
