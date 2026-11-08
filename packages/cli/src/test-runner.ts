import { javaAdapter } from "@devflow/adapter-java";
import { javascriptAdapter } from "@devflow/adapter-javascript";
import { WorkspaceRepository } from "@devflow/context";
import {
  AdapterRegistry,
  CommandPolicy,
  Executor,
  PathToolchainProbe,
  TrustStore,
  defaultGates,
  defaultTrustStorePath,
  runGates,
  type GateDefinition,
} from "@devflow/core";
import type { TestRunner } from "@devflow/workflow";
import { askApproval } from "./commands/verify.js";
import type { CliIo } from "./io.js";
import { type Workspace, currentUser } from "./workspace.js";

/** The default of `context.maxFileBytes`, when there is no configuration. */
const DEFAULT_MAX_FILE_BYTES = 524_288;

export interface TestRunnerOptions {
  /** Command fingerprints approved for this invocation (`--allow`). */
  readonly allow: readonly string[];
  /** Ask on the terminal before running a command that is not approved yet. */
  readonly interactive: boolean;
  /** Reports each gate as it starts. */
  readonly onGate?: ((gateId: string, commandId: string | undefined) => void) | undefined;
}

/**
 * Test mode's runner, as `devflow verify` runs gates: the modules come from the language
 * adapters, and every command goes through the command policy (workspace trust, then an
 * approval: interactive, an earlier "always", or `--allow <fingerprint>`). The policy writes
 * its decisions to the run's audit log.
 */
export function testRunnerFactory(
  workspace: Workspace,
  io: CliIo,
  options: TestRunnerOptions,
): () => Promise<TestRunner> {
  return async () => {
    const { config, guard } = workspace;
    const repo = new WorkspaceRepository(guard, {
      maxFileBytes: config?.context.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      exclude: config?.context.exclude ?? [],
    });
    const registry = new AdapterRegistry([javaAdapter, javascriptAdapter]);
    const declared = config?.modules;
    const discovery = await registry.discover(repo, declared === undefined ? {} : { declared });
    const toolchain = new PathToolchainProbe({ env: io.env });
    return {
      modules: discovery.modules,
      gates: async (): Promise<readonly GateDefinition[]> => {
        const configured = config?.verification.gates ?? [];
        return configured.length > 0
          ? configured.map((gate) => ({ ...gate }))
          : defaultGates(discovery.modules, repo, toolchain);
      },
      run: async (gates, context) => {
        const trust = await TrustStore.open(defaultTrustStorePath(io.env));
        const policy = new CommandPolicy({
          guard,
          trust,
          configSha256: workspace.configSha256,
          approvedBy: currentUser(io.env),
          allowlist: options.allow,
          audit: context.audit,
          ...(options.interactive && io.prompt !== undefined
            ? { approver: (request) => askApproval(request, io) }
            : {}),
        });
        const executor = new Executor({
          guard,
          redactor: workspace.redactor,
          audit: context.audit,
          env: io.env,
        });
        return runGates(gates, {
          repo,
          modules: discovery.modules,
          policy,
          executor,
          toolchain,
          redactor: workspace.redactor,
          logDir: context.logDir,
          ...(context.signal === undefined ? {} : { signal: context.signal }),
          onEvent: (event) => {
            if (event.type === "gate-started") options.onGate?.(event.gate.id, event.commandId);
          },
        });
      },
    };
  };
}
