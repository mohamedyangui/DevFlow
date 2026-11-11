import { describe, expect, it } from "vitest";
import {
  ADAPTER_API_VERSION,
  ErrorCode,
  apiVersionProblem,
  checkApiVersion,
  parseApiVersion,
} from "../../src/index.js";

describe("adapter API versioning", () => {
  it("is 1.1.0: 1.0.0 plus the optional testSelection", () => {
    expect(ADAPTER_API_VERSION).toBe("1.1.0");
    expect(parseApiVersion(ADAPTER_API_VERSION)).toEqual({ major: 1, minor: 1, patch: 0 });
  });

  it("parses only major.minor.patch", () => {
    expect(parseApiVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    for (const bad of [1, "1", "1.0", "1.0.0-beta", "01.0.0", " 1.0.0", "v1.0.0", null]) {
      expect(parseApiVersion(bad)).toBeUndefined();
    }
  });

  it("accepts the same major with a minor not above the host, whatever the patch", () => {
    expect(apiVersionProblem("1.0.0", "1.0.0")).toBeUndefined();
    expect(apiVersionProblem("1.0.9", "1.0.0")).toBeUndefined();
    expect(apiVersionProblem("1.1.0", "1.3.2")).toBeUndefined();
    expect(apiVersionProblem("1.3.0", "1.3.0")).toBeUndefined();
  });

  it("refuses another major, a newer minor or a malformed version", () => {
    expect(apiVersionProblem("2.0.0", "1.0.0")).toMatch(/not supported.*major version 1/);
    expect(apiVersionProblem("0.9.0", "1.0.0")).toMatch(/not supported/);
    expect(apiVersionProblem("1.1.0", "1.0.0")).toMatch(/newer than this DevFlow/);
    expect(apiVersionProblem(1, "1.0.0")).toMatch(/not a version of the form/);
  });

  it("throws ADAPTER_API_INCOMPATIBLE naming the adapter", () => {
    expect(() => {
      checkApiVersion("toy", "2.0.0");
    }).toThrow(
      expect.objectContaining({
        code: ErrorCode.AdapterApiIncompatible,
        message: expect.stringContaining('adapter "toy" cannot be used') as string,
      }),
    );
    expect(() => {
      checkApiVersion("toy", ADAPTER_API_VERSION);
    }).not.toThrow();
  });
});
