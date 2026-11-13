import {
  formatIssuePath,
  isDevflowError,
  loadTaskFile,
  type LoadedTask,
  type TaskContract,
  type ValidationIssue,
} from "@devflowai/core";
import { ExitCode } from "../exit-codes.js";
import { colorsFor, type CliIo, type Colors } from "../io.js";

export interface TaskValidateOptions {
  readonly json: boolean;
  readonly strict: boolean;
}

/** `devflow task validate <file>`: parse, normalize and lint a task file. */
export async function taskValidateCommand(
  file: string,
  options: TaskValidateOptions,
  io: CliIo,
): Promise<ExitCode> {
  let loaded: LoadedTask;
  try {
    loaded = await loadTaskFile(file, { cwd: io.cwd });
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    if (options.json) {
      writeJson(io, {
        file,
        valid: false,
        error: { code: error.code, message: error.message },
      });
    } else {
      io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    }
    return ExitCode.UsageError;
  }

  const errors = loaded.issues.filter((issue) => issue.severity === "error");
  const warnings = loaded.issues.filter((issue) => issue.severity === "warning");
  const strictFailure = options.strict && warnings.length > 0;
  const valid = loaded.valid && !strictFailure;

  if (options.json) {
    writeJson(io, {
      file: loaded.contract?.source.ref ?? file,
      format: loaded.format,
      valid,
      strict: options.strict,
      errorCount: errors.length,
      warningCount: warnings.length,
      issues: loaded.issues.map((issue) => ({ ...issue, location: formatIssuePath(issue.path) })),
      task: loaded.contract ?? null,
    });
  } else {
    renderHuman(io, file, loaded, { valid, strictFailure, errors, warnings });
  }
  return valid ? ExitCode.Success : ExitCode.Failure;
}

function renderHuman(
  io: CliIo,
  file: string,
  loaded: LoadedTask,
  summary: {
    valid: boolean;
    strictFailure: boolean;
    errors: readonly ValidationIssue[];
    warnings: readonly ValidationIssue[];
  },
): void {
  const c = colorsFor(io.stdout, io.env);
  const out: string[] = [];
  out.push(`${c.bold("Task file:")} ${loaded.contract?.source.ref ?? file} (${loaded.format})`);
  if (loaded.contract !== undefined) {
    out.push(`${c.bold("Task:")}      ${loaded.contract.id} - ${loaded.contract.title}`);
    out.push(`${c.bold("Contents:")}  ${describeContents(loaded.contract)}`);
  }
  if (loaded.issues.length > 0) out.push("");
  for (const issue of loaded.issues) out.push(...renderIssue(issue, c));
  out.push("");

  const counts = [
    plural(summary.errors.length, "error"),
    plural(summary.warnings.length, "warning"),
  ]
    .filter((text) => !text.startsWith("0 "))
    .join(", ");
  if (summary.valid) {
    out.push(`${c.bold("Result:")} ${c.green("VALID")}${counts === "" ? "" : ` (${counts})`}`);
  } else if (summary.strictFailure && summary.errors.length === 0) {
    out.push(
      `${c.bold("Result:")} ${c.red("INVALID")} (strict mode: ${plural(summary.warnings.length, "warning")} treated as errors)`,
    );
  } else {
    out.push(`${c.bold("Result:")} ${c.red("INVALID")} (${counts})`);
  }
  io.stdout.write(`${out.join("\n")}\n`);
}

function renderIssue(issue: ValidationIssue, c: Colors): string[] {
  const severity = issue.severity === "error" ? c.red("error  ") : c.yellow("warning");
  const where = [
    issue.line === undefined ? undefined : `line ${issue.line}`,
    issue.path.length === 0 ? undefined : formatIssuePath(issue.path),
  ]
    .filter((part) => part !== undefined)
    .join("  ");
  return [`${severity}  ${c.dim(issue.code)}  ${where}`.trimEnd(), `         ${issue.message}`];
}

function describeContents(contract: TaskContract): string {
  return [
    plural(contract.requirements.functional.length, "functional requirement"),
    plural(contract.requirements.nonFunctional.length, "non-functional requirement"),
    plural(contract.acceptanceCriteria.length, "acceptance criterion", "acceptance criteria"),
    plural(contract.definitionOfDone.length, "definition-of-done item"),
  ].join(", ");
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
