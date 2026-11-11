import type { ModuleProfile } from "@devflow/core";
import { describe, expect, it } from "vitest";
import {
  GRADLE_TEST_FILTER,
  MAVEN_TEST_SELECTOR,
  javaAdapter,
  javaTestSelection,
} from "../src/index.js";

function profile(tool: "maven" | "gradle" | undefined): ModuleProfile {
  return {
    ...(tool === undefined ? {} : { buildTool: { id: tool, evidence: [] } }),
  } as unknown as ModuleProfile;
}

const matches = (pattern: string | undefined, value: string | undefined) =>
  value !== undefined && new RegExp(pattern ?? "").test(value);

describe("javaTestSelection", () => {
  it("selects Class#method for Maven, accepted by the Surefire parameter", () => {
    const value = javaTestSelection(profile("maven"), {
      file: "orders/src/test/java/com/acme/orders/OrderProbeTest.java",
      name: "returnsSecondPage",
    });
    expect(value).toBe("test=OrderProbeTest#returnsSecondPage");
    expect(matches(MAVEN_TEST_SELECTOR.pattern, value)).toBe(true);
  });

  it("selects package.Class.method for Gradle, accepted by the --tests parameter", () => {
    const value = javaTestSelection(profile("gradle"), {
      file: "src/test/kotlin/com/acme/OrderProbeTest.kt",
      name: "returnsSecondPage",
    });
    expect(value).toBe("com.acme.OrderProbeTest.returnsSecondPage");
    expect(matches(GRADLE_TEST_FILTER.pattern, value)).toBe(true);
  });

  it("uses a class wildcard for Gradle outside a source directory", () => {
    const value = javaTestSelection(profile("gradle"), {
      file: "tests/OrderProbeTest.java",
      name: "returnsSecondPage",
    });
    expect(value).toBe("*OrderProbeTest.returnsSecondPage");
    expect(matches(GRADLE_TEST_FILTER.pattern, value)).toBe(true);
  });

  it("cannot select a name that is not a method identifier, or a non-JVM file", () => {
    const file = "src/test/java/com/acme/OrderProbeTest.java";
    expect(
      javaTestSelection(profile("maven"), { file, name: "returns second page" }),
    ).toBeUndefined();
    expect(javaTestSelection(profile("maven"), { file, name: "a,b" })).toBeUndefined();
    expect(
      javaTestSelection(profile("maven"), { file: "src/test/OrderProbe.txt", name: "x" }),
    ).toBeUndefined();
    expect(javaTestSelection(profile(undefined), { file, name: "x" })).toBeUndefined();
  });

  it("is the Java adapter's testSelection, and the adapter targets API 1.1.0", () => {
    expect(
      javaAdapter.testSelection?.(profile("maven"), {
        file: "src/test/java/a/ATest.java",
        name: "works",
      }),
    ).toBe("test=ATest#works");
    expect(javaAdapter.apiVersion).toBe("1.1.0");
  });
});
