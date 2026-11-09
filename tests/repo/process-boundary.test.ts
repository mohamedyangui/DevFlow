import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

/**
 * Only the executor's process launcher may start processes (ADR 0003, ADR 0018). ESLint
 * enforces this per file; this test makes sure the exception stays a single file and that no
 * source starts processes through a dynamic import or `process.binding`. The launcher is used
 * by the executor (approved commands) and by DevFlow's own fixed git calls (ADR 0012).
 */
const LAUNCHER = "packages/core/src/security/process-launcher.ts";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === "node_modules" || entry.name === "dist" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") ? [full] : [];
  });
}

const sources = readdirSync(path.join(repoRoot, "packages"))
  .map((pkg) => path.join(repoRoot, "packages", pkg, "src"))
  .flatMap((dir) => {
    try {
      return sourceFiles(dir);
    } catch {
      return [];
    }
  })
  .map((file) => ({
    relative: path.relative(repoRoot, file).split(path.sep).join("/"),
    text: readFileSync(file, "utf8"),
  }));

describe("process boundary", () => {
  it("lets exactly one source file import child_process", () => {
    const importers = sources
      .filter(({ text }) => /from\s+["'](?:node:)?child_process["']/.test(text))
      .map(({ relative }) => relative);
    expect(importers).toEqual([LAUNCHER]);
  });

  it("has no dynamic or indirect way to start processes elsewhere", () => {
    const offenders = sources
      .filter(({ relative }) => relative !== LAUNCHER)
      .filter(({ text }) =>
        /import\(\s*["'](?:node:)?child_process["']\)|require\(\s*["'](?:node:)?child_process["']\)|process\.binding\(|\bworker_threads\b/.test(
          text,
        ),
      )
      .map(({ relative }) => relative);
    expect(offenders).toEqual([]);
  });

  it("is used only by the executor and the git client", () => {
    const users = sources
      .filter(({ text }) => text.includes("process-launcher.js"))
      .map(({ relative }) => relative)
      .sort();
    expect(users).toEqual([
      "packages/core/src/security/executor.ts",
      "packages/core/src/security/git.ts",
    ]);
  });
});
