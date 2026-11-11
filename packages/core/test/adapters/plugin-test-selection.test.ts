import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importPlugin, type ModuleProfile } from "../../src/index.js";

const BODY = `
  displayName: "Selecting",
  languages: ["sel"],
  async detectModules() { return []; },
  async analyzeModule() { return {}; },
  async discoverTests() { return {}; },
  testAuthoringGuide() { return {}; },
  async commandCatalog() { return []; },
  async parseResults() { return {}; },
`;

describe("importPlugin and testSelection (adapter API 1.1.0)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(process.env.TEMP ?? os.tmpdir(), "devflow-plugin-sel-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(name: string, source: string) {
    const entry = path.join(dir, `${name}.mjs`);
    await writeFile(entry, source, "utf8");
    return importPlugin(entry, name);
  }

  it("passes a plugin's testSelection through, keeping only string results", async () => {
    const loaded = await load(
      "with",
      `export const devflowAdapter = { id: "sel", apiVersion: "1.1.0", ${BODY}
        testSelection(profile, test) { return test.name === "none" ? 42 : test.file + "#" + test.name; } };`,
    );
    const profile = {} as ModuleProfile;
    expect(loaded.adapter.testSelection?.(profile, { file: "t/A.sel", name: "b" })).toBe(
      "t/A.sel#b",
    );
    expect(
      loaded.adapter.testSelection?.(profile, { file: "t/A.sel", name: "none" }),
    ).toBeUndefined();
  });

  it("has no testSelection when the plugin does not define one", async () => {
    const loaded = await load(
      "without",
      `export const devflowAdapter = { id: "sel", apiVersion: "1.0.0", ${BODY} };`,
    );
    expect("testSelection" in loaded.adapter).toBe(false);
  });
});
