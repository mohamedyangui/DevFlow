import type { SecretRedactor } from "@devflow-ai/core";
import { estimateTokens } from "./files.js";
import type { RankCandidate, RankedFile } from "./rank.js";
import type { PackedFile } from "./schemas.js";

const MAX_FULL_FILES = 25;
const MAX_OUTLINE_FILES = 60;
const MAX_LISTED_FILES = 400;

export interface PackOptions {
  readonly ranked: readonly RankedFile[];
  readonly candidates: ReadonlyMap<string, RankCandidate>;
  /** Tokens available for files (the step budget minus instructions). */
  readonly budgetTokens: number;
  readonly redactor: SecretRedactor;
  /** Modules whose other files are listed by path after the ranked files. */
  readonly listModules: ReadonlySet<string>;
}

/**
 * Fits the ranked files into a token budget: the top files in full, the next tier as
 * outlines, then paths only (docs/specs/context-engine.md, section 2). Content is redacted
 * before it is counted, so the budget matches what a model receives.
 */
export function packFiles(options: PackOptions): { files: PackedFile[]; usedTokens: number } {
  const files: PackedFile[] = [];
  let remaining = options.budgetTokens;
  const perFileLimit = Math.max(2_000, Math.floor(options.budgetTokens * 0.25));
  let full = 0;
  let outlined = 0;
  let listed = 0;

  const listFile = (candidate: RankCandidate, score: number, reasons: readonly string[]): void => {
    const tokens = estimateTokens(candidate.path) + 1;
    if (listed >= MAX_LISTED_FILES || tokens > remaining) return;
    remaining -= tokens;
    listed += 1;
    files.push({
      path: candidate.path,
      role: candidate.role,
      language: candidate.language,
      module: candidate.module,
      mode: "listed",
      score,
      reasons: [...reasons],
      tokens: 0,
      redactions: 0,
    });
  };

  for (const ranked of options.ranked) {
    const candidate = options.candidates.get(ranked.path);
    if (candidate === undefined) continue;
    // Generated files (lockfiles, *.generated.*) are listed only: their content is long and
    // says little about the change.
    if (candidate.role === "generated") {
      listFile(candidate, ranked.score, ranked.reasons);
      continue;
    }
    if (full < MAX_FULL_FILES && candidate.text !== "") {
      const redacted = options.redactor.redact(candidate.text);
      const tokens = estimateTokens(redacted.text);
      if (tokens <= perFileLimit && tokens <= remaining) {
        remaining -= tokens;
        full += 1;
        files.push({
          path: candidate.path,
          role: candidate.role,
          language: candidate.language,
          module: candidate.module,
          mode: "full",
          score: ranked.score,
          reasons: [...ranked.reasons],
          tokens,
          content: redacted.text,
          redactions: redacted.redactions.length,
        });
        continue;
      }
    }
    if (outlined < MAX_OUTLINE_FILES && candidate.outline !== "") {
      const redacted = options.redactor.redact(candidate.outline);
      const tokens = estimateTokens(redacted.text);
      if (tokens <= remaining) {
        remaining -= tokens;
        outlined += 1;
        files.push({
          path: candidate.path,
          role: candidate.role,
          language: candidate.language,
          module: candidate.module,
          mode: "outline",
          score: ranked.score,
          reasons: [...ranked.reasons],
          tokens,
          content: redacted.text,
          redactions: redacted.redactions.length,
        });
        continue;
      }
    }
    listFile(candidate, ranked.score, ranked.reasons);
  }

  const packed = new Set(files.map((file) => file.path));
  const rest = [...options.candidates.values()]
    .filter(
      (candidate) =>
        !packed.has(candidate.path) &&
        candidate.role !== "instructions" &&
        candidate.module !== null &&
        options.listModules.has(candidate.module),
    )
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const candidate of rest) {
    listFile(candidate, 0, [`in module ${candidate.module ?? ""}`]);
  }

  return { files, usedTokens: options.budgetTokens - remaining };
}
