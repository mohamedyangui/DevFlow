import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../repo/helpers.js";

/**
 * Runs the built `devflow` executable as a real process (argv only, no shell). This checks
 * the compiled output, the shebang entry point and the exit codes. It requires `pnpm build`.
 */
const run = promisify(execFile);
const bin = path.join(repoRoot, "packages", "cli", "dist", "bin.js");

beforeAll(() => {
  if (!existsSync(bin)) {
    throw new Error(`${bin} does not exist. Run \`pnpm build\` before the end-to-end tests.`);
  }
});

async function devflow(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin, ...args], { cwd: repoRoot });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe("devflow executable", () => {
  it("prints its version", async () => {
    const result = await devflow(["--version"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("0.0.0");
  });

  it("validates an example task", async () => {
    const result = await devflow(["task", "validate", "examples/tasks/add-pagination.task.md"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Result: VALID");
  });

  it("exits with 2 for a missing file", async () => {
    const result = await devflow(["task", "validate", "does-not-exist.yaml"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("TASK_FILE_NOT_FOUND");
  });
});
