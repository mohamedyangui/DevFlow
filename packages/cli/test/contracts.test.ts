import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CliIo, ExitCode, runCli } from "../src/index.js";

/** `devflow contracts diff` (Phase 6, ADR 0021) on the contracts package's fixtures. */

const FIXTURES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "contracts",
  "test",
  "fixtures",
);

async function run(args: string[], cwd = FIXTURES) {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd,
    env: { PATH: process.env.PATH ?? process.env.Path ?? "" },
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.autocrlf=false",
      ...args,
    ],
    { cwd, encoding: "utf8" },
  ).trim();
}

const PROTO =
  'syntax = "proto3";\npackage shop;\nmessage Order { string id = 1; string note = 2; }\n';

describe("devflow contracts diff", () => {
  it("prints the changes of two OpenAPI files and exits 1 on a breaking change", async () => {
    const result = await run([
      "contracts",
      "diff",
      "openapi/petstore.base.yaml",
      "openapi/petstore.head.json",
    ]);
    expect(result.code).toBe(ExitCode.Failure);
    expect(result.stdout).toContain(
      "Contract: openapi/petstore.head.json (openapi, decided by builtin-rules)",
    );
    expect(result.stdout).toMatch(
      /breaking +operation-removed +DELETE \/pets\/\{id\}: the operation was removed \(line 53\)/,
    );
    expect(result.stdout).toMatch(
      /Result: BREAKING \(\d+ breaking, \d+ non-breaking, \d+ unknown\)/,
    );
  });

  it("prints JSON with --json", async () => {
    const result = await run([
      "contracts",
      "diff",
      "protobuf/orders.base.proto",
      "protobuf/orders.head.proto",
      "--json",
    ]);
    expect(result.code).toBe(ExitCode.Failure);
    const parsed = JSON.parse(result.stdout) as {
      breaking: boolean;
      contracts: { kind: string; decidedBy: string; summary: { breaking: number } }[];
    };
    expect(parsed.breaking).toBe(true);
    expect(parsed.contracts[0]).toMatchObject({ kind: "protobuf", decidedBy: "builtin-rules" });
  });

  it("exits 0 when nothing is breaking", async () => {
    const result = await run([
      "contracts",
      "diff",
      "openapi/petstore.base.yaml",
      "openapi/petstore.base.yaml",
    ]);
    expect(result.code).toBe(ExitCode.Success);
    expect(result.stdout).toContain("no change");
    expect(result.stdout).toContain("Result: COMPATIBLE (0 breaking, 0 non-breaking, 0 unknown)");
  });

  it("refuses unusable input with exit code 2", async () => {
    const missing = await run(["contracts", "diff", "nope.yaml", "openapi/petstore.head.json"]);
    expect(missing.code).toBe(ExitCode.UsageError);
    expect(missing.stderr).toContain("nope.yaml does not exist [CONTRACT_FILE_INVALID]");
    const notContract = await run(["contracts", "diff", "README.md", "README.md"]);
    expect(notContract.code).toBe(ExitCode.UsageError);
    expect(notContract.stderr).toContain("is neither a .proto file nor an OpenAPI document");
    const one = await run(["contracts", "diff", "openapi/petstore.head.json", "--json"]);
    expect(one.code).toBe(ExitCode.UsageError);
    expect(JSON.parse(one.stdout)).toMatchObject({ error: { code: "OPTIONS_INVALID" } });
  });

  it("compares working-tree files with a git reference with --base", async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-contracts-")));
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "api", "shop.proto"), PROTO);
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "add", ".");
    git(root, "commit", "--quiet", "-m", "base");
    await writeFile(
      path.join(root, "api", "shop.proto"),
      'syntax = "proto3";\npackage shop;\nmessage Order { string id = 1; }\n',
    );
    await writeFile(path.join(root, "api", "new.proto"), PROTO);

    const result = await run(
      ["contracts", "diff", "--base", "main", "api/shop.proto", "./api/new.proto", "--json"],
      root,
    );
    expect(result.stderr).toBe("");
    expect(result.code).toBe(ExitCode.Failure);
    const parsed = JSON.parse(result.stdout) as {
      contracts: { file: string; changes: { rule: string; compatibility: string }[] }[];
    };
    expect(parsed.contracts.map((diff) => [diff.file, diff.changes.map((c) => c.rule)])).toEqual([
      ["api/shop.proto", ["field-removed"]],
      ["api/new.proto", ["contract-added"]],
    ]);

    const outside = await run(["contracts", "diff", "--base", "main", "../x.proto"], root);
    expect(outside.code).toBe(ExitCode.UsageError);
    expect(outside.stderr).toContain("[PATH_REJECTED]");
  });
});
