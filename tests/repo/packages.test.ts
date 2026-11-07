import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageDirectories,
  readJson,
  readJsonc,
  repoRoot,
  type BuildConfig,
  type PackageManifest,
  type RootManifest,
} from "./helpers.js";

/**
 * Structural rules for workspace packages (ADR 0003, ADR 0016). The import-level rules are
 * enforced by ESLint from the same table in the root package.json.
 */
const root = readJson("package.json") as RootManifest;
const scope = root.devflow.npmScope;
const boundaries = root.devflow.packageBoundaries;
const directories = packageDirectories();

function manifest(dir: string): PackageManifest {
  return readJson(`packages/${dir}/package.json`) as PackageManifest;
}

function internalDependencies(pkg: PackageManifest): string[] {
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => name.startsWith(`${scope}/`))
    .map((name) => name.slice(scope.length + 1))
    .sort();
}

describe("workspace layout", () => {
  it("has exactly the seven MVP packages, each with declared boundaries", () => {
    expect(directories).toEqual([
      "adapter-java",
      "adapter-javascript",
      "ai",
      "cli",
      "context",
      "core",
      "workflow",
    ]);
    expect(Object.keys(boundaries).sort()).toEqual(directories);
  });

  it("builds every package from the root build solution", () => {
    const solution = readJsonc("tsconfig.build.json") as BuildConfig;
    expect((solution.references ?? []).map((ref) => ref.path).sort()).toEqual(
      directories.map((dir) => `packages/${dir}/tsconfig.build.json`).sort(),
    );
  });

  it("uses a valid npm scope", () => {
    expect(scope).toMatch(/^@[a-z0-9][a-z0-9._-]*$/);
  });
});

describe.each(directories)("package %s", (dir) => {
  const pkg = manifest(dir);

  it("is named within the configured scope", () => {
    expect(pkg.name).toBe(`${scope}/${dir}`);
  });

  it("cannot be published until scope ownership is verified (ADR 0016)", () => {
    expect(pkg.private).toBe(true);
  });

  it("declares the license, module type and supported Node.js versions", () => {
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.type).toBe("module");
    expect(pkg.engines?.node).toBe(">=22.12.0");
  });

  it("exposes source and build entry points", () => {
    expect(pkg.exports?.["."]).toEqual({
      "devflow-source": "./src/index.ts",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(pkg.files).toEqual(["dist"]);
    expect(existsSync(path.join(repoRoot, "packages", dir, "src", "index.ts"))).toBe(true);
  });

  it("only depends on the workspace packages its boundary allows", () => {
    const allowed = boundaries[dir];
    const actual = internalDependencies(pkg);
    if (allowed !== "*") {
      expect(actual.filter((dep) => !allowed?.includes(dep))).toEqual([]);
    }
    for (const dep of actual) {
      expect(pkg.dependencies?.[`${scope}/${dep}`]).toBe("workspace:*");
    }
  });

  it("references exactly its workspace dependencies in the build configuration", () => {
    const build = readJsonc(`packages/${dir}/tsconfig.build.json`) as BuildConfig;
    const referenced = (build.references ?? [])
      .map((ref) => /^\.\.\/([^/]+)\/tsconfig\.build\.json$/.exec(ref.path)?.[1] ?? ref.path)
      .sort();
    expect(referenced).toEqual(internalDependencies(pkg));
  });

  it("has a README", () => {
    expect(existsSync(path.join(repoRoot, "packages", dir, "README.md"))).toBe(true);
  });
});

describe("repository files", () => {
  it("ships the Apache-2.0 license text", () => {
    const license = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");
    expect(license).toContain("Apache License");
    expect(license).toContain("Version 2.0, January 2004");
  });

  it("requires a Node.js version that the development tooling supports", () => {
    expect(root.engines.node).toBe(">=22.13.0");
  });
});
