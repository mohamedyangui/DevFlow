import { describe, expect, it } from "vitest";
import {
  detection,
  fileEvidence,
  findLine,
  findLines,
  freshReportFiles,
  isWithin,
  joinRepoPath,
  moduleIdFor,
  readTextIfPresent,
  relativeTo,
  repoDirname,
  runDetectors,
  type DetectionStrategy,
} from "../../src/index.js";
import { MemoryRepository } from "../../src/testing/index.js";
import { toyAdapter } from "./toy-adapter.js";

describe("defineAdapter", () => {
  it("sets the API version and defaults inferConventions to no conventions", async () => {
    const adapter = toyAdapter();
    expect(adapter.apiVersion).toBe(1);
    const repo = new MemoryRepository({ "toy.json": "{}" });
    const [candidate] = await adapter.detectModules(repo);
    if (candidate === undefined) throw new Error("expected a module");
    const profile = await adapter.analyzeModule(candidate, repo);
    expect(await adapter.inferConventions(profile, repo)).toEqual([]);
  });
});

describe("evidence helpers", () => {
  const text = 'line one\n  "runner": "fast"\nthird "runner" line';

  it("finds the first matching line with its 1-based number and trimmed excerpt", () => {
    const hit = findLine(text, /"runner":\s*"(\w+)"/);
    expect(hit?.line).toBe(2);
    expect(hit?.excerpt).toBe('"runner": "fast"');
    expect(hit?.match[1]).toBe("fast");
    expect(findLine(text, /absent/)).toBeUndefined();
  });

  it("ignores global and sticky flags so repeated calls give the same answer", () => {
    const pattern = /runner/g;
    expect(findLine(text, pattern)?.line).toBe(2);
    expect(findLine(text, pattern)?.line).toBe(2);
    expect(findLines(text, pattern).map((hit) => hit.line)).toEqual([2, 3]);
  });

  it("builds file evidence and detections without empty optional fields", () => {
    expect(fileEvidence("pom.xml", "Maven build file", { line: 3, excerpt: "  <x/>  " })).toEqual({
      kind: "file",
      description: "Maven build file",
      deterministic: true,
      path: "pom.xml",
      line: 3,
      excerpt: "<x/>",
    });
    expect(detection("maven", 1, [], "")).toEqual({ id: "maven", confidence: 1, evidence: [] });
    expect(detection("maven", 1, [], "3.9.9").version).toBe("3.9.9");
  });
});

describe("repository paths", () => {
  it("joins, splits and compares repository-relative paths", () => {
    expect(joinRepoPath(".", "src")).toBe("src");
    expect(joinRepoPath("services/orders", "./pom.xml")).toBe("services/orders/pom.xml");
    expect(joinRepoPath(".", ".")).toBe(".");
    expect(repoDirname("pom.xml")).toBe(".");
    expect(repoDirname("services/orders/pom.xml")).toBe("services/orders");
    expect(isWithin(".", "anything")).toBe(true);
    expect(isWithin("services/orders", "services/orders/src")).toBe(true);
    expect(isWithin("services/orders", "services/orders-api/src")).toBe(false);
    expect(relativeTo("services/orders", "services/orders/src/A.java")).toBe("src/A.java");
    expect(relativeTo("services/orders", "services/other")).toBeUndefined();
  });

  it("derives module ids from roots", () => {
    expect(moduleIdFor({ adapterId: "java", root: "." })).toBe("java");
    expect(moduleIdFor({ adapterId: "java", root: "services/orders" })).toBe("services-orders");
    expect(moduleIdFor({ adapterId: "javascript", root: "@scope pkg/web" })).toBe("scope_pkg-web");
  });
});

describe("runDetectors", () => {
  const found = (id: string, confidence: number): DetectionStrategy<string> => ({
    id,
    detect: () => Promise.resolve(detection(id, confidence, [fileEvidence("a", "a")])),
  });
  const absent: DetectionStrategy<string> = { id: "absent", detect: () => Promise.resolve(null) };

  it("keeps what was found, highest confidence first, ties in strategy order", async () => {
    const repo = new MemoryRepository({});
    const result = await runDetectors(
      [found("a", 0.5), absent, found("b", 0.9), found("c", 0.5)],
      "ctx",
      repo,
    );
    expect(result.map((d) => d.id)).toEqual(["b", "a", "c"]);
  });
});

describe("report files", () => {
  const start = "2026-05-01T10:00:00.000Z";
  const at = (iso: string): number => Date.parse(iso);

  it("returns only matching files written after the execution started", async () => {
    const repo = new MemoryRepository({
      "target/surefire-reports/TEST-a.xml": {
        text: "<a/>",
        modifiedMs: at("2026-05-01T10:00:05Z"),
      },
      "target/surefire-reports/TEST-old.xml": {
        text: "<o/>",
        modifiedMs: at("2026-04-30T09:00:00Z"),
      },
      "target/surefire-reports/a.txt": { text: "x", modifiedMs: at("2026-05-01T10:00:05Z") },
      "target/surefire-reports/nested/TEST-b.xml": {
        text: "<b/>",
        modifiedMs: at("2026-05-01T10:00:06Z"),
      },
    });
    const flat = await freshReportFiles(repo, "target/surefire-reports", {
      name: /^TEST-.*\.xml$/,
      startedAt: start,
    });
    expect(flat.map((file) => file.path)).toEqual(["target/surefire-reports/TEST-a.xml"]);
    const deep = await freshReportFiles(repo, "target/surefire-reports", {
      name: /^TEST-.*\.xml$/,
      startedAt: start,
      depth: 1,
    });
    expect(deep.map((file) => file.path)).toEqual([
      "target/surefire-reports/TEST-a.xml",
      "target/surefire-reports/nested/TEST-b.xml",
    ]);
  });

  it("accepts files up to two seconds older than the start, for coarse file system clocks", async () => {
    const repo = new MemoryRepository({
      "r/TEST-edge.xml": { text: "<e/>", modifiedMs: at("2026-05-01T09:59:58.500Z") },
      "r/TEST-stale.xml": { text: "<s/>", modifiedMs: at("2026-05-01T09:59:57.000Z") },
    });
    const files = await freshReportFiles(repo, "r", { name: /^TEST-/, startedAt: start });
    expect(files.map((file) => file.path)).toEqual(["r/TEST-edge.xml"]);
  });

  it("returns nothing for a missing directory or an unparseable start time", async () => {
    const repo = new MemoryRepository({ "r/TEST-a.xml": "<a/>" });
    expect(await freshReportFiles(repo, "missing", { name: /./, startedAt: start })).toEqual([]);
    expect(await freshReportFiles(repo, "r", { name: /./, startedAt: "not a date" })).toEqual([]);
  });

  it("reads optional files without throwing", async () => {
    const repo = new MemoryRepository({ "a.txt": "hello" });
    expect(await readTextIfPresent(repo, "a.txt")).toBe("hello");
    expect(await readTextIfPresent(repo, "b.txt")).toBeUndefined();
    expect(await readTextIfPresent(repo, "a.txt", 2)).toBeUndefined();
  });
});
