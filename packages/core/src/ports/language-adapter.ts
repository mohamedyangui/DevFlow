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

/** The adapter SDK version this interface describes. */
export const LANGUAGE_ADAPTER_API_VERSION = 1;

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
  readonly apiVersion: typeof LANGUAGE_ADAPTER_API_VERSION;

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
