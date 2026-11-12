import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  type ContractDiff,
  type ContractImpact,
  compareContractBuiltin,
  contractImpact,
  contractKindOf,
} from "@devflow-ai/contracts";
import {
  type ContractKind,
  DevflowError,
  ErrorCode,
  GitClient,
  PathGuard,
  checkRepoRelativePath,
  isDevflowError,
  loadProjectConfig,
} from "@devflow-ai/core";
import { consumerRepository, consumerSources } from "@devflow-ai/workflow";
import { ExitCode } from "../exit-codes.js";
import { colorsFor, type CliIo } from "../io.js";

export interface ContractsDiffOptions {
  /** Compare working-tree files with their version at the merge base of this ref and HEAD. */
  readonly base?: string | undefined;
  readonly kind?: ContractKind | undefined;
  readonly json: boolean;
}

/** Contract files larger than this are refused. */
const MAX_CONTRACT_BYTES = 4 * 1024 * 1024;

/**
 * `devflow contracts diff`: compares two versions of an OpenAPI or Protobuf contract with the
 * built-in rules (ADR 0021) and prints every change with its compatibility. Two forms:
 *
 * - `devflow contracts diff <base-file> <head-file>`: two files on disk;
 * - `devflow contracts diff --base <ref> <file>...`: working-tree files against their version
 *   at the merge base of `<ref>` and HEAD (what `devflow review --base <ref>` compares).
 *
 * Exit code 1 when a change is breaking, 0 otherwise (unknown changes are printed and need a
 * person's check), 2 for unusable input. External tools are not run here: review mode runs
 * oasdiff and buf through the command policy.
 */
export async function contractsDiffCommand(
  files: readonly string[],
  options: ContractsDiffOptions,
  io: CliIo,
): Promise<ExitCode> {
  let diffs: ContractDiff[];
  try {
    diffs =
      options.base === undefined
        ? [await twoFiles(files, options, io)]
        : await againstRef(files, options.base, options, io);
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2)}\n`,
      );
    } else {
      io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    }
    return ExitCode.UsageError;
  }
  const breaking = diffs.some((diff) => diff.summary.breaking > 0);
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ breaking, contracts: diffs }, null, 2)}\n`);
  } else {
    render(diffs, io);
  }
  return breaking ? ExitCode.Failure : ExitCode.Success;
}

async function twoFiles(
  files: readonly string[],
  options: ContractsDiffOptions,
  io: CliIo,
): Promise<ContractDiff> {
  const [baseFile, headFile] = files;
  if (files.length !== 2 || baseFile === undefined || headFile === undefined) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      "give a base file and a head file, or --base <ref> and the files to compare",
    );
  }
  const base = await readContract(path.resolve(io.cwd, baseFile), baseFile);
  const head = await readContract(path.resolve(io.cwd, headFile), headFile);
  if (base === null || head === null) {
    throw new DevflowError(
      ErrorCode.ContractFileInvalid,
      `${base === null ? baseFile : headFile} does not exist`,
    );
  }
  const kind =
    options.kind ?? contractKindOf(headFile, base, head) ?? contractKindOf(baseFile, base, head);
  if (kind === null) throw notAContract(headFile);
  return compareContractBuiltin({ file: headFile, kind, base, head });
}

async function againstRef(
  files: readonly string[],
  ref: string,
  options: ContractsDiffOptions,
  io: CliIo,
  versions?: { file: string; base: string | null; head: string | null }[],
): Promise<ContractDiff[]> {
  if (files.length === 0) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      "give the contract files to compare with --base",
    );
  }
  const git = new GitClient({ root: io.cwd, env: io.env });
  const inspection = await git.inspect();
  if (inspection.kind === "unavailable") {
    throw new DevflowError(
      ErrorCode.GitFailed,
      `--base needs a git repository: ${inspection.reason}`,
    );
  }
  const commit = await git.mergeBase(ref);
  const diffs: ContractDiff[] = [];
  for (const file of files) {
    const relative = file.replace(/\\/g, "/").replace(/^\.\//, "");
    const problem = checkRepoRelativePath(relative);
    if (problem !== null) {
      throw new DevflowError(ErrorCode.PathRejected, `${file}: ${problem}`, { details: { file } });
    }
    const head = await readContract(path.resolve(io.cwd, relative), file);
    const base = await git.show(commit, relative);
    if (base === null && head === null) {
      throw new DevflowError(
        ErrorCode.ContractFileInvalid,
        `${file} exists neither in the working tree nor at ${ref}`,
      );
    }
    const kind = options.kind ?? contractKindOf(relative, base, head);
    if (kind === null) throw notAContract(file);
    diffs.push(compareContractBuiltin({ file: relative, kind, base, head }));
    versions?.push({ file: relative, base, head });
  }
  return diffs;
}

/** The file's text, or null when it does not exist. */
async function readContract(absolute: string, shown: string): Promise<string | null> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new DevflowError(ErrorCode.ContractFileInvalid, `${shown} is not a file`);
    }
    if (info.size > MAX_CONTRACT_BYTES) {
      throw new DevflowError(ErrorCode.ContractFileInvalid, `${shown} is larger than 4 MB`);
    }
    return await readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    if (isDevflowError(error)) throw error;
    throw new DevflowError(
      ErrorCode.ContractFileInvalid,
      `${shown} cannot be read: ${(error as Error).message}`,
    );
  }
}

function notAContract(file: string): DevflowError {
  return new DevflowError(
    ErrorCode.ContractFileInvalid,
    `${file} is neither a .proto file nor an OpenAPI document; pass --kind openapi or --kind protobuf`,
  );
}

function render(diffs: readonly ContractDiff[], io: CliIo): void {
  const c = colorsFor(io.stdout, io.env);
  const out: string[] = [];
  for (const diff of diffs) {
    out.push(`${c.bold("Contract:")} ${diff.file} (${diff.kind}, decided by ${diff.decidedBy})`);
    if (diff.changes.length === 0) out.push("  no change");
    for (const change of diff.changes) {
      const label =
        change.compatibility === "breaking"
          ? c.red("breaking    ")
          : change.compatibility === "unknown"
            ? c.yellow("unknown     ")
            : c.green("non-breaking");
      const line =
        change.location.line === undefined ? "" : c.dim(` (line ${String(change.location.line)})`);
      out.push(`  ${label}  ${c.dim(change.rule)}  ${change.message}${line}`);
    }
    for (const text of diff.notes) out.push(`  ${c.dim(`note: ${text}`)}`);
    out.push("");
  }
  const total = (key: keyof ContractDiff["summary"]) =>
    diffs.reduce((sum, diff) => sum + diff.summary[key], 0);
  const counts = `${String(total("breaking"))} breaking, ${String(total("nonBreaking"))} non-breaking, ${String(total("unknown"))} unknown`;
  const result =
    total("breaking") > 0
      ? c.red("BREAKING")
      : total("unknown") > 0
        ? c.yellow("NO BREAKING CHANGE FOUND, CHECK THE UNKNOWN ONES")
        : c.green("COMPATIBLE");
  out.push(`${c.bold("Result:")} ${result} (${counts})`);
  io.stdout.write(`${out.join("\n")}\n`);
}

export interface ContractsImpactOptions {
  /** Compare with the version at the merge base of this ref and HEAD; HEAD by default. */
  readonly base?: string | undefined;
  readonly kind?: ContractKind | undefined;
  readonly json: boolean;
}

/**
 * `devflow contracts impact <file>...`: compares working-tree contract files with their
 * version at the merge base of `--base` (HEAD by default) and HEAD, like
 * `devflow contracts diff --base`, then lists the consumers of each breaking change found in
 * the working tree by deterministic heuristics (ADR 0022). Exit code 1 when a change is
 * breaking, 0 otherwise, 2 for unusable input. Nothing is executed and no model is called.
 */
export async function contractsImpactCommand(
  files: readonly string[],
  options: ContractsImpactOptions,
  io: CliIo,
): Promise<ExitCode> {
  const versions: { file: string; base: string | null; head: string | null }[] = [];
  let diffs: ContractDiff[];
  let impact: ContractImpact[];
  let notes: string[];
  try {
    diffs = await againstRef(
      files,
      options.base ?? "HEAD",
      { base: options.base, kind: options.kind, json: options.json },
      io,
      versions,
    );
    const guard = await PathGuard.create(io.cwd);
    const loaded = await loadProjectConfig(guard);
    const sources = await consumerSources(guard, loaded.config);
    impact = contractImpact(diffs, consumerRepository(sources.files, versions));
    notes = [
      ...(loaded.valid
        ? []
        : [".devflow/config.yaml is invalid: its include and exclude globs were not applied"]),
      ...sources.notes,
    ];
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    if (options.json) {
      io.stdout.write(
        `${JSON.stringify({ error: { code: error.code, message: error.message } }, null, 2)}\n`,
      );
    } else {
      io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    }
    return ExitCode.UsageError;
  }
  const breaking = diffs.some((diff) => diff.summary.breaking > 0);
  if (options.json) {
    io.stdout.write(`${JSON.stringify({ breaking, contracts: diffs, impact, notes }, null, 2)}\n`);
  } else {
    render(diffs, io);
    renderImpact(impact, notes, io);
  }
  return breaking ? ExitCode.Failure : ExitCode.Success;
}

function renderImpact(
  impact: readonly ContractImpact[],
  notes: readonly string[],
  io: CliIo,
): void {
  const c = colorsFor(io.stdout, io.env);
  const out: string[] = ["", c.bold("Impact:")];
  if (impact.length === 0) out.push("  no breaking change, so no consumer was searched for");
  for (const entry of impact) {
    out.push(
      `  ${c.red(entry.rule)}  ${entry.message}`,
      `    consumers of ${entry.target}: ${entry.consumers.length === 0 ? "none found" : String(entry.consumers.length + entry.omitted)}`,
    );
    for (const ref of entry.consumers) {
      const kind = ref.kind === "test" ? `test (${ref.via ?? "?"})` : ref.kind;
      const confidence = ref.confidence === "exact" ? c.green("exact  ") : c.yellow("pattern");
      out.push(`    ${confidence}  ${ref.path}:${String(ref.line)}  ${c.dim(kind)}  ${ref.match}`);
    }
    if (entry.omitted > 0) out.push(`    ${String(entry.omitted)} more, not listed`);
  }
  out.push(
    "",
    c.dim(
      "Consumers are found by deterministic heuristics (Spring mappings, HTTP client calls, " +
        "operation ids, generated-code imports); a pattern match may be a false positive, and " +
        "none found does not prove there is none.",
    ),
  );
  for (const text of notes) out.push(c.dim(`note: ${text}`));
  io.stdout.write(`${out.join("\n")}\n`);
}
