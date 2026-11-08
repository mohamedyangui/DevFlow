import { describe, expect, it } from "vitest";
import { MemoryRepository, checkAdapterConformance } from "../../src/testing/index.js";
import { toyAdapter } from "./toy-adapter.js";

const fixture = {
  name: "two modules",
  repo: new MemoryRepository({
    "toy.json": '{ "runner": "fast" }',
    "lib/toy.json": "{}",
    "lib/test/a.toy-test": "",
  }),
  expectedRoots: [".", "lib"],
};

describe("checkAdapterConformance", () => {
  it("passes a well-behaved adapter", async () => {
    const report = await checkAdapterConformance(toyAdapter(), [fixture]);
    expect(report.failures).toEqual([]);
    expect(report.checks.map((check) => check.check)).toEqual(
      expect.arrayContaining([
        "identity",
        "detectModules: deterministic",
        "detectModules: expected roots",
        "analyzeModule: evidence exists",
        "discoverTests: files exist",
        "commandCatalog[toolchain 1]: deterministic",
        "parseResults(toy:test, exit 0, no reports): never guesses",
      ]),
    );
  });

  it("fails an adapter that reports passed tests without reading any report", async () => {
    const guessing = toyAdapter({
      parseResults: () =>
        Promise.resolve({
          parse: "parsed",
          tests: [{ id: "t", name: "t", outcome: "passed", status: "passed", markers: [] }],
          diagnostics: [],
          evidence: [],
        }),
    });
    const report = await checkAdapterConformance(guessing, [fixture]);
    expect(report.failures.map((f) => f.check)).toContain(
      "parseResults(toy:test, exit 0, no reports): never guesses",
    );
  });

  it("fails non-deterministic detection, wrong roots and evidence pointing at missing files", async () => {
    let calls = 0;
    const flaky = toyAdapter({
      detectModules: () =>
        Promise.resolve([
          {
            adapterId: "toy",
            root: calls++ % 2 === 0 ? "." : "lib",
            confidence: 1,
            evidence: [
              { kind: "file", description: "x", deterministic: true, path: "nowhere.json" },
            ],
          },
        ]),
    });
    const report = await checkAdapterConformance(flaky, [fixture]);
    expect(report.failures.map((f) => f.check)).toEqual(
      expect.arrayContaining([
        "detectModules: deterministic",
        "detectModules: expected roots",
        "detectModules: evidence exists",
      ]),
    );
  });

  it("stops at an invalid identity", async () => {
    const report = await checkAdapterConformance(toyAdapter({ id: "Bad" }), [fixture]);
    expect(report.checks).toHaveLength(1);
    expect(report.failures[0]?.check).toBe("identity");
  });
});
