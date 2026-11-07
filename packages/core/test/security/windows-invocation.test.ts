import { describe, expect, it } from "vitest";
import {
  DevflowError,
  ErrorCode,
  batchCommandLine,
  checkBatchArgument,
  cmdArguments,
  shimEntryPoint,
} from "../../src/index.js";

function rejectionOf(fn: () => unknown): DevflowError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    if (error instanceof DevflowError) return error;
    throw error;
  }
}

describe("windows-batch argument check (ADR 0014)", () => {
  it.each(["%", "!", "^", "&", "|", "<", ">", '"', "(", ")"])(
    "rejects %j before any process starts",
    (character) => {
      const error = rejectionOf(() => {
        checkBatchArgument(`a${character}b`, 0);
      });
      expect(error?.code).toBe(ErrorCode.CommandArgumentRejected);
      expect(error?.details.character).toBe(`"${character}"`);
    },
  );

  it.each([
    ["\r", "U+000D"],
    ["\n", "U+000A"],
    ["\u0000", "U+0000"],
    ["\u001a", "U+001A"],
    ["\t", "U+0009"],
  ])("rejects control character %j", (character, shown) => {
    const error = rejectionOf(() => {
      checkBatchArgument(`a${character}b`, 2);
    });
    expect(error?.code).toBe(ErrorCode.CommandArgumentRejected);
    expect(error?.details).toEqual({ index: 2, character: shown });
  });

  it("rejects a quoted argument ending with a backslash", () => {
    expect(
      rejectionOf(() => {
        checkBatchArgument("C:\\my dir\\", 0);
      })?.code,
    ).toBe(ErrorCode.CommandArgumentRejected);
    expect(() => {
      checkBatchArgument("C:\\dir\\", 0);
    }).not.toThrow();
  });

  it("accepts ordinary arguments, including non-ASCII text", () => {
    for (const arg of ["test", "--tests", "com.example.OrderTest", "a b", "x=y", "é", ""]) {
      expect(() => {
        checkBatchArgument(arg, 0);
      }).not.toThrow();
    }
  });
});

describe("windows-batch command line", () => {
  it("quotes the batch file and every argument that contains a delimiter", () => {
    expect(
      batchCommandLine("C:\\work\\gradlew.bat", ["test", "a b", "x=y", "1,2", "a;b", ""]),
    ).toBe('"C:\\work\\gradlew.bat" test "a b" "x=y" "1,2" "a;b" ""');
  });

  it("uses the fixed cmd.exe layout with AutoRun and delayed expansion disabled", () => {
    expect(cmdArguments("C:\\Program Files (x86)\\tool\\run.cmd", ["a b"])).toEqual([
      "/d",
      "/s",
      "/v:off",
      "/c",
      '""C:\\Program Files (x86)\\tool\\run.cmd" "a b""',
    ]);
  });

  it("refuses batch file paths that cmd.exe would interpret", () => {
    for (const file of [
      "C:\\%TEMP%\\x.cmd",
      "C:\\a!b\\x.cmd",
      'C:\\a"b\\x.cmd',
      "C:\\a^b\\x.cmd",
    ]) {
      expect(rejectionOf(() => batchCommandLine(file, []))?.code).toBe(
        ErrorCode.CommandArgumentRejected,
      );
    }
  });

  it("refuses the whole command line when one argument is unsafe", () => {
    expect(rejectionOf(() => batchCommandLine("C:\\x.cmd", ["ok", "a&calc"]))?.details).toEqual({
      index: 1,
      character: '"&"',
    });
  });
});

describe("Node.js shim entry points", () => {
  it("reads npm's cmd-shim for node_modules/.bin", () => {
    const shim = [
      "@ECHO off",
      "GOTO start",
      ":find_dp0",
      "SET dp0=%~dp0",
      "EXIT /b",
      ":start",
      "SETLOCAL",
      "CALL :find_dp0",
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ") ELSE (",
      '  SET "_prog=node"',
      "  SET PATHEXT=%PATHEXT:;.JS;=;%",
      ")",
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\vitest\\vitest.mjs" %*',
    ].join("\r\n");
    expect(shimEntryPoint(shim)).toBe("..\\vitest\\vitest.mjs");
  });

  it("reads pnpm's shim", () => {
    const shim = [
      "@SETLOCAL",
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\typescript\\bin\\tsc" %*',
      ") ELSE (",
      '  node  "%~dp0\\..\\eslint\\bin\\eslint.js" %*',
      ")",
    ].join("\r\n");
    expect(shimEntryPoint(shim)).toBe("..\\eslint\\bin\\eslint.js");
  });

  it("reads the npm.cmd of a Node.js installation", () => {
    const shim = [
      ":: Created by npm, please don't edit manually.",
      "@ECHO OFF",
      'SET "NODE_EXE=%~dp0\\node.exe"',
      'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
      'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
      '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
    ].join("\r\n");
    expect(shimEntryPoint(shim)).toBe("node_modules\\npm\\bin\\npm-cli.js");
  });

  it("returns nothing for files that are not Node.js shims", () => {
    expect(shimEntryPoint("@echo off\r\njava -jar app.jar %*\r\n")).toBeUndefined();
    expect(shimEntryPoint("")).toBeUndefined();
  });
});
