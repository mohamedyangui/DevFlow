import path from "node:path";
import type { PathGuard, SecretRedactor } from "@devflow-ai/core";
import { readTextForPrompt } from "./files.js";
import type { Instruction } from "./schemas.js";

const MAX_RULE_FILES = 20;
const MAX_AGENTS_FILES = 5;
const MAX_INSTRUCTION_CHARS = 16_000;
const MAX_README_CHARS = 8_000;

export interface LoadInstructionsOptions {
  readonly guard: PathGuard;
  readonly redactor: SecretRedactor;
  /** Repository-relative paths that discovery found. */
  readonly files: readonly string[];
  /** The most relevant files: their nearest `AGENTS.md` files are loaded. */
  readonly focus: readonly string[];
  /** Whether the user trusts this workspace (`devflow trust`). */
  readonly trusted: boolean;
}

/**
 * Loads project instructions in precedence order (docs/specs/context-engine.md, section 4):
 * `.devflow/rules/*.md` (rank 4), the nearest `AGENTS.md` files (rank 5) and the root README
 * (rank 7, informational). Every text is redacted and truncated. None of them can grant
 * permissions; project rules count as trusted configuration only in a trusted workspace.
 */
export async function loadInstructions(options: LoadInstructionsOptions): Promise<{
  readonly instructions: Instruction[];
  readonly redactions: number;
}> {
  const known = new Set(options.files);
  const instructions: Instruction[] = [];
  let redactions = 0;

  const load = async (
    relative: string,
    kind: Instruction["kind"],
    rank: Instruction["rank"],
    limit: number,
  ): Promise<void> => {
    const loaded = await readTextForPrompt(options.guard, relative, 1024 * 1024);
    if (!loaded.ok) return;
    const redacted = options.redactor.redact(loaded.text);
    redactions += redacted.redactions.length;
    const truncated = redacted.text.length > limit;
    instructions.push({
      path: relative,
      kind,
      rank,
      trust: kind === "project-rules" && options.trusted ? "trusted-config" : "repository",
      text: truncated ? `${redacted.text.slice(0, limit)}\n[truncated]` : redacted.text,
      truncated,
      sha256: loaded.sha256,
    });
  };

  const rules = options.files
    .filter((file) => file.startsWith(".devflow/rules/") && file.endsWith(".md"))
    .sort()
    .slice(0, MAX_RULE_FILES);
  for (const rule of rules) await load(rule, "project-rules", 4, MAX_INSTRUCTION_CHARS);

  // Nearest AGENTS.md first for the focus files, then the root one.
  const agents: string[] = [];
  for (const file of options.focus) {
    let directory = path.posix.dirname(file);
    for (;;) {
      const candidate = directory === "." ? "AGENTS.md" : `${directory}/AGENTS.md`;
      if (known.has(candidate) && !agents.includes(candidate)) agents.push(candidate);
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
  }
  if (known.has("AGENTS.md") && !agents.includes("AGENTS.md")) agents.push("AGENTS.md");
  for (const file of agents.slice(0, MAX_AGENTS_FILES)) {
    await load(file, "agents", 5, MAX_INSTRUCTION_CHARS);
  }

  const readme = ["README.md", "readme.md", "Readme.md"].find((name) => known.has(name));
  if (readme !== undefined) await load(readme, "readme", 7, MAX_README_CHARS);

  return { instructions, redactions };
}
