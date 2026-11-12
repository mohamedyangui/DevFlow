import path from "node:path";
import { AgentProvider, createProvider } from "@devflow-ai/ai";
import {
  DevflowError,
  ErrorCode,
  type ExecutionBackendKind,
  GitClient,
  PathGuard,
  type ProjectConfig,
  SecretRedactor,
  TrustStore,
  credentialValuesFromEnv,
  defaultTrustStorePath,
  formatIssuePath,
  isDevflowError,
  type LlmProvider,
  loadProjectConfig,
  resolveExecutionSettings,
} from "@devflow-ai/core";
import type { ProgressEvent, WorkflowServices } from "@devflow-ai/workflow";
import type { CliIo, Interruption } from "./io.js";
import { contractToolsFactory, testRunnerFactory } from "./test-runner.js";
import { readCliVersion } from "./version.js";

/** The workspace a workflow command runs in: the current directory (run it from the root). */
export interface Workspace {
  readonly root: string;
  readonly guard: PathGuard;
  readonly config: ProjectConfig | undefined;
  readonly configExists: boolean;
  readonly configSha256: string | null;
  readonly trusted: boolean;
  readonly redactor: SecretRedactor;
  /** Problems found while opening the workspace that do not stop the command. */
  readonly warnings: readonly string[];
}

/**
 * Opens the workspace: loads `.devflow/config.yaml`, checks workspace trust and builds the path
 * guard with the configuration's extra protected paths. An invalid configuration stops the
 * command: its restrictions could not be applied.
 */
export async function openWorkspace(io: CliIo): Promise<Workspace> {
  const plain = await PathGuard.create(io.cwd);
  const loaded = await loadProjectConfig(plain);
  if (!loaded.valid) {
    const first = loaded.issues[0];
    const where =
      first === undefined
        ? ""
        : ` (${[first.line === undefined ? undefined : `line ${String(first.line)}`, formatIssuePath(first.path) || undefined].filter((part) => part !== undefined).join(", ")})`;
    throw new DevflowError(
      ErrorCode.ConfigFileUnreadable,
      `${loaded.path} is invalid${where}: ${first?.message ?? "unknown problem"}; ` +
        "run `devflow trust --status` to see every problem",
      { details: { path: loaded.path, issues: loaded.issues.length } },
    );
  }
  const warnings: string[] = [];
  let trusted = false;
  try {
    const store = await TrustStore.open(defaultTrustStorePath(io.env));
    trusted = store.workspaceStatus(plain.root, loaded.sha256) === "trusted";
  } catch (error) {
    if (!isDevflowError(error) || error.code !== ErrorCode.TrustStoreInvalid) throw error;
    warnings.push(`${error.message}; the workspace is treated as untrusted`);
  }
  const guard = await PathGuard.create(plain.root, {
    additionalProtectedPaths: loaded.config?.security.additionalProtectedPaths ?? [],
  });
  return {
    root: guard.root,
    guard,
    config: loaded.config,
    configExists: loaded.exists,
    configSha256: loaded.sha256,
    trusted,
    redactor: new SecretRedactor({ knownSecrets: credentialValuesFromEnv(io.env) }),
    warnings,
  };
}

/** Where agent mode keeps the model requests and the agent's answers (ADR 0027). */
export function agentDirectory(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".devflow", "agent");
}

export interface ServiceOptions {
  /** Cassette file for the replay provider (`--cassette`, or `DEVFLOW_CASSETTE`). */
  readonly cassette?: string | undefined;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly interruption?: Interruption | undefined;
  /** Command fingerprints approved for this invocation (`--allow`), for test mode. */
  readonly allow?: readonly string[] | undefined;
  /** `--backend`: where gate commands run; it takes precedence over `execution.backend`. */
  readonly backend?: ExecutionBackendKind | undefined;
  /** Ask on the terminal before running a command that is not approved yet. */
  readonly interactiveApproval?: boolean | undefined;
  /** Reports each verification gate as it starts. */
  readonly onGate?: ((gateId: string, commandId: string | undefined) => void) | undefined;
}

export function workflowServices(
  workspace: Workspace,
  io: CliIo,
  options: ServiceOptions = {},
): WorkflowServices {
  const cassetteOption = options.cassette ?? io.env.DEVFLOW_CASSETTE;
  const cassette =
    cassetteOption === undefined || cassetteOption.trim() === ""
      ? undefined
      : path.resolve(io.cwd, cassetteOption);
  // One provider per name for the whole command, so it can be checked before a run starts.
  const providers = new Map<string, Promise<LlmProvider>>();
  const provider = (name: string): Promise<LlmProvider> => {
    let created = providers.get(name);
    if (created === undefined) {
      created =
        name === "agent"
          ? Promise.resolve(new AgentProvider({ directory: agentDirectory(workspace.root) }))
          : io.createProvider !== undefined
            ? io.createProvider(name, cassette === undefined ? {} : { cassette })
            : createProvider({
                name,
                env: io.env,
                ...(cassette === undefined ? {} : { cassette }),
              });
      providers.set(name, created);
    }
    return created;
  };
  // Resolved now, so a container backend without an image fails before a run starts.
  const execution = resolveExecutionSettings({
    flag: options.backend,
    config: workspace.config?.execution,
  });
  return {
    guard: workspace.guard,
    redactor: workspace.redactor,
    config: workspace.config,
    trusted: workspace.trusted,
    devflowVersion: readCliVersion(),
    provider,
    testRunner: testRunnerFactory(workspace, io, {
      allow: options.allow ?? [],
      execution,
      interactive: options.interactiveApproval === true,
      onGate: options.onGate,
    }),
    // `oasdiff` and `buf` run on the host only: with the container backend, nothing runs on
    // the host and the built-in rules decide (ADR 0021).
    ...(execution.backend === "local"
      ? {
          contractTools: contractToolsFactory(workspace, io, {
            allow: options.allow ?? [],
            interactive: options.interactiveApproval === true,
          }),
        }
      : {}),
    // DevFlow's own fixed git calls (ADR 0012); git is looked up outside the workspace.
    git: new GitClient({ root: workspace.guard.root, env: io.env }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    ...(options.interruption === undefined ? {} : { signal: options.interruption.signal }),
  };
}

/** Who made a decision, for the audit log: `DEVFLOW_USER`, then the operating-system user. */
export function currentUser(env: CliIo["env"]): string {
  for (const name of ["DEVFLOW_USER", "USER", "USERNAME"]) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return "unknown";
}
