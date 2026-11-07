import { describe, expect, it } from "vitest";
import { RepoGlob, RepoPath, TaskId, checkRepoRelativePath } from "../src/index.js";

describe("checkRepoRelativePath", () => {
  it.each([
    "src/main/java/com/acme/App.java",
    "README.md",
    ".",
    "packages/core/",
    ".github/workflows/ci.yml",
    "a-b_c.d/e+f",
  ])("accepts %j", (value) => {
    expect(checkRepoRelativePath(value)).toBeNull();
  });

  it.each([
    ["", "must not be empty"],
    ["/etc/passwd", "relative to the repository root"],
    ["C:/Windows/system32", "drive letter"],
    ["src\\main\\App.java", "forward slashes"],
    ["../secrets.txt", '".." segments'],
    ["src/../../etc", '".." segments'],
    ["src//App.java", "empty segments"],
    ["./src/App.java", '"." segments'],
    ["logs/CON", "reserved device name"],
    ["logs/nul.txt", "reserved device name"],
    ["notes.txt:hidden-stream", "not portable to Windows"],
    ["src/a\u0000b", "not portable to Windows"],
    ["src/file.", "must not end with a space or a dot"],
    ["src/dir /file", "must not end with a space or a dot"],
    ["src/*.java", "not portable to Windows"],
  ])("rejects %j (%s)", (value, reason) => {
    expect(checkRepoRelativePath(value)).toContain(reason);
  });

  it("allows glob metacharacters only in glob mode", () => {
    expect(checkRepoRelativePath("src/**/*.{ts,tsx}", { glob: true })).toBeNull();
    expect(checkRepoRelativePath("src/**/*.{ts,tsx}")).not.toBeNull();
  });
});

describe("RepoPath / RepoGlob schemas", () => {
  it("validates paths", () => {
    expect(RepoPath.safeParse("pom.xml").success).toBe(true);
    expect(RepoPath.safeParse("../pom.xml").success).toBe(false);
  });

  it("rejects negated and escaping globs", () => {
    expect(RepoGlob.safeParse("services/**/*.java").success).toBe(true);
    expect(RepoGlob.safeParse("!services/**").success).toBe(false);
    expect(RepoGlob.safeParse("../**").success).toBe(false);
  });
});

describe("TaskId", () => {
  it.each(["TASK-142", "gh-142", "feature.pagination_v2"])("accepts %j", (value) => {
    expect(TaskId.safeParse(value).success).toBe(true);
  });

  // Task ids become branch and directory names, so anything shell- or path-like is rejected.
  it.each(["", "-leading-dash", "has space", "a/b", "a;rm -rf", "x".repeat(65)])(
    "rejects %j",
    (value) => {
      expect(TaskId.safeParse(value).success).toBe(false);
    },
  );
});
