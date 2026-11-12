import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { readJson, repoRoot } from "../repo/helpers.js";

/**
 * Stages the npm package from the built workspace (ADR 0029) in `dist-npm/package` and checks
 * its contents. Requires `pnpm build`. `npm pack` and an install
 * of the tarball are checked by hand and in the publish workflow, not here.
 */
const run = promisify(execFile);
const script = path.join(repoRoot, "scripts", "pack-cli.mjs");
const staged = path.join(repoRoot, "dist-npm", "package");

interface Staged {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  dependencies: Record<string, string>;
  bundleDependencies: string[];
  scripts?: unknown;
  publishConfig: Record<string, unknown>;
}

let manifest: Staged;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : [full];
  });
}

beforeAll(async () => {
  if (!existsSync(path.join(repoRoot, "packages", "cli", "dist", "bin.js"))) {
    throw new Error("Run `pnpm build` before the end-to-end tests.");
  }
  await run(process.execPath, [script]);
  manifest = JSON.parse(readFileSync(path.join(staged, "package.json"), "utf8")) as Staged;
}, 60_000);

describe("scripts/pack-cli.mjs", () => {
  const root = readJson("package.json") as { version: string; devflow: { npmScope: string } };
  const scope = root.devflow.npmScope;

  it("stages one public package with the devflow command at the repository version", () => {
    expect(manifest.name).toBe(`${scope}/cli`);
    expect(manifest.version).toBe(root.version);
    expect(manifest.private).toBeUndefined();
    expect(manifest.bin).toEqual({ devflow: "./dist/bin.js" });
    expect(manifest.scripts).toBeUndefined();
    expect(manifest.publishConfig).toEqual({ access: "public", provenance: true });
  });

  it("bundles every internal package the CLI needs and declares the bundled ones as dependencies", () => {
    const internal = readdirSync(path.join(repoRoot, "packages"))
      .filter((dir) => dir !== "cli")
      .map((dir) => `${scope}/${dir}`);
    for (const name of internal) {
      expect(manifest.bundleDependencies).toContain(name);
      expect(manifest.dependencies[name]).toBe(root.version);
      expect(existsSync(path.join(staged, "node_modules", name, "dist", "index.js"))).toBe(true);
    }
    for (const name of manifest.bundleDependencies)
      expect(manifest.dependencies[name]).toBeDefined();
  });

  it("ships the grammars as WebAssembly only, without install scripts", () => {
    for (const name of ["tree-sitter-java", "tree-sitter-javascript", "tree-sitter-typescript"]) {
      expect(manifest.bundleDependencies).toContain(name);
      const grammar = JSON.parse(
        readFileSync(path.join(staged, "node_modules", name, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(grammar.scripts).toBeUndefined();
      expect(grammar.dependencies).toBeUndefined();
      expect(existsSync(path.join(staged, "node_modules", name, `${name}.wasm`))).toBe(true);
      expect(existsSync(path.join(staged, "node_modules", name, "binding.gyp"))).toBe(false);
    }
  });

  it("leaves out type declarations, source maps and TypeScript sources", () => {
    const shipped = files(staged).map((file) => file.split(path.sep).join("/"));
    expect(shipped.filter((file) => /\.(d\.ts|map|tsbuildinfo)$/.test(file))).toEqual([]);
    expect(shipped.filter((file) => file.endsWith(".ts"))).toEqual([]);
  });

  it("points the README's relative links at the release tag", () => {
    const readme = readFileSync(path.join(staged, "README.md"), "utf8");
    expect(readme).toContain(
      `](https://github.com/mohamedyangui/DevFlow/blob/v${root.version}/CONTRIBUTING.md)`,
    );
    expect(readme).not.toMatch(/\]\((?!https?:|#|mailto:)[^)\s]+\)/);
  });
});
