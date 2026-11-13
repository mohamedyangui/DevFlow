import { createPathMatcher, type SourceImport, type TaskContract } from "@devflowai/core";
import { Bm25Index, tokenize } from "./bm25.js";
import { importsOf, resolveImports, suffixIndexOf } from "./outline.js";
import type { ContractSummary, FileRole } from "./schemas.js";

/**
 * Explainable relevance ranking (ADR 0008): BM25 over path, outline and content, plus boosts
 * for identifiers quoted in the task, the task scope, contracts mentioned by the task,
 * test/source pairs and one-hop import neighbours. Every score comes with its reasons.
 */

export interface RankCandidate {
  readonly path: string;
  readonly role: FileRole;
  readonly language: string | null;
  readonly module: string | null;
  /** File text used for scoring only; it never leaves the process from here. */
  readonly text: string;
  readonly outline: string;
  /** Imports read by the source parser; without them, imports are found by regex. */
  readonly imports?: readonly SourceImport[];
}

export interface RankedFile {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface QueryItem {
  /** `title`, `description`, a requirement or criterion id, or `constraint N`. */
  readonly id: string;
  readonly text: string;
}

export interface TaskIdentifier {
  readonly value: string;
  readonly source: string;
  readonly kind: "identifier" | "path" | "route";
}

const ROLE_FACTOR: Readonly<Record<FileRole, number>> = {
  source: 1,
  test: 1,
  contract: 1,
  configuration: 0.8,
  documentation: 0.6,
  other: 0.5,
  generated: 0.3,
  instructions: 0,
};

const CONTENT_SCAN_LIMIT = 32 * 1024;

export function taskQueryItems(task: TaskContract): QueryItem[] {
  const items: QueryItem[] = [{ id: "title", text: task.title }];
  if (task.description.trim() !== "") items.push({ id: "description", text: task.description });
  for (const fr of task.requirements.functional) items.push({ id: fr.id, text: fr.text });
  for (const nfr of task.requirements.nonFunctional) items.push({ id: nfr.id, text: nfr.text });
  for (const ac of task.acceptanceCriteria) {
    items.push({
      id: ac.id,
      text: [ac.statement, ac.given, ac.when, ac.then].filter((t) => t !== undefined).join(" "),
    });
  }
  task.constraints.forEach((text, index) => items.push({ id: `constraint ${index + 1}`, text }));
  return items;
}

/** Identifiers, file paths and HTTP routes written in the task. */
export function taskIdentifiers(items: readonly QueryItem[]): TaskIdentifier[] {
  const found = new Map<string, TaskIdentifier>();
  const add = (value: string, source: string, kind: TaskIdentifier["kind"]): void => {
    const trimmed = value.trim().replace(/[.,;:)]+$/, "");
    if (trimmed.length < 3 || trimmed.length > 160 || found.has(trimmed)) return;
    found.set(trimmed, { value: trimmed, source, kind });
  };
  for (const item of items) {
    for (const match of item.text.matchAll(/`([^`\n]{2,160})`/g)) {
      const value = match[1] ?? "";
      const kind = value.startsWith("/") ? "route" : value.includes("/") ? "path" : "identifier";
      add(value.split(/\s/)[0] ?? value, item.id, kind);
    }
    for (const match of item.text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b/g)) {
      add(match[0], item.id, "identifier");
    }
    for (const match of item.text.matchAll(/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+\b/g)) {
      add(match[0], item.id, "identifier");
    }
    for (const match of item.text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) {
      add(match[0], item.id, "identifier");
    }
    for (const match of item.text.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+)/g)) {
      add(match[1] ?? "", item.id, "path");
    }
    for (const match of item.text.matchAll(/(?:^|[\s(])(\/[\w{}.-]+(?:\/[\w{}.-]+)*)/g)) {
      add(match[1] ?? "", item.id, "route");
    }
  }
  return [...found.values()];
}

export interface RankOptions {
  readonly task: TaskContract;
  readonly contracts: readonly ContractSummary[];
}

export function rankFiles(
  candidates: readonly RankCandidate[],
  options: RankOptions,
): RankedFile[] {
  const { task } = options;
  const items = taskQueryItems(task);
  const identifiers = taskIdentifiers(items);
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const scopeInclude = createPathMatcher(task.scope.include, { caseInsensitive });
  const scopeExclude = createPathMatcher(task.scope.exclude, { caseInsensitive });
  const scopeModules = new Set(task.scope.modules);

  const eligible = candidates.filter(
    (candidate) =>
      ROLE_FACTOR[candidate.role] > 0 && scopeExclude.match(candidate.path) === undefined,
  );

  // Query tokens, remembering which task items they came from.
  const sources = new Map<string, Set<string>>();
  for (const item of items) {
    for (const token of tokenize(item.text)) {
      const set = sources.get(token) ?? new Set<string>();
      set.add(item.id);
      sources.set(token, set);
    }
  }
  const index = new Bm25Index(
    eligible.map((candidate) => {
      const pathTokens = tokenize(candidate.path);
      return {
        id: candidate.path,
        tokens: [
          ...pathTokens,
          ...pathTokens,
          ...pathTokens,
          ...tokenize(candidate.outline),
          ...tokenize(candidate.outline),
          ...tokenize(candidate.text.slice(0, CONTENT_SCAN_LIMIT)),
        ],
      };
    }),
  );
  const lexical = index.search([...sources.keys()]);

  const scores = new Map<string, { score: number; reasons: string[] }>();
  const entry = (file: string): { score: number; reasons: string[] } => {
    let value = scores.get(file);
    if (value === undefined) {
      value = { score: 0, reasons: [] };
      scores.set(file, value);
    }
    return value;
  };

  const contractNames = contractMentions(options.contracts, identifiers, items);

  for (const candidate of eligible) {
    const match = lexical.get(candidate.path);
    if (match !== undefined) {
      const current = entry(candidate.path);
      current.score += match.score;
      const terms = match.terms.slice(0, 4);
      const from = [...new Set(terms.flatMap((term) => [...(sources.get(term) ?? [])]))].slice(
        0,
        4,
      );
      current.reasons.push(
        `matched ${terms.map((term) => `\`${term}\``).join(", ")} from ${from.join(", ")}`,
      );
    }

    const base = candidate.path.slice(candidate.path.lastIndexOf("/") + 1);
    const stem = base.replace(/\.[^.]+$/, "");
    let identifierBoost = 0;
    for (const identifier of identifiers) {
      if (identifierBoost >= 12) break;
      if (identifier.kind === "path") {
        if (
          candidate.path === identifier.value ||
          candidate.path.endsWith(`/${identifier.value}`)
        ) {
          identifierBoost += 10;
          entry(candidate.path).reasons.push(
            `is \`${identifier.value}\` named in ${identifier.source}`,
          );
        }
        continue;
      }
      if (identifier.kind === "identifier" && stem === identifier.value) {
        identifierBoost += 6;
        entry(candidate.path).reasons.push(
          `file name matches \`${identifier.value}\` from ${identifier.source}`,
        );
      } else if (
        candidate.outline.includes(identifier.value) ||
        candidate.text.slice(0, CONTENT_SCAN_LIMIT).includes(identifier.value)
      ) {
        identifierBoost += 3;
        entry(candidate.path).reasons.push(
          `mentions \`${identifier.value}\` from ${identifier.source}`,
        );
      }
    }
    if (identifierBoost > 0) entry(candidate.path).score += Math.min(identifierBoost, 12);

    if (task.scope.include.length > 0) {
      const pattern = scopeInclude.match(candidate.path);
      if (pattern !== undefined) {
        entry(candidate.path).score += 3;
        entry(candidate.path).reasons.push(`in the task scope (\`${pattern}\`)`);
      }
    }
    if (candidate.module !== null && scopeModules.has(candidate.module)) {
      entry(candidate.path).score += 2;
      entry(candidate.path).reasons.push(`in scope module ${candidate.module}`);
    }

    const contract = contractNames.get(candidate.path);
    if (contract !== undefined) {
      entry(candidate.path).score += 6;
      entry(candidate.path).reasons.push(...contract);
    }
  }

  const byPath = new Map(eligible.map((candidate) => [candidate.path, candidate]));
  for (const [file, value] of scores) {
    const candidate = byPath.get(file);
    if (candidate !== undefined) value.score *= ROLE_FACTOR[candidate.role];
  }

  // Test/source pairs and one-hop import neighbours of the top results.
  const top = sorted(scores).slice(0, 15);
  const pairs = pairIndex(eligible.map((candidate) => candidate.path));
  const files = new Set(eligible.map((candidate) => candidate.path));
  const suffixes = suffixIndexOf([...files]);
  for (const [file, value] of top) {
    for (const partner of pairs.get(file) ?? []) {
      const partnerEntry = entry(partner);
      partnerEntry.score += value.score * 0.5;
      partnerEntry.reasons.push(
        byPath.get(partner)?.role === "test"
          ? `test of \`${file}\``
          : `code under test in \`${file}\``,
      );
    }
  }
  for (const [file, value] of top.slice(0, 10)) {
    const candidate = byPath.get(file);
    if (candidate === undefined) continue;
    const neighbours =
      candidate.imports === undefined
        ? importsOf(file, candidate.language, candidate.text, files, suffixes)
        : resolveImports(file, candidate.language, candidate.imports, files, suffixes);
    for (const imported of neighbours) {
      const importedEntry = entry(imported);
      importedEntry.score += value.score * 0.3;
      importedEntry.reasons.push(`imported by \`${file}\``);
    }
  }

  return sorted(scores)
    .filter(([, value]) => value.score > 0)
    .map(([file, value]) => ({
      path: file,
      score: Math.round(value.score * 1000) / 1000,
      reasons: [...new Set(value.reasons)].slice(0, 6),
    }));
}

function sorted(
  scores: Map<string, { score: number; reasons: string[] }>,
): [string, { score: number; reasons: string[] }][] {
  return [...scores].sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1));
}

/** Contract files whose declarations the task mentions, with the reason. */
function contractMentions(
  contracts: readonly ContractSummary[],
  identifiers: readonly { value: string; source: string }[],
  items: readonly QueryItem[],
): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const mentioned = (name: string): string | undefined =>
    identifiers.find((identifier) => identifier.value === name)?.source ??
    items.find((item) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(item.text))?.id;
  for (const contract of contracts) {
    const reasons: string[] = [];
    const names: [string, string][] =
      contract.kind === "protobuf"
        ? [
            ...contract.messages.map((n): [string, string] => ["message", n]),
            ...contract.services.map((n): [string, string] => ["service", n]),
            ...contract.enums.map((n): [string, string] => ["enum", n]),
          ]
        : [
            ...contract.operationIds.map((n): [string, string] => ["operation", n]),
            ...contract.paths.map((n): [string, string] => ["path", n]),
          ];
    for (const [kind, name] of names) {
      if (name.length < 3) continue;
      const source = mentioned(name);
      if (source !== undefined) reasons.push(`defines ${kind} \`${name}\` mentioned in ${source}`);
      if (reasons.length >= 3) break;
    }
    if (reasons.length > 0) result.set(contract.path, reasons);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Test/source counterparts by naming convention. */
function pairIndex(paths: readonly string[]): Map<string, string[]> {
  const byKey = new Map<string, { tests: string[]; sources: string[] }>();
  const keyOf = (file: string): { key: string; test: boolean } => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const js = /^(.+?)\.(?:test|spec)\.([cm]?[jt]s)x?$/.exec(name);
    if (js !== null) return { key: `${js[1] ?? ""}.${js[2] ?? ""}`, test: true };
    const jvm = /^(.+?)(?:Test|Tests|IT)\.(java|kt|groovy|scala)$/.exec(name);
    if (jvm !== null) return { key: `${jvm[1] ?? ""}.${jvm[2] ?? ""}`, test: true };
    const py = /^test_(.+\.py)$/.exec(name);
    if (py !== null) return { key: py[1] ?? name, test: true };
    return { key: name.replace(/\.([cm]?[jt]s)x$/, ".$1"), test: false };
  };
  for (const file of paths) {
    const { key, test } = keyOf(file);
    const group = byKey.get(key) ?? { tests: [], sources: [] };
    (test ? group.tests : group.sources).push(file);
    byKey.set(key, group);
  }
  // Only test-to-source links; unrelated files that share a name (index.ts) are not pairs.
  const result = new Map<string, string[]>();
  for (const { tests, sources } of byKey.values()) {
    if (tests.length === 0 || sources.length === 0 || tests.length + sources.length > 6) continue;
    for (const file of sources) result.set(file, tests);
    for (const file of tests) result.set(file, sources);
  }
  return result;
}
