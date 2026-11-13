/**
 * A DevFlow adapter plugin for the invented Toy language, used by the plugin tests
 * (docs/specs/language-adapter.md, section 12). It depends on nothing, not even @devflowai/core.
 *
 * - A module is a directory with a `toy.json` manifest.
 * - Tests are `*.toy` files under `tests/`.
 * - The test command is `node toy-test.mjs` in the module root; the script writes
 *   `toy-report.json`, a list of `{ "name": ..., "passed": true|false }`.
 *
 * Like every adapter it only returns data: it reads through the repository view and describes
 * commands; DevFlow's command policy decides whether they run.
 */

const REPORT = "toy-report.json";

function join(root, file) {
  return root === "." ? file : `${root}/${file}`;
}

function evidence(path, description) {
  return { kind: "file", description, deterministic: true, path };
}

function markers(name) {
  const match = /^(AC-\d+):/.exec(name);
  return match === null ? [] : [match[1]];
}

export const devflowAdapter = {
  id: "toy",
  displayName: "Toy (test plugin)",
  apiVersion: "1.0.0",
  languages: ["toy"],

  async detectModules(repo) {
    const manifests = await repo.glob(["**/toy.json"]);
    return manifests.map((manifest) => {
      const slash = manifest.lastIndexOf("/");
      return {
        adapterId: "toy",
        root: slash === -1 ? "." : manifest.slice(0, slash),
        confidence: 1,
        evidence: [evidence(manifest, "Toy manifest")],
      };
    });
  },

  async analyzeModule(candidate) {
    const manifest = join(candidate.root, "toy.json");
    return {
      moduleId: candidate.root === "." ? "toy" : candidate.root.replace(/\//g, "-"),
      adapterId: "toy",
      root: candidate.root,
      languages: [{ id: "toy", confidence: 1, evidence: [evidence(manifest, "Toy manifest")] }],
      frameworks: [],
      testFrameworks: [
        { id: "toy-test", confidence: 0.9, evidence: [evidence(manifest, "Toy manifest")] },
      ],
      qualityTools: [],
      sourceRoots: [join(candidate.root, "src")],
      testRoots: [join(candidate.root, "tests")],
      contracts: [],
    };
  },

  async discoverTests(profile, repo) {
    const files = await repo.glob(["tests/**/*.toy"], { cwd: profile.root });
    return {
      moduleId: profile.moduleId,
      files: files.map((path) => ({ path, framework: "toy-test" })),
      namingPatterns: ["*.toy"],
    };
  },

  testAuthoringGuide(profile) {
    return {
      framework: "toy-test",
      testRoot: join(profile.root, "tests"),
      fileNamePattern: "{name}.toy",
      acMarker: { style: "title-prefix", example: "AC-1: does the thing" },
      notes: [],
    };
  },

  async commandCatalog(profile) {
    return [
      {
        id: `${profile.moduleId}:test`,
        purpose: "test",
        executable: "node",
        args: ["toy-test.mjs"],
        cwd: profile.root,
        env: {},
        timeoutMs: 60000,
        network: "none",
        parameters: [],
        results: { parser: "toy-report", reportGlobs: [REPORT] },
        origin: "adapter",
      },
    ];
  },

  async parseResults(command, execution, repo) {
    const unparseable = (note) => ({
      parse: "unparseable",
      tests: [],
      diagnostics: [],
      evidence: [],
      note,
    });
    const started = Date.parse(execution.startedAt);
    const entries = await repo.list(command.cwd);
    const report = entries.find(
      (entry) =>
        entry.kind === "file" &&
        entry.path === join(command.cwd, REPORT) &&
        entry.modifiedMs !== undefined &&
        entry.modifiedMs >= started - 2000,
    );
    if (report === undefined) return unparseable(`no fresh ${REPORT}`);
    let data;
    try {
      data = JSON.parse(await repo.readText(report.path));
    } catch {
      return unparseable(`${REPORT} is not JSON`);
    }
    if (!Array.isArray(data)) return unparseable(`${REPORT} is not a list`);
    return {
      parse: "parsed",
      tests: data.map((test) => ({
        id: `toy#${String(test.name)}`,
        name: String(test.name),
        outcome: test.passed === true ? "passed" : "assertion_failure",
        status: test.passed === true ? "passed" : "failed",
        markers: markers(String(test.name)),
      })),
      diagnostics: [],
      evidence: [evidence(report.path, "Toy test report")],
    };
  },
};
