import { findModule, type WorkspaceModule } from "../adapters/registry.js";
import { isDevflowError } from "../errors.js";
import type { ToolchainProbe } from "../ports/language-adapter.js";
import type { RepositoryEntry, RepositoryView } from "../ports/repository-view.js";
import type { CommandPurpose, CommandSpec, ExecutionRecord } from "../schemas/command.js";
import type { Evidence } from "../schemas/primitives.js";
import {
  GateResult,
  type Diagnostic,
  type ParsedCommandResults,
  type ResultStatus,
  type TestCaseResult,
} from "../schemas/verification.js";
import type {
  ApprovedCommand,
  CommandRequest,
  DenialReason,
  PolicyDecision,
} from "../security/command-policy.js";
import type { ExecuteOptions, ExecutionResult } from "../security/executor.js";
import type { SecretRedactor } from "../security/secrets.js";

/**
 * The verification engine (docs/specs/verification-and-evidence.md, section 4): runs gates,
 * one adapter command per gate, through the command policy and the executor, and turns what
 * happened into `GateResult`s. It never upgrades a status: a gate is `passed` only when the
 * command ran, exited 0 and its results were read and contain no failure.
 */

/** A gate as configured in `.devflow/config.yaml` (`verification.gates[]`). */
export interface GateDefinition {
  readonly id: string;
  readonly module: string;
  readonly use: CommandPurpose;
  readonly required: boolean;
}

/** Why the command policy did not let a gate's command run. */
export interface GateDenial {
  readonly gateId: string;
  readonly commandId: string;
  /** The command as it would have run (redacted), to review before approving it. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly reason: DenialReason;
  readonly message: string;
  readonly fingerprint?: string;
}

export type GateEvent =
  | { readonly type: "gate-started"; readonly gate: GateDefinition; readonly commandId?: string }
  | { readonly type: "gate-finished"; readonly gate: GateDefinition; readonly result: GateResult };

export interface VerificationOptions {
  readonly repo: RepositoryView;
  readonly modules: readonly WorkspaceModule[];
  readonly policy: { evaluate(request: CommandRequest): Promise<PolicyDecision> };
  readonly executor: {
    run(command: ApprovedCommand, options: ExecuteOptions): Promise<ExecutionResult>;
  };
  readonly toolchain: ToolchainProbe;
  readonly redactor: SecretRedactor;
  /** Repository-relative directory for command logs, e.g. `.devflow/runs/verify/<id>/logs`. */
  readonly logDir: string;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: GateEvent) => void;
}

export interface VerificationRun {
  readonly gates: readonly GateResult[];
  readonly denials: readonly GateDenial[];
}

/**
 * The gates to run when the configuration lists none: the `test` command of every module that
 * has one, each required. Modules without a test command get no gate.
 */
export async function defaultGates(
  modules: readonly WorkspaceModule[],
  repo: RepositoryView,
  toolchain: ToolchainProbe,
): Promise<GateDefinition[]> {
  const gates: GateDefinition[] = [];
  for (const module of modules) {
    let catalog: readonly CommandSpec[];
    try {
      catalog = await module.adapter.commandCatalog(module.profile, toolchain, repo);
    } catch {
      continue;
    }
    if (catalog.some((command) => command.purpose === "test" && command.parameters.length === 0)) {
      gates.push({
        id: `${module.profile.moduleId}-test`.slice(0, 64),
        module: module.profile.moduleId,
        use: "test",
        required: true,
      });
    }
  }
  return gates;
}

/** Runs the gates one after the other, in order. */
export async function runGates(
  gates: readonly GateDefinition[],
  options: VerificationOptions,
): Promise<VerificationRun> {
  const results: GateResult[] = [];
  const denials: GateDenial[] = [];
  for (const gate of gates) {
    const outcome = await runGate(gate, options);
    results.push(outcome.result);
    if (outcome.denial !== undefined) denials.push(outcome.denial);
  }
  return { gates: results, denials };
}

export interface GateOutcome {
  readonly result: GateResult;
  readonly denial?: GateDenial;
}

/**
 * Runs only some of a test gate's tests: the module's test command that takes one parameter
 * (the adapter's filter, such as a test name pattern), with this value. The policy checks the
 * value against the parameter's anchored pattern. Evidence-seeking review (ADR 0025) runs one
 * probe test this way.
 */
export interface GateSelection {
  /** The test name; the parameter's value unless the adapter derives another one. */
  readonly filter: string;
  /** The test's file, repository-relative, for the adapter's `testSelection`. */
  readonly testFile?: string;
}

/** Resolves, authorizes, runs and reads one gate. */
export async function runGate(
  gate: GateDefinition,
  options: VerificationOptions,
  selection?: GateSelection,
): Promise<GateOutcome> {
  const { redactor } = options;
  const finish = (outcome: GateOutcome): GateOutcome => {
    options.onEvent?.({ type: "gate-finished", gate, result: outcome.result });
    return outcome;
  };
  const notExecuted = (commandId: string, reason: string, denial?: GateDenial): GateOutcome =>
    finish({
      result: GateResult.parse({
        gateId: gate.id,
        commandId,
        required: gate.required,
        status: "not_executed",
        reason: redactor.redactText(reason),
        tests: [],
        diagnostics: [],
        evidence: [],
      }),
      ...(denial === undefined ? {} : { denial }),
    });

  const unresolved = `${gate.module}:${gate.use}`;
  if (options.signal?.aborted === true) {
    options.onEvent?.({ type: "gate-started", gate });
    return notExecuted(unresolved, "cancelled before the gate ran");
  }

  let module: WorkspaceModule;
  let command: CommandSpec;
  try {
    module = findModule(options.modules, gate.module);
    const catalog = await module.adapter.commandCatalog(
      module.profile,
      options.toolchain,
      options.repo,
    );
    const parameters = selection === undefined ? 0 : 1;
    const found = catalog.find((c) => c.purpose === gate.use && c.parameters.length === parameters);
    if (found === undefined) {
      options.onEvent?.({ type: "gate-started", gate });
      const purposes = [...new Set(catalog.map((c) => c.purpose))];
      return notExecuted(
        unresolved,
        selection === undefined
          ? `module ${gate.module} has no "${gate.use}" command (it has: ${purposes.join(", ") || "none"})`
          : `module ${gate.module} has no "${gate.use}" command that takes a filter`,
      );
    }
    command = found;
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    options.onEvent?.({ type: "gate-started", gate });
    return notExecuted(unresolved, error.message);
  }
  options.onEvent?.({ type: "gate-started", gate, commandId: command.id });

  if (!command.executable.startsWith("./")) {
    const available = await options.toolchain.probe(command.executable);
    if (!available.available) {
      return notExecuted(
        command.id,
        `${command.executable} was not found on PATH, so ${command.id} could not run`,
      );
    }
  }

  const parameter = command.parameters[0];
  let selected = selection?.filter;
  if (selection?.testFile !== undefined && module.adapter.testSelection !== undefined) {
    try {
      selected =
        module.adapter.testSelection(module.profile, {
          file: selection.testFile,
          name: selection.filter,
        }) ?? selection.filter;
    } catch {
      return notExecuted(command.id, `the ${module.adapter.id} adapter could not select the test`);
    }
  }
  const decision = await options.policy.evaluate({
    spec: command,
    module: gate.module,
    ...(selection === undefined || parameter === undefined
      ? {}
      : { params: { [parameter.name]: selected ?? selection.filter } }),
  });
  if (!decision.allowed) {
    return notExecuted(command.id, `denied by the command policy: ${decision.message}`, {
      gateId: gate.id,
      commandId: command.id,
      argv: [command.executable, ...command.args].map((arg) => redactor.redactText(arg)),
      cwd: command.cwd,
      reason: decision.reason,
      message: redactor.redactText(decision.message),
      ...(decision.fingerprint === undefined ? {} : { fingerprint: decision.fingerprint }),
    });
  }

  let executed: ExecutionResult;
  try {
    executed = await options.executor.run(decision.command, {
      logDir: options.logDir,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    return notExecuted(command.id, `${command.id} could not be started: ${error.message}`);
  }

  const record = executed.record;
  let parsed: ParsedCommandResults;
  try {
    parsed = await module.adapter.parseResults(
      command,
      record,
      withExecutionLogs(options.repo, executed),
    );
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    parsed = {
      parse: "unparseable",
      tests: [],
      diagnostics: [],
      evidence: [],
      note: `the results could not be read: ${error.message}`,
    };
  }
  const redacted = redactParsed(parsed, redactor);
  const decided = decideGate(command, record, redacted);
  return finish({
    result: GateResult.parse({
      gateId: gate.id,
      commandId: command.id,
      required: gate.required,
      status: decided.status,
      ...(decided.reason === undefined ? {} : { reason: redactor.redactText(decided.reason) }),
      execution: record,
      tests: redacted.tests,
      diagnostics: redacted.diagnostics,
      evidence: redacted.evidence,
    }),
  });
}

/**
 * The status of a gate whose command ran. In order: a timeout or an abnormal end is
 * `unverified`; a non-zero exit code is `failed`; with exit code 0, results that could not be
 * read are `unverified`, failed tests or error diagnostics are `failed`, tests without a
 * trustworthy result are `unverified`, a test command that ran no test is `unverified`, and one
 * whose tests were all skipped is `skipped`. Only what remains is `passed`.
 */
export function decideGate(
  command: CommandSpec,
  execution: ExecutionRecord,
  parsed: ParsedCommandResults,
): { status: ResultStatus; reason?: string } {
  const count = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
  const note = parsed.note === undefined ? "" : ` (${parsed.note})`;
  if (execution.timedOut) {
    return {
      status: "unverified",
      reason: `the command timed out after ${String(Math.round(command.timeoutMs / 1000))} s`,
    };
  }
  if (execution.exitCode === null) {
    return {
      status: "unverified",
      reason:
        execution.signal === null
          ? "the command did not exit normally (it may have been cancelled)"
          : `the command was ended by ${execution.signal}`,
    };
  }
  const failedTests = parsed.tests.filter((test) => test.status === "failed");
  const errors = parsed.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const untrusted = parsed.tests.filter(
    (test) => test.status === "unverified" || test.status === "not_executed",
  );
  if (execution.exitCode !== 0) {
    const details = [
      failedTests.length > 0 ? count(failedTests.length, "failed test") : undefined,
      untrusted.length > 0
        ? `${count(untrusted.length, "test")} without a trustworthy result`
        : undefined,
      errors.length > 0 ? count(errors.length, "error") : undefined,
    ].filter((part): part is string => part !== undefined);
    return {
      status: "failed",
      reason: `exit code ${String(execution.exitCode)}${details.length > 0 ? `: ${details.join(", ")}` : ""}${
        parsed.parse === "unparseable" ? `; the results could not be read${note}` : ""
      }`,
    };
  }
  if (parsed.parse === "unparseable") {
    return {
      status: "unverified",
      reason: `exit code 0, but the results could not be read${note}`,
    };
  }
  if (failedTests.length > 0) {
    return {
      status: "failed",
      reason: `exit code 0, but ${count(failedTests.length, "test")} failed`,
    };
  }
  if (errors.length > 0) {
    return {
      status: "failed",
      reason: `exit code 0, but the tool reported ${count(errors.length, "error")}`,
    };
  }
  if (untrusted.length > 0) {
    return {
      status: "unverified",
      reason: `${count(untrusted.length, "test")} ran without a trustworthy result`,
    };
  }
  if (command.purpose === "test") {
    if (parsed.tests.length === 0) {
      return { status: "unverified", reason: `the test command ran no tests${note}` };
    }
    if (parsed.tests.every((test) => test.status === "skipped")) {
      return {
        status: "skipped",
        reason: `all ${count(parsed.tests.length, "test")} were skipped`,
      };
    }
  }
  return { status: "passed" };
}

/**
 * The repository as the adapter's parser should see it after an execution: the command's
 * standard output and error logs are served from the executor's (redacted) output, whatever
 * the path guard allows for the log directory; everything else is the repository itself.
 */
export function withExecutionLogs(repo: RepositoryView, executed: ExecutionResult): RepositoryView {
  const logs = new Map<string, string>([
    [executed.record.stdoutPath, executed.stdout],
    [executed.record.stderrPath, executed.stderr],
  ]);
  return {
    root: repo.root,
    exists: (path) => (logs.has(path) ? Promise.resolve(true) : repo.exists(path)),
    readText: (path, readOptions) => {
      const log = logs.get(path);
      if (log === undefined) return repo.readText(path, readOptions);
      return Promise.resolve(log);
    },
    list: (directory): Promise<readonly RepositoryEntry[]> => repo.list(directory),
    glob: (patterns, globOptions) => repo.glob(patterns, globOptions),
  };
}

const MAX_MESSAGE = 8000;
const MAX_EXCERPT = 4000;

function redactParsed(
  parsed: ParsedCommandResults,
  redactor: SecretRedactor,
): ParsedCommandResults {
  const text = (value: string, max: number): string => redactor.redactText(value).slice(0, max);
  const tests: TestCaseResult[] = parsed.tests.map((test) =>
    test.message === undefined ? test : { ...test, message: text(test.message, MAX_MESSAGE) },
  );
  const diagnostics: Diagnostic[] = parsed.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    message: text(diagnostic.message, MAX_MESSAGE) || "(redacted)",
  }));
  const evidence: Evidence[] = parsed.evidence.map((item) => ({
    ...item,
    description: text(item.description, MAX_MESSAGE) || "(redacted)",
    ...(item.excerpt === undefined ? {} : { excerpt: text(item.excerpt, MAX_EXCERPT) }),
  }));
  return {
    ...parsed,
    tests,
    diagnostics,
    evidence,
    ...(parsed.note === undefined ? {} : { note: text(parsed.note, MAX_MESSAGE) }),
  };
}

/**
 * The overall result of a verification for the CLI: `passed` when every required gate passed;
 * `denied` when the required gates that did not pass were all stopped by the command policy;
 * otherwise `failed`. When only optional gates ran (selected by name), they count as required.
 * No gate at all is `failed`: nothing was verified.
 */
export function verificationOutcome(run: VerificationRun): "passed" | "denied" | "failed" {
  const required = run.gates.some((gate) => gate.required)
    ? run.gates.filter((gate) => gate.required)
    : run.gates;
  if (required.length === 0) return "failed";
  const notPassed = required.filter((gate) => gate.status !== "passed");
  if (notPassed.length === 0) return "passed";
  const denied = new Set(run.denials.map((denial) => denial.gateId));
  return notPassed.every((gate) => denied.has(gate.gateId)) ? "denied" : "failed";
}
