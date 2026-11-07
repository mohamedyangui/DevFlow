import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  StaticToolchainProbe,
  validatedAdapter,
  type CommandSpec,
  type LanguageAdapter,
  type ModuleCandidate,
  type ModuleProfile,
} from "../../src/index.js";
import { MemoryRepository } from "../../src/testing/index.js";
import { toyAdapter } from "./toy-adapter.js";

const repo = new MemoryRepository({ "app/toy.json": '{ "runner": "x" }' });
const candidate: ModuleCandidate = {
  adapterId: "toy",
  root: "app",
  confidence: 1,
  evidence: [{ kind: "file", description: "manifest", deterministic: true, path: "app/toy.json" }],
};

async function profileOf(adapter: LanguageAdapter): Promise<ModuleProfile> {
  return validatedAdapter(adapter).analyzeModule(candidate, repo);
}

function command(overrides: Partial<CommandSpec> = {}): CommandSpec {
  return {
    id: "app:test",
    purpose: "test",
    executable: "toy",
    args: ["test"],
    cwd: "app",
    env: {},
    timeoutMs: 60_000,
    network: "none",
    parameters: [],
    results: { parser: "toy", reportGlobs: [] },
    origin: "adapter",
    ...overrides,
  };
}

describe("validatedAdapter", () => {
  it("passes valid output through unchanged", async () => {
    const adapter = validatedAdapter(toyAdapter());
    expect(await adapter.detectModules(repo)).toEqual(
      [candidate].map((c) => ({
        ...c,
        evidence: [{ ...c.evidence[0], description: "toy manifest" }],
      })),
    );
    const profile = await profileOf(toyAdapter());
    expect(profile.moduleId).toBe("app");
    expect(profile.testFrameworks.map((d) => d.id)).toEqual(["toy-test"]);
  });

  it("rejects output that does not match the schemas, naming the adapter and operation", async () => {
    const broken = toyAdapter({
      detectModules: () =>
        Promise.resolve([
          { adapterId: "toy", root: "../outside", confidence: 2, evidence: [] },
        ] as unknown as ModuleCandidate[]),
    });
    await expect(validatedAdapter(broken).detectModules(repo)).rejects.toMatchObject({
      code: ErrorCode.AdapterOutputInvalid,
      message: expect.stringContaining(
        "the toy adapter returned invalid data from detectModules",
      ) as unknown,
    });
  });

  it("rejects candidates for another adapter and duplicate roots", async () => {
    const other = toyAdapter({
      detectModules: () => Promise.resolve([{ ...candidate, adapterId: "java" }]),
    });
    await expect(validatedAdapter(other).detectModules(repo)).rejects.toMatchObject({
      code: ErrorCode.AdapterOutputInvalid,
      message: expect.stringContaining('names adapter "java"') as unknown,
    });
    const twice = toyAdapter({ detectModules: () => Promise.resolve([candidate, candidate]) });
    await expect(validatedAdapter(twice).detectModules(repo)).rejects.toMatchObject({
      message: expect.stringContaining("reported twice") as unknown,
    });
  });

  it("rejects profiles that move the module or point outside it", async () => {
    const base = await profileOf(toyAdapter());
    const moved = toyAdapter({
      analyzeModule: () => Promise.resolve({ ...base, root: "elsewhere" }),
    });
    await expect(profileOf(moved)).rejects.toMatchObject({
      message: expect.stringContaining("differs from the candidate root") as unknown,
    });
    const outside = toyAdapter({
      analyzeModule: () => Promise.resolve({ ...base, testRoots: ["other/test"] }),
    });
    await expect(profileOf(outside)).rejects.toMatchObject({
      message: expect.stringContaining("outside the module root") as unknown,
    });
  });

  it("rejects test inventories for another module or with files outside it", async () => {
    const profile = await profileOf(toyAdapter());
    const wrong = validatedAdapter(
      toyAdapter({
        discoverTests: () => Promise.resolve({ moduleId: "other", files: [], namingPatterns: [] }),
      }),
    );
    await expect(wrong.discoverTests(profile, repo)).rejects.toMatchObject({
      message: expect.stringContaining('not "app"') as unknown,
    });
    const outside = validatedAdapter(
      toyAdapter({
        discoverTests: () =>
          Promise.resolve({
            moduleId: "app",
            files: [{ path: "lib/a.toy-test", framework: "toy" }],
            namingPatterns: [],
          }),
      }),
    );
    await expect(outside.discoverTests(profile, repo)).rejects.toMatchObject({
      message: expect.stringContaining("outside the module") as unknown,
    });
  });

  it("rejects catalogs with duplicate ids, foreign origins, outside cwds and denied commands", async () => {
    const profile = await profileOf(toyAdapter());
    const catalog = (commands: CommandSpec[]): LanguageAdapter =>
      validatedAdapter(toyAdapter({ commandCatalog: () => Promise.resolve(commands) }));
    const probe = new StaticToolchainProbe(["toy"]);
    const cases: [CommandSpec[], string][] = [
      [[command(), command()], 'command id "app:test" is used twice'],
      [[command({ origin: "user" })], 'must have origin "adapter"'],
      [[command({ cwd: "lib" })], "outside the module root"],
      [[command({ executable: "bash", args: ["-c", "echo"] })], "hard deny list"],
      [[command({ executable: "mvn", args: ["deploy"] })], "hard deny list"],
      [[command(), command({ id: "app:test-all" })], 'both provide "test" without parameters'],
    ];
    for (const [commands, message] of cases) {
      await expect(catalog(commands).commandCatalog(profile, probe, repo)).rejects.toMatchObject({
        code: ErrorCode.AdapterOutputInvalid,
        message: expect.stringContaining(message) as unknown,
      });
    }
  });

  it("turns adapter exceptions into ADAPTER_FAILED errors", async () => {
    const throwing = toyAdapter({ detectModules: () => Promise.reject(new Error("boom")) });
    await expect(validatedAdapter(throwing).detectModules(repo)).rejects.toMatchObject({
      code: ErrorCode.AdapterFailed,
      message: "the toy adapter failed in detectModules: boom",
    });
    const profile = await profileOf(toyAdapter());
    const guide = toyAdapter({
      testAuthoringGuide: () => {
        throw new Error("no guide");
      },
    });
    expect(() => validatedAdapter(guide).testAuthoringGuide(profile)).toThrow(
      /failed in testAuthoringGuide: no guide/,
    );
  });

  it("refuses adapters with a bad id, an unsupported API version or no display name", () => {
    expect(() => validatedAdapter(toyAdapter({ id: "Bad Id" }))).toThrow(/must match/);
    expect(() => validatedAdapter({ ...toyAdapter(), apiVersion: 2 as 1 })).toThrow(
      /API version 2 is not supported/,
    );
    expect(() => validatedAdapter(toyAdapter({ displayName: " " }))).toThrow(/displayName/);
  });
});
