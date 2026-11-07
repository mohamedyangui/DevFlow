import { Command, CommanderError } from "commander";
import { taskValidateCommand } from "./commands/task-validate.js";
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
