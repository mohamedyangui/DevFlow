import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { DevflowError, ErrorCode, isDevflowError } from "../errors.js";
import type { LanguageAdapter, ToolchainProbe } from "../ports/language-adapter.js";
import type { RepositoryView } from "../ports/repository-view.js";
import type { CommandSpec, ExecutionRecord } from "../schemas/command.js";
import type {
  InferredConvention,
  ModuleCandidate,
  ModuleProfile,
  TestAuthoringGuide,
  TestInventory,
} from "../schemas/module.js";
import { IsoDateTime, Sha256 } from "../schemas/primitives.js";
import type { ParsedCommandResults } from "../schemas/verification.js";
import { caseInsensitiveFileSystem } from "../security/path-patterns.js";
import { checkApiVersion } from "./api-version.js";
import { ADAPTER_ID, isRecord } from "./sdk.js";

/**
 * External language adapters (docs/specs/language-adapter.md, section 12; ADR 0023).
 *
 * A plugin is an ES module, usually an npm package, whose `devflowAdapter` export (or default
 * export) is a language adapter with a manifest: `id`, `displayName`, `apiVersion` and
 * `languages`. Plugins are declared only by the user, in `$DEVFLOW_HOME/plugins.json` (or
 * `~/.devflow/plugins.json`), never by a repository: the list records the resolved absolute
 * path of the entry file and the SHA-256 of that file and of the package's `package.json`.
 * A plugin whose files changed since it was added is refused until the user adds it again.
 *
 * Package names are resolved only in the user's plugin directory
 * (`$DEVFLOW_HOME/plugins/node_modules`), never in the analysed repository. A plugin is
 * trusted code running in the DevFlow process, like any npm package the user installs; what
 * it returns is still validated, and the commands it describes run only through the command
 * policy, exactly like those of the built-in adapters.
 */

/** The named export a plugin module provides; the default export is used when it is absent. */
export const PLUGIN_EXPORT_NAME = "devflowAdapter";

/** Files read to resolve a plugin are small; anything larger is refused. */
const MAX_PACKAGE_JSON_BYTES = 1_048_576;

const AbsolutePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => path.isAbsolute(value), "must be an absolute path");

const PluginRecord = z.strictObject({
  id: z.string().regex(ADAPTER_ID),
  displayName: z.string().min(1).max(128),
  apiVersion: z.string().min(1).max(32),
  languages: z.array(z.string().min(1).max(64)).max(32),
  /** What the user passed to `devflow plugins add`. */
  specifier: z.string().min(1).max(4096),
  /** The package directory, or null when the plugin is a single file. */
  packageRoot: AbsolutePath.nullable(),
  entry: AbsolutePath,
  entrySha256: Sha256,
  packageJsonSha256: Sha256.nullable(),
  addedAt: IsoDateTime,
  addedBy: z.string().min(1).max(256),
});
export type InstalledPlugin = z.infer<typeof PluginRecord>;

const PluginFile = z
  .strictObject({ version: z.literal(1), plugins: z.array(PluginRecord) })
  .refine(
    (file) => new Set(file.plugins.map((plugin) => plugin.id)).size === file.plugins.length,
    "two plugins have the same id",
  );
type PluginFile = z.infer<typeof PluginFile>;

/** The manifest a plugin declares on its exported adapter. */
export interface PluginManifest {
  readonly id: string;
  readonly displayName: string;
  readonly apiVersion: string;
  readonly languages: readonly string[];
}

/** A plugin module that was imported and checked. */
export interface LoadedPlugin {
  readonly manifest: PluginManifest;
  /** The plugin's adapter. The registry still wraps it with `validatedAdapter`. */
  readonly adapter: LanguageAdapter;
}

/** Where the user's plugin package and entry files are. */
export interface ResolvedPlugin {
  readonly specifier: string;
  readonly packageRoot: string | null;
  readonly entry: string;
}

export interface PluginHashes {
  readonly entrySha256: string;
  readonly packageJsonSha256: string | null;
}

type Env = Readonly<Record<string, string | undefined>>;

/** DevFlow's user directory: `$DEVFLOW_HOME`, else `~/.devflow`. */
export function devflowHome(env: Env = process.env): string {
  const home = env.DEVFLOW_HOME;
  if (home !== undefined && home.trim() !== "") return path.resolve(home);
  return path.join(os.homedir(), ".devflow");
}

/** The plugin list: `$DEVFLOW_HOME/plugins.json`, else `~/.devflow/plugins.json`. */
export function defaultPluginStorePath(env: Env = process.env): string {
  return path.join(devflowHome(env), "plugins.json");
}

/**
 * The directory plugin packages are installed into, with
 * `npm install --prefix <directory> <package>`: `$DEVFLOW_HOME/plugins`.
 */
export function pluginInstallDirectory(env: Env = process.env): string {
  return path.join(devflowHome(env), "plugins");
}

// ---- Store ----------------------------------------------------------------------------------

/**
 * The user's list of installed plugins. A missing file is an empty list; an invalid file is
 * an error (`PLUGIN_STORE_INVALID`), so nothing is loaded from a list DevFlow cannot read.
 * Writes are atomic and the file is readable by its owner only.
 */
export class PluginStore {
  readonly file: string;
  private data: PluginFile;

  private constructor(file: string, data: PluginFile) {
    this.file = file;
    this.data = data;
  }

  static async open(file: string): Promise<PluginStore> {
    return new PluginStore(file, await readPluginFile(file));
  }

  list(): readonly InstalledPlugin[] {
    return this.data.plugins;
  }

  find(id: string): InstalledPlugin | undefined {
    return this.data.plugins.find((plugin) => plugin.id === id);
  }

  /** Adds a plugin, replacing the entry with the same id. */
  async put(record: InstalledPlugin): Promise<void> {
    await this.update((data) => ({
      ...data,
      plugins: [...data.plugins.filter((plugin) => plugin.id !== record.id), record].sort((a, b) =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      ),
    }));
  }

  /** Removes a plugin. Returns whether it was installed. */
  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.update((data) => {
      const plugins = data.plugins.filter((plugin) => plugin.id !== id);
      removed = plugins.length !== data.plugins.length;
      return { ...data, plugins };
    });
    return removed;
  }

  private async update(change: (data: PluginFile) => PluginFile): Promise<void> {
    const next = PluginFile.parse(change(await readPluginFile(this.file)));
    await writePluginFile(this.file, next);
    this.data = next;
  }
}

async function readPluginFile(file: string): Promise<PluginFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, plugins: [] };
    throw new DevflowError(ErrorCode.PluginStoreInvalid, `cannot read the plugin list ${file}`, {
      details: { file },
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DevflowError(
      ErrorCode.PluginStoreInvalid,
      `the plugin list ${file} is not valid JSON; fix or delete it (no plugin is loaded meanwhile)`,
      { details: { file }, cause: error },
    );
  }
  const parsed = PluginFile.safeParse(json);
  if (!parsed.success) {
    throw new DevflowError(
      ErrorCode.PluginStoreInvalid,
      `the plugin list ${file} has an unexpected format; fix or delete it (no plugin is loaded meanwhile)`,
      { details: { file } },
    );
  }
  return parsed.data;
}

async function writePluginFile(file: string, data: PluginFile): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.plugins-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (process.platform !== "win32") await chmod(file, 0o600);
}

// ---- Resolution -----------------------------------------------------------------------------

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Resolves what the user passed to `devflow plugins add`:
 *
 * - an npm package name (`devflow-adapter-toy`, `@acme/devflow-adapter`) is looked up only in
 *   `<installDirectory>/node_modules`, never in the current directory or the repository;
 * - anything else is a path (absolute, or relative to `cwd`) to a package directory or to an
 *   ES module file.
 *
 * Paths are resolved through symbolic links; a package's entry file must be inside the package.
 */
export async function resolvePlugin(
  specifier: string,
  options: { readonly cwd: string; readonly installDirectory: string },
): Promise<ResolvedPlugin> {
  const isPackageName = PACKAGE_NAME.test(specifier) && !specifier.startsWith(".");
  const target = isPackageName
    ? path.join(options.installDirectory, "node_modules", ...specifier.split("/"))
    : path.resolve(options.cwd, specifier);
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    const hint = isPackageName
      ? `; install it with npm install --prefix "${options.installDirectory}" ${specifier}, or pass a path`
      : "";
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `plugin ${specifier} was not found (${target})${hint}`,
      { details: { specifier, path: target } },
    );
  }
  const info = await stat(real);
  if (info.isFile()) {
    if (isPackageName) {
      throw new DevflowError(ErrorCode.PluginInvalid, `plugin ${specifier} is not a package`, {
        details: { specifier },
      });
    }
    return { specifier, packageRoot: null, entry: real };
  }
  if (!info.isDirectory()) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `plugin ${specifier} is neither a file nor a directory`,
      { details: { specifier } },
    );
  }
  const manifest = await readPackageJson(real, specifier);
  const relative = packageEntry(manifest);
  let entry: string;
  try {
    entry = await realpath(path.resolve(real, relative));
  } catch {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the entry file ${relative} of plugin ${specifier} does not exist`,
      { details: { specifier, entry: relative } },
    );
  }
  const inside = path.relative(real, entry);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the entry file ${relative} of plugin ${specifier} is outside the package`,
      { details: { specifier, entry: relative } },
    );
  }
  if (!(await stat(entry)).isFile()) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the entry ${relative} of plugin ${specifier} is not a file`,
      { details: { specifier, entry: relative } },
    );
  }
  return { specifier, packageRoot: real, entry };
}

async function readPackageJson(root: string, specifier: string): Promise<unknown> {
  const file = path.join(root, "package.json");
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES) throw new Error("not usable");
    text = await readFile(file, "utf8");
  } catch {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `plugin ${specifier} has no readable package.json`,
      { details: { specifier } },
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the package.json of plugin ${specifier} is not valid JSON`,
      { details: { specifier } },
    );
  }
}

/** The package's main entry: `exports` (`.`, then `import`/`node`/`default`), `main`, `index.js`. */
function packageEntry(manifest: unknown): string {
  if (isRecord(manifest)) {
    const fromExports = exportTarget(manifest.exports);
    if (fromExports !== undefined) return fromExports;
    if (typeof manifest.main === "string" && manifest.main !== "") return manifest.main;
  }
  return "index.js";
}

function exportTarget(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (!isRecord(value)) return undefined;
  if ("." in value) return exportTarget(value["."]);
  for (const condition of ["import", "node", "default"]) {
    const target = exportTarget(value[condition]);
    if (target !== undefined) return target;
  }
  return undefined;
}

/** SHA-256 of the entry file and of the package's `package.json`. */
export async function hashPlugin(
  resolved: Omit<ResolvedPlugin, "specifier">,
): Promise<PluginHashes> {
  return {
    entrySha256: await sha256File(resolved.entry),
    packageJsonSha256:
      resolved.packageRoot === null
        ? null
        : await sha256File(path.join(resolved.packageRoot, "package.json")),
  };
}

async function sha256File(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

// ---- Import and shape check -----------------------------------------------------------------

type Method = (...args: unknown[]) => unknown;
const method = z.custom<Method>((value) => typeof value === "function", "must be a function");

const PluginExport = z.object({
  id: z.string(),
  displayName: z.string().trim().min(1).max(128),
  apiVersion: z.string().max(32),
  languages: z.array(z.string().min(1).max(64)).min(1).max(32),
  detectModules: method,
  analyzeModule: method,
  inferConventions: method.optional(),
  discoverTests: method,
  testAuthoringGuide: method,
  commandCatalog: method,
  parseResults: method,
});

/**
 * Imports a plugin's entry file and checks its export. The module URL carries the hash that
 * was checked, so a re-added, changed plugin is imported again rather than served from the
 * module cache. Importing runs the module's top-level code: this is why only plugins the user
 * added, with matching hashes, are ever imported.
 */
export async function importPlugin(entry: string, entrySha256: string): Promise<LoadedPlugin> {
  const url = `${pathToFileURL(entry).href}?sha256=${entrySha256}`;
  let module: unknown;
  try {
    module = await import(/* @vite-ignore */ url);
  } catch (error) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the plugin ${entry} cannot be loaded: ${error instanceof Error ? error.message : "import failed"}`,
      { details: { entry }, cause: error },
    );
  }
  const exported = isRecord(module) ? (module[PLUGIN_EXPORT_NAME] ?? module.default) : undefined;
  if (!isRecord(exported)) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the plugin ${entry} has no "${PLUGIN_EXPORT_NAME}" or default export that is an adapter object`,
      { details: { entry } },
    );
  }
  const parsed = PluginExport.safeParse(exported);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) =>
      issue.path.length === 0
        ? issue.message
        : `${issue.path.map(String).join(".")}: ${issue.message}`,
    );
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the plugin ${entry} does not export a valid adapter: ${problems.slice(0, 5).join("; ")}`,
      { details: { entry, problems } },
    );
  }
  const shape = parsed.data;
  if (!ADAPTER_ID.test(shape.id)) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `the plugin ${entry} has the id "${shape.id}", which must match ${String(ADAPTER_ID)}`,
      { details: { entry, id: shape.id } },
    );
  }
  checkApiVersion(shape.id, shape.apiVersion);

  const target: object = exported;
  const call = <T>(fn: Method, args: unknown[]): Promise<T> =>
    Promise.resolve().then(() => fn.apply(target, args) as T);
  const { inferConventions } = shape;
  const adapter: LanguageAdapter = {
    id: shape.id,
    displayName: shape.displayName,
    apiVersion: shape.apiVersion,
    detectModules: (repo: RepositoryView) =>
      call<readonly ModuleCandidate[]>(shape.detectModules, [repo]),
    analyzeModule: (candidate: ModuleCandidate, repo: RepositoryView) =>
      call<ModuleProfile>(shape.analyzeModule, [candidate, repo]),
    inferConventions: (profile: ModuleProfile, repo: RepositoryView) =>
      inferConventions === undefined
        ? Promise.resolve<readonly InferredConvention[]>([])
        : call<readonly InferredConvention[]>(inferConventions, [profile, repo]),
    discoverTests: (profile: ModuleProfile, repo: RepositoryView) =>
      call<TestInventory>(shape.discoverTests, [profile, repo]),
    testAuthoringGuide: (profile: ModuleProfile) =>
      shape.testAuthoringGuide.apply(target, [profile]) as TestAuthoringGuide,
    commandCatalog: (profile: ModuleProfile, toolchain: ToolchainProbe, repo: RepositoryView) =>
      call<readonly CommandSpec[]>(shape.commandCatalog, [profile, toolchain, repo]),
    parseResults: (command: CommandSpec, execution: ExecutionRecord, repo: RepositoryView) =>
      call<ParsedCommandResults>(shape.parseResults, [command, execution, repo]),
  };
  return {
    manifest: {
      id: shape.id,
      displayName: shape.displayName,
      apiVersion: shape.apiVersion,
      languages: [...shape.languages],
    },
    adapter,
  };
}

// ---- Add, check and load --------------------------------------------------------------------

export interface PluginOptions {
  readonly env: Env;
  /** Ids of the built-in adapters: a plugin cannot take one (built-ins take precedence). */
  readonly builtInIds: readonly string[];
}

export interface AddPluginResult {
  readonly plugin: InstalledPlugin;
  /** The entry this one replaced (the same plugin added again), if any. */
  readonly replaced?: InstalledPlugin;
  readonly store: string;
}

/**
 * `devflow plugins add`: resolves the plugin, hashes it, imports it, checks its export and API
 * version, and records it. Adding a plugin that is already installed from the same location
 * accepts its current files; an id already used by a built-in adapter or by a plugin from
 * another location is refused.
 */
export async function addPlugin(
  specifier: string,
  options: PluginOptions & {
    readonly cwd: string;
    readonly addedBy: string;
    readonly clock?: () => Date;
  },
): Promise<AddPluginResult> {
  const store = await PluginStore.open(defaultPluginStorePath(options.env));
  const resolved = await resolvePlugin(specifier, {
    cwd: options.cwd,
    installDirectory: pluginInstallDirectory(options.env),
  });
  const hashes = await hashPlugin(resolved);
  const { manifest } = await importPlugin(resolved.entry, hashes.entrySha256);
  if (options.builtInIds.includes(manifest.id)) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `plugin ${specifier} has the id "${manifest.id}" of a built-in adapter; built-in adapters take precedence, so it cannot be added`,
      { details: { specifier, id: manifest.id } },
    );
  }
  const existing = store.find(manifest.id);
  if (existing !== undefined && !samePath(existing.entry, resolved.entry)) {
    throw new DevflowError(
      ErrorCode.PluginInvalid,
      `a plugin with the id "${manifest.id}" is already installed from ${existing.entry}; remove it first (devflow plugins remove ${manifest.id})`,
      { details: { specifier, id: manifest.id, installed: existing.entry } },
    );
  }
  const plugin: InstalledPlugin = {
    id: manifest.id,
    displayName: manifest.displayName,
    apiVersion: manifest.apiVersion,
    languages: [...manifest.languages],
    specifier,
    packageRoot: resolved.packageRoot,
    entry: resolved.entry,
    ...hashes,
    addedAt: (options.clock ?? (() => new Date()))().toISOString(),
    addedBy: options.addedBy,
  };
  await store.put(plugin);
  return { plugin, store: store.file, ...(existing === undefined ? {} : { replaced: existing }) };
}

export type PluginFileStatus = "ok" | "changed" | "missing";

/** Whether an installed plugin's files still have the recorded hashes. Imports nothing. */
export async function pluginFileStatus(plugin: InstalledPlugin): Promise<PluginFileStatus> {
  let hashes: PluginHashes;
  try {
    hashes = await hashPlugin(plugin);
  } catch {
    return "missing";
  }
  return hashes.entrySha256 === plugin.entrySha256 &&
    hashes.packageJsonSha256 === plugin.packageJsonSha256
    ? "ok"
    : "changed";
}

export interface InstalledAdapters {
  /** The adapters of the plugins that were loaded, unvalidated (the registry validates them). */
  readonly adapters: readonly LanguageAdapter[];
  readonly plugins: readonly InstalledPlugin[];
  /** Plugins that were skipped, and why. */
  readonly warnings: readonly string[];
}

/**
 * Loads the user's installed plugins. A plugin whose id is a built-in adapter's is skipped with
 * a warning (built-ins take precedence). A plugin whose files changed or that no longer loads is
 * an error, never a silent skip: verification must not quietly lose the modules of a language.
 */
export async function loadInstalledPlugins(options: PluginOptions): Promise<InstalledAdapters> {
  const store = await PluginStore.open(defaultPluginStorePath(options.env));
  const adapters: LanguageAdapter[] = [];
  const plugins: InstalledPlugin[] = [];
  const warnings: string[] = [];
  for (const plugin of store.list()) {
    if (options.builtInIds.includes(plugin.id)) {
      warnings.push(
        `plugin ${plugin.id} (${plugin.entry}) is ignored: the built-in adapter with the same id takes precedence`,
      );
      continue;
    }
    const status = await pluginFileStatus(plugin);
    if (status !== "ok") {
      throw new DevflowError(
        ErrorCode.PluginChanged,
        status === "missing"
          ? `plugin ${plugin.id}: ${plugin.entry} no longer exists; add it again or remove it (devflow plugins remove ${plugin.id})`
          : `plugin ${plugin.id} changed since it was added (${plugin.entry}); review the change, then accept it with devflow plugins add ${plugin.specifier}, or remove it (devflow plugins remove ${plugin.id})`,
        { details: { plugin: plugin.id, entry: plugin.entry, status } },
      );
    }
    let loaded: LoadedPlugin;
    try {
      loaded = await importPlugin(plugin.entry, plugin.entrySha256);
    } catch (error) {
      if (!isDevflowError(error)) throw error;
      throw new DevflowError(error.code, `plugin ${plugin.id}: ${error.message}`, {
        details: { ...error.details, plugin: plugin.id },
        cause: error,
      });
    }
    if (loaded.manifest.id !== plugin.id) {
      throw new DevflowError(
        ErrorCode.PluginChanged,
        `plugin ${plugin.id} now declares the id "${loaded.manifest.id}"; add it again or remove it`,
        { details: { plugin: plugin.id, id: loaded.manifest.id } },
      );
    }
    adapters.push(loaded.adapter);
    plugins.push(plugin);
  }
  return { adapters, plugins, warnings };
}

function samePath(a: string, b: string): boolean {
  return caseInsensitiveFileSystem() ? a.toLowerCase() === b.toLowerCase() : a === b;
}
