import type { z } from "zod";
import { DevflowError, ErrorCode, isDevflowError } from "../errors.js";
import type { LanguageAdapter, ToolchainProbe } from "../ports/language-adapter.js";
import type { RepositoryView } from "../ports/repository-view.js";
import { CommandSpec, type ExecutionRecord } from "../schemas/command.js";
import {
  InferredConvention,
  ModuleCandidate,
  ModuleProfile,
  TestAuthoringGuide,
  TestInventory,
} from "../schemas/module.js";
import { ParsedCommandResults } from "../schemas/verification.js";
import { hardDenyReason } from "../security/command-policy.js";
import { checkApiVersion } from "./api-version.js";
import { ADAPTER_ID, isWithin } from "./sdk.js";

/**
 * Wraps an adapter so that everything it returns is checked before DevFlow uses it
 * (docs/specs/language-adapter.md, rule 5): the core schemas, plus consistency rules the
 * schemas cannot express (the module root, the adapter id, command ids, hard-denied commands).
 * Adapter exceptions become `ADAPTER_FAILED` errors that name the adapter and the operation.
 */
export function validatedAdapter(adapter: LanguageAdapter): LanguageAdapter {
  checkIdentity(adapter);
  const id = adapter.id;

  async function call<T>(operation: string, run: () => Promise<T> | T): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isDevflowError(error) && error.code === ErrorCode.AdapterOutputInvalid) throw error;
      throw new DevflowError(
        ErrorCode.AdapterFailed,
        `the ${id} adapter failed in ${operation}: ${error instanceof Error ? error.message : String(error)}`,
        { details: { adapter: id, operation }, cause: error },
      );
    }
  }

  function check<S extends z.ZodType>(operation: string, schema: S, value: unknown): z.output<S> {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    throw outputError(id, operation, parsed.error.issues.map(formatIssue));
  }

  function reject(operation: string, problems: readonly string[]): void {
    if (problems.length > 0) throw outputError(id, operation, problems);
  }

  return {
    id,
    displayName: adapter.displayName,
    apiVersion: adapter.apiVersion,

    async detectModules(repo: RepositoryView) {
      const raw = await call("detectModules", () => adapter.detectModules(repo));
      const candidates = check("detectModules", ModuleCandidate.array(), raw);
      const roots = new Set<string>();
      const problems: string[] = [];
      for (const candidate of candidates) {
        if (candidate.adapterId !== id) {
          problems.push(`candidate ${candidate.root} names adapter "${candidate.adapterId}"`);
        }
        if (roots.has(candidate.root))
          problems.push(`module root ${candidate.root} is reported twice`);
        roots.add(candidate.root);
      }
      reject("detectModules", problems);
      return candidates;
    },

    async analyzeModule(candidate, repo) {
      const raw = await call("analyzeModule", () => adapter.analyzeModule(candidate, repo));
      const profile = check("analyzeModule", ModuleProfile, raw);
      const problems: string[] = [];
      if (profile.adapterId !== id) problems.push(`profile names adapter "${profile.adapterId}"`);
      if (profile.root !== candidate.root) {
        problems.push(
          `profile root ${profile.root} differs from the candidate root ${candidate.root}`,
        );
      }
      for (const root of [...profile.sourceRoots, ...profile.testRoots]) {
        if (!isWithin(profile.root, root))
          problems.push(`${root} is outside the module root ${profile.root}`);
      }
      if (
        profile.buildTool?.wrapper !== undefined &&
        !isWithin(profile.root, profile.buildTool.wrapper)
      ) {
        problems.push(`wrapper ${profile.buildTool.wrapper} is outside the module root`);
      }
      reject("analyzeModule", problems);
      return profile;
    },

    async inferConventions(profile, repo) {
      const raw = await call("inferConventions", () => adapter.inferConventions(profile, repo));
      return check("inferConventions", InferredConvention.array(), raw);
    },

    async discoverTests(profile, repo) {
      const raw = await call("discoverTests", () => adapter.discoverTests(profile, repo));
      const inventory = check("discoverTests", TestInventory, raw);
      const problems: string[] = [];
      if (inventory.moduleId !== profile.moduleId) {
        problems.push(`inventory is for module "${inventory.moduleId}", not "${profile.moduleId}"`);
      }
      for (const file of inventory.files) {
        if (!isWithin(profile.root, file.path))
          problems.push(`test file ${file.path} is outside the module`);
      }
      reject("discoverTests", problems);
      return inventory;
    },

    testAuthoringGuide(profile) {
      let raw: unknown;
      try {
        raw = adapter.testAuthoringGuide(profile);
      } catch (error) {
        throw new DevflowError(
          ErrorCode.AdapterFailed,
          `the ${id} adapter failed in testAuthoringGuide: ${error instanceof Error ? error.message : String(error)}`,
          { details: { adapter: id, operation: "testAuthoringGuide" }, cause: error },
        );
      }
      const guide = check("testAuthoringGuide", TestAuthoringGuide, raw);
      reject(
        "testAuthoringGuide",
        isWithin(profile.root, guide.testRoot)
          ? []
          : [`test root ${guide.testRoot} is outside the module root ${profile.root}`],
      );
      return guide;
    },

    async commandCatalog(profile, toolchain: ToolchainProbe, repo) {
      const raw = await call("commandCatalog", () =>
        adapter.commandCatalog(profile, toolchain, repo),
      );
      const commands = check("commandCatalog", CommandSpec.array(), raw);
      reject("commandCatalog", catalogProblems(profile.root, commands));
      return commands;
    },

    async parseResults(command, execution: ExecutionRecord, repo) {
      const raw = await call("parseResults", () => adapter.parseResults(command, execution, repo));
      return check("parseResults", ParsedCommandResults, raw);
    },

    ...(adapter.testSelection === undefined
      ? {}
      : {
          testSelection(profile, test) {
            let value: unknown;
            try {
              value = adapter.testSelection?.(profile, test);
            } catch (error) {
              throw new DevflowError(
                ErrorCode.AdapterFailed,
                `the ${id} adapter failed in testSelection: ${error instanceof Error ? error.message : String(error)}`,
                { details: { adapter: id, operation: "testSelection" }, cause: error },
              );
            }
            if (value === undefined) return undefined;
            if (typeof value !== "string" || value.length === 0 || value.length > 512) {
              throw outputError(id, "testSelection", [
                "must return a non-empty string or undefined",
              ]);
            }
            return value;
          },
        }),
  };
}

/** Problems with a command catalog that the `CommandSpec` schema cannot see. */
export function catalogProblems(moduleRoot: string, commands: readonly CommandSpec[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  // A gate (`use: test`) resolves to the one command for its purpose that needs no parameters.
  const gateCommands = new Map<string, string>();
  for (const command of commands) {
    if (ids.has(command.id)) problems.push(`command id "${command.id}" is used twice`);
    ids.add(command.id);
    if (command.parameters.length === 0) {
      const other = gateCommands.get(command.purpose);
      if (other !== undefined) {
        problems.push(
          `commands ${other} and ${command.id} both provide "${command.purpose}" without parameters; a gate could not choose`,
        );
      }
      gateCommands.set(command.purpose, command.id);
    }
    if (command.origin !== "adapter") {
      problems.push(`command ${command.id} must have origin "adapter", not "${command.origin}"`);
    }
    if (!isWithin(moduleRoot, command.cwd)) {
      problems.push(
        `command ${command.id} runs in ${command.cwd}, outside the module root ${moduleRoot}`,
      );
    }
    const denied = hardDenyReason(command.executable, command.args);
    if (denied !== undefined)
      problems.push(`command ${command.id} is on the hard deny list (${denied})`);
  }
  return problems;
}

/**
 * Throws `ADAPTER_INVALID` unless the adapter's identity is acceptable, and
 * `ADAPTER_API_INCOMPATIBLE` unless its API version can run on this DevFlow (ADR 0023).
 */
export function checkIdentity(adapter: LanguageAdapter): void {
  const problems: string[] = [];
  if (!ADAPTER_ID.test(adapter.id)) {
    problems.push(`id "${adapter.id}" must match ${String(ADAPTER_ID)}`);
  }
  if (adapter.displayName.trim() === "") problems.push("displayName must not be empty");
  if (problems.length > 0) {
    throw new DevflowError(
      ErrorCode.AdapterInvalid,
      `adapter "${adapter.id}" cannot be used: ${problems.join("; ")}`,
      { details: { adapter: adapter.id, problems } },
    );
  }
  checkApiVersion(adapter.id, adapter.apiVersion);
}

function outputError(
  adapter: string,
  operation: string,
  problems: readonly string[],
): DevflowError {
  const shown = problems.slice(0, 5).join("; ");
  const more = problems.length > 5 ? ` (and ${String(problems.length - 5)} more)` : "";
  return new DevflowError(
    ErrorCode.AdapterOutputInvalid,
    `the ${adapter} adapter returned invalid data from ${operation}: ${shown}${more}`,
    { details: { adapter, operation, problems: [...problems] } },
  );
}

function formatIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.map(String).join(".");
  return where === "" ? issue.message : `${where}: ${issue.message}`;
}
