import {
  defineAdapter,
  detection,
  evidenceAt,
  fileEvidence,
  freshReportFiles,
  joinRepoPath,
  moduleIdFor,
  parseJsonOrUndefined,
  readTextIfPresent,
  repoDirname,
  unparseable,
  type CommandSpec,
  type LanguageAdapter,
  type ParsedCommandResults,
} from "../../src/index.js";

/**
 * A minimal adapter for the SDK tests: a module is a directory with a `toy.json` manifest;
 * tests are `*.toy-test` files; the test command writes `toy-report.json` in the module root.
 */
export function toyAdapter(overrides: Partial<LanguageAdapter> = {}): LanguageAdapter {
  return {
    ...defineAdapter({
      id: "toy",
      displayName: "Toy",
      async detectModules(repo) {
        const manifests = await repo.glob(["**/toy.json"]);
        return manifests.map((manifest) => ({
          adapterId: "toy",
          root: repoDirname(manifest),
          confidence: 1,
          evidence: [fileEvidence(manifest, "toy manifest")],
        }));
      },
      async analyzeModule(candidate, repo) {
        const manifestPath = joinRepoPath(candidate.root, "toy.json");
        const text = (await readTextIfPresent(repo, manifestPath)) ?? "{}";
        const runner = evidenceAt(manifestPath, text, /"runner"/, "test runner declared");
        return {
          moduleId: moduleIdFor(candidate),
          adapterId: "toy",
          root: candidate.root,
          languages: [detection("toy", 1, [fileEvidence(manifestPath, "toy manifest")])],
          frameworks: [],
          testFrameworks: runner === undefined ? [] : [detection("toy-test", 0.9, [runner])],
          qualityTools: [],
          sourceRoots: [joinRepoPath(candidate.root, "src")],
          testRoots: [joinRepoPath(candidate.root, "test")],
          contracts: [],
        };
      },
      async discoverTests(profile, repo) {
        const files = await repo.glob(["**/*.toy-test"], { cwd: profile.root });
        return {
          moduleId: profile.moduleId,
          files: files.map((path) => ({ path, framework: "toy-test" })),
          namingPatterns: ["*.toy-test"],
        };
      },
      testAuthoringGuide(profile) {
        return {
          framework: "toy-test",
          testRoot: joinRepoPath(profile.root, "test"),
          fileNamePattern: "{name}.toy-test",
          acMarker: { style: "title-prefix", example: "AC-1: does the thing" },
          notes: [],
        };
      },
      async commandCatalog(profile, toolchain) {
        const available = (await toolchain.probe("toy")).available;
        if (!available) return [];
        const test: CommandSpec = {
          id: `${profile.moduleId}:test`,
          purpose: "test",
          executable: "toy",
          args: ["test"],
          cwd: profile.root,
          env: {},
          timeoutMs: 60_000,
          network: "none",
          parameters: [],
          results: { parser: "toy-report", reportGlobs: ["toy-report.json"] },
          origin: "adapter",
        };
        return [test];
      },
      async parseResults(command, execution, repo): Promise<ParsedCommandResults> {
        const reports = await freshReportFiles(repo, command.cwd, {
          name: /^toy-report\.json$/,
          startedAt: execution.startedAt,
        });
        const report = reports[0];
        if (report === undefined) return unparseable("no fresh toy-report.json");
        const data = parseJsonOrUndefined(await repo.readText(report.path));
        if (!Array.isArray(data)) return unparseable("toy-report.json is not a list");
        return {
          parse: "parsed",
          tests: data.map((name: unknown) => ({
            id: String(name),
            name: String(name),
            outcome: "passed" as const,
            status: "passed" as const,
            markers: [],
          })),
          diagnostics: [],
          evidence: [fileEvidence(report.path, "toy report")],
        };
      },
    }),
    ...overrides,
  };
}
