import { checkAdapterConformance, MemoryRepository } from "@devflow/core/testing";
import { describe, expect, it } from "vitest";
import { javaAdapter, parseXml } from "../src/index.js";
import { isWellFormed } from "../src/xml.js";
import { gradleRepo, legacyGradleRepo, mavenReactorRepo, springMavenRepo } from "./fixtures.js";

describe("parseXml", () => {
  it("returns an ordered element tree with attributes and text", () => {
    const root = parseXml('<?xml version="1.0"?>\n<!-- c --><a x="1"><b>one</b><c/><b>two</b></a>');
    expect(root?.name).toBe("a");
    expect(root?.attributes).toEqual({ x: "1" });
    expect(root?.children.map((c) => [c.name, c.text])).toEqual([
      ["b", "one"],
      ["c", ""],
      ["b", "two"],
    ]);
  });

  it("refuses entity declarations", () => {
    const bomb = '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY e "boom">]><a>&e;</a>';
    expect(parseXml(bomb)).toBeUndefined();
  });
});

describe("isWellFormed", () => {
  it("accepts complete documents with comments, CDATA, processing instructions and a doctype", () => {
    expect(
      isWellFormed(
        '\uFEFF<?xml version="1.0"?><!DOCTYPE a><a><!-- x --><b attr="a>b"/><![CDATA[<c>]]></a>\n',
      ),
    ).toBe(true);
  });

  it("rejects truncated, mismatched and trailing content", () => {
    for (const text of [
      "<a><b></b>",
      "<a><b></a></b>",
      "<a/><b/>",
      "<a/>trailing",
      'text<a x="1/>',
      "<a><!-- open</a>",
      "",
    ]) {
      expect(isWellFormed(text), text).toBe(false);
    }
  });
});

describe("conformance", () => {
  it("passes the shared adapter conformance checks on every fixture", async () => {
    const report = await checkAdapterConformance(javaAdapter, [
      { name: "spring-maven", repo: springMavenRepo(), expectedRoots: ["services/orders"] },
      { name: "maven-reactor", repo: mavenReactorRepo(), expectedRoots: [".", "tools/standalone"] },
      { name: "gradle", repo: gradleRepo(), expectedRoots: ["."] },
      { name: "gradle-legacy", repo: legacyGradleRepo(), expectedRoots: ["legacy"] },
      {
        name: "empty",
        repo: new MemoryRepository({ "README.md": "# nothing to build" }),
        expectedRoots: [],
      },
    ]);
    expect(report.failures).toEqual([]);
    expect(report.checks.length).toBeGreaterThan(50);
  });
});
