import { checkIdentity, validatedAdapter } from "../adapters/validate.js";
import type {
  LanguageAdapter,
  ToolAvailability,
  ToolchainProbe,
} from "../ports/language-adapter.js";
import type { RepositoryView } from "../ports/repository-view.js";
import type { CommandSpec, ExecutionRecord } from "../schemas/command.js";
import type { ModuleCandidate, ModuleProfile } from "../schemas/module.js";
import type { Evidence } from "../schemas/primitives.js";
import { StaticToolchainProbe } from "../security/toolchain-probe.js";

/**
 * The adapter conformance kit (docs/specs/language-adapter.md). Every adapter, built-in or
 * external, runs it over its own fixture repositories:
 *
 * ```ts
 * const report = await checkAdapterConformance(javaAdapter, [{ name: "maven", repo }]);
 * expect(report.failures).toEqual([]);
 * ```
 *
 * It is framework-agnostic: it returns a report instead of registering tests.
 */

export interface ConformanceFixture {
  readonly name: string;
  readonly repo: RepositoryView;
  /** When given, the module roots the adapter must detect, in any order. */
  readonly expectedRoots?: readonly string[];
}

export interface ConformanceCheck {
  readonly fixture: string;
  readonly check: string;
  readonly passed: boolean;
  readonly message?: string;
}

export interface ConformanceReport {
  readonly checks: readonly ConformanceCheck[];
  readonly failures: readonly ConformanceCheck[];
}

export interface ConformanceOptions {
  /**
   * Toolchains the command catalog is resolved against. By default: every tool available, and
   * no tool available. Catalogs must be valid and deterministic for each.
   */
  readonly toolchains?: readonly ToolchainProbe[];
}

export async function checkAdapterConformance(
  adapter: LanguageAdapter,
  fixtures: readonly ConformanceFixture[],
  options: ConformanceOptions = {},
): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];
  const record = (fixture: string, check: string, problem: string | undefined): void => {
    checks.push(
      problem === undefined
        ? { fixture, check, passed: true }
        : { fixture, check, passed: false, message: problem },
    );
  };

  try {
    checkIdentity(adapter);
    record("-", "identity", undefined);
  } catch (error) {
    record("-", "identity", message(error));
    return report(checks);
  }

  const validated = validatedAdapter(adapter);
  const toolchains = options.toolchains ?? [new AllToolsProbe(), new StaticToolchainProbe([])];

  for (const fixture of fixtures) {
    const { name, repo } = fixture;
    let candidates: readonly ModuleCandidate[];
    try {
      candidates = await validated.detectModules(repo);
      const again = await validated.detectModules(repo);
      record(name, "detectModules: valid", undefined);
      record(
        name,
        "detectModules: deterministic",
        same(candidates, again) ? undefined : "two calls returned different modules",
      );
    } catch (error) {
      record(name, "detectModules: valid", message(error));
      continue;
    }
    if (fixture.expectedRoots !== undefined) {
      const actual = candidates.map((candidate) => candidate.root).sort();
      const expected = [...fixture.expectedRoots].sort();
      record(
        name,
        "detectModules: expected roots",
        same(actual, expected)
          ? undefined
          : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
      );
    }
    record(
      name,
      "detectModules: evidence exists",
      await missingEvidence(
        repo,
        candidates.flatMap((c) => c.evidence),
      ),
    );

    for (const candidate of candidates) {
      const where = `${name}:${candidate.root}`;
      let profile: ModuleProfile;
      try {
        profile = await validated.analyzeModule(candidate, repo);
        record(where, "analyzeModule: valid", undefined);
      } catch (error) {
        record(where, "analyzeModule: valid", message(error));
        continue;
      }
      record(
        where,
        "analyzeModule: evidence exists",
        await missingEvidence(repo, profileEvidence(profile)),
      );

      try {
        await validated.inferConventions(profile, repo);
        record(where, "inferConventions: valid", undefined);
      } catch (error) {
        record(where, "inferConventions: valid", message(error));
      }

      try {
        const inventory = await validated.discoverTests(profile, repo);
        const missing: string[] = [];
        for (const file of inventory.files)
          if (!(await repo.exists(file.path))) missing.push(file.path);
        record(where, "discoverTests: valid", undefined);
        record(
          where,
          "discoverTests: files exist",
          missing.length === 0 ? undefined : `missing: ${missing.join(", ")}`,
        );
      } catch (error) {
        record(where, "discoverTests: valid", message(error));
      }

      try {
        validated.testAuthoringGuide(profile);
        record(where, "testAuthoringGuide: valid", undefined);
      } catch (error) {
        record(where, "testAuthoringGuide: valid", message(error));
      }

      let fullCatalog: readonly CommandSpec[] = [];
      for (const [index, toolchain] of toolchains.entries()) {
        const label = `commandCatalog[toolchain ${String(index + 1)}]`;
        try {
          const catalog = await validated.commandCatalog(profile, toolchain, repo);
          const again = await validated.commandCatalog(profile, toolchain, repo);
          record(where, `${label}: valid`, undefined);
          record(
            where,
            `${label}: deterministic`,
            same(catalog, again) ? undefined : "two calls returned different commands",
          );
          if (index === 0) fullCatalog = catalog;
        } catch (error) {
          record(where, `${label}: valid`, message(error));
        }
      }

      for (const command of fullCatalog) {
        for (const exitCode of [0, 1]) {
          const check = `parseResults(${command.id}, exit ${String(exitCode)}, no reports): never guesses`;
          try {
            const parsed = await validated.parseResults(
              command,
              fakeExecution(command, exitCode),
              repo,
            );
            const invented = parsed.tests.filter((test) => test.status === "passed");
            record(
              where,
              check,
              invented.length === 0
                ? undefined
                : `reported ${String(invented.length)} passed test(s) without any report file`,
            );
          } catch (error) {
            record(where, check, message(error));
          }
        }
      }
    }
  }
  return report(checks);
}

/** A probe that reports every tool as available. */
class AllToolsProbe implements ToolchainProbe {
  readonly platform: NodeJS.Platform = process.platform;
  probe(): Promise<ToolAvailability> {
    return Promise.resolve({ available: true });
  }
}

/**
 * An execution record for a run that produced no report files. Its start time is in the far
 * future, so no existing file can count as fresh output of this run.
 */
function fakeExecution(command: CommandSpec, exitCode: number): ExecutionRecord {
  return {
    commandId: command.id,
    argv: [command.executable, ...command.args],
    cwd: command.cwd,
    invocation: "direct",
    approval: { via: "allowlist-flag" },
    startedAt: "2099-01-01T00:00:00.000Z",
    durationMs: 1000,
    exitCode,
    signal: null,
    timedOut: false,
    stdoutPath: ".devflow/runs/conformance/stdout.log",
    stderrPath: ".devflow/runs/conformance/stderr.log",
    outputTruncated: false,
  };
}

function profileEvidence(profile: ModuleProfile): Evidence[] {
  return [
    ...profile.languages,
    ...(profile.buildTool === undefined ? [] : [profile.buildTool]),
    ...profile.frameworks,
    ...profile.testFrameworks,
    ...profile.qualityTools,
    ...profile.contracts,
  ].flatMap((detection) => detection.evidence);
}

async function missingEvidence(
  repo: RepositoryView,
  evidence: readonly Evidence[],
): Promise<string | undefined> {
  const missing = new Set<string>();
  for (const item of evidence) {
    if (item.path !== undefined && !(await repo.exists(item.path))) missing.add(item.path);
  }
  return missing.size === 0
    ? undefined
    : `evidence points at missing files: ${[...missing].join(", ")}`;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function report(checks: readonly ConformanceCheck[]): ConformanceReport {
  return { checks, failures: checks.filter((check) => !check.passed) };
}
