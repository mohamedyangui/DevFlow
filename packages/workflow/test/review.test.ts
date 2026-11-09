import { describe, expect, it } from "vitest";
import {
  MAX_AI_FINDINGS,
  type ReviewDiff,
  aiFindings,
  isDependencyManifest,
  looksLikeTestPath,
  patchLines,
  publicDeclaration,
  untrackedSection,
  withholdSections,
} from "../src/index.js";
import { task } from "./helpers.js";

describe("review helpers", () => {
  it("recognises test files of the supported languages", () => {
    for (const file of [
      "src/orders.test.ts",
      "web/App.spec.tsx",
      "src/__tests__/a.js",
      "service/src/test/java/shop/OrderServiceTest.java",
      "service/src/test/java/shop/OrderIT.java",
      "tests/test_orders.py",
      "pkg/orders_test.go",
    ]) {
      expect(looksLikeTestPath(file), file).toBe(true);
    }
    for (const file of ["src/orders.ts", "src/testing-utils.ts", "src/main/java/shop/Order.java"]) {
      expect(looksLikeTestPath(file), file).toBe(false);
    }
    expect(isDependencyManifest("service/pom.xml")).toBe(true);
    expect(isDependencyManifest("gradle/libs.versions.toml")).toBe(true);
    expect(isDependencyManifest("src/package.ts")).toBe(false);
  });

  it("reads added and removed lines with their line numbers", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,3 +3,3 @@",
      " keep",
      "-old",
      "+new",
      " keep",
      "diff --git a/gone.ts b/gone.ts",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const gone = 1;",
      "",
    ].join("\n");
    expect(patchLines(patch)).toEqual({
      added: [{ path: "a.ts", line: 4, text: "new" }],
      removed: [
        { path: "a.ts", line: 4, text: "old" },
        { path: "gone.ts", line: 1, text: "export const gone = 1;" },
      ],
    });
  });

  it("finds public declarations in TypeScript and Java", () => {
    expect(publicDeclaration("a.ts", "export async function load() {")).toBe("load");
    expect(publicDeclaration("a.ts", "export default class Shop {")).toBe("Shop");
    expect(publicDeclaration("a.ts", "export interface Order {")).toBe("Order");
    expect(publicDeclaration("a.ts", "const local = 1;")).toBeUndefined();
    expect(publicDeclaration("A.java", "public final class OrderService {")).toBe("OrderService");
    expect(publicDeclaration("A.java", "  public List<Order> list(int page) {")).toBe("list");
    expect(publicDeclaration("A.java", "  private void hidden() {")).toBeUndefined();
    expect(publicDeclaration("a.py", "def public(): pass")).toBeUndefined();
  });

  it("turns an untracked file into a new-file section", () => {
    const section = untrackedSection("src/new.ts", "a\nb\n");
    expect(section).toBe(
      [
        "diff --git a/src/new.ts b/src/new.ts",
        "new file (untracked)",
        "--- /dev/null",
        "+++ b/src/new.ts",
        "@@ -0,0 +1,2 @@",
        "+a",
        "+b",
        "",
      ].join("\n"),
    );
    expect(patchLines(section).added.map((line) => line.line)).toEqual([1, 2]);
  });

  it("withholds the sections of sensitive files", () => {
    const patch = untrackedSection(".env", "TOKEN=x\n") + untrackedSection("src/a.ts", "ok\n");
    const shown = withholdSections(patch, new Set([".env"]));
    expect(shown).not.toContain("TOKEN=x");
    expect(shown).toContain("diff --git a/.env b/.env\n(content withheld");
    expect(shown).toContain("+ok");
    expect(withholdSections(patch, new Set())).toBe(patch);
  });

  it("keeps at most the limit of AI findings, all unverified", () => {
    const diff = { files: [{ path: "src/a.ts" }] } as unknown as ReviewDiff;
    const wire = {
      summary: "many",
      findings: Array.from({ length: MAX_AI_FINDINGS + 3 }, (_, index) => ({
        title: `finding ${String(index)}`,
        severity: "critical" as const,
        category: "security" as const,
        path: "src/a.ts",
        line: index + 1,
        description: "a suspicion",
        recommendation: "check it",
        confidence: 0.9,
        acIds: [],
      })),
    };
    const { findings, dropped } = aiFindings(wire, { diff, task: task() });
    expect(findings).toHaveLength(MAX_AI_FINDINGS);
    expect(dropped).toBe(3);
    expect(new Set(findings.map((finding) => finding.verification))).toEqual(
      new Set(["unverified"]),
    );
    expect(findings[0]).toMatchObject({ source: "ai", severity: "critical", confidence: 0.9 });
  });
});
