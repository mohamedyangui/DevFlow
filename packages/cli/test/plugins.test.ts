import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode, runCli, type CliIo } from "../src/index.js";

/**
 * External adapter plugins end to end (ADR 0023): `devflow plugins add` records a plugin from
 * the user's plugin directory, and `devflow verify` loads it, discovers a Toy module, runs its
 * test command through the command policy and parses the report. The plugin is the fixture
 * package `fixtures/devflow-adapter-toy`, plain ES module JavaScript.
 */

const FIXTURE = fileURLToPath(new URL("./fixtures/devflow-adapter-toy", import.meta.url));
const PACKAGE = "devflow-adapter-toy";

let base: string;
let workspace: string;
let home: string;
/** The installed copy of the fixture, in `$DEVFLOW_HOME/plugins/node_modules`. */
let installed: string;

const TOY_RUNNER = `import { writeFileSync } from "node:fs";
const tests = [
  { name: "AC-1: adds", passed: true },
  { name: "AC-2: subtracts", passed: true },
];
writeFileSync("toy-report.json", JSON.stringify(tests));
console.log("toy ran " + tests.length + " tests");
`;

async function write(root: string, relative: string, text: string): Promise<void> {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** Copies the fixture plugin to `target`, optionally editing its entry file. */
async function plugin(target: string, edit?: (source: string) => string): Promise<string> {
  await cp(FIXTURE, target, { recursive: true });
  if (edit !== undefined) {
    const entry = path.join(target, "index.js");
    await writeFile(entry, edit(await readFile(entry, "utf8")));
  }
  return target;
}

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "devflow-plugins-cli-")));
  workspace = path.join(base, "repo");
  home = path.join(base, "home");
  installed = path.join(home, "plugins", "node_modules", PACKAGE);
  await mkdir(workspace, { recursive: true });
  await write(workspace, "toy.json", '{ "name": "calculator" }\n');
  await write(workspace, "tests/sum.toy", "AC-1: adds\nAC-2: subtracts\n");
  await write(workspace, "toy-test.mjs", TOY_RUNNER);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(args: string[], cwd = workspace): Promise<Captured> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd,
    env: {
      ...process.env,
      DEVFLOW_HOME: home,
      DEVFLOW_USER: "tester",
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    },
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

interface ErrorJson {
  error: { code: string; message: string };
}

interface VerifyJson {
  outcome: string;
  modules: { id: string; adapter: string; root: string }[];
  warnings: string[];
  gates: { gateId: string; status: string; tests: { id: string; markers: string[] }[] }[];
  denials: { gateId: string; reason: string; fingerprint?: string; argv: string[] }[];
}

interface ListJson {
  hostApiVersion: string;
  builtIn: { id: string; apiVersion: string }[];
  plugins: { id: string; status: string; entry: string; entrySha256: string }[];
}

interface AddedJson {
  action: string;
  plugin: { displayName: string; packageRoot: string | null; entry: string };
}

/** The JSON output of each kind of command, by name. */
interface Shapes {
  error: ErrorJson;
  verify: VerifyJson;
  list: ListJson;
  added: AddedJson;
}

async function json<K extends keyof Shapes>(
  _kind: K,
  args: string[],
  cwd = workspace,
): Promise<{ code: number; value: Shapes[K] }> {
  const captured = await run([...args, "--json"], cwd);
  return { code: captured.code, value: JSON.parse(captured.stdout) as Shapes[K] };
}

async function trust(): Promise<void> {
  expect((await run(["trust", "--yes"])).code).toBe(ExitCode.Success);
}

describe("devflow plugins and verify with an external adapter", () => {
  it("adds an installed package, lists it, and verifies a Toy repository with it", async () => {
    await plugin(installed);
    const added = await run(["plugins", "add", PACKAGE]);
    expect(added.stderr).toBe("");
    expect(added.code).toBe(ExitCode.Success);
    expect(added.stdout).toContain("Added plugin toy: Toy (test plugin)");
    expect(added.stdout).toContain("A plugin is trusted code");

    const list = await json("list", ["plugins", "list"]);
    expect(list.value.hostApiVersion).toBe("1.0.0");
    expect(list.value.builtIn.map((adapter) => [adapter.id, adapter.apiVersion])).toEqual([
      ["java", "1.0.0"],
      ["javascript", "1.0.0"],
      ["python", "1.0.0"],
    ]);
    expect(list.value.plugins).toMatchObject([
      { id: "toy", status: "ok", entry: path.join(installed, "index.js") },
    ]);
    const store = JSON.parse(await readFile(path.join(home, "plugins.json"), "utf8")) as {
      plugins: { entrySha256: string; packageJsonSha256: string | null }[];
    };
    expect(store.plugins[0]?.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(store.plugins[0]?.packageJsonSha256).toMatch(/^[0-9a-f]{64}$/);

    // The plugin's command goes through the command policy like any built-in command.
    const untrusted = await json("verify", ["verify"]);
    expect(untrusted.code).toBe(ExitCode.PolicyDenied);
    expect(untrusted.value.modules).toEqual([{ id: "toy", adapter: "toy", root: "." }]);
    expect(untrusted.value.denials).toMatchObject([
      { gateId: "toy-test", reason: "workspace-untrusted" },
    ]);

    await trust();
    const pending = await json("verify", ["verify"]);
    const denial = pending.value.denials[0];
    expect(denial).toMatchObject({
      reason: "approval-required",
      argv: ["node", "toy-test.mjs"],
    });
    const fingerprint = denial?.fingerprint ?? "";
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const verified = await json("verify", ["verify", "--allow", fingerprint]);
    expect(verified.code).toBe(ExitCode.Success);
    expect(verified.value.outcome).toBe("passed");
    expect(verified.value.gates[0]?.tests.map((test) => [test.id, test.markers])).toEqual([
      ["toy#AC-1: adds", ["AC-1"]],
      ["toy#AC-2: subtracts", ["AC-2"]],
    ]);

    const removed = await run(["plugins", "remove", "toy"]);
    expect(removed.code).toBe(ExitCode.Success);
    const after = await json("verify", ["verify"]);
    expect(after.value.modules).toEqual([]);
    expect((await run(["plugins", "remove", "toy"])).code).toBe(ExitCode.Failure);
  });

  it("adds a plugin by path, a package directory or a module file", async () => {
    const directory = await plugin(path.join(base, "src", "toy-plugin"));
    expect((await run(["plugins", "add", directory])).code).toBe(ExitCode.Success);
    expect((await run(["plugins", "remove", "toy"])).code).toBe(ExitCode.Success);
    const relative = path.relative(workspace, path.join(directory, "index.js"));
    const file = await json("added", ["plugins", "add", relative]);
    expect(file.code).toBe(ExitCode.Success);
    expect(file.value.plugin).toEqual(
      expect.objectContaining({ packageRoot: null, entry: path.join(directory, "index.js") }),
    );
  });

  it("refuses a plugin whose API version this DevFlow cannot run", async () => {
    for (const version of ["2.0.0", "1.1.0", "one"]) {
      const target = path.join(base, `toy-${version}`);
      await plugin(target, (source) =>
        source.replace('apiVersion: "1.0.0"', `apiVersion: "${version}"`),
      );
      const result = await json("error", ["plugins", "add", target]);
      expect(result.code).toBe(ExitCode.UsageError);
      expect(result.value.error.code).toBe("ADAPTER_API_INCOMPATIBLE");
      expect(result.value.error.message).toContain(`API version ${version}`);
    }
    expect((await json("list", ["plugins", "list"])).value.plugins).toEqual([]);
  });

  it("refuses to load a plugin whose files changed until it is added again", async () => {
    await plugin(installed);
    expect((await run(["plugins", "add", PACKAGE])).code).toBe(ExitCode.Success);
    const entry = path.join(installed, "index.js");
    await writeFile(
      entry,
      (await readFile(entry, "utf8")).replace("Toy (test plugin)", "Toy (changed plugin)"),
    );

    const refused = await json("error", ["verify"]);
    expect(refused.code).toBe(ExitCode.UsageError);
    expect(refused.value.error.code).toBe("PLUGIN_CHANGED");
    expect(refused.value.error.message).toContain("plugin toy changed since it was added");
    const list = await json("list", ["plugins", "list"]);
    expect(list.value.plugins[0]?.status).toBe("changed");

    // A changed package.json is a change too.
    const accepted = await json("added", ["plugins", "add", PACKAGE]);
    expect(accepted.value.action).toBe("updated");
    // The new file was imported, not the cached module of the first version.
    expect(accepted.value.plugin.displayName).toBe("Toy (changed plugin)");
    const manifest = path.join(installed, "package.json");
    await writeFile(manifest, (await readFile(manifest, "utf8")).replace("1.0.0", "1.0.1"));
    expect((await json("error", ["verify"])).value.error.code).toBe("PLUGIN_CHANGED");
    expect((await run(["plugins", "add", PACKAGE])).code).toBe(ExitCode.Success);
    const verified = await json("verify", ["verify"]);
    expect(verified.value.modules).toEqual([{ id: "toy", adapter: "toy", root: "." }]);
  });

  it("refuses a plugin without a valid adapter export", async () => {
    const cases: [string, (source: string) => string, RegExp][] = [
      [
        "no-parser",
        (source) => source.replace("async parseResults(", "async parseResultz("),
        /does not export a valid adapter: parseResults/,
      ],
      [
        "no-export",
        (source) => source.replace("export const devflowAdapter", "const devflowAdapter"),
        /no "devflowAdapter" or default export/,
      ],
      ["bad-id", (source) => source.replace('id: "toy"', 'id: "Toy Lang"'), /must match/],
      [
        "no-languages",
        (source) => source.replace('languages: ["toy"]', "languages: []"),
        /languages/,
      ],
      ["syntax", (source) => `${source}\nexport const = ;\n`, /cannot be loaded/],
    ];
    for (const [name, edit, message] of cases) {
      const target = await plugin(path.join(base, name), edit);
      const result = await json("error", ["plugins", "add", target]);
      expect(result.code, name).toBe(ExitCode.UsageError);
      expect(result.value.error.code, name).toBe("PLUGIN_INVALID");
      expect(result.value.error.message, name).toMatch(message);
    }
    const missing = await json("error", ["plugins", "add", "devflow-adapter-absent"]);
    expect(missing.value.error).toMatchObject({ code: "PLUGIN_INVALID" });
    expect(missing.value.error.message).toContain("npm install --prefix");
  });

  it("reports a plugin that throws as a clear adapter failure, without hiding other modules", async () => {
    const target = await plugin(path.join(base, "throwing"), (source) =>
      source.replace(
        "async detectModules(repo) {",
        'async detectModules(repo) {\n    if (repo !== null) throw new Error("toy detection exploded");',
      ),
    );
    expect((await run(["plugins", "add", target])).code).toBe(ExitCode.Success);
    await write(workspace, "package.json", JSON.stringify({ name: "web" }));
    const result = await json("verify", ["verify"]);
    expect(result.value.warnings).toContain(
      "the toy adapter failed in detectModules: toy detection exploded",
    );
    expect(result.value.modules.map((module) => module.adapter)).toEqual(["javascript"]);
  });

  it("refuses duplicate ids: a built-in adapter's id, or a second plugin with the same id", async () => {
    const java = await plugin(path.join(base, "java-plugin"), (source) =>
      source.replace('id: "toy"', 'id: "java"'),
    );
    const builtIn = await json("error", ["plugins", "add", java]);
    expect(builtIn.value.error.code).toBe("PLUGIN_INVALID");
    expect(builtIn.value.error.message).toContain("built-in adapters take precedence");

    const first = await plugin(path.join(base, "first"));
    const second = await plugin(path.join(base, "second"));
    expect((await run(["plugins", "add", first])).code).toBe(ExitCode.Success);
    const duplicate = await json("error", ["plugins", "add", second]);
    expect(duplicate.value.error.code).toBe("PLUGIN_INVALID");
    expect(duplicate.value.error.message).toContain(
      'a plugin with the id "toy" is already installed',
    );

    // A list edited by hand cannot make a plugin replace a built-in adapter.
    const store = path.join(home, "plugins.json");
    const data = JSON.parse(await readFile(store, "utf8")) as { plugins: { id: string }[] };
    await writeFile(
      store,
      JSON.stringify({ ...data, plugins: data.plugins.map((p) => ({ ...p, id: "javascript" })) }),
    );
    await write(workspace, "package.json", JSON.stringify({ name: "web" }));
    const result = await json("verify", ["verify"]);
    expect(result.value.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("plugin javascript (") as string]),
    );
    expect(result.value.modules).toEqual([{ id: "javascript", adapter: "javascript", root: "." }]);
    const listed = await json("list", ["plugins", "list"]);
    expect(listed.value.plugins[0]?.status).toBe("shadowed");
  });

  it("never takes a plugin from the repository", async () => {
    // The repository ships the plugin package, a plugin list and a configuration naming it.
    await plugin(path.join(workspace, "node_modules", PACKAGE));
    await write(
      workspace,
      ".devflow/plugins.json",
      JSON.stringify({ version: 1, plugins: [{ id: "toy" }] }),
    );
    await write(
      workspace,
      ".devflow/config.yaml",
      ["version: 1", "modules:", "  - id: toy", "    path: .", "    adapter: toy", ""].join("\n"),
    );

    const result = await json("verify", ["verify"]);
    expect(result.value.modules).toEqual([]);
    expect(result.value.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining('no adapter named "toy"') as string]),
    );

    // A package name is resolved only in $DEVFLOW_HOME/plugins, never in the repository.
    const added = await json("error", ["plugins", "add", PACKAGE]);
    expect(added.code).toBe(ExitCode.UsageError);
    expect(added.value.error.code).toBe("PLUGIN_INVALID");
    expect(added.value.error.message).toContain(
      path.join(home, "plugins", "node_modules", PACKAGE),
    );
    expect((await json("list", ["plugins", "list"])).value.plugins).toEqual([]);
  });

  it("refuses an invalid plugin list instead of loading anything", async () => {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "plugins.json"), "{ not json");
    const result = await json("error", ["verify"]);
    expect(result.code).toBe(ExitCode.UsageError);
    expect(result.value.error.code).toBe("PLUGIN_STORE_INVALID");
  });
});
