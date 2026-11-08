import { describe, expect, it } from "vitest";
import { AdapterRegistry, ErrorCode, findModule, type ModuleCandidate } from "../../src/index.js";
import { MemoryRepository } from "../../src/testing/index.js";
import { toyAdapter } from "./toy-adapter.js";

/** A second adapter that claims the same directories, to exercise id collisions. */
const twin = () =>
  toyAdapter({
    id: "twin",
    displayName: "Twin",
    detectModules: async (repo) =>
      (await repo.glob(["**/toy.json"])).map((manifest): ModuleCandidate => ({
        adapterId: "twin",
        root: manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : ".",
        confidence: 0.5,
        evidence: [{ kind: "file", description: "twin", deterministic: true, path: manifest }],
      })),
    analyzeModule: async (candidate, repo) => ({
      ...(await toyAdapter().analyzeModule(candidate, repo)),
      adapterId: "twin",
    }),
  });

describe("AdapterRegistry", () => {
  const repo = new MemoryRepository({
    "toy.json": "{}",
    "services/orders/toy.json": "{}",
    "services/orders/test/a.toy-test": "",
  });

  it("refuses duplicate adapter ids", () => {
    const registry = new AdapterRegistry([toyAdapter()]);
    expect(() => {
      registry.register(toyAdapter());
    }).toThrow(/already registered/);
    expect(registry.ids()).toEqual(["toy"]);
  });

  it("discovers modules across adapters, sorted by root, with unique ids", async () => {
    const registry = new AdapterRegistry([toyAdapter(), twin()]);
    const { modules, warnings } = await registry.discover(repo);
    expect(warnings).toEqual([]);
    expect(modules.map((m) => [m.profile.root, m.profile.adapterId, m.profile.moduleId])).toEqual([
      [".", "toy", "toy"],
      [".", "twin", "twin"],
      ["services/orders", "toy", "services-orders"],
      ["services/orders", "twin", "services-orders-twin"],
    ]);
  });

  it("uses declared modules instead of detection, keeping their ids", async () => {
    const registry = new AdapterRegistry([toyAdapter()]);
    const { modules, warnings } = await registry.discover(repo, {
      declared: [
        { id: "orders", path: "services/orders", adapter: "toy" },
        { id: "ghost", path: "services/ghost", adapter: "toy" },
        { id: "web", path: "web", adapter: "javascript" },
      ],
    });
    expect(modules.map((m) => m.profile.moduleId)).toEqual(["orders"]);
    expect(modules[0]?.candidate.evidence[0]?.path).toBe(".devflow/config.yaml");
    expect(warnings).toEqual([
      "module ghost: services/ghost does not exist",
      'module web: no adapter named "javascript" (available: toy)',
    ]);
  });

  it("reports a failing adapter or module as a warning and keeps the others", async () => {
    const broken = toyAdapter({
      id: "broken",
      displayName: "Broken",
      detectModules: () => Promise.reject(new Error("bad build file")),
    });
    const registry = new AdapterRegistry([broken, toyAdapter()]);
    const { modules, warnings } = await registry.discover(repo);
    expect(modules.map((m) => m.profile.moduleId)).toEqual(["toy", "services-orders"]);
    expect(warnings).toEqual(["the broken adapter failed in detectModules: bad build file"]);

    const failingModule = toyAdapter({
      analyzeModule: (candidate, view) =>
        candidate.root === "."
          ? Promise.reject(new Error("unreadable"))
          : toyAdapter().analyzeModule(candidate, view),
    });
    const second = await new AdapterRegistry([failingModule]).discover(repo);
    expect(second.modules.map((m) => m.profile.root)).toEqual(["services/orders"]);
    expect(second.warnings).toEqual([
      "module . (toy): the toy adapter failed in analyzeModule: unreadable",
    ]);
  });

  it("finds modules by id and lists the known ids otherwise", async () => {
    const { modules } = await new AdapterRegistry([toyAdapter()]).discover(repo);
    expect(findModule(modules, "services-orders").profile.root).toBe("services/orders");
    expect(() => findModule(modules, "web")).toThrow(
      'no module "web" (known modules: toy, services-orders)',
    );
    try {
      findModule([], "web");
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.ModuleNotFound });
    }
  });
});
