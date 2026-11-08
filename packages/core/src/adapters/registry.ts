import { DevflowError, ErrorCode, isDevflowError } from "../errors.js";
import type { LanguageAdapter } from "../ports/language-adapter.js";
import type { RepositoryView } from "../ports/repository-view.js";
import type { ModuleCandidate, ModuleProfile } from "../schemas/module.js";
import { ModuleId } from "../schemas/primitives.js";
import { validatedAdapter } from "./validate.js";

/** A module found in the workspace, with the adapter that handles it. */
export interface WorkspaceModule {
  readonly profile: ModuleProfile;
  /** The validated adapter: its outputs are checked against the core schemas. */
  readonly adapter: LanguageAdapter;
  readonly candidate: ModuleCandidate;
}

export interface ModuleDiscovery {
  readonly modules: readonly WorkspaceModule[];
  /** Adapters or modules that could not be analysed, and why. Nothing is silently dropped. */
  readonly warnings: readonly string[];
}

/** A module declared in `.devflow/config.yaml` (`modules[]`). */
export interface DeclaredModule {
  readonly id: string;
  readonly path: string;
  readonly adapter: string;
}

const CONFIG_FILE = ".devflow/config.yaml";

/**
 * The language adapters DevFlow can use, and module discovery across them. Every adapter is
 * wrapped by `validatedAdapter`, so callers only ever see schema-checked data.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, LanguageAdapter>();

  constructor(adapters: readonly LanguageAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  /** Adds an adapter. Throws `ADAPTER_INVALID` for a bad identity or a duplicate id. */
  register(adapter: LanguageAdapter): void {
    const validated = validatedAdapter(adapter);
    if (this.adapters.has(validated.id)) {
      throw new DevflowError(
        ErrorCode.AdapterInvalid,
        `an adapter with id "${validated.id}" is already registered`,
        { details: { adapter: validated.id } },
      );
    }
    this.adapters.set(validated.id, validated);
  }

  get(id: string): LanguageAdapter | undefined {
    return this.adapters.get(id);
  }

  ids(): string[] {
    return [...this.adapters.keys()];
  }

  /**
   * Finds and analyses the modules of a workspace. Declared modules (from the project
   * configuration) replace detection; otherwise every adapter's `detectModules` runs. A failing
   * adapter or module becomes a warning, so one broken build file does not hide the rest.
   */
  async discover(
    repo: RepositoryView,
    options: { readonly declared?: readonly DeclaredModule[] } = {},
  ): Promise<ModuleDiscovery> {
    const warnings: string[] = [];
    const found: { candidate: ModuleCandidate; adapter: LanguageAdapter; id?: string }[] = [];

    if (options.declared !== undefined && options.declared.length > 0) {
      for (const declared of options.declared) {
        const adapter = this.adapters.get(declared.adapter);
        if (adapter === undefined) {
          warnings.push(
            `module ${declared.id}: no adapter named "${declared.adapter}" (available: ${this.ids().join(", ") || "none"})`,
          );
          continue;
        }
        if (declared.path !== "." && !(await repo.exists(declared.path))) {
          warnings.push(`module ${declared.id}: ${declared.path} does not exist`);
          continue;
        }
        found.push({
          adapter,
          id: declared.id,
          candidate: {
            adapterId: adapter.id,
            root: declared.path,
            confidence: 1,
            evidence: [
              {
                kind: "file",
                description: `module ${declared.id} is declared in the project configuration`,
                deterministic: true,
                path: CONFIG_FILE,
              },
            ],
          },
        });
      }
    } else {
      for (const adapter of this.adapters.values()) {
        try {
          for (const candidate of await adapter.detectModules(repo))
            found.push({ adapter, candidate });
        } catch (error) {
          warnings.push(describe(error));
        }
      }
    }

    const analysed: WorkspaceModule[] = [];
    for (const entry of found) {
      try {
        const profile = await entry.adapter.analyzeModule(entry.candidate, repo);
        analysed.push({
          adapter: entry.adapter,
          candidate: entry.candidate,
          profile: entry.id === undefined ? profile : { ...profile, moduleId: entry.id },
        });
      } catch (error) {
        warnings.push(`module ${entry.candidate.root} (${entry.adapter.id}): ${describe(error)}`);
      }
    }

    analysed.sort(
      (a, b) =>
        compare(a.profile.root, b.profile.root) ||
        compare(a.profile.adapterId, b.profile.adapterId),
    );
    const declaredIds = new Set(
      found.flatMap((entry) => (entry.id === undefined ? [] : [entry.id])),
    );
    return { modules: uniqueIds(analysed, declaredIds), warnings };
  }
}

/** Finds a module by id, or throws `MODULE_NOT_FOUND` listing the known ids. */
export function findModule(modules: readonly WorkspaceModule[], id: string): WorkspaceModule {
  const match = modules.find((module) => module.profile.moduleId === id);
  if (match !== undefined) return match;
  const known = modules.map((module) => module.profile.moduleId);
  throw new DevflowError(
    ErrorCode.ModuleNotFound,
    `no module "${id}" (known modules: ${known.join(", ") || "none"})`,
    { details: { module: id, known } },
  );
}

/**
 * Detected module ids are derived from roots, so two adapters can propose the same id. Declared
 * ids are kept as they are; detected duplicates get the adapter id, then a number, appended.
 */
function uniqueIds(
  modules: readonly WorkspaceModule[],
  declared: ReadonlySet<string>,
): WorkspaceModule[] {
  const taken = new Set<string>(declared);
  return modules.map((module) => {
    const base = module.profile.moduleId;
    if (declared.has(base)) return module;
    let id = base;
    if (taken.has(id)) id = fit(`${base}-${module.profile.adapterId}`);
    for (let n = 2; taken.has(id); n++)
      id = fit(`${base}-${module.profile.adapterId}-${String(n)}`);
    taken.add(id);
    return id === base ? module : { ...module, profile: { ...module.profile, moduleId: id } };
  });
}

function fit(id: string): string {
  const trimmed = id.length > 64 ? id.slice(id.length - 64).replace(/^[^A-Za-z0-9]+/, "") : id;
  return ModuleId.safeParse(trimmed).success ? trimmed : "module";
}

function describe(error: unknown): string {
  if (isDevflowError(error)) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
