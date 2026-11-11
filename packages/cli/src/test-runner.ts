import { WorkspaceRepository } from "@devflow/context";
import {
  CommandPolicy,
  ContainerToolchainProbe,
  Executor,
  PathToolchainProbe,
  TrustStore,
  defaultGates,
  defaultTrustStorePath,
  joinRepoPath,
  runGate,
  runGates,
  type AuditLog,
  type ExecutionSettings,
  type GateDefinition,
  type ModuleProfile,
  type WorkspaceModule,
} from "@devflow/core";
import type { TestRunner, WorkflowServices } from "@devflow/workflow";
import { workspaceAdapters } from "./adapters.js";
import { askApproval } from "./commands/verify.js";
import type { CliIo } from "./io.js";
import { type Workspace, currentUser } from "./workspace.js";

/** The default of `context.maxFileBytes`, when there is no configuration. */
const DEFAULT_MAX_FILE_BYTES = 524_288;

export interface TestRunnerOptions {
  /** Command fingerprints approved for this invocation (`--allow`). */
  readonly allow: readonly string[];
  /** Where gate commands run (ADR 0020), resolved from `--backend` and the configuration. */
  readonly execution: ExecutionSettings;
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
    const { registry } = await workspaceAdapters(io.env);
    const declared = config?.modules;
    const discovery = await registry.discover(repo, declared === undefined ? {} : { declared });
    const toolchain =
      options.execution.backend === "container"
        ? new ContainerToolchainProbe()
        : new PathToolchainProbe({ env: io.env });
    return {
      modules: discovery.modules,
      gates: async (): Promise<readonly GateDefinition[]> => {
        const configured = config?.verification.gates ?? [];
        return configured.length > 0
          ? configured.map((gate) => ({ ...gate }))
          : defaultGates(discovery.modules, repo, toolchain);
      },
      run: async (gates, context) => {
        const { policy, executor } = await policyAndExecutor(context.audit);
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
      // Evidence-seeking review (ADR 0025): the module's filtered test command, with the
      // module's paths moved under the worktree, so it runs there; same policy and executor.
      runProbe: async (request, context) => {
        const module = discovery.modules.find(
          (candidate) => candidate.profile.moduleId === request.module,
        );
        const { policy, executor } = await policyAndExecutor(context.audit);
        const moved = module === undefined ? [] : [movedModule(module, request.root)];
        return runGate(
          {
            id: `${request.module}-probe`.slice(0, 64),
            module: request.module,
            use: "test",
            required: true,
          },
          {
            repo,
            modules: moved,
            policy,
            executor,
            toolchain,
            redactor: workspace.redactor,
            logDir: context.logDir,
            ...(context.signal === undefined ? {} : { signal: context.signal }),
          },
          { filter: request.filter },
        );
      },
    };

    async function policyAndExecutor(audit: AuditLog) {
      const trust = await TrustStore.open(defaultTrustStorePath(io.env));
      const policy = new CommandPolicy({
        guard,
        trust,
        configSha256: workspace.configSha256,
        approvedBy: currentUser(io.env),
        allowlist: options.allow,
        audit,
        execution: options.execution,
        ...(options.interactive && io.prompt !== undefined
          ? { approver: (request) => askApproval(request, io) }
          : {}),
      });
      const executor = new Executor({
        guard,
        redactor: workspace.redactor,
        audit,
        env: io.env,
      });
      return { policy, executor };
    }
  };
}

/** A module whose paths are moved under `root` (a workspace-relative copy of the workspace). */
function movedModule(module: WorkspaceModule, root: string): WorkspaceModule {
  const move = (relative: string) => (relative === "." ? root : joinRepoPath(root, relative));
  const profile: ModuleProfile = {
    ...module.profile,
    root: move(module.profile.root),
    sourceRoots: module.profile.sourceRoots.map(move),
    testRoots: module.profile.testRoots.map(move),
    ...(module.profile.buildTool?.wrapper === undefined
      ? {}
      : {
          buildTool: {
            ...module.profile.buildTool,
            wrapper: move(module.profile.buildTool.wrapper),
          },
        }),
  };
  return { ...module, profile };
}

/**
 * Review mode's contract tools (ADR 0021): `oasdiff` and `buf`, when they are on PATH, run
 * through the same command policy as the gates (workspace trust, then an approval).
 */
export function contractToolsFactory(
  workspace: Workspace,
  io: CliIo,
  options: Pick<TestRunnerOptions, "allow" | "interactive">,
): NonNullable<WorkflowServices["contractTools"]> {
  return async (context) => {
    const { guard } = workspace;
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
    return {
      toolchain: new PathToolchainProbe({ env: io.env }),
      policy,
      executor,
      logDir: context.logDir,
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    };
  };
}
