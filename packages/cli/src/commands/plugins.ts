import {
  ADAPTER_API_VERSION,
  DevflowError,
  ErrorCode,
  PluginStore,
  addPlugin,
  apiVersionProblem,
  defaultPluginStorePath,
  isDevflowError,
  pluginFileStatus,
  pluginInstallDirectory,
  type InstalledPlugin,
  type PluginFileStatus,
} from "@devflowai/core";
import { BUILT_IN_ADAPTERS, BUILT_IN_ADAPTER_IDS } from "../adapters.js";
import { ExitCode } from "../exit-codes.js";
import { colorsFor, type CliIo } from "../io.js";
import { currentUser } from "../workspace.js";

export interface PluginsOptions {
  readonly json: boolean;
}

/** Shown when a plugin is added: what adding one means (ADR 0023). */
export const PLUGIN_TRUST_NOTE =
  "A plugin is trusted code: it runs inside the DevFlow process with your privileges, like any npm package you install. The commands it describes still go through the command policy.";

/**
 * `devflow plugins add <package|path>`: imports the plugin, checks its export and API version,
 * and records it with the SHA-256 of its entry file and package.json in the user's plugin list
 * (`$DEVFLOW_HOME/plugins.json`). Package names are resolved in `$DEVFLOW_HOME/plugins` only.
 */
export async function pluginsAddCommand(
  specifier: string,
  options: PluginsOptions,
  io: CliIo,
): Promise<ExitCode> {
  try {
    const result = await addPlugin(specifier, {
      cwd: io.cwd,
      env: io.env,
      builtInIds: BUILT_IN_ADAPTER_IDS,
      addedBy: currentUser(io.env),
    });
    const action = result.replaced === undefined ? "added" : "updated";
    if (options.json) {
      writeJson(io, {
        action,
        store: result.store,
        plugin: result.plugin,
        hostApiVersion: ADAPTER_API_VERSION,
      });
    } else {
      const c = colorsFor(io.stdout, io.env);
      const { plugin } = result;
      io.stdout.write(
        [
          `${c.green(action === "added" ? "Added" : "Updated")} plugin ${c.bold(plugin.id)}: ${plugin.displayName}`,
          `  Languages:   ${plugin.languages.join(", ")}`,
          `  API version: ${plugin.apiVersion} (this DevFlow: ${ADAPTER_API_VERSION})`,
          `  Entry:       ${plugin.entry}`,
          `  SHA-256:     ${plugin.entrySha256}`,
          ...(plugin.packageJsonSha256 === null
            ? []
            : [`  package.json SHA-256: ${plugin.packageJsonSha256}`]),
          `  Plugin list: ${result.store}`,
          "",
          PLUGIN_TRUST_NOTE,
          "If its files change, DevFlow refuses to load it until you add it again.",
        ].join("\n") + "\n",
      );
    }
    return ExitCode.Success;
  } catch (error) {
    return reportError(error, io, options);
  }
}

/** `devflow plugins list`: the built-in adapters and the installed plugins, with their status. */
export async function pluginsListCommand(options: PluginsOptions, io: CliIo): Promise<ExitCode> {
  let store: PluginStore;
  try {
    store = await PluginStore.open(defaultPluginStorePath(io.env));
  } catch (error) {
    return reportError(error, io, options);
  }
  const plugins: { plugin: InstalledPlugin; status: PluginListStatus }[] = [];
  for (const plugin of store.list()) plugins.push({ plugin, status: await statusOf(plugin) });

  if (options.json) {
    writeJson(io, {
      store: store.file,
      installDirectory: pluginInstallDirectory(io.env),
      hostApiVersion: ADAPTER_API_VERSION,
      builtIn: BUILT_IN_ADAPTERS.map((adapter) => ({
        id: adapter.id,
        displayName: adapter.displayName,
        apiVersion: adapter.apiVersion,
      })),
      plugins: plugins.map(({ plugin, status }) => ({ ...plugin, status })),
    });
    return ExitCode.Success;
  }
  const c = colorsFor(io.stdout, io.env);
  const out = [
    `${c.bold("Adapter API:")} ${ADAPTER_API_VERSION}`,
    `${c.bold("Plugin list:")} ${store.file}`,
    "",
    c.bold("Built-in adapters:"),
    ...BUILT_IN_ADAPTERS.map(
      (adapter) =>
        `  ${adapter.id}  ${adapter.displayName}  ${c.dim(`(API ${adapter.apiVersion})`)}`,
    ),
    "",
    c.bold("Plugins:"),
  ];
  if (plugins.length === 0) out.push("  none (add one with devflow plugins add <package|path>)");
  for (const { plugin, status } of plugins) {
    const shown =
      status === "ok"
        ? c.green("OK")
        : status === "changed"
          ? c.red("CHANGED (not loaded; add it again to accept the change)")
          : status === "missing"
            ? c.red("MISSING (not loaded)")
            : status === "shadowed"
              ? c.yellow("IGNORED (a built-in adapter has this id)")
              : c.red("INCOMPATIBLE API VERSION");
    out.push(
      `  ${plugin.id}  ${plugin.displayName}  ${c.dim(`(API ${plugin.apiVersion}; ${plugin.languages.join(", ")})`)}  ${shown}`,
      `      ${plugin.entry}`,
    );
  }
  io.stdout.write(`${out.join("\n")}\n`);
  return ExitCode.Success;
}

/** `devflow plugins remove <id>`. */
export async function pluginsRemoveCommand(
  id: string,
  options: PluginsOptions,
  io: CliIo,
): Promise<ExitCode> {
  try {
    const store = await PluginStore.open(defaultPluginStorePath(io.env));
    const removed = await store.remove(id);
    if (!removed) {
      throw new DevflowError(ErrorCode.PluginNotFound, `no plugin "${id}" is installed`, {
        details: { id, installed: store.list().map((plugin) => plugin.id) },
      });
    }
    if (options.json) writeJson(io, { action: "removed", store: store.file, id });
    else io.stdout.write(`Removed plugin ${id}.\n`);
    return ExitCode.Success;
  } catch (error) {
    return reportError(error, io, options);
  }
}

type PluginListStatus = PluginFileStatus | "shadowed" | "incompatible";

async function statusOf(plugin: InstalledPlugin): Promise<PluginListStatus> {
  if (BUILT_IN_ADAPTER_IDS.includes(plugin.id)) return "shadowed";
  const status = await pluginFileStatus(plugin);
  if (status !== "ok") return status;
  return apiVersionProblem(plugin.apiVersion) === undefined ? "ok" : "incompatible";
}

function reportError(error: unknown, io: CliIo, options: PluginsOptions): ExitCode {
  if (!isDevflowError(error)) throw error;
  if (options.json) {
    writeJson(io, { error: { code: error.code, message: error.message } });
  } else {
    io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
  }
  return error.code === ErrorCode.PluginNotFound ? ExitCode.Failure : ExitCode.UsageError;
}

function writeJson(io: CliIo, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
