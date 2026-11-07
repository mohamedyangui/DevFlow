import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DevflowError,
  ErrorCode,
  PathGuard,
  type PathCheckRequest,
  type PathRejectionReason,
} from "../../src/index.js";

let base: string;
let root: string;
let outside: string;

const read: PathCheckRequest = { access: "read", origin: "model" };
const prompt: PathCheckRequest = { access: "prompt", origin: "model" };
const write: PathCheckRequest = { access: "write", origin: "model" };

async function file(relative: string, content = "x"): Promise<void> {
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Directory link that works without privileges on Windows (a junction). */
async function linkDirectory(target: string, at: string): Promise<boolean> {
  try {
    await symlink(target, at, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

async function rejection(
  guard: PathGuard,
  input: string,
  request: PathCheckRequest,
): Promise<PathRejectionReason | undefined> {
  try {
    await guard.check(input, request);
    return undefined;
  } catch (error) {
    if (!(error instanceof DevflowError)) throw error;
    expect(error.code).toBe(ErrorCode.PathRejected);
    return error.details.reason as PathRejectionReason;
  }
}

beforeAll(async () => {
  base = await mkdtemp(path.join(os.tmpdir(), "devflow-guard-"));
  root = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "outside");
  await file("src/a.ts");
  await file("src/id_utils.ts");
  await file(".git/config");
  await file(".env");
  await file("config/.env.local");
  await file("keys/server.pem");
  await file(".github/workflows/ci.yml");
  await file("package-lock.json");
  await file("web/pnpm-lock.yaml");
  await file("gradlew");
  await file("gradle/wrapper/gradle-wrapper.properties");
  await file(".devflow/config.yaml");
  await file("docs/guide.md");
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("PathGuard.create", () => {
  it("resolves the workspace to its real path", async () => {
    const guard = await PathGuard.create(root);
    expect(path.isAbsolute(guard.root)).toBe(true);
    const checked = await guard.check("src/a.ts", read);
    expect(checked).toMatchObject({ relative: "src/a.ts", realRelative: "src/a.ts", exists: true });
    expect(checked.absolute).toBe(path.join(guard.root, "src", "a.ts"));
  });

  it("refuses a workspace that does not exist or is not a directory", async () => {
    await expect(PathGuard.create(path.join(base, "missing"))).rejects.toMatchObject({
      code: ErrorCode.WorkspaceInvalid,
    });
    await expect(PathGuard.create(path.join(root, "src", "a.ts"))).rejects.toMatchObject({
      code: ErrorCode.WorkspaceInvalid,
    });
  });

  it("refuses invalid protected and unlocked paths", async () => {
    await expect(
      PathGuard.create(root, { additionalProtectedPaths: ["/etc/**"] }),
    ).rejects.toMatchObject({ code: ErrorCode.PathRejected });
    await expect(PathGuard.create(root, { unlockedPaths: ["../x"] })).rejects.toMatchObject({
      code: ErrorCode.PathRejected,
    });
  });

  it("never unlocks repository or DevFlow metadata", async () => {
    for (const unlocked of [".git/config", ".devflow/config.yaml", "sub/.git/HEAD"]) {
      await expect(PathGuard.create(root, { unlockedPaths: [unlocked] })).rejects.toMatchObject({
        code: ErrorCode.PathRejected,
        details: { reason: "protected" },
      });
    }
  });
});

describe("paths from model output", () => {
  let guard: PathGuard;
  beforeAll(async () => {
    guard = await PathGuard.create(root);
  });

  it.each<[string, PathRejectionReason]>([
    ["", "empty"],
    ["src/a\u0000.ts", "nul-byte"],
    ["src/a\n.ts", "control-character"],
    ["src/\u001b[31m.ts", "control-character"],
    ["/etc/passwd", "absolute-path"],
    ["C:\\Windows\\System32", "absolute-path"],
    ["C:Windows", "absolute-path"],
    ["\\\\server\\share\\file", "absolute-path"],
    ["\\\\?\\C:\\x", "absolute-path"],
    ["~/.ssh/id_rsa", "absolute-path"],
    ["../outside/secret.txt", "outside-workspace"],
    ["src/../../outside/secret.txt", "outside-workspace"],
    ["src/../a.ts", "outside-workspace"],
    ["src\\a.ts", "invalid-syntax"],
    ["src/./a.ts", "invalid-syntax"],
    ["src//a.ts", "invalid-syntax"],
  ])("rejects %j (%s)", async (input, reason) => {
    expect(await rejection(guard, input, read)).toBe(reason);
  });

  it.each<[string, PathRejectionReason]>([
    ["CON", "device-name"],
    ["con.txt", "device-name"],
    ["src/NUL", "device-name"],
    ["src/nul.ts", "device-name"],
    ["AUX.json", "device-name"],
    ["logs/COM1.log", "device-name"],
    ["LPT9", "device-name"],
    ["CONIN$", "device-name"],
    ["src/a.ts:hidden", "alternate-data-stream"],
    ["src/a.ts::$DATA", "alternate-data-stream"],
    ["dir:stream/a.ts", "alternate-data-stream"],
  ])("rejects Windows device names and alternate data streams: %j", async (input, reason) => {
    expect(await rejection(guard, input, read)).toBe(reason);
  });

  it("rejects trailing dots and spaces, which Windows would strip to reach a protected path", async () => {
    expect(await rejection(guard, ".git./config", write)).toBe("invalid-syntax");
    expect(await rejection(guard, ".github/workflows /ci.yml", write)).toBe("invalid-syntax");
  });

  it("accepts ordinary repository paths, existing or not", async () => {
    await expect(guard.check("src/a.ts", read)).resolves.toMatchObject({ exists: true });
    await expect(guard.check("src/new/file.ts", write)).resolves.toMatchObject({
      relative: "src/new/file.ts",
      exists: false,
    });
    await expect(guard.check("src/", read)).resolves.toMatchObject({ relative: "src" });
  });
});

describe("paths typed by the user", () => {
  const user: PathCheckRequest = { access: "read", origin: "user" };

  it("accepts absolute paths inside the workspace", async () => {
    const guard = await PathGuard.create(root);
    const checked = await guard.check(path.join(guard.root, "src", "a.ts"), user);
    expect(checked.relative).toBe("src/a.ts");
  });

  it("rejects paths outside the workspace", async () => {
    const guard = await PathGuard.create(root);
    expect(await rejection(guard, path.join(outside, "secret.txt"), user)).toBe(
      "outside-workspace",
    );
    expect(await rejection(guard, "../outside/secret.txt", user)).toBe("outside-workspace");
    expect(await rejection(guard, `${guard.root}-sibling/file`, user)).toBe("outside-workspace");
  });

  it("still rejects device names and alternate data streams", async () => {
    const guard = await PathGuard.create(root);
    expect(await rejection(guard, "src/aux.ts", user)).toBe("device-name");
    expect(await rejection(guard, "src/a.ts:x", user)).toBe("alternate-data-stream");
    expect(await rejection(guard, "src/a.ts.", user)).toBe("trailing-dot-or-space");
  });
});

describe("symbolic links", () => {
  it("rejects a path that leads outside the workspace through a link", async ({ skip }) => {
    const at = path.join(root, "escape");
    if (!(await linkDirectory(outside, at))) skip("cannot create directory links here");
    try {
      const guard = await PathGuard.create(root);
      expect(await rejection(guard, "escape/secret.txt", read)).toBe("symlink-escape");
      expect(await rejection(guard, "escape/new.txt", write)).toBe("symlink-escape");
      expect(await rejection(guard, "escape", read)).toBe("symlink-escape");
    } finally {
      await rm(at, { recursive: true, force: true });
    }
  });

  it("checks protected and sensitive paths at the link's real location", async ({ skip }) => {
    const workflows = path.join(root, "wf");
    const keys = path.join(root, "certs");
    const linked =
      (await linkDirectory(path.join(root, ".github", "workflows"), workflows)) &&
      (await linkDirectory(path.join(root, "keys"), keys));
    if (!linked) skip("cannot create directory links here");
    try {
      const guard = await PathGuard.create(root);
      await expect(guard.check("wf/ci.yml", read)).resolves.toMatchObject({
        relative: "wf/ci.yml",
        realRelative: ".github/workflows/ci.yml",
      });
      expect(await rejection(guard, "wf/ci.yml", write)).toBe("protected");
      expect(await rejection(guard, "certs/server.pem", prompt)).toBe("sensitive");
    } finally {
      await rm(workflows, { recursive: true, force: true });
      await rm(keys, { recursive: true, force: true });
    }
  });

  it("rejects a dangling link", async ({ skip }) => {
    const at = path.join(root, "dangling");
    if (!(await linkDirectory(path.join(outside, "does-not-exist"), at))) {
      skip("cannot create dangling directory links here");
    }
    try {
      const guard = await PathGuard.create(root);
      expect(await rejection(guard, "dangling/x.txt", write)).toBe("symlink-escape");
    } finally {
      await rm(at, { recursive: true, force: true });
    }
  });

  it("refuses to write through a link even when it stays inside the workspace", async ({
    skip,
  }) => {
    const at = path.join(root, "src", "link.ts");
    try {
      await symlink(path.join(root, "src", "a.ts"), at, "file");
    } catch {
      skip("file links need Developer Mode or administrator rights on Windows");
    }
    try {
      const guard = await PathGuard.create(root);
      expect(await rejection(guard, "src/link.ts", write)).toBe("symlink-write");
      await expect(guard.check("src/link.ts", read)).resolves.toMatchObject({
        realRelative: "src/a.ts",
      });
    } finally {
      await rm(at, { force: true });
    }
  });
});

describe("sensitive paths are never sent to a model", () => {
  it.each([
    ".env",
    "config/.env.local",
    "keys/server.pem",
    ".git/config",
    "deploy/id_rsa",
    ".npmrc",
  ])("rejects %s for prompts", async (input) => {
    const guard = await PathGuard.create(root);
    expect(await rejection(guard, input, prompt)).toBe("sensitive");
  });

  it("allows ordinary source files, including names that merely start with id_", async () => {
    const guard = await PathGuard.create(root);
    await expect(guard.check("src/id_utils.ts", prompt)).resolves.toMatchObject({ exists: true });
    expect(guard.isSensitive("src/id_utils.ts")).toBe(false);
    expect(guard.isSensitive("a/b/.env.production")).toBe(true);
  });
});

describe("write protection", () => {
  it.each([
    ".git/config",
    "sub/.git/HEAD",
    ".devflow/config.yaml",
    ".devflow/rules/style.md",
    ".github/workflows/ci.yml",
    "package-lock.json",
    "web/pnpm-lock.yaml",
    "gradlew",
    "gradle/wrapper/gradle-wrapper.properties",
    ".mvn/wrapper/maven-wrapper.properties",
    ".env",
    "keys/server.pem",
  ])("protects %s from model edits", async (input) => {
    const guard = await PathGuard.create(root);
    expect(await rejection(guard, input, write)).toBe("protected");
    expect(guard.isProtected(input)).toBe(true);
  });

  it("lets a confirmed plan unlock one specific protected path", async () => {
    const guard = await PathGuard.create(root, { unlockedPaths: [".github/workflows/ci.yml"] });
    await expect(guard.check(".github/workflows/ci.yml", write)).resolves.toMatchObject({
      exists: true,
    });
    expect(await rejection(guard, ".github/workflows/release.yml", write)).toBe("protected");
  });

  it("adds the project's additional protected paths", async () => {
    const guard = await PathGuard.create(root, { additionalProtectedPaths: ["docs/**"] });
    expect(await rejection(guard, "docs/guide.md", write)).toBe("protected");
    await expect(guard.check("docs/guide.md", read)).resolves.toMatchObject({ exists: true });
  });

  it("allows DevFlow's own bookkeeping but never outside the workspace or onto the root", async () => {
    const guard = await PathGuard.create(root);
    const internal: PathCheckRequest = { access: "write", origin: "internal" };
    await expect(guard.check(".devflow/runs/run-1/audit.jsonl", internal)).resolves.toMatchObject({
      exists: false,
    });
    expect(await rejection(guard, "../outside/x", internal)).toBe("outside-workspace");
    expect(await rejection(guard, ".", internal)).toBe("workspace-root");
  });

  it("compares case-insensitively where the file system does", async () => {
    const guard = await PathGuard.create(root, { caseInsensitive: true });
    expect(await rejection(guard, ".GIT/config", write)).toBe("protected");
    expect(await rejection(guard, ".GitHub/Workflows/CI.yml", write)).toBe("protected");
    expect(await rejection(guard, "Keys/Server.PEM", prompt)).toBe("sensitive");
    const unlocked = await PathGuard.create(root, {
      caseInsensitive: true,
      unlockedPaths: [".github/workflows/ci.yml"],
    });
    await expect(unlocked.check(".GITHUB/workflows/CI.yml", write)).resolves.toBeDefined();
  });
});
