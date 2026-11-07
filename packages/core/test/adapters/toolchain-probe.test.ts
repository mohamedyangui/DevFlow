import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PathToolchainProbe, StaticToolchainProbe } from "../../src/index.js";
import { MemoryRepository } from "../../src/testing/index.js";

describe("PathToolchainProbe", () => {
  let dir: string;
  const isWindows = process.platform === "win32";
  const toolFile = isWindows ? "devflowprobe.cmd" : "devflowprobe";

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "devflow-probe-"));
    await mkdir(path.join(dir, "bin"));
    await writeFile(path.join(dir, "bin", toolFile), isWindows ? "@echo off\r\n" : "#!/bin/sh\n");
    if (!isWindows) await chmod(path.join(dir, "bin", toolFile), 0o755);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("finds tools on absolute PATH entries without running them", async () => {
    const probe = new PathToolchainProbe({
      env: { PATH: path.join(dir, "bin"), PATHEXT: ".EXE;.CMD" },
    });
    expect(await probe.probe("devflowprobe")).toEqual({ available: true });
    expect(await probe.probe("missing-tool")).toEqual({ available: false });
  });

  it("ignores relative PATH entries, so a repository cannot provide a tool", async () => {
    const probe = new PathToolchainProbe({ env: { PATH: "bin", PATHEXT: ".EXE;.CMD" } });
    const previous = process.cwd();
    process.chdir(dir);
    try {
      expect(await probe.probe("devflowprobe")).toEqual({ available: false });
    } finally {
      process.chdir(previous);
    }
  });

  it("refuses tool names that are paths or contain shell syntax", async () => {
    const probe = new PathToolchainProbe({ env: { PATH: path.join(dir, "bin") } });
    for (const name of ["../bin/devflowprobe", "bin/devflowprobe", "devflowprobe;rm", "", "a b"]) {
      expect(await probe.probe(name)).toEqual({ available: false });
    }
  });
});

describe("StaticToolchainProbe", () => {
  it("answers from a fixed list or table", async () => {
    expect(await new StaticToolchainProbe(["java"]).probe("java")).toEqual({ available: true });
    expect(await new StaticToolchainProbe(["java"]).probe("mvn")).toEqual({ available: false });
    const table = new StaticToolchainProbe(
      { node: { available: true, version: "22.12.0" } },
      "linux",
    );
    expect(await table.probe("node")).toEqual({ available: true, version: "22.12.0" });
    expect(table.platform).toBe("linux");
  });
});

describe("MemoryRepository", () => {
  const repo = new MemoryRepository({
    "a/b/c.txt": "c",
    "a/d.txt": { text: "dd", modifiedMs: 5 },
    "node_modules/x/index.js": "",
  });

  it("lists direct children with sizes and times, and treats parents as directories", async () => {
    expect(await repo.exists("a")).toBe(true);
    expect(await repo.exists("a/b/c.txt")).toBe(true);
    expect(await repo.exists("a/e")).toBe(false);
    expect(await repo.list("a")).toEqual([
      { path: "a/b", kind: "directory" },
      { path: "a/d.txt", kind: "file", sizeBytes: 2, modifiedMs: 5 },
    ]);
  });

  it("globs like the workspace repository, skipping dependency and build directories", async () => {
    expect(await repo.glob(["**/*.js", "**/*.txt"])).toEqual(["a/b/c.txt", "a/d.txt"]);
    expect(await repo.glob(["*.txt"], { cwd: "a" })).toEqual(["a/d.txt"]);
  });

  it("refuses missing and oversized files like the workspace repository", async () => {
    await expect(repo.readText("missing.txt")).rejects.toThrow(/cannot be read/);
    await expect(repo.readText("a/d.txt", { maxBytes: 1 })).rejects.toThrow(/too-large/);
    expect(await repo.with({ "a/d.txt": "new" }).readText("a/d.txt")).toBe("new");
  });
});
