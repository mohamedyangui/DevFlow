import path from "node:path";
import {
  PathGuard,
  TrustStore,
  defaultTrustStorePath,
  formatIssuePath,
  isDevflowError,
  loadProjectConfig,
  type LoadedProjectConfig,
  type WorkspaceTrustEntry,
  type WorkspaceTrustStatus,
} from "@devflow/core";
import { ExitCode } from "../exit-codes.js";
import { colorsFor, type CliIo, type Colors } from "../io.js";

export interface TrustOptions {
  readonly yes: boolean;
  readonly revoke: boolean;
  readonly status: boolean;
  readonly json: boolean;
}

/** What remains true even for a trusted workspace (ADR 0007), shown before every decision. */
export const RESIDUAL_RISKS: readonly string[] = [
  "A trusted build runs arbitrary code with your privileges. DevFlow makes execution explicit, approved, time-bounded and scrubbed of secrets from the environment; it cannot make a malicious build safe.",
  "There is no network or file-system isolation in local mode. A build can read files outside the workspace (for example ~/.ssh) and reach the network.",
  "Trust is a point-in-time decision. New commits can change test code and dependencies without changing .devflow/config.yaml; command fingerprints only catch changed scripts and wrappers.",
  "DevFlow never installs dependencies, but installs you ran earlier may already have run lifecycle scripts.",
];

type TrustAction =
  | "status"
  | "trusted"
  | "already-trusted"
  | "declined"
  | "confirmation-required"
  | "invalid-config"
  | "revoked"
  | "not-trusted";

interface Review {
  readonly workspace: string;
  readonly store: TrustStore;
  readonly config: LoadedProjectConfig;
}

/**
 * `devflow trust [directory]`: review the workspace configuration and trust it, show the trust
 * status, or revoke trust (ADR 0007). Trust is stored outside the repository, in
 * `$DEVFLOW_HOME/trust.json` or `~/.devflow/trust.json`, and is bound to the exact bytes of
 * `.devflow/config.yaml` that were reviewed.
 */
export async function trustCommand(
  directory: string | undefined,
  options: TrustOptions,
  io: CliIo,
): Promise<ExitCode> {
  const requested = path.resolve(io.cwd, directory ?? ".");
  let review: Review;
  try {
    const guard = await PathGuard.create(requested);
    const config = await loadProjectConfig(guard);
    const store = await TrustStore.open(defaultTrustStorePath(io.env));
    review = { workspace: guard.root, store, config };
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    if (options.json) {
      writeJson(io, { workspace: requested, error: { code: error.code, message: error.message } });
    } else {
      io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    }
    return ExitCode.UsageError;
  }

  if (options.revoke) {
    const removed = await review.store.revokeWorkspace(review.workspace);
    return finish(io, options, review, removed ? "revoked" : "not-trusted", ExitCode.Success);
  }
  if (options.status) {
    const trusted = statusOf(review) === "trusted";
    return finish(io, options, review, "status", trusted ? ExitCode.Success : ExitCode.Failure);
  }

  if (!review.config.valid) {
    return finish(io, options, review, "invalid-config", ExitCode.Failure);
  }
  if (statusOf(review) === "trusted") {
    return finish(io, options, review, "already-trusted", ExitCode.Success);
  }

  if (options.yes) {
    await trust(review, io);
    return finish(io, options, review, "trusted", ExitCode.Success);
  }
  // Without --yes, only an interactive terminal can confirm; JSON output never prompts.
  if (options.json || io.prompt === undefined) {
    return finish(io, options, review, "confirmation-required", ExitCode.Failure);
  }
  io.stdout.write(`${renderReview(review, colorsFor(io.stdout, io.env)).join("\n")}\n\n`);
  const answer = await io.prompt("Trust this workspace for this configuration? [y/N] ");
  if (!/^\s*y(es)?\s*$/i.test(answer)) {
    return finish(io, options, review, "declined", ExitCode.Failure, { reviewShown: true });
  }
  await trust(review, io);
  return finish(io, options, review, "trusted", ExitCode.Success, { reviewShown: true });
}

async function trust(review: Review, io: CliIo): Promise<void> {
  const by = io.env.USER ?? io.env.USERNAME ?? "unknown";
  // Bound to the hash of the bytes that were reviewed: if the file changed since, the
  // workspace shows as "config-changed" and must be reviewed again.
  await review.store.trustWorkspace(review.workspace, review.config.sha256, by);
}

function statusOf(review: Review): WorkspaceTrustStatus {
  return review.store.workspaceStatus(review.workspace, review.config.sha256);
}

function finish(
  io: CliIo,
  options: TrustOptions,
  review: Review,
  action: TrustAction,
  code: ExitCode,
  flags: { reviewShown?: boolean } = {},
): ExitCode {
  if (options.json) {
    writeJson(io, toJson(review, action));
  } else {
    renderHuman(io, review, action, flags.reviewShown === true);
  }
  return code;
}

function toJson(review: Review, action: TrustAction): unknown {
  const entry = review.store.workspace(review.workspace);
  const { config } = review;
  return {
    workspace: review.workspace,
    trustStore: review.store.file,
    action,
    status: statusOf(review),
    config: {
      path: config.path,
      exists: config.exists,
      sha256: config.sha256,
      valid: config.valid,
      issues: config.issues.map((issue) => ({ ...issue, location: formatIssuePath(issue.path) })),
      modules: config.config?.modules ?? null,
      gates: config.config?.verification.gates ?? [],
      additionalProtectedPaths: config.config?.security.additionalProtectedPaths ?? [],
    },
    trustedAt: entry?.trustedAt ?? null,
    trustedBy: entry?.trustedBy ?? null,
    commands: entry?.commands ?? [],
    residualRisks: RESIDUAL_RISKS,
  };
}

function renderHuman(io: CliIo, review: Review, action: TrustAction, reviewShown: boolean): void {
  const c = colorsFor(io.stdout, io.env);
  const out: string[] = [];
  const entry = review.store.workspace(review.workspace);
  switch (action) {
    case "status":
      out.push(...renderStatus(review, entry, c));
      break;
    case "revoked":
      out.push(`${c.bold("Workspace:")} ${review.workspace}`);
      out.push(`Trust ${c.green("revoked")}, with every command approval of this workspace.`);
      break;
    case "not-trusted":
      out.push(`${c.bold("Workspace:")} ${review.workspace}`);
      out.push("The workspace was not trusted; nothing to revoke.");
      break;
    case "already-trusted":
      out.push(...renderStatus(review, entry, c));
      out.push("", "Already trusted for this configuration. Nothing changed.");
      break;
    case "invalid-config":
      out.push(...renderReview(review, c));
      out.push(
        "",
        `${c.red("Not trusted:")} the configuration is invalid. Fix it, then run devflow trust again.`,
      );
      break;
    case "confirmation-required":
      out.push(...renderReview(review, c));
      out.push(
        "",
        `${c.yellow("Not trusted yet.")} Review the above, then run ${c.bold("devflow trust --yes")} to confirm.`,
      );
      break;
    case "declined":
      out.push("Declined. The workspace is not trusted.");
      break;
    case "trusted":
      if (!reviewShown) out.push(...renderReview(review, c), "");
      out.push(
        `${c.green("Trusted.")} Each command is still approved separately the first time it runs.`,
      );
      break;
  }
  io.stdout.write(`${out.join("\n")}\n`);
}

function renderStatus(
  review: Review,
  entry: Readonly<WorkspaceTrustEntry> | undefined,
  c: Colors,
): string[] {
  const out = header(review, c);
  const status = statusOf(review);
  if (status === "trusted" && entry !== undefined) {
    out.push(
      `${c.bold("Status:")}      ${c.green("TRUSTED")} since ${entry.trustedAt} by ${entry.trustedBy}`,
    );
  } else if (status === "config-changed" && entry !== undefined) {
    out.push(
      `${c.bold("Status:")}      ${c.yellow("CONFIG CHANGED")} since it was trusted on ${entry.trustedAt}; run devflow trust to review it again`,
    );
  } else {
    out.push(`${c.bold("Status:")}      ${c.red("UNTRUSTED")}`);
  }
  if (status === "trusted" && entry !== undefined) {
    out.push(
      `${c.bold("Approved commands:")} ${entry.commands.length === 0 ? "none" : ""}`.trimEnd(),
    );
    for (const command of entry.commands) {
      out.push(
        `  ${command.commandId}  ${command.summary}  ${c.dim(`(${command.approvedAt} by ${command.approvedBy})`)}`,
      );
    }
  }
  return out;
}

function header(review: Review, c: Colors): string[] {
  const { config } = review;
  const out = [
    `${c.bold("Workspace:")}   ${review.workspace}`,
    `${c.bold("Trust store:")} ${review.store.file}`,
  ];
  if (!config.exists) {
    out.push(`${c.bold("Config:")}      none (${config.path} is absent; defaults apply)`);
  } else {
    out.push(`${c.bold("Config:")}      ${config.path}`);
    out.push(`${c.bold("SHA-256:")}     ${config.sha256 ?? ""}`);
  }
  return out;
}

/** The facts a user reviews before trusting a workspace. */
function renderReview(review: Review, c: Colors): string[] {
  const out = header(review, c);
  const { config } = review;
  const status = statusOf(review);
  out.push(
    `${c.bold("Status:")}      ${status === "config-changed" ? c.yellow("CONFIG CHANGED since it was last trusted") : c.red("UNTRUSTED")}`,
  );

  if (!config.valid) {
    out.push("", c.bold("Configuration problems:"));
    for (const issue of config.issues) {
      const where = [
        issue.line === undefined ? undefined : `line ${String(issue.line)}`,
        issue.path.length === 0 ? undefined : formatIssuePath(issue.path),
      ]
        .filter((part) => part !== undefined)
        .join("  ");
      out.push(`  ${c.red(issue.severity)}  ${c.dim(issue.code)}  ${where}`.trimEnd());
      out.push(`      ${issue.message}`);
    }
    return out;
  }

  const settings = config.config;
  if (settings !== undefined) {
    out.push("", c.bold("What this configuration enables:"));
    const modules = settings.modules;
    out.push(
      `  Modules: ${
        modules === undefined
          ? "auto-detected"
          : modules.map((m) => `${m.id} (${m.path}, ${m.adapter})`).join(", ")
      }`,
    );
    const gates = settings.verification.gates;
    if (gates.length === 0) {
      out.push("  Gates:   none configured");
    } else {
      out.push("  Gates:");
      for (const gate of gates) {
        out.push(
          `    ${gate.id}: ${gate.use} in module ${gate.module}${gate.required ? "" : " (optional)"}`,
        );
      }
    }
    const extra = settings.security.additionalProtectedPaths;
    if (extra.length > 0) out.push(`  Extra protected paths: ${extra.join(", ")}`);
  }

  out.push(
    "",
    "Trusting lets DevFlow run build, test, lint and analysis commands in this workspace.",
    "Each command is still approved separately the first time, showing its exact arguments,",
    "working directory and the script or wrapper it runs. Editing the configuration revokes trust.",
    "",
    c.bold("Residual risks, even for a trusted workspace:"),
    ...RESIDUAL_RISKS.map((risk) => `  - ${risk}`),
  );
  return out;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
