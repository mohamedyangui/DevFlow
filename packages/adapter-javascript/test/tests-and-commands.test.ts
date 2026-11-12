import {
  hardDenyReason,
  StaticToolchainProbe,
  validatedAdapter,
  type ModuleProfile,
} from "@devflow-ai/core";
import { MemoryRepository } from "@devflow-ai/core/testing";
import { describe, expect, it } from "vitest";
import { isSolutionStyleTsconfig, javascriptAdapter, pathFrom } from "../src/index.js";
import { expressRepo, mochaRepo, monorepoRepo } from "./fixtures.js";

const adapter = validatedAdapter(javascriptAdapter);
const probe = new StaticToolchainProbe([]);

async function profileAt(repo: MemoryRepository, root: string): Promise<ModuleProfile> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  return adapter.analyzeModule(candidate, repo);
}

describe("discoverTests", () => {
  it("lists test files with their runner and level, leaving out helpers", async () => {
    const repo = expressRepo();
    const inventory = await adapter.discoverTests(await profileAt(repo, "."), repo);
    expect(inventory.files).toEqual([
      { path: "src/app.test.ts", framework: "vitest", level: "integration" },
      { path: "src/orders.test.ts", framework: "vitest", level: "unit" },
    ]);
    expect(inventory.namingPatterns).toEqual(["**/*.test.ts"]);
  });

  it("separates Playwright end-to-end tests from unit tests", async () => {
    const repo = monorepoRepo();
    const inventory = await adapter.discoverTests(await profileAt(repo, "apps/web"), repo);
    expect(inventory.files).toEqual([
      { path: "apps/web/e2e/checkout.spec.ts", framework: "playwright", level: "e2e" },
      { path: "apps/web/src/App.test.tsx", framework: "vitest", level: "unit" },
      { path: "apps/web/src/Cart.spec.tsx", framework: "vitest", level: "unit" },
    ]);
    const api = await adapter.discoverTests(await profileAt(repo, "packages/api"), repo);
    expect(api.files).toEqual([
      { path: "packages/api/test/orders.int.test.ts", framework: "jest", level: "integration" },
      { path: "packages/api/test/orders.service.test.ts", framework: "jest", level: "unit" },
    ]);
    const root = await adapter.discoverTests(await profileAt(repo, "."), repo);
    expect(root.files).toEqual([]);
  });

  it("reads Mocha's test directory, where files have no .test suffix", async () => {
    const repo = mochaRepo();
    const inventory = await adapter.discoverTests(await profileAt(repo, "."), repo);
    expect(inventory.files).toEqual([{ path: "test/sum.js", framework: "mocha", level: "unit" }]);
    expect(inventory.namingPatterns).toEqual(["test/**"]);
  });
});

describe("inferConventions", () => {
  it("reports what most test files do, with the files as evidence", async () => {
    const repo = expressRepo();
    const conventions = await adapter.inferConventions(await profileAt(repo, "."), repo);
    expect(conventions.map((c) => [c.id, c.confidence])).toEqual([
      ["js.test-file-suffix.test", 1],
      ["js.test-location.colocated", 1],
      ["js.test-function.it", 1],
      ["js.test-imports.explicit", 1],
      ["js.ac-title-marker", 1],
    ]);
    expect(conventions[3]).toMatchObject({
      description: '2 of 2 test files import describe/it/expect from "vitest"',
      evidence: [
        { path: "src/app.test.ts", line: 1 },
        { path: "src/orders.test.ts", line: 1 },
      ],
    });
  });

  it("reports nothing below the threshold, and notices AC title markers", async () => {
    const repo = monorepoRepo();
    const web = await adapter.inferConventions(await profileAt(repo, "apps/web"), repo);
    // One .test and one .spec unit file: no suffix convention (Playwright's .spec is not counted).
    expect(web.map((c) => c.id)).toEqual([
      "js.test-location.colocated",
      "js.test-function.test",
      "js.test-imports.explicit",
      "js.ac-title-marker",
    ]);
    const api = await adapter.inferConventions(await profileAt(repo, "packages/api"), repo);
    expect(api.map((c) => c.id)).toEqual([
      "js.test-file-suffix.test",
      "js.test-location.test-directory",
      "js.test-function.it",
      "js.test-imports.globals",
      "js.ac-title-marker",
    ]);
  });
});

describe("testAuthoringGuide", () => {
  it("uses title markers and the module's runner and language", async () => {
    const express = adapter.testAuthoringGuide(await profileAt(expressRepo(), "."));
    expect(express).toMatchObject({
      framework: "vitest",
      testRoot: "src",
      fileNamePattern: "{name}.test.ts",
      acMarker: {
        style: "title-prefix",
        example: 'it("AC-1: returns the second page", () => { ... })',
      },
    });
    const mocha = adapter.testAuthoringGuide(await profileAt(mochaRepo(), "."));
    expect(mocha).toMatchObject({
      framework: "mocha",
      testRoot: "test",
      fileNamePattern: "{name}.test.js",
    });
    expect(mocha.notes.some((note) => note.includes("no Mocha command"))).toBe(true);
  });

  it("assumes Vitest, and says so, when no runner is detected", async () => {
    const repo = new MemoryRepository({ "package.json": '{ "name": "x" }', "index.js": "" });
    const guide = adapter.testAuthoringGuide(await profileAt(repo, "."));
    expect(guide).toMatchObject({ framework: "vitest", testRoot: "test" });
    expect(guide.notes.some((note) => note.includes("No test runner was detected"))).toBe(true);
  });
});

describe("commandCatalog", () => {
  it("runs the installed tools' entry scripts with node, writing reports into node_modules", async () => {
    const repo = expressRepo();
    const catalog = await adapter.commandCatalog(await profileAt(repo, "."), probe, repo);
    expect(catalog.map((c) => [c.id, c.purpose, c.executable, ...c.args])).toEqual([
      [
        "javascript:test",
        "test",
        "node",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--reporter=default",
        "--reporter=json",
        "--outputFile.json=node_modules/.devflow-javascript-vitest.json",
        "--passWithNoTests",
      ],
      [
        "javascript:test-filter",
        "test",
        "node",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--reporter=default",
        "--reporter=json",
        "--outputFile.json=node_modules/.devflow-javascript-vitest.json",
        "--passWithNoTests",
        "--testNamePattern",
        "{testNamePattern}",
      ],
      [
        "javascript:lint",
        "lint",
        "node",
        "node_modules/eslint/bin/eslint.js",
        ".",
        "--format",
        "json",
        "--output-file",
        "node_modules/.devflow-javascript-eslint.json",
      ],
      [
        "javascript:typecheck",
        "typecheck",
        "node",
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--pretty",
        "false",
        "--project",
        "tsconfig.json",
      ],
      [
        "javascript:format-check",
        "format-check",
        "node",
        "node_modules/prettier/bin/prettier.cjs",
        "--check",
        ".",
      ],
    ]);
    expect(catalog[0]).toMatchObject({
      cwd: ".",
      env: { NO_COLOR: "1", FORCE_COLOR: "0" },
      network: "none",
      results: {
        parser: "jest-json",
        reportGlobs: ["node_modules/.devflow-javascript-vitest.json"],
      },
    });
  });

  it("finds tools installed further up, and uses Jest where the package does", async () => {
    const repo = monorepoRepo();
    const web = await adapter.commandCatalog(await profileAt(repo, "apps/web"), probe, repo);
    expect(web.map((c) => [c.id, c.args[0]])).toEqual([
      ["apps-web:test", "node_modules/vitest/vitest.mjs"],
      ["apps-web:test-filter", "node_modules/vitest/vitest.mjs"],
      ["apps-web:typecheck", "../../node_modules/typescript/bin/tsc"],
    ]);
    expect(web[0]?.results.reportGlobs).toEqual([
      "apps/web/node_modules/.devflow-apps-web-vitest.json",
    ]);

    const api = await adapter.commandCatalog(await profileAt(repo, "packages/api"), probe, repo);
    expect(api.map((c) => [c.id, ...c.args])).toEqual([
      [
        "packages-api:test",
        "node_modules/jest/bin/jest.js",
        "--ci",
        "--json",
        "--outputFile=node_modules/.devflow-packages-api-jest.json",
        "--passWithNoTests",
      ],
      [
        "packages-api:test-filter",
        "node_modules/jest/bin/jest.js",
        "--ci",
        "--json",
        "--outputFile=node_modules/.devflow-packages-api-jest.json",
        "--passWithNoTests",
        "--testNamePattern",
        "{testNamePattern}",
      ],
      [
        "packages-api:typecheck",
        "../../node_modules/typescript/bin/tsc",
        "--noEmit",
        "--pretty",
        "false",
        "--project",
        "tsconfig.json",
      ],
    ]);
  });

  it("skips typecheck for a solution-style tsconfig and gives the root its shared tools", async () => {
    const repo = monorepoRepo();
    const root = await adapter.commandCatalog(await profileAt(repo, "."), probe, repo);
    expect(root.map((c) => c.id)).toEqual(["javascript:lint", "javascript:format-check"]);
    expect(isSolutionStyleTsconfig('{ "files": [], "references": [{ "path": "a" }] }')).toBe(true);
    expect(isSolutionStyleTsconfig('{ "files": [], "include": ["src"], "references": [] }')).toBe(
      false,
    );
  });

  it("points at the not yet installed script, which the command policy then refuses", async () => {
    const repo = new MemoryRepository({
      "packages/a/package.json": JSON.stringify({
        name: "a",
        devDependencies: { vitest: "^2.1.0" },
      }),
    });
    const catalog = await adapter.commandCatalog(await profileAt(repo, "packages/a"), probe, repo);
    expect(catalog[0]?.args[0]).toBe("node_modules/vitest/vitest.mjs");
    expect(catalog[0]?.results.reportGlobs).toEqual([
      "packages/a/node_modules/.devflow-packages-a-vitest.json",
    ]);
  });

  it("offers no command for a runner DevFlow cannot read, nor for undeclared tools", async () => {
    const repo = mochaRepo();
    expect(await adapter.commandCatalog(await profileAt(repo, "."), probe, repo)).toEqual([]);
  });

  it("passes the script before any option, so node's inline-code options never apply", async () => {
    const repo = expressRepo();
    const catalog = await adapter.commandCatalog(await profileAt(repo, "."), probe, repo);
    for (const command of catalog) {
      expect(command.args[0]?.startsWith("-")).toBe(false);
      expect(hardDenyReason(command.executable, command.args)).toBeUndefined();
    }
  });
});

describe("pathFrom", () => {
  it("names a repository path relative to a directory", () => {
    expect(pathFrom(".", "node_modules/x")).toBe("node_modules/x");
    expect(pathFrom("packages/a", "node_modules/x")).toBe("../../node_modules/x");
    expect(pathFrom("packages/a", "packages/a/node_modules/x")).toBe("node_modules/x");
    expect(pathFrom("a/b", "a/c/d")).toBe("../c/d");
    expect(pathFrom("a", "a")).toBe(".");
  });
});
