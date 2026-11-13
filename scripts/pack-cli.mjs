#!/usr/bin/env node
/**
 * Stages the one published npm package, `<scope>/cli` (ADR 0029), from the built workspace.
 *
 *   node scripts/pack-cli.mjs            stage the package in dist-npm/package
 *   node scripts/pack-cli.mjs --pack     also run `npm pack` (tarball in dist-npm/)
 *   options: --root <dir>  repository root (default: the parent of this script's directory)
 *
 * Run `pnpm build` first. The workspace packages stay private; the staged package bundles the
 * compiled internal packages (`bundleDependencies`) and declares their third-party
 * dependencies itself. The tree-sitter grammars are bundled as their `.wasm` files only, so
 * installing DevFlow never runs a grammar's native build script. Source maps and type
 * declarations are left out: the package is a command, not a library.
 */
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { pack: { type: "boolean", default: false }, root: { type: "string" } },
});

const root = path.resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, data) => writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);

const rootManifest = readJson(path.join(root, "package.json"));
const scope = rootManifest.devflow.npmScope;
const version = rootManifest.version;
const repository = "https://github.com/mohamedyangui/DevFlow";

/** Grammar packages shipped as their .wasm files (read by @devflowai/context). */
const GRAMMARS = {
  "tree-sitter-java": ["tree-sitter-java.wasm"],
  "tree-sitter-javascript": ["tree-sitter-javascript.wasm"],
  "tree-sitter-typescript": ["tree-sitter-typescript.wasm", "tree-sitter-tsx.wasm"],
};

function fail(message) {
  console.error(`pack-cli: ${message}`);
  process.exit(1);
}

const packageDirs = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const manifests = new Map(
  packageDirs.map((dir) => [dir, readJson(path.join(root, "packages", dir, "package.json"))]),
);
const internalName = (name) => name.startsWith(`${scope}/`);

// The packages the CLI needs at run time, followed through their dependencies.
const needed = new Set();
const queue = ["cli"];
while (queue.length > 0) {
  const dir = queue.pop();
  if (needed.has(dir)) continue;
  needed.add(dir);
  for (const dep of Object.keys(manifests.get(dir).dependencies ?? {})) {
    if (internalName(dep)) queue.push(dep.slice(scope.length + 1));
  }
}

for (const dir of needed) {
  const manifest = manifests.get(dir);
  if (manifest.version !== version) fail(`${manifest.name} is ${manifest.version}, not ${version}`);
  if (!existsSync(path.join(root, "packages", dir, "dist", "index.js"))) {
    fail(`packages/${dir}/dist is missing: run \`pnpm build\` first`);
  }
}

// Third-party dependencies, declared once with the range every package agrees on.
const external = {};
for (const dir of [...needed].sort()) {
  for (const [name, range] of Object.entries(manifests.get(dir).dependencies ?? {})) {
    if (internalName(name) || name in GRAMMARS) continue;
    if (external[name] !== undefined && external[name] !== range) {
      fail(`${name} has two ranges: ${external[name]} and ${range}`);
    }
    external[name] = range;
  }
}

const out = path.join(root, "dist-npm");
const staged = path.join(out, "package");
rmSync(out, { recursive: true, force: true });
mkdirSync(staged, { recursive: true });

/** Copies compiled JavaScript only: no declarations, source maps or build info. */
function copyDist(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !/\.(d\.ts|map|tsbuildinfo)$/.test(source),
  });
}

/** `exports` without the development source condition and the type declarations. */
function runtimeExports(exportsField) {
  return Object.fromEntries(
    Object.entries(exportsField).map(([subpath, conditions]) => [subpath, conditions.default]),
  );
}

const license = path.join(root, "LICENSE");
const bundled = [];

for (const dir of [...needed].filter((dir) => dir !== "cli").sort()) {
  const manifest = manifests.get(dir);
  const target = path.join(staged, "node_modules", ...manifest.name.split("/"));
  copyDist(path.join(root, "packages", dir, "dist"), path.join(target, "dist"));
  cpSync(license, path.join(target, "LICENSE"));
  writeJson(path.join(target, "package.json"), {
    name: manifest.name,
    version,
    description: manifest.description,
    license: manifest.license,
    type: "module",
    exports: runtimeExports(manifest.exports),
  });
  bundled.push(manifest.name);
}

const contextRequire = createRequire(path.join(root, "packages", "context", "package.json"));
for (const [name, files] of Object.entries(GRAMMARS)) {
  const source = path.dirname(contextRequire.resolve(`${name}/${files[0]}`));
  const grammar = readJson(path.join(source, "package.json"));
  const target = path.join(staged, "node_modules", name);
  mkdirSync(target, { recursive: true });
  for (const file of [...files, "LICENSE"])
    cpSync(path.join(source, file), path.join(target, file));
  writeJson(path.join(target, "package.json"), {
    name,
    version: grammar.version,
    description: `${grammar.description ?? name} (WebAssembly build only, bundled by DevFlow AI)`,
    license: grammar.license,
  });
  bundled.push(name);
}

// The CLI itself.
const cli = manifests.get("cli");
copyDist(path.join(root, "packages", "cli", "dist"), path.join(staged, "dist"));
cpSync(license, path.join(staged, "LICENSE"));
cpSync(path.join(root, "CHANGELOG.md"), path.join(staged, "CHANGELOG.md"));

// The repository README, with relative links pointing at this version's tag on GitHub.
const readme = readFileSync(path.join(root, "README.md"), "utf8").replace(
  /\]\((?!https?:|#|mailto:)([^)\s]+)\)/g,
  (_, target) => `](${repository}/blob/v${version}/${target.replace(/^\.\//, "")})`,
);
writeFileSync(path.join(staged, "README.md"), readme);

writeJson(path.join(staged, "package.json"), {
  name: `${scope}/cli`,
  version,
  description: rootManifest.description,
  keywords: ["ai", "coding-agent", "mcp", "testing", "verification", "developer-tools", "cli"],
  homepage: `${repository}#readme`,
  bugs: { url: `${repository}/issues` },
  repository: { type: "git", url: `git+${repository}.git` },
  license: cli.license,
  author: rootManifest.author,
  type: "module",
  bin: { devflow: "./dist/bin.js" },
  files: ["dist", "CHANGELOG.md"],
  engines: cli.engines,
  // npm packs a bundled dependency only when it is also a dependency; the bundled copy is used.
  dependencies: Object.fromEntries(
    [
      ...Object.entries(external),
      ...bundled.map((name) => [
        name,
        readJson(path.join(staged, "node_modules", name, "package.json")).version,
      ]),
    ].sort(([a], [b]) => a.localeCompare(b)),
  ),
  bundleDependencies: bundled.sort(),
  publishConfig: { access: "public", provenance: true },
});

console.log(`Staged ${scope}/cli ${version} in ${path.relative(root, staged)}`);
console.log(`  bundled: ${bundled.join(", ")}`);
console.log(`  dependencies: ${Object.keys(external).sort().join(", ")}`);

if (values.pack) {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--pack-destination", out, "--json"], {
    cwd: staged,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const [result] = JSON.parse(output);
  console.log(
    `Packed ${path.join("dist-npm", result.filename)}: ${result.entryCount} files, ${result.size} bytes`,
  );
}
