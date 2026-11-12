import {
  StaticToolchainProbe,
  validatedAdapter,
  type ModuleProfile,
  type RepositoryView,
} from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import { javaAdapter, supportsNoTransferProgress } from "../src/index.js";
import { gradleRepo, legacyGradleRepo, springMavenRepo } from "./fixtures.js";

const adapter = validatedAdapter(javaAdapter);
const probe = new StaticToolchainProbe([]);

async function profileAt(repo: RepositoryView, root: string): Promise<ModuleProfile> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  return adapter.analyzeModule(candidate, repo);
}

describe("discoverTests", () => {
  it("lists the classes Surefire and Failsafe run, with framework and level", async () => {
    const repo = springMavenRepo();
    const inventory = await adapter.discoverTests(await profileAt(repo, "services/orders"), repo);
    const dir = "services/orders/src/test/java/com/acme/orders";
    expect(inventory.files).toEqual([
      { path: `${dir}/OrderControllerTest.java`, framework: "junit5", level: "unit" },
      { path: `${dir}/OrderServiceTest.java`, framework: "junit5", level: "unit" },
      { path: `${dir}/OrdersIT.java`, framework: "junit5", level: "integration" },
      { path: `${dir}/PaymentControllerTest.java`, framework: "junit5", level: "unit" },
    ]);
    expect(inventory.namingPatterns).toContain("**/*IT.java");
  });

  it("lists every test class of the Gradle test source sets", async () => {
    const repo = gradleRepo();
    const inventory = await adapter.discoverTests(await profileAt(repo, "."), repo);
    expect(inventory.files.map((f) => [f.path, f.level])).toEqual([
      ["app/src/test/java/com/shop/AppTest.java", "unit"],
      ["app/src/integrationTest/java/com/shop/CheckoutFlow.java", "integration"],
      ["lib/core/src/test/java/com/shop/core/MoneyTests.java", "unit"],
    ]);
    expect(inventory.namingPatterns).toEqual(["**/*.java", "**/*Test.java", "**/*Tests.java"]);
  });
});

describe("inferConventions", () => {
  it("measures conventions over the existing tests and cites the files", async () => {
    const repo = springMavenRepo();
    const conventions = await adapter.inferConventions(
      await profileAt(repo, "services/orders"),
      repo,
    );
    const byId = new Map(conventions.map((c) => [c.id, c]));
    expect(byId.get("java.test-class-suffix.test")).toMatchObject({
      description: '3 of 3 unit test classes end in "Test"',
      confidence: 1,
    });
    expect(byId.get("java.assertions.assertj")?.description).toBe(
      "AssertJ assertions in 3 of 3 test classes that make assertions",
    );
    expect(byId.get("java.controller-tests")).toMatchObject({
      description: "2 of 2 controller tests use @WebMvcTest",
      evidence: [
        { path: "services/orders/src/test/java/com/acme/orders/OrderControllerTest.java", line: 7 },
        {
          path: "services/orders/src/test/java/com/acme/orders/PaymentControllerTest.java",
          line: 7,
        },
      ],
    });
    // 2 of 4 JUnit 5 classes use @DisplayName, and one Mockito user is not enough: no convention.
    expect(byId.has("java.display-names")).toBe(false);
    expect(byId.has("java.mockito.extension")).toBe(false);
  });
});

describe("testAuthoringGuide", () => {
  it("uses the method-name prefix marker with @DisplayName for JUnit 5", async () => {
    const guide = adapter.testAuthoringGuide(await profileAt(springMavenRepo(), "services/orders"));
    expect(guide).toMatchObject({
      framework: "junit5",
      testRoot: "services/orders/src/test/java",
      fileNamePattern: "{name}Test.java",
      acMarker: { style: "method-name-prefix" },
    });
    expect(guide.acMarker.example).toContain("void ac1_returnsSecondPage()");
    expect(guide.notes.join(" ")).toContain("Failsafe");
  });

  it("drops @DisplayName for JUnit 4", async () => {
    const guide = adapter.testAuthoringGuide(await profileAt(legacyGradleRepo(), "legacy"));
    expect(guide.framework).toBe("junit4");
    expect(guide.acMarker.example).toBe("@Test public void ac1_returnsSecondPage()");
  });
});

describe("commandCatalog", () => {
  it("runs the Maven wrapper with one gate command per purpose", async () => {
    const repo = springMavenRepo();
    const catalog = await adapter.commandCatalog(
      await profileAt(repo, "services/orders"),
      probe,
      repo,
    );
    expect(catalog.map((c) => [c.id, c.purpose, c.parameters.length])).toEqual([
      ["services-orders:compile", "compile", 0],
      ["services-orders:test", "test", 0],
      ["services-orders:test-filter", "test", 1],
      ["services-orders:build", "build", 0],
      ["services-orders:checkstyle", "lint", 0],
      ["services-orders:spotbugs", "static-analysis", 0],
    ]);
    const test = catalog[1];
    expect(test).toMatchObject({
      executable: "./mvnw",
      args: ["--batch-mode", "--no-transfer-progress", "test"],
      cwd: "services/orders",
      network: "required",
      results: {
        parser: "junit-xml",
        reportGlobs: ["services/orders/**/target/surefire-reports/TEST-*.xml"],
      },
    });
    expect(catalog[2]?.args).toEqual([
      "--batch-mode",
      "--no-transfer-progress",
      "--define",
      "{testSelector}",
      "--define",
      "surefire.failIfNoSpecifiedTests=false",
      "test",
    ]);
    const selector = new RegExp(catalog[2]?.parameters[0]?.pattern ?? "", "u");
    expect(selector.test("test=OrderControllerTest#ac1_returnsSecondPage")).toBe(true);
    expect(selector.test("-Dexec=evil")).toBe(false);
  });

  it("runs gradle from PATH without a wrapper and cleans test outputs first", async () => {
    const repo = legacyGradleRepo();
    const catalog = await adapter.commandCatalog(await profileAt(repo, "legacy"), probe, repo);
    expect(catalog.find((c) => c.id === "legacy:test")).toMatchObject({
      executable: "gradle",
      args: ["--no-daemon", "--console=plain", "cleanTest", "test"],
      cwd: "legacy",
    });
    expect(catalog.find((c) => c.id === "legacy:test-filter")?.args.slice(-2)).toEqual([
      "--tests",
      "{testFilter}",
    ]);
  });

  it("uses the Gradle wrapper and adds the quality tools the build applies", async () => {
    const repo = gradleRepo();
    const catalog = await adapter.commandCatalog(await profileAt(repo, "."), probe, repo);
    expect(catalog.every((c) => c.executable === "./gradlew")).toBe(true);
    expect(catalog.map((c) => c.id)).toContain("java:checkstyle");
  });

  it("knows which Maven versions accept --no-transfer-progress", () => {
    expect(supportsNoTransferProgress(undefined)).toBe(true);
    expect(supportsNoTransferProgress("3.9.9")).toBe(true);
    expect(supportsNoTransferProgress("3.6.1")).toBe(true);
    expect(supportsNoTransferProgress("3.6.0")).toBe(false);
    expect(supportsNoTransferProgress("3.5.4")).toBe(false);
    expect(supportsNoTransferProgress("4.0.0-rc-2")).toBe(true);
  });
});
