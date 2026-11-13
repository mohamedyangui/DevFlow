import {
  isRecord,
  isWithin,
  joinRepoPath,
  readTextIfPresent,
  type CommandPurpose,
  type CommandSpec,
  type ModuleProfile,
  type ParamSpec,
  type RepositoryView,
} from "@devflowai/core";
import { parseJsonc } from "./jsonc.js";
import { installedPackage } from "./manifest.js";
import { pathFrom, resolveRepoPath } from "./paths.js";

/** Result parsers of the JavaScript adapter, named in `CommandSpec.results.parser`. */
export const JAVASCRIPT_PARSERS = {
  jestJson: "jest-json",
  eslintJson: "eslint-json",
  tsc: "tsc",
  exitCode: "exit-code",
} as const;

const MINUTE = 60_000;

export const TEST_NAME_PATTERN: ParamSpec = {
  name: "testNamePattern",
  description:
    'Runs only tests whose full name (describe titles and test title) matches this regular expression, e.g. "AC-1:" or "AC-1:|AC-2:"',
  pattern: "^[A-Za-z0-9][A-Za-z0-9 _.:,'()|-]*$",
  maxLength: 256,
};

/** The command-line entry point of a tool package, and where it is when `bin` says nothing. */
interface ToolBin {
  readonly packageName: string;
  readonly bin: string;
  readonly fallback: string;
}

export const TOOL_BINS = {
  vitest: { packageName: "vitest", bin: "vitest", fallback: "vitest.mjs" },
  jest: { packageName: "jest", bin: "jest", fallback: "bin/jest.js" },
  eslint: { packageName: "eslint", bin: "eslint", fallback: "bin/eslint.js" },
  tsc: { packageName: "typescript", bin: "tsc", fallback: "bin/tsc" },
  prettier: { packageName: "prettier", bin: "prettier", fallback: "bin/prettier.cjs" },
} as const satisfies Record<string, ToolBin>;

export interface ResolvedBin {
  /** The script, as a repository path. */
  readonly script: string;
  /** The `node_modules` directory the package is in (or would be in once installed). */
  readonly nodeModules: string;
  readonly installed: boolean;
}

/**
 * Finds a tool's entry script the way Node.js would from the module root. When the package is
 * not installed, the script is where installing the module's dependencies puts it: the command
 * policy then denies the command (the script does not exist), and the gate is not executed.
 */
export async function resolveBin(
  repo: RepositoryView,
  root: string,
  tool: ToolBin,
): Promise<ResolvedBin> {
  const installed = await installedPackage(repo, root, tool.packageName);
  if (installed === undefined) {
    const nodeModules = joinRepoPath(root, "node_modules");
    return {
      script: joinRepoPath(nodeModules, tool.packageName, tool.fallback),
      nodeModules,
      installed: false,
    };
  }
  const field = installed.json.bin;
  const declared =
    typeof field === "string"
      ? field
      : isRecord(field) && typeof field[tool.bin] === "string"
        ? field[tool.bin]
        : undefined;
  const fromField =
    typeof declared === "string" ? resolveRepoPath(installed.dir, declared) : undefined;
  const script =
    fromField !== undefined && isWithin(installed.dir, fromField) && fromField !== installed.dir
      ? fromField
      : joinRepoPath(installed.dir, tool.fallback);
  return { script, nodeModules: installed.nodeModules, installed: true };
}

/**
 * A `tsconfig.json` that only references other projects (`"files": []` with `references`)
 * checks nothing with `tsc -p`; it needs `tsc --build`, which DevFlow does not run.
 */
export function isSolutionStyleTsconfig(text: string): boolean {
  const json = parseJsonc(text);
  if (!isRecord(json)) return false;
  const files = json.files;
  const references = json.references;
  return (
    Array.isArray(files) &&
    files.length === 0 &&
    json.include === undefined &&
    Array.isArray(references) &&
    references.length > 0
  );
}

/** The test runner a gate uses: Vitest or Jest, whichever the module shows more strongly. */
export function testRunnerOf(profile: ModuleProfile): "vitest" | "jest" | undefined {
  const vitest = profile.testFrameworks.find((d) => d.id === "vitest");
  const jest = profile.testFrameworks.find((d) => d.id === "jest");
  if (vitest !== undefined && (jest === undefined || vitest.confidence >= jest.confidence)) {
    return "vitest";
  }
  return jest === undefined ? undefined : "jest";
}

/**
 * The command catalog of a JavaScript module. Every command runs `node` with the entry script
 * of a tool installed in `node_modules`, never a package script: package scripts are shell
 * command lines the command policy cannot inspect. A tool gets a command only when the module
 * itself declares or configures it. Commands need no network.
 *
 * Tools that write a report write it into the `node_modules` directory they are installed in,
 * under a name unique to the module and the tool, so the working tree stays clean.
 */
export async function javaScriptCommandCatalog(
  profile: ModuleProfile,
  repo: RepositoryView,
): Promise<CommandSpec[]> {
  const cwd = profile.root;
  const catalog: CommandSpec[] = [];
  const command = (
    suffix: string,
    purpose: CommandPurpose,
    script: string,
    args: readonly string[],
    parser: string,
    reportGlobs: readonly string[],
    timeoutMs: number,
    parameters: readonly ParamSpec[] = [],
  ): CommandSpec => ({
    id: `${profile.moduleId}:${suffix}`,
    purpose,
    executable: "node",
    args: [pathFrom(cwd, script), ...args],
    cwd,
    env: { NO_COLOR: "1", FORCE_COLOR: "0" },
    timeoutMs,
    network: "none",
    parameters: [...parameters],
    results: { parser, reportGlobs: [...reportGlobs] },
    origin: "adapter",
  });
  const report = (bin: ResolvedBin, tool: string): string =>
    joinRepoPath(bin.nodeModules, `.devflow-${profile.moduleId}-${tool}.json`);
  const hasTool = (id: string) => profile.qualityTools.some((d) => d.id === id);

  const runner = testRunnerOf(profile);
  if (runner === "vitest") {
    const bin = await resolveBin(repo, cwd, TOOL_BINS.vitest);
    const output = report(bin, "vitest");
    const args = [
      "run",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${pathFrom(cwd, output)}`,
      "--passWithNoTests",
    ];
    catalog.push(
      command("test", "test", bin.script, args, JAVASCRIPT_PARSERS.jestJson, [output], 30 * MINUTE),
      command(
        "test-filter",
        "test",
        bin.script,
        [...args, "--testNamePattern", "{testNamePattern}"],
        JAVASCRIPT_PARSERS.jestJson,
        [output],
        30 * MINUTE,
        [TEST_NAME_PATTERN],
      ),
    );
  } else if (runner === "jest") {
    const bin = await resolveBin(repo, cwd, TOOL_BINS.jest);
    const output = report(bin, "jest");
    const args = ["--ci", "--json", `--outputFile=${pathFrom(cwd, output)}`, "--passWithNoTests"];
    catalog.push(
      command("test", "test", bin.script, args, JAVASCRIPT_PARSERS.jestJson, [output], 30 * MINUTE),
      command(
        "test-filter",
        "test",
        bin.script,
        [...args, "--testNamePattern", "{testNamePattern}"],
        JAVASCRIPT_PARSERS.jestJson,
        [output],
        30 * MINUTE,
        [TEST_NAME_PATTERN],
      ),
    );
  }

  if (hasTool("eslint")) {
    const bin = await resolveBin(repo, cwd, TOOL_BINS.eslint);
    const output = report(bin, "eslint");
    catalog.push(
      command(
        "lint",
        "lint",
        bin.script,
        [".", "--format", "json", "--output-file", pathFrom(cwd, output)],
        JAVASCRIPT_PARSERS.eslintJson,
        [output],
        15 * MINUTE,
      ),
    );
  }

  const tsconfig = await readTextIfPresent(repo, joinRepoPath(cwd, "tsconfig.json"));
  if (hasTool("tsc") && tsconfig !== undefined && !isSolutionStyleTsconfig(tsconfig)) {
    const bin = await resolveBin(repo, cwd, TOOL_BINS.tsc);
    catalog.push(
      command(
        "typecheck",
        "typecheck",
        bin.script,
        ["--noEmit", "--pretty", "false", "--project", "tsconfig.json"],
        JAVASCRIPT_PARSERS.tsc,
        [],
        15 * MINUTE,
      ),
    );
  }

  if (hasTool("prettier")) {
    const bin = await resolveBin(repo, cwd, TOOL_BINS.prettier);
    catalog.push(
      command(
        "format-check",
        "format-check",
        bin.script,
        ["--check", "."],
        JAVASCRIPT_PARSERS.exitCode,
        [],
        10 * MINUTE,
      ),
    );
  }
  return catalog;
}
