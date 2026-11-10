import { describe, expect, it } from "vitest";
import { CommandSpec, type ParamSpec } from "../src/index.js";

const testFilter: ParamSpec = {
  name: "testFilter",
  description: "Test class or method selector",
  pattern: "^[A-Za-z0-9_.$#*]+$",
  maxLength: 256,
};

const valid = {
  id: "backend:test",
  purpose: "test",
  executable: "./mvnw",
  args: ["-B", "-ntp", "test", "-Dsurefire.failIfNoSpecifiedTests=false", "{testFilter}"],
  cwd: "services/orders",
  env: { MAVEN_OPTS: "-Xmx1g" },
  timeoutMs: 600_000,
  network: "required",
  parameters: [testFilter],
  results: { parser: "junit-xml", reportGlobs: ["services/orders/target/surefire-reports/*.xml"] },
  origin: "adapter",
} as const;

function messages(input: unknown): string[] {
  const result = CommandSpec.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
}

describe("CommandSpec", () => {
  it("accepts a well-formed command", () => {
    expect(messages(valid)).toEqual([]);
  });

  it.each([
    "mvn",
    "pnpm",
    "node",
    "./gradlew",
    "./.venv/bin/python",
    "./.venv/Scripts/python.exe",
    "./venv/bin/python3",
  ])("accepts executable %j", (executable) => {
    expect(messages({ ...valid, executable })).toEqual([]);
  });

  it.each([
    "/bin/sh",
    "../tools/run",
    "sh -c",
    "mvn;rm",
    "C:\\tools\\x.exe",
    "sub/dir/tool",
    "./.venv/bin/sh",
    "./.venv/../tool",
    "./node_modules/.bin/vitest",
    "./.venv/Scripts/python.cmd",
  ])("rejects executable %j", (executable) => {
    expect(messages({ ...valid, executable })).toHaveLength(1);
  });

  it("requires placeholders to be whole arguments", () => {
    expect(messages({ ...valid, args: ["-Dtest={testFilter}"] })).toEqual([
      "a placeholder must be the entire argument (no prefix, suffix or second placeholder)",
    ]);
  });

  it("requires placeholders to reference declared parameters", () => {
    expect(messages({ ...valid, args: ["{other}"] })).toEqual([
      'placeholder "{other}" does not match a declared parameter',
    ]);
  });

  it("rejects control characters in arguments", () => {
    expect(messages({ ...valid, args: ["ok", "line1\nline2"] })).toEqual([
      "arguments must not contain control characters",
    ]);
  });

  it("rejects unanchored and invalid parameter patterns", () => {
    expect(messages({ ...valid, parameters: [{ ...testFilter, pattern: "[a-z]+" }] })).toEqual([
      'parameter patterns must be anchored with "^" and "$"',
    ]);
    expect(
      messages({ ...valid, parameters: [{ ...testFilter, pattern: "^([a-z]$" }] })[0],
    ).toContain("invalid regular expression");
  });

  it("rejects duplicate parameter names", () => {
    expect(messages({ ...valid, parameters: [testFilter, testFilter] })).toEqual([
      "duplicate parameter name",
    ]);
  });

  it.each(["GITHUB_TOKEN", "ANTHROPIC_API_KEY", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY"])(
    "refuses to pass credential-like variable %s to a child process",
    (name) => {
      expect(messages({ ...valid, env: { [name]: "x" } })).toEqual([
        "commands must not add credential-like environment variables",
      ]);
    },
  );

  it("rejects working directories outside the repository", () => {
    expect(messages({ ...valid, cwd: "../elsewhere" })).toHaveLength(1);
  });
});
