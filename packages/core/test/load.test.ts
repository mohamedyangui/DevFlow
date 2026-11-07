import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DevflowError,
  ErrorCode,
  MAX_TASK_FILE_BYTES,
  TaskIssueCode,
  detectTaskFormat,
  loadTaskFile,
} from "../src/index.js";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "devflow-load-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fixture(name: string, content: string | Uint8Array): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

async function expectLoadError(file: string, code: string): Promise<void> {
  const error: unknown = await loadTaskFile(file, { cwd: dir }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(DevflowError);
  expect((error as DevflowError).code).toBe(code);
}

describe("detectTaskFormat", () => {
  it.each([
    ["task.yaml", "yaml"],
    ["task.YML", "yaml"],
    ["task.json", "json"],
    ["task.md", "markdown"],
    ["task.markdown", "markdown"],
    ["task.txt", undefined],
  ])("%s -> %s", (file, format) => {
    expect(detectTaskFormat(file)).toBe(format);
  });
});

describe("loadTaskFile", () => {
  it("loads a YAML task and records a portable source reference", async () => {
    await fixture(
      "tasks/ok.yaml",
      "id: T-1\ntitle: Ok\nacceptanceCriteria: [a]\ndefinitionOfDone: [d]\n",
    );
    const result = await loadTaskFile("tasks/ok.yaml", { cwd: dir });
    expect(result.valid).toBe(true);
    expect(result.format).toBe("yaml");
    expect(result.path).toBe(path.join(dir, "tasks", "ok.yaml"));
    expect(result.contract?.source).toEqual({ kind: "file", ref: "tasks/ok.yaml", trust: "user" });
  });

  it("reports YAML schema problems at the right line", async () => {
    const file = await fixture(
      "lines.yaml",
      [
        "id: T-1",
        "title: Lines",
        "requirements:",
        "  functional: [f]",
        "acceptanceCriteria:",
        "  - statement: a",
        "    covers: [FR-1, FR-7]",
      ].join("\n"),
    );
    const result = await loadTaskFile(file);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: TaskIssueCode.UnknownRequirementRef,
        path: ["acceptanceCriteria", 0, "covers", 1],
        line: 7,
      }),
    );
  });

  it("rejects duplicate YAML keys instead of silently keeping the last one", async () => {
    const file = await fixture("dup.yaml", "id: T-1\ntitle: a\ntitle: b\n");
    const result = await loadTaskFile(file);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: TaskIssueCode.ParseError, line: 3 });
  });

  it("rejects YAML documents that abuse aliases", async () => {
    const aliases = Array.from({ length: 60 }, () => "  - *a").join("\n");
    const file = await fixture("aliases.yaml", `x: &a [1, 2, 3]\nitems:\n${aliases}\n`);
    const result = await loadTaskFile(file);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe(TaskIssueCode.ParseError);
  });

  it("reports JSON syntax errors with a line number", async () => {
    const file = await fixture("broken.json", '{\n  "id": "T-1",\n  "title": "x",,\n}\n');
    const result = await loadTaskFile(file);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({ code: TaskIssueCode.ParseError, line: 3 });
  });

  it("maps JSON schema problems to lines", async () => {
    const file = await fixture(
      "schema.json",
      '{\n  "id": "T-1",\n  "title": "x",\n  "testing": { "levels": ["smoke"] }\n}\n',
    );
    const result = await loadTaskFile(file);
    expect(result.issues[0]).toMatchObject({ path: ["testing", "levels", 0], line: 4 });
  });

  it("strips a UTF-8 byte order mark", async () => {
    const file = await fixture("bom.yaml", "﻿id: T-1\ntitle: BOM\n");
    const result = await loadTaskFile(file);
    expect(result.contract?.title).toBe("BOM");
  });

  it("throws for unsupported extensions", async () => {
    await expectLoadError(await fixture("task.txt", "id: T-1"), ErrorCode.TaskUnsupportedFormat);
  });

  it("throws for missing files", async () => {
    await expectLoadError(path.join(dir, "missing.yaml"), ErrorCode.TaskFileNotFound);
  });

  it("throws for directories", async () => {
    await mkdir(path.join(dir, "folder.yaml"), { recursive: true });
    await expectLoadError(path.join(dir, "folder.yaml"), ErrorCode.TaskFileNotAFile);
  });

  it("throws for files above the size limit", async () => {
    const file = await fixture("big.yaml", "#".repeat(MAX_TASK_FILE_BYTES + 1));
    await expectLoadError(file, ErrorCode.TaskFileTooLarge);
  });

  it("throws for files that are not valid UTF-8", async () => {
    const file = await fixture(
      "latin1.yaml",
      Uint8Array.from([0x69, 0x64, 0x3a, 0x20, 0xe9, 0xff]),
    );
    await expectLoadError(file, ErrorCode.TaskFileUnreadable);
  });
});
