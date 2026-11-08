import path from "node:path";
import { createProvider } from "@devflow/ai";
import {
  DevflowError,
  ErrorCode,
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
} from "@devflow/core";
import type { ProgressEvent, WorkflowServices } from "@devflow/workflow";
import type { CliIo, Interruption } from "./io.js";
import { testRunnerFactory } from "./test-runner.js";
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

export interface ServiceOptions {
  /** Cassette file for the replay provider (`--cassette`, or `DEVFLOW_CASSETTE`). */
  readonly cassette?: string | undefined;
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly interruption?: Interruption | undefined;
  /** Command fingerprints approved for this invocation (`--allow`), for test mode. */
  readonly allow?: readonly string[] | undefined;
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
        io.createProvider !== undefined
          ? io.createProvider(name, cassette === undefined ? {} : { cassette })
          : createProvider({ name, env: io.env, ...(cassette === undefined ? {} : { cassette }) });
      providers.set(name, created);
    }
    return created;
  };
  return {
    guard: workspace.guard,
    redactor: workspace.redactor,
    config: workspace.config,
    trusted: workspace.trusted,
    devflowVersion: readCliVersion(),
    provider,
    testRunner: testRunnerFactory(workspace, io, {
      allow: options.allow ?? [],
      interactive: options.interactiveApproval === true,
      onGate: options.onGate,
    }),
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
