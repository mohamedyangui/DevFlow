import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorCode, GitClient, cutPatch, statusPaths } from "../../src/index.js";
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

describe("cutPatch", () => {
  const patch = ["diff --git a/a.ts b/a.ts", "+one", "diff --git a/b.ts b/b.ts", "+two", ""].join(
    "\n",
  );

  it("keeps a patch within the limit", () => {
    expect(cutPatch(patch, false, 10_000)).toEqual({ patch, truncated: false });
  });

  it("cuts a long patch at a file boundary", () => {
    expect(cutPatch(patch, false, 40)).toEqual({
      patch: "diff --git a/a.ts b/a.ts\n+one\n",
      truncated: true,
    });
  });

  it("drops the partial first file when the launcher kept only the end", () => {
    expect(cutPatch(`ne\n+tail\n${patch}`, true, 10_000)).toEqual({ patch, truncated: true });
  });
});

describe("GitClient diff", () => {
  it("lists staged, unstaged and untracked changes since the merge base, with the patch", async () => {
    const base = await repository();
    await git(dir, "checkout", "--quiet", "-b", "feature");
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\n");
    await git(dir, "commit", "--quiet", "-am", "feature work");
    await rm(path.join(dir, "src", "old.ts"));
    await writeFile(path.join(dir, "README.md"), "# demo\n\nmore\n");
    await git(dir, "add", "README.md");
    await writeFile(path.join(dir, "src", "new.ts"), "export const n = 1;\n");
    await writeFile(path.join(dir, "logo.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await git(dir, "add", "logo.bin");
    await mkdir(path.join(dir, ".devflow", "runs"), { recursive: true });
    await writeFile(path.join(dir, ".devflow", "runs", "run.json"), "{}\n");

    const client = new GitClient({ root: dir });
    expect(await client.mergeBase("main")).toBe(base);
    const head = await git(dir, "rev-parse", "HEAD");
    const diff = await client.diff(base);
    expect(diff.base).toBe(base);
    expect(diff.head).toBe(head);
    expect(diff.files).toEqual([
      {
        path: "README.md",
        change: "modified",
        additions: 2,
        deletions: 0,
        binary: false,
        tracked: true,
      },
      {
        path: "logo.bin",
        change: "added",
        additions: null,
        deletions: null,
        binary: true,
        tracked: true,
      },
      {
        path: "src/a.ts",
        change: "modified",
        additions: 1,
        deletions: 0,
        binary: false,
        tracked: true,
      },
      {
        path: "src/new.ts",
        change: "added",
        additions: null,
        deletions: null,
        binary: false,
        tracked: false,
      },
      {
        path: "src/old.ts",
        change: "deleted",
        additions: 0,
        deletions: 1,
        binary: false,
        tracked: true,
      },
    ]);
    expect(diff.patch).toContain("diff --git a/src/a.ts b/src/a.ts");
    expect(diff.patch).toContain("+export const b = 2;");
    expect(diff.patch).toContain("-export const old = 1;");
    expect(diff.patchTruncated).toBe(false);
  });

  it("runs no external diff driver or text conversion", async () => {
    const base = await repository();
    const marker = path.join(dir, "driver-ran");
    const script = path.join(dir, "driver.sh");
    await writeFile(script, `#!/bin/sh\necho ran >> "${marker.split(path.sep).join("/")}"\n`);
    await chmod(script, 0o755);
    const command = `sh "${script.split(path.sep).join("/")}"`;
    await git(dir, "config", "diff.external", command);
    await git(dir, "config", "diff.fake.textconv", command);
    await writeFile(path.join(dir, ".gitattributes"), "*.ts diff=fake\n");
    await git(dir, "add", ".gitattributes");
    await git(dir, "commit", "--quiet", "-m", "attributes");
    await writeFile(path.join(dir, "src", "a.ts"), "export const a = 5;\n");

    // Plain git runs the driver: the setup is right.
    await git(dir, "diff");
    expect(await exists(marker)).toBe(true);
    await rm(marker);

    const diff = await new GitClient({ root: dir }).diff(base);
    expect(diff.patch).toContain("+export const a = 5;");
    expect(await exists(marker)).toBe(false);
  });

  it("refuses references that look like options, and unknown ones", async () => {
    await repository();
    const client = new GitClient({ root: dir });
    await expect(client.mergeBase("--output=x")).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
    });
    await expect(client.mergeBase("no-such-branch")).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
      message: '"no-such-branch" is not a commit of this repository',
    });
  });
});

describe("GitClient remoteUrl", () => {
  it("reads a remote's URL, and null when there is none", async () => {
    await repository();
    const client = new GitClient({ root: dir });
    expect(await client.remoteUrl()).toBeNull();
    await git(dir, "remote", "add", "origin", "https://github.com/acme/shop.git");
    await git(dir, "remote", "add", "fork", "git@github.com:someone/shop.git");
    expect(await client.remoteUrl()).toBe("https://github.com/acme/shop.git");
    expect(await client.remoteUrl("fork")).toBe("git@github.com:someone/shop.git");
    expect(await client.remoteUrl("upstream")).toBeNull();
    await expect(client.remoteUrl("--global")).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
    });
  });
});

describe("GitClient push (Phase 5)", () => {
  /** A repository in `dir/work` whose `origin` is the bare repository `dir/origin.git`. */
  async function withOrigin(): Promise<{ work: string; origin: string; base: string }> {
    const work = path.join(dir, "work");
    const origin = path.join(dir, "origin.git");
    await mkdir(work);
    await mkdir(origin);
    const base = await repository(work);
    await git(origin, "init", "--quiet", "--bare", "--initial-branch=main");
    await git(work, "remote", "add", "origin", origin);
    return { work, origin, base };
  }

  async function refs(origin: string): Promise<string[]> {
    const out = await git(origin, "for-each-ref", "--format=%(refname) %(objectname)");
    return out === "" ? [] : out.split(/\r?\n/);
  }

  it("pushes exactly the given branch: no tag, no other branch, no hook, no upstream", async () => {
    const { work, origin } = await withOrigin();
    await git(work, "branch", "other");
    await git(work, "checkout", "--quiet", "-b", "devflow/TASK-1");
    await writeFile(path.join(work, "README.md"), "# changed\n");
    await git(work, "commit", "--quiet", "-am", "DevFlow TASK-1: change");
    await git(work, "tag", "-a", "v1", "-m", "release");
    // The user's configuration would push annotated tags, and a pre-push hook would refuse.
    await git(work, "config", "push.followTags", "true");
    await writeFile(path.join(work, ".git", "hooks", "pre-push"), "#!/bin/sh\nexit 1\n");
    await chmod(path.join(work, ".git", "hooks", "pre-push"), 0o755);

    const client = new GitClient({ root: work });
    const head = await git(work, "rev-parse", "HEAD");
    expect(await client.push("devflow/TASK-1")).toBe(head);
    expect(await refs(origin)).toEqual([`refs/heads/devflow/TASK-1 ${head}`]);
    await expect(git(work, "config", "--get", "branch.devflow/TASK-1.remote")).rejects.toThrow();

    // Pushing the same commit again changes nothing.
    expect(await client.push("devflow/TASK-1")).toBe(head);
    expect(await refs(origin)).toEqual([`refs/heads/devflow/TASK-1 ${head}`]);
  });

  it("never forces: a remote branch that moved is rejected and left as it is", async () => {
    const { work, origin } = await withOrigin();
    await git(work, "checkout", "--quiet", "-b", "devflow/TASK-1");
    await writeFile(path.join(work, "README.md"), "# first\n");
    await git(work, "commit", "--quiet", "-am", "first");
    const client = new GitClient({ root: work });
    const pushed = await client.push("devflow/TASK-1");

    await writeFile(path.join(work, "README.md"), "# rewritten\n");
    await git(work, "commit", "--quiet", "--amend", "-am", "rewritten");
    await expect(client.push("devflow/TASK-1")).rejects.toMatchObject({
      code: ErrorCode.GitPushFailed,
      message: expect.stringContaining("git push of devflow/TASK-1 to origin failed") as unknown,
    });
    expect(await refs(origin)).toEqual([`refs/heads/devflow/TASK-1 ${pushed}`]);
  });

  it("refuses branch names that are options or refspecs, and missing branches", async () => {
    const { work, origin } = await withOrigin();
    const client = new GitClient({ root: work });
    for (const name of ["+main", "-f", "main:main", "a b", "refs/*", "x..y", ""]) {
      await expect(client.push(name)).rejects.toMatchObject({ code: ErrorCode.GitFailed });
    }
    await expect(client.push("devflow/none")).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
      message: "branch devflow/none does not exist",
    });
    await expect(client.push("main", { remote: "--mirror" })).rejects.toMatchObject({
      code: ErrorCode.GitFailed,
    });
    expect(await refs(origin)).toEqual([]);
  });

  it("reads branch commits, ancestry and the URLs a push goes to", async () => {
    const { work, origin, base } = await withOrigin();
    const client = new GitClient({ root: work });
    expect(await client.branchCommit("main")).toBe(base);
    expect(await client.branchCommit("devflow/none")).toBeNull();
    await git(work, "checkout", "--quiet", "-b", "feature");
    await writeFile(path.join(work, "README.md"), "# feature\n");
    await git(work, "commit", "--quiet", "-am", "feature");
    const head = await git(work, "rev-parse", "HEAD");
    expect(await client.isAncestor(base, head)).toBe(true);
    expect(await client.isAncestor(head, base)).toBe(false);

    expect(await client.pushUrls()).toEqual([origin]);
    expect(await client.pushUrls("upstream")).toEqual([]);
    await git(work, "remote", "add", "upstream", "https://github.com/acme/shop.git");
    await git(work, "config", "url.https://example.invalid/.pushInsteadOf", "https://github.com/");
    expect(await client.pushUrls("upstream")).toEqual(["https://example.invalid/acme/shop.git"]);
  });
});
