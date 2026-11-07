#!/usr/bin/env node
/**
 * Renames the npm scope of every workspace package (ADR 0016).
 *
 *   node scripts/rename-scope.mjs --to @my-org            dry run: list the files that would change
 *   node scripts/rename-scope.mjs --to @my-org --write    apply the change
 *   options: --root <dir>  repository root (default: the parent of this script's directory)
 *
 * The current scope is read from `devflow.npmScope` in the root package.json. Every occurrence
 * of "<old-scope>/" in source, test, configuration and documentation files is replaced.
 * node_modules, dist, coverage, .git and pnpm-lock.yaml are skipped; run `pnpm install`
 * afterwards to refresh the workspace links and the lockfile.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    to: { type: "string" },
    write: { type: "boolean", default: false },
    root: { type: "string" },
  },
});

const root = path.resolve(values.root ?? fileURLToPath(new URL("..", import.meta.url)));
const newScope = values.to;
if (newScope === undefined || !/^@[a-z0-9][a-z0-9._-]*$/.test(newScope)) {
  console.error(
    'usage: rename-scope --to <@scope> [--write] [--root <dir>]   (e.g. --to "@my-org")',
  );
  process.exit(2);
}

const manifestPath = path.join(root, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const oldScope = manifest.devflow?.npmScope;
if (typeof oldScope !== "string") {
  console.error(`${manifestPath} has no "devflow.npmScope" setting`);
  process.exit(2);
}
if (oldScope === newScope) {
  console.log(`The scope is already ${newScope}; nothing to do.`);
  process.exit(0);
}

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);
const SKIP_FILES = new Set(["pnpm-lock.yaml"]);
const EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".json", ".md", ".yaml", ".yml"]);

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) yield* walk(full);
    } else if (
      entry.isFile() &&
      EXTENSIONS.has(path.extname(entry.name)) &&
      !SKIP_FILES.has(entry.name)
    ) {
      yield full;
    }
  }
}

const needle = `${oldScope}/`;
const changes = [];
for (const file of walk(root)) {
  const original = readFileSync(file, "utf8");
  let updated = original.split(needle).join(`${newScope}/`);
  if (file === manifestPath) {
    updated = updated.replace(`"npmScope": "${oldScope}"`, `"npmScope": "${newScope}"`);
  }
  if (updated !== original) {
    changes.push({ file, updated, occurrences: original.split(needle).length - 1 });
  }
}

console.log(`${values.write ? "Renaming" : "Dry run: would rename"} ${oldScope} -> ${newScope}`);
for (const change of changes) {
  console.log(
    `  ${path.relative(root, change.file).split(path.sep).join("/")} (${change.occurrences})`,
  );
  if (values.write) writeFileSync(change.file, change.updated);
}
console.log(`${changes.length} file(s) ${values.write ? "updated" : "would change"}.`);
if (values.write)
  console.log("Next: run `pnpm install` to refresh workspace links and the lockfile.");
else console.log("Re-run with --write to apply.");
