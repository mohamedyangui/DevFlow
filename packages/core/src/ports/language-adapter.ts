import type { CommandSpec, ExecutionRecord } from "../schemas/command.js";
import type {
  InferredConvention,
  ModuleCandidate,
  ModuleProfile,
  TestAuthoringGuide,
  TestInventory,
} from "../schemas/module.js";
import type { ParsedCommandResults } from "../schemas/verification.js";
import type { RepositoryView } from "./repository-view.js";

/**
 * The version of this interface (semver). An adapter declares the version it targets in
 * `apiVersion`; it can be used when the major versions are equal and its minor version is not
 * above this one (docs/specs/language-adapter.md, section 12). A minor version adds optional
 * capabilities; a major version changes or removes something adapters rely on.
 */
export const ADAPTER_API_VERSION = "1.0.0";

export interface ToolAvailability {
  readonly available: boolean;
  readonly version?: string;
}

/**
 * Answers "is this tool available?" without letting the caller run anything. Implemented by
 * the core executor (Phase 2) using fixed, internal probe commands.
 */
export interface ToolchainProbe {
  readonly platform: NodeJS.Platform;
  probe(tool: string): Promise<ToolAvailability>;
}

/**
 * A language adapter (docs/specs/language-adapter.md).
 *
 * Adapters are pure with respect to side effects: they read through `RepositoryView`, return
 * data, and never start processes, write files or access the network. Everything they return
 * is validated against the core schemas before use, and every command they describe runs
 * only through the policy-gated executor.
 */
export interface LanguageAdapter {
  /** Stable identifier, e.g. `java` or `javascript`. */
  readonly id: string;
  readonly displayName: string;
  /** The adapter API version the adapter targets (semver, see `ADAPTER_API_VERSION`). */
  readonly apiVersion: string;

  /** Finds the project roots this adapter can handle, with confidence and evidence. */
  detectModules(repo: RepositoryView): Promise<readonly ModuleCandidate[]>;

  /** Build tool, languages, frameworks, test frameworks, quality tools, roots and contracts. */
  analyzeModule(candidate: ModuleCandidate, repo: RepositoryView): Promise<ModuleProfile>;

  /** Conventions inferred from the existing code, each with evidence. */
  inferConventions(
    profile: ModuleProfile,
    repo: RepositoryView,
  ): Promise<readonly InferredConvention[]>;

  /** Existing tests: files, frameworks, naming patterns. */
  discoverTests(profile: ModuleProfile, repo: RepositoryView): Promise<TestInventory>;

  /** Where and how a new test should be written, including the AC marker convention. */
  testAuthoringGuide(profile: ModuleProfile): TestAuthoringGuide;

  /** The command catalog for this module, resolved against the available toolchain. */
  commandCatalog(
    profile: ModuleProfile,
    toolchain: ToolchainProbe,
    repo: RepositoryView,
  ): Promise<readonly CommandSpec[]>;

  /**
   * Turns the artifacts of an execution (JUnit XML, JSON reporters, compiler output) into
   * normalized results. Must return `parse: "unparseable"` rather than guess.
   */
  parseResults(
    command: CommandSpec,
    execution: ExecutionRecord,
    repo: RepositoryView,
  ): Promise<ParsedCommandResults>;
}
