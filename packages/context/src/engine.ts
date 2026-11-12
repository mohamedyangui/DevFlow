import type {
  LanguageAdapter,
  PathGuard,
  ProjectConfig,
  SecretRedactor,
  SourceImport,
  SourceParser,
  TaskContract,
} from "@devflow-ai/core";
import { languageOf, moduleOf, roleOf } from "./classify.js";
import { looksLikeOpenApi, scanOpenApi, scanProtobuf } from "./contracts.js";
import { discoverFiles } from "./discover.js";
import { estimateTokens, readTextForPrompt } from "./files.js";
import { loadInstructions } from "./instructions.js";
import { outlineOf } from "./outline.js";
import { packFiles } from "./pack.js";
import { rankFiles, type RankCandidate } from "./rank.js";
import { WorkspaceRepository } from "./repository.js";
import { FallbackSourceParser, TreeSitterSourceParser, renderOutline } from "./source-parser.js";
import {
  ContextPack,
  type ContextModule,
  type ContractSummary,
  type Instruction,
  type SkipReason,
} from "./schemas.js";

/** Default token budget of a context pack. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 60_000;
const DEFAULT_MAX_FILE_BYTES = 524_288;
/** Above this many bytes of text, further files are ranked by path and outline only. */
const MAX_BYTES_LOADED = 64 * 1024 * 1024;
const MAX_CONTRACTS = 50;
/** Above this many bytes of parsed source, further files get regex outlines (ADR 0009). */
const MAX_BYTES_PARSED = 32 * 1024 * 1024;

/** One tree-sitter parser per process: the runtime and grammars are loaded once. */
let sharedParser: TreeSitterSourceParser | undefined;

export interface BuildContextOptions {
  readonly guard: PathGuard;
  readonly task: TaskContract;
  readonly redactor: SecretRedactor;
  /** Whether the user trusts this workspace. Project rules are trusted configuration only then. */
  readonly trusted: boolean;
  /** The effective project configuration (context settings and declared modules). */
  readonly config?: ProjectConfig;
  readonly budgetTokens?: number;
  /** Language adapters for module detection (Phase 3). Without them, modules come from config. */
  readonly adapters?: readonly LanguageAdapter[];
  readonly maxFiles?: number;
  readonly signal?: AbortSignal;
  /**
   * Reads declarations and imports for outlines and ranking. Defaults to tree-sitter for Java,
   * TypeScript and JavaScript; other languages, and files the parser fails on, get the regex
   * outline.
   */
  readonly sourceParser?: SourceParser;
}

/**
 * Builds the context pack for a task: discover, classify, scan contracts, rank, load
 * instructions and pack to the budget (docs/specs/context-engine.md). The result is
 * deterministic for the same workspace content and task.
 */
export async function buildContext(options: BuildContextOptions): Promise<ContextPack> {
  const { guard, task, config } = options;
  const maxFileBytes = config?.context.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const budgetTokens = options.budgetTokens ?? DEFAULT_CONTEXT_BUDGET_TOKENS;
  const warnings: string[] = [];
  const skipped: Record<SkipReason, number> = {
    "too-large": 0,
    binary: 0,
    sensitive: 0,
    symlink: 0,
    unreadable: 0,
  };

  const discovery = await discoverFiles(guard, {
    maxFileBytes,
    include: config?.context.include ?? [],
    exclude: config?.context.exclude ?? [],
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
  for (const entry of discovery.skipped) skipped[entry.reason] += 1;
  if (discovery.truncated) {
    warnings.push(`discovery stopped after ${discovery.files.length} files; ranking is partial`);
  }

  const modules = await resolveModules(options, maxFileBytes, warnings);

  const parser = new FallbackSourceParser(
    options.sourceParser ?? (sharedParser ??= new TreeSitterSourceParser()),
    (reason) => {
      warnings.push(`the source parser failed (${reason}); regex outlines are used instead`);
    },
  );
  const candidates = new Map<string, RankCandidate>();
  const contracts: ContractSummary[] = [];
  let loadedBytes = 0;
  let parsedBytes = 0;
  for (const file of discovery.files) {
    options.signal?.throwIfAborted();
    let role = roleOf(file.path);
    const language = languageOf(file.path);
    let text = "";
    if (loadedBytes + file.sizeBytes <= MAX_BYTES_LOADED) {
      const loaded = await readTextForPrompt(guard, file.path, maxFileBytes);
      if (!loaded.ok) {
        skipped[loaded.reason] += 1;
        continue;
      }
      text = loaded.text;
      loadedBytes += file.sizeBytes;
    }
    if (
      role !== "contract" &&
      (language === "yaml" || language === "json") &&
      looksLikeOpenApi(text)
    ) {
      role = "contract";
    }
    if (role === "contract" && contracts.length < MAX_CONTRACTS) {
      if (language === "protobuf") contracts.push(scanProtobuf(file.path, text));
      else {
        const summary = scanOpenApi(file.path, text);
        if (summary !== null) contracts.push(summary);
      }
    }
    let outline: string;
    let imports: readonly SourceImport[] | undefined;
    if (
      language !== null &&
      text !== "" &&
      parser.supports(language) &&
      parsedBytes + file.sizeBytes <= MAX_BYTES_PARSED
    ) {
      const parsed = await parser.parse({ path: file.path, language, text });
      parsedBytes += file.sizeBytes;
      outline = renderOutline(parsed);
      imports = parsed.imports;
    } else {
      outline = outlineOf(language, text);
    }
    candidates.set(file.path, {
      path: file.path,
      role,
      language,
      module: moduleOf(file.path, modules),
      text,
      outline,
      ...(imports === undefined ? {} : { imports }),
    });
  }
  if (loadedBytes >= MAX_BYTES_LOADED) {
    warnings.push("the workspace has more text than DevFlow loads; some files were ranked by path");
  }

  const ranked = rankFiles([...candidates.values()], { task, contracts });
  const focus = ranked.slice(0, 10).map((file) => file.path);
  const loaded = await loadInstructions({
    guard,
    redactor: options.redactor,
    files: discovery.files.map((file) => file.path),
    focus,
    trusted: options.trusted,
  });
  const instructions = fitInstructions(
    loaded.instructions,
    Math.floor(budgetTokens * 0.3),
    warnings,
  );
  if (!options.trusted && instructions.some((i) => i.kind === "project-rules")) {
    warnings.push(
      "the workspace is not trusted: project rules are included as repository content only",
    );
  }
  const instructionTokens = instructions.reduce((sum, i) => sum + estimateTokens(i.text), 0);

  const listModules = new Set<string>(task.scope.modules);
  for (const file of focus) {
    const module = candidates.get(file)?.module;
    if (module !== null && module !== undefined) listModules.add(module);
  }
  const packed = packFiles({
    ranked,
    candidates,
    budgetTokens: Math.max(0, budgetTokens - instructionTokens),
    redactor: options.redactor,
    listModules,
  });

  return ContextPack.parse({
    schemaVersion: 1,
    taskId: task.id,
    budgetTokens,
    usedTokens: packed.usedTokens + instructionTokens,
    modules,
    files: packed.files,
    instructions,
    contracts,
    stats: {
      discovered: discovery.files.length + discovery.skipped.length,
      considered: candidates.size,
      skipped,
      truncated: discovery.truncated,
    },
    warnings,
  });
}

/** Keeps instructions within their share of the budget, dropping the lowest precedence first. */
function fitInstructions(
  instructions: readonly Instruction[],
  limit: number,
  warnings: string[],
): Instruction[] {
  const kept = [...instructions];
  let total = kept.reduce((sum, i) => sum + estimateTokens(i.text), 0);
  while (total > limit && kept.length > 0) {
    let index = 0;
    kept.forEach((instruction, i) => {
      const current = kept[index];
      if (current !== undefined && instruction.rank >= current.rank) index = i;
    });
    const [dropped] = kept.splice(index, 1);
    if (dropped === undefined) break;
    total -= estimateTokens(dropped.text);
    warnings.push(`instruction file ${dropped.path} was left out to fit the context budget`);
  }
  return kept;
}

async function resolveModules(
  options: BuildContextOptions,
  maxFileBytes: number,
  warnings: string[],
): Promise<ContextModule[]> {
  const declared = options.config?.modules;
  if (declared !== undefined && declared.length > 0) {
    const modules: ContextModule[] = [];
    for (const module of declared) {
      const checked = await options.guard
        .check(module.path, { access: "read", origin: "internal" })
        .catch(() => undefined);
      if (checked?.exists !== true) {
        warnings.push(`module ${module.id}: ${module.path} does not exist`);
      }
      modules.push({ id: module.id, root: module.path, adapter: module.adapter, source: "config" });
    }
    return modules;
  }
  if (options.adapters !== undefined && options.adapters.length > 0) {
    const repository = new WorkspaceRepository(options.guard, { maxFileBytes });
    const modules: ContextModule[] = [];
    const ids = new Set<string>();
    for (const adapter of options.adapters) {
      for (const candidate of await adapter.detectModules(repository)) {
        const base =
          candidate.root === "."
            ? "root"
            : candidate.root.slice(candidate.root.lastIndexOf("/") + 1);
        let id = base.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "module";
        for (let n = 2; ids.has(id); n += 1) id = `${base}-${n}`;
        ids.add(id);
        modules.push({ id, root: candidate.root, adapter: adapter.id, source: "adapter" });
      }
    }
    if (modules.length > 0) return modules;
  }
  return [{ id: "root", root: ".", adapter: "none", source: "default" }];
}
