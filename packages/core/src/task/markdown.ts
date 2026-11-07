import { LineCounter, isMap, parseDocument, type Document } from "yaml";
import { TaskIssueCode, type IssuePath, type ValidationIssue } from "./issues.js";
import { locateYamlPath, yamlMessage } from "./yaml-lines.js";

/**
 * Deterministic parser for Markdown task documents (docs/specs/task-contract.md).
 *
 * The parser recognizes a small, documented set of conventions and never guesses: text it
 * cannot place is reported as a warning rather than silently dropped or reinterpreted. It
 * produces a plain object in the `TaskFile` shape, which is then validated like any YAML or
 * JSON task. GitHub issues reuse this parser (Phase 5).
 */

export interface MarkdownTaskParseResult {
  readonly data: Record<string, unknown>;
  readonly issues: readonly ValidationIssue[];
  /** Best-known 1-based line for a path into `data`. */
  readonly lineOf: (path: IssuePath) => number | undefined;
}

type ListSection =
  | "requirements"
  | "functional"
  | "nonFunctional"
  | "acceptanceCriteria"
  | "constraints"
  | "definitionOfDone";
type SectionKind = "description" | "unknown" | ListSection;

const SECTION_NAMES: ReadonlyMap<string, SectionKind> = new Map<string, SectionKind>([
  ["description", "description"],
  ["overview", "description"],
  ["requirements", "requirements"],
  ["functional requirements", "functional"],
  ["functional", "functional"],
  ["non-functional requirements", "nonFunctional"],
  ["nonfunctional requirements", "nonFunctional"],
  ["non functional requirements", "nonFunctional"],
  ["non-functional", "nonFunctional"],
  ["nonfunctional", "nonFunctional"],
  ["acceptance criteria", "acceptanceCriteria"],
  ["constraints", "constraints"],
  ["definition of done", "definitionOfDone"],
]);

const LIST_SECTIONS: ReadonlySet<SectionKind> = new Set<SectionKind>([
  "requirements",
  "functional",
  "nonFunctional",
  "acceptanceCriteria",
  "constraints",
  "definitionOfDone",
]);

const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BULLET = /^( *)(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const CHECKBOX = /^\[( |x|X)\]\s+/;
const ITEM_ID = /^(\*\*)?((?:AC|NFR|FR)-\d+)\b/;
const GIVEN_WHEN_THEN = /^(given|when|then|and)\b[\s:]*(.*)$/i;
const TRAILING_GROUP = /\s*\(([^()]*)\)\s*$/;

const TAGS: Readonly<Record<string, readonly [field: string, value: string]>> = {
  manual: ["verification", "manual"],
  automated: ["verification", "automated"],
  feature: ["testIntent", "feature"],
  regression: ["testIntent", "regression"],
  characterization: ["testIntent", "characterization"],
  unit: ["testLevel", "unit"],
  integration: ["testLevel", "integration"],
  e2e: ["testLevel", "e2e"],
};

interface Line {
  readonly text: string;
  readonly number: number;
}

interface ListItem {
  text: string;
  readonly line: number;
  readonly children: { text: string; readonly line: number }[];
}

interface Section {
  readonly kind: SectionKind;
  readonly headingLine: number;
  readonly items: ListItem[];
  readonly textLines: string[];
}

export function parseMarkdownTask(source: string): MarkdownTaskParseResult {
  const issues: ValidationIssue[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const bodyLines: Line[] = [];

  // ---- Front matter ---------------------------------------------------------------------
  let frontMatter: Record<string, unknown> = {};
  let frontMatterDoc: Document | undefined;
  const frontMatterLineCounter = new LineCounter();
  let bodyStart = 0;
  if (lines[0]?.trimEnd() === "---") {
    const end = lines.findIndex((line, index) => index > 0 && /^(---|\.\.\.)\s*$/.test(line));
    if (end === -1) {
      issues.push({
        severity: "error",
        code: TaskIssueCode.MarkdownFrontMatter,
        message: 'front matter starts with "---" but is never closed',
        path: [],
        line: 1,
      });
      return { data: {}, issues, lineOf: () => undefined };
    }
    const yamlText = lines.slice(1, end).join("\n");
    frontMatterDoc = parseDocument(yamlText, {
      lineCounter: frontMatterLineCounter,
      uniqueKeys: true,
      // `prettyErrors` is what makes the parser compute line positions for errors.
      prettyErrors: true,
    });
    for (const error of frontMatterDoc.errors) {
      issues.push({
        severity: "error",
        code: TaskIssueCode.ParseError,
        message: `front matter: ${yamlMessage(error.message)}`,
        path: [],
        ...(error.linePos?.[0] ? { line: error.linePos[0].line + 1 } : {}),
      });
    }
    if (frontMatterDoc.errors.length > 0) return { data: {}, issues, lineOf: () => undefined };
    const contents = frontMatterDoc.contents;
    if (contents !== null && !isMap(contents)) {
      issues.push({
        severity: "error",
        code: TaskIssueCode.MarkdownFrontMatter,
        message: "front matter must be a YAML mapping of task fields",
        path: [],
        line: 2,
      });
      return { data: {}, issues, lineOf: () => undefined };
    }
    frontMatter = (frontMatterDoc.toJS({ maxAliasCount: 50 }) ?? {}) as Record<string, unknown>;
    bodyStart = end + 1;
  }
  for (let index = bodyStart; index < lines.length; index++) {
    bodyLines.push({ text: lines[index] ?? "", number: index + 1 });
  }

  // ---- Body -----------------------------------------------------------------------------
  let title: { text: string; line: number } | undefined;
  const preamble: string[] = [];
  const sections: Section[] = [];
  let section: Section | undefined;
  let current: ListItem | undefined;
  let baseIndent = 0;
  let previousBlank = false;
  let fence: string | undefined;

  const warnUnparsed = (line: Line): void => {
    issues.push({
      severity: "warning",
      code: TaskIssueCode.MarkdownUnparsedText,
      message: `text outside a list item was ignored: "${truncate(line.text.trim(), 60)}"`,
      path: section ? [sectionKey(section.kind)] : [],
      line: line.number,
    });
  };

  for (const line of bodyLines) {
    const fenceMatch = FENCE.exec(line.text);
    if (fence !== undefined || fenceMatch !== null) {
      if (fence === undefined && fenceMatch !== null) fence = fenceMatch[1]?.[0] ?? "`";
      else if (fence !== undefined && fenceMatch?.[1]?.startsWith(fence) === true)
        fence = undefined;
      if (section === undefined) preamble.push(line.text);
      else if (!LIST_SECTIONS.has(section.kind)) section.textLines.push(line.text);
      else if (current !== undefined) current.text += `\n${line.text}`;
      else warnUnparsed(line);
      continue;
    }

    const heading = HEADING.exec(line.text);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const name = heading[2] ?? "";
      current = undefined;
      previousBlank = false;
      if (level === 1 && title === undefined && section === undefined) {
        title = { text: stripEmphasis(name), line: line.number };
        continue;
      }
      const kind = SECTION_NAMES.get(normalizeHeading(name));
      if (kind !== undefined) {
        section = { kind, headingLine: line.number, items: [], textLines: [] };
        sections.push(section);
      } else if (level >= 3 && section !== undefined && section.kind !== "unknown") {
        // A sub-heading inside a known section only groups its content.
        if (!LIST_SECTIONS.has(section.kind)) section.textLines.push(line.text);
      } else {
        section = { kind: "unknown", headingLine: line.number, items: [], textLines: [line.text] };
        sections.push(section);
      }
      continue;
    }

    if (section === undefined) {
      preamble.push(line.text);
      continue;
    }
    if (!LIST_SECTIONS.has(section.kind)) {
      section.textLines.push(line.text);
      continue;
    }

    // List section.
    const expanded = line.text.replace(/\t/g, "    ");
    if (expanded.trim() === "") {
      previousBlank = true;
      continue;
    }
    const bullet = BULLET.exec(expanded);
    if (bullet !== null) {
      const indent = bullet[1]?.length ?? 0;
      const text = (bullet[2] ?? "").trim();
      if (current === undefined || section.items.length === 0) baseIndent = indent;
      if (current === undefined || indent <= baseIndent + 1) {
        current = { text, line: line.number, children: [] };
        section.items.push(current);
      } else {
        current.children.push({ text, line: line.number });
      }
    } else {
      const indented = /^ {2,}/.test(expanded);
      if (current !== undefined && (!previousBlank || indented)) {
        const target = current.children.at(-1) ?? current;
        target.text = `${target.text} ${expanded.trim()}`.trim();
      } else {
        warnUnparsed(line);
      }
    }
    previousBlank = false;
  }

  // ---- Assemble -------------------------------------------------------------------------
  const data: Record<string, unknown> = { ...frontMatter };
  const bodyLinesByPath = new Map<string, number>();
  const remember = (path: IssuePath, lineNumber: number): void => {
    bodyLinesByPath.set(JSON.stringify(path), lineNumber);
  };
  const conflict = (field: string, lineNumber: number): void => {
    issues.push({
      severity: "error",
      code: TaskIssueCode.MarkdownConflict,
      message: `"${field}" is defined both in the front matter and in the document body`,
      path: [field],
      line: lineNumber,
    });
  };

  if (data.title === undefined && title !== undefined) {
    data.title = title.text;
    remember(["title"], title.line);
  }

  const descriptionParts = [
    blockText(preamble),
    ...sections
      .filter((s) => s.kind === "description" || s.kind === "unknown")
      .map((s) => blockText(s.textLines)),
  ].filter((part) => part !== "");
  if (descriptionParts.length > 0) {
    const firstDescription = sections.find((s) => s.kind === "description" || s.kind === "unknown");
    if (data.description !== undefined) conflict("description", firstDescription?.headingLine ?? 1);
    else {
      data.description = descriptionParts.join("\n\n");
      if (firstDescription !== undefined) remember(["description"], firstDescription.headingLine);
    }
  }

  const functional: Record<string, unknown>[] = [];
  const nonFunctional: Record<string, unknown>[] = [];
  const acceptanceCriteria: Record<string, unknown>[] = [];
  const constraints: string[] = [];
  const definitionOfDone: string[] = [];
  let requirementsLine: number | undefined;

  for (const s of sections) {
    switch (s.kind) {
      case "requirements":
      case "functional":
      case "nonFunctional": {
        requirementsLine ??= s.headingLine;
        for (const item of s.items) {
          const head = parseItemHead(item.text);
          const isNonFunctional =
            s.kind === "nonFunctional" ||
            (s.kind === "requirements" && head.id?.startsWith("NFR-"));
          const extra = item.children.map((c) => c.text).join("; ");
          const text = [head.text, extra].filter((t) => t !== "").join("; ");
          if (isNonFunctional) {
            remember(["requirements", "nonFunctional", nonFunctional.length], item.line);
            nonFunctional.push(compact({ id: head.id, text, category: head.category }));
          } else {
            remember(["requirements", "functional", functional.length], item.line);
            functional.push(compact({ id: head.id, text }));
          }
        }
        break;
      }
      case "acceptanceCriteria":
        remember(["acceptanceCriteria"], s.headingLine);
        for (const item of s.items) {
          remember(["acceptanceCriteria", acceptanceCriteria.length], item.line);
          acceptanceCriteria.push(parseAcceptanceCriterion(item));
        }
        break;
      case "constraints":
        remember(["constraints"], s.headingLine);
        for (const item of s.items) {
          remember(["constraints", constraints.length], item.line);
          constraints.push(plainItemText(item));
        }
        break;
      case "definitionOfDone":
        remember(["definitionOfDone"], s.headingLine);
        for (const item of s.items) {
          remember(["definitionOfDone", definitionOfDone.length], item.line);
          definitionOfDone.push(plainItemText(item));
        }
        break;
      case "description":
      case "unknown":
        break;
    }
  }

  const hasRequirementSection = requirementsLine !== undefined;
  if (hasRequirementSection) {
    if (data.requirements !== undefined) conflict("requirements", requirementsLine ?? 1);
    else {
      data.requirements = {
        ...(functional.length > 0 ? { functional } : {}),
        ...(nonFunctional.length > 0 ? { nonFunctional } : {}),
      };
      remember(["requirements"], requirementsLine ?? 1);
    }
  }
  const assignList = (field: string, kind: SectionKind, values: unknown[]): void => {
    const s = sections.find((candidate) => candidate.kind === kind);
    if (s === undefined) return;
    if (data[field] !== undefined) conflict(field, s.headingLine);
    else data[field] = values;
  };
  assignList("acceptanceCriteria", "acceptanceCriteria", acceptanceCriteria);
  assignList("constraints", "constraints", constraints);
  assignList("definitionOfDone", "definitionOfDone", definitionOfDone);

  const lineOf = (path: IssuePath): number | undefined => {
    for (let length = path.length; length > 0; length--) {
      const found = bodyLinesByPath.get(JSON.stringify(path.slice(0, length)));
      if (found !== undefined) return found;
    }
    if (frontMatterDoc !== undefined) {
      // Front matter content starts on line 2 (line 1 is the opening "---").
      return locateYamlPath(frontMatterDoc, frontMatterLineCounter, path, 1);
    }
    return undefined;
  };

  return { data, issues, lineOf };
}

// ---- Helpers --------------------------------------------------------------------------------

interface ItemHead {
  readonly id: string | undefined;
  readonly category: string | undefined;
  readonly text: string;
}

/** Parses `[ ] **AC-1**: text`, `FR-2 - text`, `NFR-1 [performance]: text`, or plain text. */
function parseItemHead(raw: string): ItemHead {
  let text = raw.replace(CHECKBOX, "");
  const idMatch = ITEM_ID.exec(text);
  if (idMatch === null) return { id: undefined, category: undefined, text: text.trim() };
  const id = idMatch[2];
  text = text.slice(idMatch[0].length);
  let category: string | undefined;
  const categoryMatch = /^\s*\[([A-Za-z-]+)\]/.exec(text);
  if (categoryMatch !== null) {
    category = categoryMatch[1]?.toLowerCase();
    text = text.slice(categoryMatch[0].length);
  }
  // Separators and the closing "**" of a bold id: "**AC-1**:", "**AC-1:**", "AC-1 -", "AC-1."
  text = text.replace(/^\s*(?:\*\*)?\s*[:.\-–—]?\s*(?:\*\*)?\s*/, "");
  return { id, category, text: text.trim() };
}

function parseAcceptanceCriterion(item: ListItem): Record<string, unknown> {
  const head = parseItemHead(item.text);
  let statement = head.text;
  const fields: Record<string, unknown> = {};

  // Trailing groups: "(covers: FR-1, FR-2)", "(manual)", "(regression, integration)".
  for (;;) {
    const match = TRAILING_GROUP.exec(statement);
    if (match === null) break;
    const content = (match[1] ?? "").trim();
    const covers = /^covers?\s*:?\s*(.*)$/i.exec(content);
    if (covers !== null) {
      fields.covers = (covers[1] ?? "").split(/[\s,]+/).filter((id) => id !== "");
    } else {
      const tokens = content.split(/\s*,\s*/).map((token) => token.toLowerCase());
      if (tokens.length === 0 || !tokens.every((token) => token in TAGS)) break;
      for (const token of tokens) {
        const tag = TAGS[token];
        if (tag !== undefined) fields[tag[0]] = tag[1];
      }
    }
    statement = statement.slice(0, match.index).trim();
  }

  // Nested "Given/When/Then/And" bullets become structured clauses.
  const extra: string[] = [];
  let lastClause: "given" | "when" | "then" | undefined;
  for (const child of item.children) {
    const clause = GIVEN_WHEN_THEN.exec(child.text);
    const keyword = clause?.[1]?.toLowerCase();
    const value = (clause?.[2] ?? "").trim();
    if (keyword === "given" || keyword === "when" || keyword === "then") {
      fields[keyword] = value;
      lastClause = keyword;
    } else if (keyword === "and" && lastClause !== undefined) {
      fields[lastClause] = `${String(fields[lastClause])} and ${value}`;
    } else {
      extra.push(child.text);
    }
  }
  const fullStatement = [statement, ...extra].filter((part) => part !== "").join("; ");
  return compact({
    id: head.id,
    statement: fullStatement === "" ? undefined : fullStatement,
    ...fields,
  });
}

function plainItemText(item: ListItem): string {
  const text = item.text.replace(CHECKBOX, "").trim();
  return [text, ...item.children.map((child) => child.text)].filter((t) => t !== "").join("; ");
}

function normalizeHeading(name: string): string {
  return stripEmphasis(name)
    .toLowerCase()
    .replace(/[:.]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripEmphasis(text: string): string {
  return text.replace(/[*_`]/g, "").trim();
}

function blockText(lines: readonly string[]): string {
  return lines.join("\n").trim();
}

function sectionKey(kind: SectionKind): string {
  return kind === "functional" || kind === "nonFunctional" ? "requirements" : kind;
}

function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
