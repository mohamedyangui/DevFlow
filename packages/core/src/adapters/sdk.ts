import type { LanguageAdapter } from "../ports/language-adapter.js";
import { ADAPTER_API_VERSION } from "../ports/language-adapter.js";
import type { RepositoryView } from "../ports/repository-view.js";
import type { CommandSpec, ExecutionRecord } from "../schemas/command.js";
import type { Detection, InferredConvention, ModuleCandidate } from "../schemas/module.js";
import type { Evidence } from "../schemas/primitives.js";
import type { ParsedCommandResults } from "../schemas/verification.js";

/**
 * The adapter SDK (docs/specs/language-adapter.md): `defineAdapter`, the strategy interfaces
 * adapters are composed of, and small helpers for evidence and repository paths. Everything
 * here is pure: adapters read through `RepositoryView` and return data.
 */

/** Adapter ids are also used in `.devflow/config.yaml` (`modules[].adapter`). */
export const ADAPTER_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What an adapter author writes. `apiVersion` is the adapter API version the adapter targets;
 * it defaults to the version of this SDK (`ADAPTER_API_VERSION`). `inferConventions` defaults
 * to "no conventions found".
 */
export type AdapterDefinition = Omit<LanguageAdapter, "apiVersion" | "inferConventions"> &
  Partial<Pick<LanguageAdapter, "apiVersion" | "inferConventions">>;

/** Declares a language adapter. The registry checks that its API version is compatible. */
export function defineAdapter(definition: AdapterDefinition): LanguageAdapter {
  const inferConventions =
    definition.inferConventions ?? (() => Promise.resolve<readonly InferredConvention[]>([]));
  return {
    ...definition,
    apiVersion: definition.apiVersion ?? ADAPTER_API_VERSION,
    inferConventions,
  };
}

// ---- Strategies -----------------------------------------------------------------------------

/**
 * One detection concern inside an adapter: a build tool, a framework, a test runner, a quality
 * tool. `detect` returns `null` when the thing is absent; otherwise a detection with evidence.
 */
export interface DetectionStrategy<Context> {
  readonly id: string;
  detect(context: Context, repo: RepositoryView): Promise<Detection | null>;
}

/** Turns the artifacts of one execution into normalized results. */
export interface ResultParser {
  readonly id: string;
  parse(input: ResultParserInput): Promise<ParsedCommandResults>;
}

export interface ResultParserInput {
  readonly command: CommandSpec;
  readonly execution: ExecutionRecord;
  readonly repo: RepositoryView;
}

/**
 * Runs detection strategies in order and returns their detections, highest confidence first
 * (ties keep the strategy order). A strategy that finds nothing contributes nothing.
 */
export async function runDetectors<Context>(
  strategies: readonly DetectionStrategy<Context>[],
  context: Context,
  repo: RepositoryView,
): Promise<Detection[]> {
  const found: Detection[] = [];
  for (const strategy of strategies) {
    const detection = await strategy.detect(context, repo);
    if (detection !== null) found.push(detection);
  }
  return found
    .map((detection, index) => ({ detection, index }))
    .sort((a, b) => b.detection.confidence - a.detection.confidence || a.index - b.index)
    .map((entry) => entry.detection);
}

// ---- Evidence -------------------------------------------------------------------------------

const MAX_EXCERPT = 200;

/** Evidence pointing at a repository file, optionally at a line with an excerpt. */
export function fileEvidence(
  path: string,
  description: string,
  at?: { readonly line?: number; readonly excerpt?: string },
): Evidence {
  return {
    kind: "file",
    description,
    deterministic: true,
    path,
    ...(at?.line === undefined ? {} : { line: at.line }),
    ...(at?.excerpt === undefined ? {} : { excerpt: at.excerpt.trim().slice(0, MAX_EXCERPT) }),
  };
}

export interface TextMatch {
  /** 1-based line number. */
  readonly line: number;
  /** The matching line, trimmed. */
  readonly excerpt: string;
  /** The regular expression match, for capture groups. */
  readonly match: RegExpExecArray;
}

/** Finds the first line matching `pattern`. Patterns are applied line by line. */
export function findLine(text: string, pattern: RegExp): TextMatch | undefined {
  const flags = pattern.flags.replace(/[gy]/g, "");
  const regex = new RegExp(pattern.source, flags);
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const match = regex.exec(line);
    if (match !== null) return { line: index + 1, excerpt: line.trim(), match };
  }
  return undefined;
}

/** Every line matching `pattern`, in order. */
export function findLines(text: string, pattern: RegExp): TextMatch[] {
  const flags = pattern.flags.replace(/[gy]/g, "");
  const regex = new RegExp(pattern.source, flags);
  const out: TextMatch[] = [];
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const match = regex.exec(line);
    if (match !== null) out.push({ line: index + 1, excerpt: line.trim(), match });
  }
  return out;
}

/** Evidence for the first line of `path` that matches `pattern`, or undefined. */
export function evidenceAt(
  path: string,
  text: string,
  pattern: RegExp,
  description: string,
): Evidence | undefined {
  const hit = findLine(text, pattern);
  return hit === undefined
    ? undefined
    : fileEvidence(path, description, { line: hit.line, excerpt: hit.excerpt });
}

/** A detection; the version is omitted when unknown. */
export function detection(
  id: string,
  confidence: number,
  evidence: readonly Evidence[],
  version?: string,
): Detection {
  return {
    id,
    confidence,
    evidence: [...evidence],
    ...(version === undefined || version === "" ? {} : { version }),
  };
}

// ---- Paths ----------------------------------------------------------------------------------

/** Joins repository-relative POSIX paths; `.` is the repository root. */
export function joinRepoPath(...parts: readonly string[]): string {
  const segments = parts
    .flatMap((part) => part.split("/"))
    .filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 ? "." : segments.join("/");
}

/** The directory of a repository-relative path (`.` for top-level files). */
export function repoDirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "." : path.slice(0, index);
}

/** True when `path` is `root` itself or inside it. */
export function isWithin(root: string, path: string): boolean {
  if (root === ".") return true;
  return path === root || path.startsWith(`${root}/`);
}

/** `path` relative to `root`, or undefined when it is outside. */
export function relativeTo(root: string, path: string): string | undefined {
  if (root === ".") return path;
  if (path === root) return ".";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
}

/**
 * A module id derived from the module root: the root path with `/` replaced by `-`, or the
 * adapter id for a module at the repository root. The registry makes ids unique.
 */
export function moduleIdFor(candidate: Pick<ModuleCandidate, "adapterId" | "root">): string {
  const base =
    candidate.root === "."
      ? candidate.adapterId
      : candidate.root.replace(/\//g, "-").replace(/[^A-Za-z0-9._-]/g, "_");
  const trimmed = base.replace(/^[^A-Za-z0-9]+/, "").slice(0, 64);
  return trimmed === "" ? candidate.adapterId : trimmed;
}

// ---- Reading --------------------------------------------------------------------------------

/** Build files and manifests are small; anything larger is not read for detection. */
export const DEFAULT_MANIFEST_BYTES = 1_048_576;

/** Reads a text file when it exists and is readable, otherwise returns undefined. */
export async function readTextIfPresent(
  repo: RepositoryView,
  path: string,
  maxBytes = DEFAULT_MANIFEST_BYTES,
): Promise<string | undefined> {
  if (!(await repo.exists(path))) return undefined;
  try {
    return await repo.readText(path, { maxBytes });
  } catch {
    return undefined;
  }
}

/**
 * Report files older than the execution are ignored. File systems with coarse timestamps (FAT,
 * some container mounts) round down by up to two seconds, so a time on a whole second may be
 * up to this much older than the write. Times with milliseconds come from a precise file system
 * and are compared exactly: a report written just before the start, by the previous run, is
 * stale.
 */
export const REPORT_FRESHNESS_TOLERANCE_MS = 2_000;

export interface ReportFile {
  readonly path: string;
  readonly sizeBytes?: number;
  readonly modifiedMs?: number;
}

/**
 * Lists report files under `directory` (searching `depth` levels of subdirectories) whose name
 * matches `name` and that were written by the execution that started at `startedAt`. A file
 * without a modification time is not trusted to be fresh and is left out. Results are sorted by
 * path, so parsing is deterministic.
 */
export async function freshReportFiles(
  repo: RepositoryView,
  directory: string,
  options: { readonly name: RegExp; readonly startedAt: string; readonly depth?: number },
): Promise<ReportFile[]> {
  const started = Date.parse(options.startedAt);
  const out: ReportFile[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await repo.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.kind === "directory") {
        if (depth > 0) await walk(entry.path, depth - 1);
        continue;
      }
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      if (!options.name.test(name)) continue;
      if (entry.modifiedMs === undefined || Number.isNaN(started)) continue;
      const coarse = entry.modifiedMs % 1000 === 0;
      if (entry.modifiedMs < started - (coarse ? REPORT_FRESHNESS_TOLERANCE_MS : 0)) continue;
      out.push({
        path: entry.path,
        ...(entry.sizeBytes === undefined ? {} : { sizeBytes: entry.sizeBytes }),
        modifiedMs: entry.modifiedMs,
      });
    }
  }
  await walk(directory, options.depth ?? 0);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Parses JSON, returning undefined instead of throwing. */
export function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A plain object (not an array or null), for narrowing parsed JSON. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The result for a command whose output could not be read. Never a guess. */
export function unparseable(note: string): ParsedCommandResults {
  return { parse: "unparseable", tests: [], diagnostics: [], evidence: [], note };
}
