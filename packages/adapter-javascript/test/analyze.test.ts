import { validatedAdapter, type ModuleProfile } from "@devflowai/core";
import { MemoryRepository } from "@devflowai/core/testing";
import { describe, expect, it } from "vitest";
import {
  javascriptAdapter,
  packageManagerOf,
  parseJsonc,
  pnpmWorkspacePackages,
  workspaceIncludes,
} from "../src/index.js";
import { expressRepo, mochaRepo, monorepoRepo } from "./fixtures.js";

const adapter = validatedAdapter(javascriptAdapter);

async function profileAt(repo: MemoryRepository, root: string): Promise<ModuleProfile> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  return adapter.analyzeModule(candidate, repo);
}

const ids = (detections: readonly { id: string }[]) => detections.map((d) => d.id);

describe("detectModules", () => {
  it("finds one module per project manifest and describes workspaces", async () => {
    const candidates = await adapter.detectModules(monorepoRepo());
    expect(candidates.map((c) => c.root)).toEqual([
      ".",
      "apps/web",
      "packages/api",
      "packages/proto",
    ]);
    expect(candidates[0]?.evidence.map((e) => [e.path, e.description])).toEqual([
      ["package.json", "workspace root with 3 package(s)"],
      ["pnpm-workspace.yaml", "pnpm workspace"],
    ]);
    expect(candidates[1]?.evidence[0]?.description).toBe("package @shop/web of the workspace at .");
  });

  it("skips fixtures, module-format markers and installed packages", async () => {
    const roots = (await adapter.detectModules(monorepoRepo())).map((c) => c.root);
    expect(roots).not.toContain("packages/api/test/fixtures/sample");
    expect(roots).not.toContain("apps/web/src/legacy");
    expect(roots.some((root) => root.includes("node_modules"))).toBe(false);
  });

  it("gives an unreadable manifest a low confidence instead of failing", async () => {
    const broken = new MemoryRepository({ "package.json": '{ "name": "x", ' });
    expect(await adapter.detectModules(broken)).toMatchObject([{ root: ".", confidence: 0.5 }]);
  });
});

describe("workspaces", () => {
  it("reads pnpm-workspace.yaml package lists, with quotes, comments and inline arrays", () => {
    expect(
      pnpmWorkspacePackages(
        "packages:\n  - 'apps/*'\n  - \"libs/**\" # shared\n  # - 'old/*'\n  - '!**/test/**'\ncatalog:\n  react: ^18\n",
      ),
    ).toEqual(["apps/*", "libs/**", "!**/test/**"]);
    expect(pnpmWorkspacePackages("packages: ['a/*', \"b\"]\n")).toEqual(["a/*", "b"]);
  });

  it("matches members against positive and negated patterns", () => {
    const workspace = {
      dir: ".",
      patterns: ["packages/*", "!packages/internal"],
      evidence: { kind: "file" as const, description: "x", deterministic: true },
    };
    expect(workspaceIncludes(workspace, "packages/a")).toBe(true);
    expect(workspaceIncludes(workspace, "packages/internal")).toBe(false);
    expect(workspaceIncludes(workspace, "packages/a/nested")).toBe(false);
    expect(workspaceIncludes(workspace, ".")).toBe(false);
  });
});

describe("packageManagerOf", () => {
  it("prefers the packageManager field, then the nearest lockfile", async () => {
    expect(await packageManagerOf(expressRepo(), ".")).toMatchObject({
      id: "pnpm",
      version: "9.12.0",
      confidence: 0.95,
      evidence: [{ path: "package.json", line: 5 }],
    });
    expect(await packageManagerOf(monorepoRepo(), "apps/web")).toMatchObject({
      id: "pnpm",
      evidence: [{ path: "pnpm-lock.yaml" }],
    });
    expect(await packageManagerOf(mochaRepo(), ".")).toMatchObject({ id: "npm" });
    expect(
      await packageManagerOf(new MemoryRepository({ "package.json": "{}" }), "."),
    ).toBeUndefined();
  });
});

describe("analyzeModule", () => {
  it("profiles a TypeScript Express service with versions of the installed packages", async () => {
    const profile = await profileAt(expressRepo(), ".");
    expect(profile.moduleId).toBe("javascript");
    expect(profile.buildTool).toMatchObject({ id: "pnpm", version: "9.12.0" });
    expect(profile.languages).toMatchObject([{ id: "typescript", version: "5.6.3" }]);
    expect(profile.frameworks).toMatchObject([
      { id: "express", version: "4.21.1", confidence: 0.95 },
    ]);
    expect(profile.testFrameworks).toMatchObject([{ id: "vitest", version: "2.1.3" }]);
    expect(ids(profile.qualityTools)).toEqual(["eslint", "prettier", "tsc"]);
    expect(profile.frameworks[0]?.evidence[0]).toMatchObject({
      path: "package.json",
      line: 12,
      description: "Express: express@^4.21.0 in dependencies",
    });
    expect(profile.sourceRoots).toEqual(["src"]);
    expect(profile.testRoots).toEqual(["src"]);
  });

  it("links the OpenAPI file a package script generates a client from", async () => {
    const profile = await profileAt(expressRepo(), ".");
    expect(profile.contracts.map((c) => [c.kind, c.path, c.role])).toEqual([
      ["openapi", "contracts/orders.openapi.yaml", "defines"],
      ["openapi", "contracts/orders.openapi.yaml", "generates-code-from"],
    ]);
    expect(profile.contracts[1]?.evidence[0]).toMatchObject({
      path: "package.json",
      line: 9,
      description: 'OpenAPI code generation in the "generate:client" script',
    });
  });

  it("keeps the files of workspace packages out of the workspace root", async () => {
    const root = await profileAt(monorepoRepo(), ".");
    expect(root.languages).toEqual([
      expect.objectContaining({ id: "typescript", confidence: 0.8 }),
    ]);
    expect(root.testFrameworks).toEqual([]);
    expect(root.frameworks).toEqual([]);
    expect(ids(root.qualityTools)).toEqual(["eslint", "prettier", "tsc"]);
    expect(root.sourceRoots).toEqual([]);
    expect(root.testRoots).toEqual([]);
    expect(root.contracts).toEqual([]);
  });

  it("profiles workspace packages from their own manifests and configuration", async () => {
    const web = await profileAt(monorepoRepo(), "apps/web");
    expect(ids(web.frameworks)).toEqual(["react", "vite"]);
    expect(web.testFrameworks).toMatchObject([
      { id: "vitest", version: "2.1.3" },
      { id: "playwright", version: "1.48.0" },
    ]);
    // tsconfig.json configures tsc; the compiler is installed at the workspace root.
    expect(web.qualityTools).toMatchObject([{ id: "tsc", version: "5.6.3", confidence: 0.9 }]);
    expect(web.testRoots).toEqual(["apps/web/e2e", "apps/web/src"]);

    const api = await profileAt(monorepoRepo(), "packages/api");
    expect(api.frameworks).toMatchObject([{ id: "nestjs", version: "10.4.4" }]);
    expect(api.testFrameworks).toMatchObject([{ id: "jest", version: "29.7.0", confidence: 0.95 }]);
    expect(api.testFrameworks[0]?.evidence.map((e) => e.description)).toEqual([
      "Jest: jest@^29.7.0 in devDependencies",
      "Jest configuration in package.json",
    ]);
    expect(api.testRoots).toEqual(["packages/api/test"]);
  });

  it("links Protobuf contracts to the generator that uses them", async () => {
    const proto = await profileAt(monorepoRepo(), "packages/proto");
    expect(proto.contracts.map((c) => [c.kind, c.path, c.role])).toEqual([
      ["protobuf", "packages/proto/proto/orders.proto", "defines"],
      ["protobuf", "packages/proto/proto/orders.proto", "generates-code-from"],
    ]);
    expect(proto.contracts[1]?.evidence[0]?.description).toBe("ts-proto: protobuf code generator");
  });

  it("profiles a JavaScript package without TypeScript", async () => {
    const profile = await profileAt(mochaRepo(), ".");
    expect(profile.languages).toMatchObject([{ id: "javascript", confidence: 0.95 }]);
    expect(profile.testFrameworks).toMatchObject([{ id: "mocha" }]);
    expect(profile.testFrameworks[0]?.version).toBeUndefined();
    expect(profile.sourceRoots).toEqual(["."]);
    expect(profile.testRoots).toEqual(["test"]);
  });

  it("counts a peer dependency with a lower confidence", async () => {
    const repo = new MemoryRepository({
      "package.json": JSON.stringify({ name: "ui-kit", peerDependencies: { react: ">=18" } }),
      "index.js": "export {};\n",
    });
    const profile = await profileAt(repo, ".");
    expect(profile.frameworks).toMatchObject([{ id: "react", confidence: 0.7 }]);
    expect(profile.frameworks[0]?.version).toBeUndefined();
  });
});

describe("parseJsonc", () => {
  it("accepts comments and trailing commas but keeps them inside strings", () => {
    expect(
      parseJsonc('{\n  // c\n  "a": "x // y", /* z */ "b": [1, 2,],\n  "c": "/* not */",\n}'),
    ).toEqual({ a: "x // y", b: [1, 2], c: "/* not */" });
    expect(parseJsonc('{ "a": 1 /* open')).toBeUndefined();
    expect(parseJsonc("not json")).toBeUndefined();
  });
});
