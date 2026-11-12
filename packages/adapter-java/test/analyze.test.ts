import { validatedAdapter, type ModuleProfile } from "@devflow-ai/core";
import { MemoryRepository } from "@devflow-ai/core/testing";
import { describe, expect, it } from "vitest";
import { buildToolAt, gradleIncludes, javaAdapter } from "../src/index.js";
import { gradleRepo, legacyGradleRepo, mavenReactorRepo, springMavenRepo } from "./fixtures.js";

const adapter = validatedAdapter(javaAdapter);

async function profileAt(repo: MemoryRepository, root: string): Promise<ModuleProfile> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  return adapter.analyzeModule(candidate, repo);
}

const ids = (detections: readonly { id: string }[]) => detections.map((d) => d.id);

describe("detectModules", () => {
  it("treats a Maven reactor as one module and ignores POMs inside source sets", async () => {
    const candidates = await adapter.detectModules(mavenReactorRepo());
    expect(candidates.map((c) => c.root)).toEqual([".", "tools/standalone"]);
    expect(candidates[0]?.evidence[0]?.description).toBe("Maven build aggregating 2 module(s)");
  });

  it("treats a Gradle build with settings as one module, and finds build-only projects", async () => {
    expect((await adapter.detectModules(gradleRepo())).map((c) => c.root)).toEqual(["."]);
    const legacy = await adapter.detectModules(legacyGradleRepo());
    expect(legacy).toMatchObject([
      { root: "legacy", confidence: 0.9, evidence: [{ path: "legacy/build.gradle" }] },
    ]);
  });

  it("reports a directory with both a POM and Gradle files once", async () => {
    const both = new MemoryRepository({
      "pom.xml": "<project><artifactId>x</artifactId></project>",
      "build.gradle": "apply plugin: 'java'\n",
      gradlew: "#!/bin/sh\n",
    });
    expect((await adapter.detectModules(both)).map((c) => c.root)).toEqual(["."]);
    expect(await buildToolAt(both, ".")).toBe("gradle");
    const withMavenWrapper = both.with({ mvnw: "#!/bin/sh\n" });
    expect(await buildToolAt(withMavenWrapper, ".")).toBe("maven");
  });

  it("gives an unreadable POM a low confidence instead of failing", async () => {
    const broken = new MemoryRepository({ "pom.xml": "<project><artifactId>x</project>" });
    expect(await adapter.detectModules(broken)).toMatchObject([{ root: ".", confidence: 0.5 }]);
  });
});

describe("gradleIncludes", () => {
  it("reads Groovy and Kotlin include statements, ignoring comments and includeBuild", () => {
    const settings = [
      "include 'a', ':b:c'",
      'include("d",',
      '  "e")',
      "// include 'commented'",
      "/* include 'blocked' */",
      'includeBuild("build-logic")',
    ].join("\n");
    expect(gradleIncludes(settings)).toEqual(["a", "b:c", "d", "e"]);
  });
});

describe("analyzeModule", () => {
  it("profiles a Spring Boot Maven service with evidence for every detection", async () => {
    const profile = await profileAt(springMavenRepo(), "services/orders");
    expect(profile.moduleId).toBe("services-orders");
    expect(profile.buildTool).toMatchObject({
      id: "maven",
      version: "3.9.9",
      wrapper: "services/orders/mvnw",
    });
    expect(profile.languages).toMatchObject([{ id: "java", version: "21", confidence: 1 }]);
    expect(profile.frameworks).toMatchObject([
      { id: "spring-boot", version: "3.3.4", confidence: 0.95 },
    ]);
    expect(ids(profile.testFrameworks)).toEqual(["junit5", "mockito", "assertj"]);
    expect(profile.testFrameworks[0]?.evidence[0]?.description).toBe(
      "spring-boot-starter-test (includes JUnit Jupiter)",
    );
    expect(ids(profile.qualityTools)).toEqual(["checkstyle", "spotbugs"]);
    expect(profile.sourceRoots).toEqual(["services/orders/src/main/java"]);
    expect(profile.testRoots).toEqual(["services/orders/src/test/java"]);
    const parent = profile.frameworks[0]?.evidence.find(
      (e) => e.description === "Spring Boot parent POM",
    );
    expect(parent).toMatchObject({ path: "services/orders/pom.xml", line: 6 });
  });

  it("links contracts the module defines and the ones its build generates code from", async () => {
    const profile = await profileAt(springMavenRepo(), "services/orders");
    expect(profile.contracts.map((c) => [c.kind, c.path, c.role])).toEqual([
      ["protobuf", "services/orders/src/main/proto/orders.proto", "defines"],
      ["protobuf", "services/orders/src/main/proto/orders.proto", "generates-code-from"],
      ["openapi", "contracts/orders.openapi.yaml", "generates-code-from"],
    ]);
  });

  it("resolves versions from reactor properties and reads the Java release", async () => {
    const profile = await profileAt(mavenReactorRepo(), ".");
    expect(profile.testFrameworks).toMatchObject([{ id: "junit5", version: "5.10.2" }]);
    expect(profile.languages[0]?.version).toBe("17");
    expect(profile.sourceRoots).toEqual(["app/src/main/java"]);
    expect(profile.testRoots).toEqual(["app/src/test/java"]);
    expect(profile.buildTool?.wrapper).toBeUndefined();
  });

  it("profiles a Gradle build through plugin blocks, the version catalog and the wrapper", async () => {
    const profile = await profileAt(gradleRepo(), ".");
    expect(profile.buildTool).toMatchObject({
      id: "gradle",
      version: "8.10.2",
      wrapper: "gradlew",
    });
    expect(profile.languages).toMatchObject([{ id: "java", version: "17" }]);
    expect(profile.frameworks).toMatchObject([{ id: "spring-boot", version: "3.3.4" }]);
    expect(profile.testFrameworks).toMatchObject([
      { id: "junit5", version: "5.10.3" },
      { id: "mockito", version: "5.12.0" },
    ]);
    expect(ids(profile.qualityTools)).toEqual(["checkstyle", "jacoco"]);
    expect(profile.sourceRoots).toEqual(["app/src/main/java", "lib/core/src/main/java"]);
    expect(profile.testRoots).toEqual([
      "app/src/test/java",
      "app/src/integrationTest/java",
      "lib/core/src/test/java",
    ]);
    expect(profile.contracts.map((c) => c.role)).toEqual(["defines", "generates-code-from"]);
  });

  it("reads Groovy DSL builds", async () => {
    const profile = await profileAt(legacyGradleRepo(), "legacy");
    expect(profile.languages[0]?.version).toBe("8");
    expect(profile.testFrameworks).toMatchObject([{ id: "junit4", version: "4.13.2" }]);
    expect(profile.buildTool?.wrapper).toBeUndefined();
  });

  it("returns an empty profile for a declared module without a build file", async () => {
    const repo = new MemoryRepository({ "app/README.md": "x" });
    const profile = await adapter.analyzeModule(
      {
        adapterId: "java",
        root: "app",
        confidence: 1,
        evidence: [
          { kind: "file", description: "declared", deterministic: true, path: "app/README.md" },
        ],
      },
      repo,
    );
    expect(profile).toMatchObject({ root: "app", languages: [], testRoots: [] });
    expect(profile.buildTool).toBeUndefined();
  });
});

describe("Gradle heuristics", () => {
  it("does not count plugins that are only declared, nor catalog entries nobody references", async () => {
    const repo = new MemoryRepository({
      "settings.gradle.kts": [
        "pluginManagement {",
        '  plugins { id("com.github.spotbugs") version "6.0.26" }',
        "}",
        'include("app")',
        "",
      ].join("\n"),
      "build.gradle.kts":
        'plugins {\n  id("com.diffplug.spotless") version "6.25.0" apply false\n}\n',
      "app/build.gradle.kts":
        "plugins { java }\ndependencies { testImplementation(libs.junit.jupiter.get()) }\n",
      "gradle/libs.versions.toml": [
        "[libraries]",
        'junit-jupiter = "org.junit.jupiter:junit-jupiter:5.11.0"',
        'assertj = "org.assertj:assertj-core:3.26.3"',
        "",
      ].join("\n"),
      "app/src/unitTest/java/AUnitTest.java":
        "class AUnitTest { @org.junit.jupiter.api.Test void a() {} }\n",
    });
    const profile = await profileAt(repo, ".");
    expect(profile.qualityTools).toEqual([]);
    expect(profile.testFrameworks).toMatchObject([
      {
        id: "junit5",
        version: "5.11.0",
        confidence: 0.95,
        evidence: [
          { path: "app/build.gradle.kts", line: 2 },
          { path: "gradle/libs.versions.toml" },
        ],
      },
      { id: "assertj", confidence: 0.7, evidence: [{ path: "gradle/libs.versions.toml" }] },
    ]);
    const inventory = await adapter.discoverTests(profile, repo);
    expect(inventory.files).toMatchObject([
      { path: "app/src/unitTest/java/AUnitTest.java", level: "unit" },
    ]);
  });
});
