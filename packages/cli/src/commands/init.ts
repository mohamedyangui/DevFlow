import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PathGuard, isDevflowError } from "@devflow/core";
import { ExitCode } from "../exit-codes.js";
import { type CliIo, colorsFor } from "../io.js";

/** The providers `devflow init --provider` can write. */
export const INIT_PROVIDERS = ["anthropic", "openai", "agent"] as const;
export type InitProvider = (typeof INIT_PROVIDERS)[number];

const MODELS_LINES: Record<InitProvider, string> = {
  anthropic: `  models: {}
    # default: <model id>   # or pass --model, or set DEVFLOW_MODEL`,
  openai: `  models: {}
    # default: <model id>   # or pass --model, or set DEVFLOW_MODEL`,
  agent: `  # Agent mode (ADR 0027): the coding agent that calls DevFlow answers its model
  # requests, so no API key and no model id are needed.
  models: {}`,
};

/** The configuration `devflow init` writes for a provider. */
export function configTemplate(provider: InitProvider): string {
  return CONFIG_TEMPLATE.replace("  provider: anthropic", `  provider: ${provider}`).replace(
    MODELS_LINES.anthropic,
    MODELS_LINES[provider],
  );
}

export const CONFIG_TEMPLATE = `# DevFlow configuration (docs/specs/project-config.md).
# This file is untrusted until you review it with \`devflow trust\`: until then its ai and
# workflow settings are ignored. API keys are never read from this file.
version: 1

# Modules are detected automatically (Phase 3 adapters); declare them to override.
# modules:
#   - id: backend
#     path: backend
#     adapter: java

ai:
  provider: anthropic
  models: {}
    # default: <model id>   # or pass --model, or set DEVFLOW_MODEL
  budgets:
    maxInputTokensPerRun: 600000
    maxOutputTokensPerRun: 80000
    maxCallsPerStep: 12

workflow:
  requirePlanApproval: true

security:
  additionalProtectedPaths: []
`;

export const RULES_TEMPLATE = `# Project rules

Rules in .devflow/rules/*.md are given to the model as project rules once the workspace is
trusted (\`devflow trust\`). Until then they are treated like any other repository text.

- Describe conventions the plan must follow, for example:
- Controllers return DTOs, never entities.
- Every public function has a unit test.
`;

const GITIGNORE_ENTRY = ".devflow/runs/";

interface InitResult {
  readonly workspace: string;
  readonly created: string[];
  readonly kept: string[];
  readonly gitignore: "added" | "present";
}

/**
 * `devflow init`: writes `.devflow/config.yaml` and a rules template when they do not exist,
 * and adds `.devflow/runs/` to `.gitignore`. Existing files are never overwritten.
 */
export async function initCommand(
  options: { json: boolean; provider?: InitProvider },
  io: CliIo,
): Promise<ExitCode> {
  const provider = options.provider ?? "anthropic";
  let root: string;
  try {
    root = (await PathGuard.create(io.cwd)).root;
  } catch (error) {
    if (!isDevflowError(error)) throw error;
    io.stderr.write(`devflow: ${error.message} [${error.code}]\n`);
    return ExitCode.UsageError;
  }
  const created: string[] = [];
  const kept: string[] = [];
  for (const [relative, content] of [
    [".devflow/config.yaml", configTemplate(provider)],
    [".devflow/rules/project.md", RULES_TEMPLATE],
  ] as const) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    try {
      await writeFile(file, content, { encoding: "utf8", flag: "wx" });
      created.push(relative);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      kept.push(relative);
    }
  }

  const gitignore = path.join(root, ".gitignore");
  let current = "";
  try {
    current = await readFile(gitignore, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const present = current
    .split(/\r?\n/)
    .some((line) =>
      [".devflow/runs/", ".devflow/runs", "/.devflow/runs/", ".devflow/", ".devflow"].includes(
        line.trim(),
      ),
    );
  if (!present) {
    const separator = current === "" || current.endsWith("\n") ? "" : "\n";
    await writeFile(gitignore, `${current}${separator}${GITIGNORE_ENTRY}\n`, "utf8");
  }
  const result: InitResult = {
    workspace: root,
    created,
    kept,
    gitignore: present ? "present" : "added",
  };

  if (options.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return ExitCode.Success;
  }
  const c = colorsFor(io.stdout, io.env);
  const out = [`${c.bold("Workspace:")} ${root}`];
  for (const file of created) out.push(`  ${c.green("created")}  ${file}`);
  for (const file of kept) out.push(`  ${c.dim("kept")}     ${file} (already exists)`);
  out.push(
    `  ${result.gitignore === "added" ? c.green("updated") : c.dim("kept")}  .gitignore (${GITIGNORE_ENTRY})`,
    "",
    "Next steps:",
    ...(provider === "agent"
      ? [
          "  1. Review and trust it: devflow trust",
          "  2. Connect DevFlow to your coding agent (devflow mcp) and ask it to plan or implement a task;",
          "     the agent answers DevFlow's model requests, you approve in a terminal (devflow approve <run>).",
        ]
      : [
          "  1. Edit .devflow/config.yaml (set ai.models.default, or use --model / DEVFLOW_MODEL).",
          "  2. Review and trust it: devflow trust",
          "  3. Analyse or plan a task: devflow plan --task <file>",
        ]),
  );
  io.stdout.write(`${out.join("\n")}\n`);
  return ExitCode.Success;
}
