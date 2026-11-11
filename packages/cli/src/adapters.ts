import { javaAdapter } from "@devflow/adapter-java";
import { javascriptAdapter } from "@devflow/adapter-javascript";
import { pythonAdapter } from "@devflow/adapter-python";
import { AdapterRegistry, loadInstalledPlugins, type LanguageAdapter } from "@devflow/core";

/** The adapters shipped with DevFlow. They take precedence over plugins with the same id. */
export const BUILT_IN_ADAPTERS: readonly LanguageAdapter[] = [
  javaAdapter,
  javascriptAdapter,
  pythonAdapter,
];

export const BUILT_IN_ADAPTER_IDS: readonly string[] = BUILT_IN_ADAPTERS.map(
  (adapter) => adapter.id,
);

export interface WorkspaceAdapters {
  readonly registry: AdapterRegistry;
  /** Plugins that were skipped, and why. */
  readonly warnings: readonly string[];
}

/**
 * The built-in adapters and the user's installed plugins (ADR 0023). Plugins come only from the
 * user's plugin list (`$DEVFLOW_HOME/plugins.json`), never from the workspace. A plugin that
 * changed since it was added, or no longer loads, is an error.
 */
export async function workspaceAdapters(
  env: Readonly<Record<string, string | undefined>>,
): Promise<WorkspaceAdapters> {
  const installed = await loadInstalledPlugins({ env, builtInIds: BUILT_IN_ADAPTER_IDS });
  return {
    registry: new AdapterRegistry([...BUILT_IN_ADAPTERS, ...installed.adapters]),
    warnings: installed.warnings,
  };
}
