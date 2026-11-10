import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { javaAdapter } from "@devflow/adapter-java";
import { javascriptAdapter } from "@devflow/adapter-javascript";
import { pythonAdapter } from "@devflow/adapter-python";
import { WorkspaceRepository } from "@devflow/context";
import {
  AdapterRegistry,
  AuditLog,
  CommandPolicy,
  ContainerToolchainProbe,
  DevflowError,
  ErrorCode,
  Executor,
  PathToolchainProbe,
  TrustStore,
  VerificationSnapshot,
  compareSnapshots,
  defaultGates,
  defaultTrustStorePath,
  isDevflowError,
  resolveExecutionSettings,
  runGates,
  verificationOutcome,
  type CommandApprovalAnswer,
  type CommandApprovalRequest,
  type ExecutionBackendKind,
  type GateDefinition,
  type GateDenial,
  type GateResult,
  type SnapshotComparison,
  type VerificationRun,
  type WorkspaceModule,
} from "@devflow/core";
import { ExitCode } from "../exit-codes.js";
import { colorsFor, type CliIo, type Colors } from "../io.js";
import { readCliVersion } from "../version.js";
import { currentUser, openWorkspace } from "../workspace.js";

export interface VerifyOptions {
  /** Gate ids to run (`--gate`, repeatable); all gates when empty. */
  readonly gates: readonly string[];
  /** Command fingerprints approved for this invocation (`--allow`, repeatable). */
  readonly allow: readonly string[];
  /** A `verification.json` of an earlier verification to compare with. */
  readonly baseline?: string | undefined;
  /** `--backend`: where the commands run; it takes precedence over `execution.backend`. */
  readonly backend?: ExecutionBackendKind | undefined;
  readonly json: boolean;
}

type Outcome = "passed" | "failed" | "denied" | "interrupted";

/** The default of `context.maxFileBytes`, when there is no configuration. */
const DEFAULT_MAX_FILE_BYTES = 524_288;

/**
 * `devflow verify`: runs the workspace's verification gates (docs/specs/cli.md). Every command
 * goes through the command policy: the workspace must be trusted and each command approved,
 * interactively, by an earlier "always" approval, or with `--allow <fingerprint>`. The results
 * are saved to `.devflow/runs/verify/<time>/verification.json`, with the command logs and an
 * audit log next to it.
 */
export async function verifyCommand(options: VerifyOptions, io: CliIo): Promise<ExitCode> {
  try {
    return await verify(options, io);
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    if (options.json) {
      writeJson(io, { workspace: io.cwd, error: { code: error.code, message: error.message } });
    } else {
      io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    }
    return ExitCode.UsageError;
  }
}

async function verify(options: VerifyOptions, io: CliIo): Promise<ExitCode> {
  const workspace = await openWorkspace(io);
  // Everything that can make the command unusable is checked before anything runs.
  const baseline =
    options.baseline === undefined ? undefined : await readBaseline(options.baseline, io.cwd);
  const trust = await TrustStore.open(defaultTrustStorePath(io.env));

  const { config, guard } = workspace;
  const execution = resolveExecutionSettings({ flag: options.backend, config: config?.execution });
  const repo = new WorkspaceRepository(guard, {
    maxFileBytes: config?.context.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    exclude: config?.context.exclude ?? [],
  });
  const registry = new AdapterRegistry([javaAdapter, javascriptAdapter, pythonAdapter]);
  const declared = config?.modules;
  const discovery = await registry.discover(repo, declared === undefined ? {} : { declared });
  const toolchain =
    execution.backend === "container"
      ? new ContainerToolchainProbe()
      : new PathToolchainProbe({ env: io.env });
  const notices = [...workspace.warnings, ...discovery.warnings];

  const configured = config?.verification.gates ?? [];
  let gates: GateDefinition[] =
    configured.length > 0
      ? configured.map((gate) => ({ ...gate }))
      : await defaultGates(discovery.modules, repo, toolchain);
  if (configured.length === 0 && gates.length > 0) {
    notices.push(
      "no gates are configured (verification.gates in .devflow/config.yaml): running the test command of each module",
    );
  }
  if (options.gates.length > 0) {
    const unknown = options.gates.filter((id) => !gates.some((gate) => gate.id === id));
    if (unknown.length > 0) {
      throw new DevflowError(
        ErrorCode.GateNotFound,
        `no gate ${unknown.map((id) => `"${id}"`).join(", ")} (gates: ${gates.map((gate) => gate.id).join(", ") || "none"})`,
        { details: { unknown, gates: gates.map((gate) => gate.id) } },
      );
    }
    gates = gates.filter((gate) => options.gates.includes(gate.id));
  }

  if (gates.length === 0) {
    const reason =
      discovery.modules.length === 0
        ? "no module was found, and no gate is configured"
        : "no gate is configured, and no module has a test command DevFlow can run";
    if (options.json) {
      writeJson(io, {
        workspace: workspace.root,
        outcome: "failed",
        reason,
        verification: null,
        modules: modulesJson(discovery.modules),
        warnings: notices,
        gates: [],
        denials: [],
        comparison: null,
      });
    } else {
      for (const notice of notices) io.stderr.write(`warning: ${notice}\n`);
      io.stdout.write(`Nothing to verify: ${reason}.\n`);
    }
    return ExitCode.Failure;
  }

  const createdAt = new Date();
  const runDir = `.devflow/runs/verify/${createdAt.toISOString().replace(/[:.]/g, "-")}`;
  const internal = { access: "write", origin: "internal" } as const;
  const audit = await AuditLog.open(
    (await guard.check(`${runDir}/audit.jsonl`, internal)).absolute,
    { redactor: workspace.redactor },
  );
  const interactive = !options.json && io.prompt !== undefined;
  const policy = new CommandPolicy({
    guard,
    trust,
    configSha256: workspace.configSha256,
    approvedBy: currentUser(io.env),
    allowlist: options.allow,
    audit,
    execution,
    ...(interactive ? { approver: (request) => askApproval(request, io) } : {}),
  });
  // The executor runs each command where its approval says: on the host or in a container.
  const executor = new Executor({ guard, redactor: workspace.redactor, audit, env: io.env });

  if (!options.json) {
    for (const notice of notices) io.stderr.write(`warning: ${notice}\n`);
  }
  const interruption = io.interrupts?.();
  let run: VerificationRun;
  try {
    run = await runGates(gates, {
      repo,
      modules: discovery.modules,
      policy,
      executor,
      toolchain,
      redactor: workspace.redactor,
      logDir: `${runDir}/logs`,
      ...(interruption === undefined ? {} : { signal: interruption.signal }),
      onEvent: (event) => {
        if (options.json || event.type !== "gate-started") return;
        const command = event.commandId === undefined ? "" : ` (${event.commandId})`;
        io.stderr.write(`Running gate ${event.gate.id}${command}...\n`);
      },
    });
  } finally {
    interruption?.dispose();
  }

  const snapshot = VerificationSnapshot.parse({
    version: 1,
    createdAt: createdAt.toISOString(),
    devflowVersion: readCliVersion(),
    gates: run.gates,
  });
  const snapshotPath = `${runDir}/verification.json`;
  const snapshotFile = await guard.check(snapshotPath, internal);
  await mkdir(path.dirname(snapshotFile.absolute), { recursive: true });
  await writeFile(snapshotFile.absolute, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  const comparison = baseline === undefined ? undefined : compareSnapshots(baseline, snapshot);

  const outcome: Outcome =
    interruption?.signal.aborted === true ? "interrupted" : verificationOutcome(run);
  if (options.json) {
    writeJson(io, {
      workspace: workspace.root,
      outcome,
      verification: snapshotPath,
      modules: modulesJson(discovery.modules),
      warnings: notices,
      gates: run.gates,
      denials: run.denials,
      comparison: comparison ?? null,
    });
  } else {
    const c = colorsFor(io.stdout, io.env);
    const lines = renderRun(workspace.root, discovery.modules, run, c);
    if (execution.backend === "container") {
      lines.splice(2, 0, `${c.bold("Backend:")}   container ${execution.image} (no network)`);
    }
    if (comparison !== undefined && options.baseline !== undefined) {
      lines.push("", ...renderComparison(options.baseline, comparison, c));
    }
    lines.push("", `Saved:  ${snapshotPath}`, `Result: ${renderOutcome(outcome, run, c)}`);
    io.stdout.write(`${lines.join("\n")}\n`);
  }
  switch (outcome) {
    case "passed":
      return ExitCode.Success;
    case "denied":
      return ExitCode.PolicyDenied;
    case "interrupted":
      return ExitCode.Interrupted;
    case "failed":
      return ExitCode.Failure;
  }
}

async function readBaseline(file: string, cwd: string): Promise<VerificationSnapshot> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path.resolve(cwd, file), "utf8"));
  } catch (error) {
    throw new DevflowError(
      ErrorCode.VerificationBaselineInvalid,
      `the baseline ${file} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
      { details: { path: file }, cause: error },
    );
  }
  const parsed = VerificationSnapshot.safeParse(data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DevflowError(
      ErrorCode.VerificationBaselineInvalid,
      `the baseline ${file} is not a verification.json saved by devflow verify` +
        (issue === undefined ? "" : ` (${issue.path.join(".") || "root"}: ${issue.message})`),
      { details: { path: file } },
    );
  }
  return parsed.data;
}

/** Shows the command about to run, then asks once, always (for this workspace) or no. */
export async function askApproval(
  request: CommandApprovalRequest,
  io: CliIo,
): Promise<CommandApprovalAnswer> {
  const prompt = io.prompt;
  if (prompt === undefined) return "reject";
  const c = colorsFor(io.stderr, io.env);
  const lines = [
    "",
    `${c.bold("Command approval:")} ${request.commandId}`,
    `  Runs:        ${request.argv.join(" ")}`,
    `  In:          ${request.cwd}`,
    ...request.bindings.map(
      (binding) =>
        `  Executes:    ${binding.path} (${binding.kind}${binding.kind === "file" ? `, sha256 ${binding.sha256.slice(0, 12)}...` : ""})`,
    ),
    ...(request.target.backend === "container"
      ? [
          `  Container:   ${request.target.image} (no network, ${String(request.target.cpus)} CPUs, ${request.target.memory} memory)`,
          `  Fingerprint: ${request.fingerprint}`,
          "  It runs in a container without network access, but it can read and change the workspace.",
        ]
      : [
          `  Fingerprint: ${request.fingerprint}`,
          "  It runs with your privileges and can read your files and reach the network.",
        ]),
    "",
  ];
  io.stderr.write(lines.join("\n"));
  const answer = (await prompt("Run it? [o]nce, [a]lways in this workspace, [N]o: ")).trim();
  if (/^o(nce)?$/i.test(answer)) return "approve-once";
  if (/^a(lways)?$/i.test(answer)) return "approve-always";
  return "reject";
}

function modulesJson(modules: readonly WorkspaceModule[]) {
  return modules.map((module) => ({
    id: module.profile.moduleId,
    adapter: module.profile.adapterId,
    root: module.profile.root,
  }));
}

const STATUS_LABEL: Record<GateResult["status"], string> = {
  passed: "PASSED",
  failed: "FAILED",
  skipped: "SKIPPED",
  not_executed: "NOT EXECUTED",
  unverified: "UNVERIFIED",
};

function statusColor(status: GateResult["status"], c: Colors): (text: string) => string {
  switch (status) {
    case "passed":
      return c.green;
    case "failed":
      return c.red;
    case "skipped":
    case "not_executed":
    case "unverified":
      return c.yellow;
  }
}

const MAX_LISTED = 10;

function renderRun(
  root: string,
  modules: readonly WorkspaceModule[],
  run: VerificationRun,
  c: Colors,
): string[] {
  const out = [
    `${c.bold("Workspace:")} ${root}`,
    `${c.bold("Modules:")}   ${
      modules
        .map((m) => `${m.profile.moduleId} (${m.profile.adapterId}, ${m.profile.root})`)
        .join(", ") || "none found"
    }`,
    "",
  ];
  const indent = " ".repeat(14);
  for (const gate of run.gates) {
    const duration =
      gate.execution === undefined ? "" : `, ${(gate.execution.durationMs / 1000).toFixed(1)} s`;
    const optional = gate.required ? "" : ", optional";
    out.push(
      `${statusColor(gate.status, c)(STATUS_LABEL[gate.status].padEnd(14))}${c.bold(gate.gateId)} (${gate.commandId}${duration}${optional})`,
    );
    const summary = testSummary(gate);
    if (summary !== undefined) out.push(`${indent}${summary}`);
    if (gate.reason !== undefined) out.push(`${indent}${gate.reason}`);
    const failed = gate.tests.filter((test) => test.status === "failed");
    for (const test of failed.slice(0, MAX_LISTED)) {
      const message = test.message?.split("\n")[0]?.slice(0, 200);
      out.push(
        `${indent}- ${test.id}${message === undefined || message === "" ? "" : `: ${message}`}`,
      );
    }
    if (failed.length > MAX_LISTED) {
      out.push(`${indent}... and ${String(failed.length - MAX_LISTED)} more failed tests`);
    }
    const errors = gate.diagnostics.filter((d) => d.severity === "error");
    for (const diagnostic of errors.slice(0, MAX_LISTED)) {
      const where =
        diagnostic.location === undefined
          ? ""
          : `${diagnostic.location.path}${diagnostic.location.line === undefined ? "" : `:${String(diagnostic.location.line)}`} `;
      out.push(`${indent}- ${where}${diagnostic.message.split("\n")[0]?.slice(0, 200) ?? ""}`);
    }
    if (errors.length > MAX_LISTED) {
      out.push(`${indent}... and ${String(errors.length - MAX_LISTED)} more errors`);
    }
  }
  const hints = approvalHints(run.denials, c);
  if (hints.length > 0) out.push("", ...hints);
  return out;
}

function testSummary(gate: GateResult): string | undefined {
  const parts: string[] = [];
  if (gate.tests.length > 0) {
    const count = (status: GateResult["status"]) =>
      gate.tests.filter((test) => test.status === status).length;
    const counts = [
      ["passed", count("passed")],
      ["failed", count("failed")],
      ["skipped", count("skipped")],
      ["not executed", count("not_executed")],
      ["unverified", count("unverified")],
    ] as const;
    parts.push(
      `${String(gate.tests.length)} test${gate.tests.length === 1 ? "" : "s"}: ${counts
        .filter(([, n]) => n > 0)
        .map(([label, n]) => `${String(n)} ${label}`)
        .join(", ")}`,
    );
  }
  if (gate.diagnostics.length > 0) {
    const errors = gate.diagnostics.filter((d) => d.severity === "error").length;
    const warnings = gate.diagnostics.filter((d) => d.severity === "warning").length;
    parts.push(
      `${String(errors)} error${errors === 1 ? "" : "s"}, ${String(warnings)} warning${warnings === 1 ? "" : "s"}`,
    );
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

function approvalHints(denials: readonly GateDenial[], c: Colors): string[] {
  const out: string[] = [];
  if (denials.some((denial) => denial.reason === "workspace-untrusted")) {
    out.push(
      `${c.yellow("The workspace is not trusted.")} Review it with ${c.bold("devflow trust")}, then run devflow verify again.`,
    );
  }
  const unapproved = denials.filter((denial) => denial.reason === "approval-required");
  if (unapproved.length > 0) {
    out.push(
      `${c.yellow("Commands need approval.")} Review each one, then approve it when devflow verify asks on a terminal, or pass its fingerprint:`,
    );
    for (const denial of unapproved) {
      out.push(
        `  ${denial.commandId}: ${denial.argv.join(" ")}`,
        `    in ${denial.cwd}`,
        `    --allow ${denial.fingerprint ?? "(no fingerprint)"}`,
      );
    }
  }
  return out;
}

function renderComparison(baseline: string, comparison: SnapshotComparison, c: Colors): string[] {
  const plural = (n: number, noun: string) => `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
  const out = [
    `${c.bold("Compared with")} ${baseline}: ${plural(comparison.regressions.length, "regression")}, ${String(comparison.fixed.length)} fixed, ${String(comparison.stillFailing.length)} still failing, ${String(comparison.added.length)} new, ${String(comparison.missing.length)} no longer reported`,
  ];
  for (const change of comparison.regressions.slice(0, MAX_LISTED)) {
    out.push(`  ${c.red("regression")} ${change.gateId}: ${change.testId}`);
  }
  for (const change of comparison.fixed.slice(0, MAX_LISTED)) {
    out.push(`  ${c.green("fixed")}      ${change.gateId}: ${change.testId}`);
  }
  for (const gateId of comparison.commandChanges) {
    out.push(`  ${c.yellow("note")}       ${gateId} ran a different command than in the baseline`);
  }
  return out;
}

function renderOutcome(outcome: Outcome, run: VerificationRun, c: Colors): string {
  const required = run.gates.some((gate) => gate.required)
    ? run.gates.filter((gate) => gate.required)
    : run.gates;
  const passed = required.filter((gate) => gate.status === "passed").length;
  const of = `${String(passed)} of ${String(required.length)} gate${required.length === 1 ? "" : "s"} passed`;
  switch (outcome) {
    case "passed":
      return `${c.green("PASSED")} (${of})`;
    case "denied":
      return `${c.yellow("DENIED BY POLICY")} (${of}; not allowed to run: ${run.denials.map((denial) => denial.gateId).join(", ")})`;
    case "interrupted":
      return `${c.yellow("INTERRUPTED")} (${of})`;
    case "failed":
      return `${c.red("FAILED")} (${of})`;
  }
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
