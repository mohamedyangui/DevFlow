import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const run = promisify(execFile);
const script = path.join(repoRoot, "scripts", "rename-scope.mjs");
let dir: string;

async function write(relative: string, content: string): Promise<void> {
  const file = path.join(dir, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function read(relative: string): Promise<string> {
  return readFile(path.join(dir, relative), "utf8");
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "devflow-scope-"));
  await write(
    "package.json",
    `${JSON.stringify(
      {
        name: "root",
        devflow: { npmScope: "@devflow" },
        devDependencies: { "@devflow/core": "workspace:*" },
      },
      null,
      2,
    )}\n`,
  );
  await write("packages/core/package.json", '{ "name": "@devflow/core" }\n');
  await write("packages/cli/src/index.ts", 'import { x } from "@devflow/core";\n');
  await write("docs/guide.md", "Install `@devflow/cli`. Not a scope: @devflow-ai/x.\n");
  await write("node_modules/@devflow/core/index.js", 'export * from "@devflow/core";\n');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scripts/rename-scope.mjs", () => {
  it("lists changes without modifying files in dry-run mode", async () => {
    const { stdout } = await run(process.execPath, [script, "--root", dir, "--to", "@acme"]);
    expect(stdout).toContain("4 file(s) would change");
    expect(await read("packages/cli/src/index.ts")).toContain("@devflow/core");
  });

  it("renames the scope everywhere except dependencies and generated files", async () => {
    await run(process.execPath, [script, "--root", dir, "--to", "@acme", "--write"]);
    const manifest = JSON.parse(await read("package.json")) as {
      devflow: { npmScope: string };
      devDependencies: Record<string, string>;
    };
    expect(manifest.devflow.npmScope).toBe("@acme");
    expect(Object.keys(manifest.devDependencies)).toEqual(["@acme/core"]);
    expect(await read("packages/core/package.json")).toContain('"@acme/core"');
    expect(await read("packages/cli/src/index.ts")).toContain('from "@acme/core"');
    expect(await read("docs/guide.md")).toBe("Install `@acme/cli`. Not a scope: @devflow-ai/x.\n");
    expect(await read("node_modules/@devflow/core/index.js")).toContain("@devflow/core");
  });

  it("rejects invalid scopes", async () => {
    const error = (await run(process.execPath, [script, "--root", dir, "--to", "acme"]).catch(
      (e: unknown) => e,
    )) as { code?: number };
    expect(error.code).toBe(2);
  });
});
