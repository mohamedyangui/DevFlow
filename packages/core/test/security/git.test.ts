import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, GitClient, statusPaths } from "../../src/index.js";
import { findOnPath } from "../../src/security/invocation.js";
import { launchProcess } from "../../src/security/process-launcher.js";

/**
 * The git client runs the real git against temporary repositories. Test setup runs git
 * directly through the launcher (with the user's hooks allowed), so that the tests can show
 * that the client's own calls do not run them.
 */

function env(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) result[name] = value;
  }
  return result;
}

let gitPath: string | undefined;

beforeAll(async () => {
  gitPath = await findOnPath("git", env(), process.platform);
});

async function git(cwd: string, ...args: string[]): Promise<string> {
  if (gitPath === undefined) throw new Error("git is not installed");
  const result = await launchProcess({
    file: gitPath,
    args: [
      "-c",
      "user.name=DevFlow Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    cwd,
    env: { ...env(), GIT_TERMINAL_PROMPT: "0" },
    windowsVerbatimArguments: false,
    timeoutMs: 30_000,
    maxOutputBytes: 1024 * 1024,
    platform: process.platform,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8")}`);
  }
  return result.stdout.toString("utf8").trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "devflow-git-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A repository with one commit on `main` and a local identity for commits. */
async function repository(root = dir): Promise<string> {
  await git(root, "init", "--quiet", "--initial-branch=main");
  await git(root, "config", "user.name", "DevFlow Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await git(root, "config", "commit.gpgSign", "false");
  await writeFile(path.join(root, "README.md"), "# demo\n");
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(path.join(root, "src", "old.ts"), "export const old = 1;\n");
  await git(root, "add", "--all");
  await git(root, "commit", "--quiet", "-m", "initial");
  return git(root, "rev-parse", "HEAD");
}

describe("statusPaths", () => {
  it("reads porcelain v1 -z output, including the source of renames", () => {
    const output = [
      " M src/a.ts",
      "?? new file.ts",
      "R  src/b.ts",
      "src/old.ts",
      "D  gone.ts",
      "",
    ].join("\0");
    expect(statusPaths(output, "")).toEqual([
      "gone.ts",
      "new file.ts",
      "src/a.ts",
      "src/b.ts",
      "src/old.ts",
    ]);
  });

  it("makes paths relative to a workspace inside the repository", () => {
    expect(statusPaths(["?? pkg/x.ts", " M pkg/src/y.ts", ""].join("\0"), "pkg/")).toEqual([
      "src/y.ts",
      "x.ts",
    ]);
  });
});

describe("GitClient", () => {
  it("reports a folder outside any repository as unavailable", async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "devflow-nogit-"));
    try {
      const inspection = await new GitClient({ root: outside }).inspect();
      // The temporary folder can itself be inside a repository on a developer machine.
      if (inspection.kind === "unavailable") {
        expect(inspection.reason).toMatch(/not in a git repository|no commit/);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reports a repository without a commit as unavailable", async () => {
    await git(dir, "init", "--quiet", "--initial-branch=main");
    expect(await new GitClient({ root: dir }).inspect()).toEqual({
      kind: "unavailable",
      reason: "the repository has no commit yet",
    });
  });

  it("inspects the head, the branch and the uncommitted changes outside .devflow/", async () => {
    const head = await repository();
    const client = new GitClient({ root: dir });
    expect(await client.inspect()).toEqual({
      kind: "repository",
      head,
      branch: "main",
      changes: [],
    });

    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(dir, "notes.txt"), "draft\n");
    await mkdir(path.join(dir, ".devflow", "runs"), { recursive: true });
    await writeFile(path.join(dir, ".devflow", "runs", "run.json"), "{}\n");
    const inspection = await client.inspect();
    expect(inspection.kind === "repository" ? inspection.changes : []).toEqual([
      "notes.txt",
      "src/a.ts",
    ]);
  });

  it("reports a detached HEAD as no branch", async () => {
    const head = await repository();
    await git(dir, "checkout", "--quiet", "--detach");
    const inspection = await new GitClient({ root: dir }).inspect();
    expect(inspection).toMatchObject({ kind: "repository", head, branch: null });
  });

  it("finds a free branch name and refuses an invalid one", async () => {
    await repository();
    const client = new GitClient({ root: dir });
    expect(await client.freeBranchName("devflow/TASK-1")).toBe("devflow/TASK-1");
    await git(dir, "branch", "devflow/TASK-1");
    await git(dir, "branch", "devflow/TASK-1-2");
    expect(await client.freeBranchName("devflow/TASK-1")).toBe("devflow/TASK-1-3");
    await expect(client.freeBranchName("devflow/a..b")).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
    });
  });

  it("creates the branch and commits exactly the given paths, deletions included", async () => {
    const base = await repository();
    const client = new GitClient({ root: dir });
    await client.createBranch("devflow/TASK-1");
    expect(await client.currentBranch()).toBe("devflow/TASK-1");

    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(path.join(dir, "src", "new.ts"), "export const n = 1;\n");
    await rm(path.join(dir, "src", "old.ts"));
    await writeFile(path.join(dir, "README.md"), "# changed by a person\n");

    const commit = await client.commit(
      ["src/a.ts", "src/new.ts", "src/old.ts"],
      "DevFlow TASK-1: implement the change\n\nRun r1.",
    );
    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(await git(dir, "rev-parse", "HEAD~1")).toBe(base);
    expect(await git(dir, "show", "--name-status", "--format=%s", "HEAD")).toBe(
      [
        "DevFlow TASK-1: implement the change",
        "",
        "M\tsrc/a.ts",
        "A\tsrc/new.ts",
        "D\tsrc/old.ts",
      ].join("\n"),
    );
    // The person's change stays uncommitted.
    expect(await git(dir, "status", "--porcelain")).toBe("M README.md");
    expect(await git(dir, "rev-parse", "main")).toBe(base);
  });

  it("runs no hooks of the repository", async () => {
    await repository();
    const hooks = path.join(dir, ".git", "hooks");
    const marker = path.join(dir, "hook-ran");
    for (const hook of ["post-checkout", "post-commit", "prepare-commit-msg"]) {
      await writeFile(path.join(hooks, hook), `#!/bin/sh\necho ${hook} >> hook-ran\n`);
      await chmod(path.join(hooks, hook), 0o755);
    }
    await writeFile(path.join(hooks, "pre-commit"), "#!/bin/sh\nexit 1\n");
    await chmod(path.join(hooks, "pre-commit"), 0o755);

    // Plain git runs them: the setup is right.
    await git(dir, "checkout", "--quiet", "-b", "plain");
    expect(await exists(marker)).toBe(true);
    await rm(marker);
    await git(dir, "checkout", "--quiet", "main");
    await rm(marker);

    const client = new GitClient({ root: dir });
    await client.createBranch("devflow/TASK-1");
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 3;\n");
    await client.commit(["src/a.ts"], "DevFlow TASK-1: tests");
    expect(await exists(marker)).toBe(false);
    expect(await readFile(path.join(dir, "src", "a.ts"), "utf8")).toBe("export const a = 3;\n");
  });

  it("works from a workspace inside the repository", async () => {
    await repository();
    const workspace = path.join(dir, "src");
    const client = new GitClient({ root: workspace });
    await writeFile(path.join(workspace, "a.ts"), "export const a = 4;\n");
    const inspection = await client.inspect();
    expect(inspection.kind === "repository" ? inspection.changes : []).toEqual(["a.ts"]);
    await client.createBranch("devflow/TASK-2");
    await client.commit(["a.ts"], "DevFlow TASK-2: change");
    expect(await git(dir, "show", "--name-only", "--format=", "HEAD")).toBe("src/a.ts");
  });

  it("does not use a git executable inside the workspace", async () => {
    await repository();
    const fake = path.join(dir, process.platform === "win32" ? "git.exe" : "git");
    await writeFile(fake, "not git");
    await chmod(fake, 0o755);
    const client = new GitClient({ root: dir, env: { ...env(), PATH: dir, Path: dir } });
    expect(await client.inspect()).toEqual({
      kind: "unavailable",
      reason: "git was not found on PATH (outside the workspace)",
    });
  });
});
