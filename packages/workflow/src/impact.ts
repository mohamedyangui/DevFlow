import type { ConsumerRepository, ConsumerSource } from "@devflow/contracts";
import { discoverFiles, languageOf, readTextForPrompt, roleOf } from "@devflow/context";
import type { PathGuard, ProjectConfig } from "@devflow/core";

/**
 * Reads the workspace's source files for the consumer finder of `@devflow/contracts`
 * (ADR 0022). The finder depends on `@devflow/core` only, so the files are read here, where
 * the package boundaries allow `@devflow/context`: its discovery (ignore files, sensitive
 * files, the configured include and exclude globs), its language and role classification
 * (test files, generated code) and its guarded reader. Nothing is executed.
 */

/** The languages the consumer finder reads. */
const CONSUMER_LANGUAGES = new Set(["java", "kotlin", "typescript", "javascript", "python"]);
/** At most this many bytes of source are read for one search. */
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;

export interface ConsumerSourcesResult {
  readonly files: ConsumerSource[];
  /** What limited the search: discovery stopped, the byte budget ran out. */
  readonly notes: string[];
}

export async function consumerSources(
  guard: PathGuard,
  config?: ProjectConfig,
): Promise<ConsumerSourcesResult> {
  const discovery = await discoverFiles(guard, {
    maxFileBytes: Math.min(config?.context.maxFileBytes ?? MAX_FILE_BYTES, MAX_FILE_BYTES),
    include: config?.context.include ?? [],
    exclude: config?.context.exclude ?? [],
  });
  const notes: string[] = [];
  if (discovery.truncated) {
    notes.push(
      `file discovery stopped after ${String(discovery.files.length)} files; consumers in later files were not searched`,
    );
  }
  const files: ConsumerSource[] = [];
  let total = 0;
  for (const entry of discovery.files) {
    const language = languageOf(entry.path);
    if (language === null || !CONSUMER_LANGUAGES.has(language)) continue;
    const role = roleOf(entry.path);
    if (role === "generated") continue;
    if (total + entry.sizeBytes > MAX_TOTAL_BYTES) {
      notes.push("the source byte budget ran out; consumers in later files were not searched");
      break;
    }
    const loaded = await readTextForPrompt(guard, entry.path, MAX_FILE_BYTES);
    if (!loaded.ok) continue;
    total += entry.sizeBytes;
    files.push({
      path: entry.path,
      language,
      text: loaded.text,
      test: role === "test",
      generated: false,
    });
  }
  return { files, notes };
}

/** A consumer repository with every version of the contracts compared. */
export function consumerRepository(
  files: readonly ConsumerSource[],
  contracts: readonly { file: string; base: string | null; head: string | null }[],
): ConsumerRepository {
  return {
    files,
    contracts: new Map(
      contracts.map((entry) => [
        entry.file,
        [entry.base, entry.head].filter((text) => text !== null),
      ]),
    ),
  };
}
