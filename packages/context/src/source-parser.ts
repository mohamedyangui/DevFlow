import { createRequire } from "node:module";
import type {
  ParsedSource,
  SourceFile,
  SourceImport,
  SourceParser,
  SourceSymbol,
  SourceSymbolKind,
} from "@devflow-ai/core";
import type * as WebTreeSitter from "web-tree-sitter";
import type { Language, Node, Parser } from "web-tree-sitter";
import { declarationLines, regexImports } from "./outline.js";

/**
 * The `SourceParser` of ADR 0009: `web-tree-sitter` (WebAssembly) with pinned grammars for
 * Java, TypeScript, TSX and JavaScript, and a regex fallback for when a grammar cannot be
 * loaded. Nothing in a parsed file is executed; the grammars only build syntax trees.
 */

type Grammar = "java" | "typescript" | "tsx" | "javascript";

/** The grammar files, resolved from the pinned packages (see packages/context/package.json). */
const GRAMMAR_FILES: Readonly<Record<Grammar, string>> = {
  java: "tree-sitter-java/tree-sitter-java.wasm",
  typescript: "tree-sitter-typescript/tree-sitter-typescript.wasm",
  tsx: "tree-sitter-typescript/tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript/tree-sitter-javascript.wasm",
};

const MAX_SIGNATURE = 200;
const MAX_SYMBOLS = 400;
const MAX_OUTLINE_LINES = 150;

const PARSED_LANGUAGES = new Set(["java", "typescript", "javascript"]);

/** The grammar for a file: `.tsx` files use the TSX dialect; JavaScript covers JSX. */
export function grammarFor(file: Pick<SourceFile, "path" | "language">): Grammar | undefined {
  if (file.language === "java") return "java";
  if (file.language === "typescript") return /\.tsx$/i.test(file.path) ? "tsx" : "typescript";
  if (file.language === "javascript") return "javascript";
  return undefined;
}

type Runtime = typeof WebTreeSitter;

/**
 * Parses Java, TypeScript (and TSX) and JavaScript with tree-sitter. The runtime and each
 * grammar are loaded on first use and kept for the life of the parser; a grammar that cannot
 * be loaded makes `parse` reject for its files, every time.
 */
export class TreeSitterSourceParser implements SourceParser {
  private runtime: Promise<Runtime> | undefined;
  private readonly parsers = new Map<Grammar, Promise<Parser>>();
  private readonly resolve: (specifier: string) => string;

  constructor(options: { readonly resolveGrammar?: (specifier: string) => string } = {}) {
    const require = createRequire(import.meta.url);
    this.resolve = options.resolveGrammar ?? ((specifier) => require.resolve(specifier));
  }

  supports(language: string): boolean {
    return PARSED_LANGUAGES.has(language);
  }

  async parse(file: SourceFile): Promise<ParsedSource> {
    const grammar = grammarFor(file);
    if (grammar === undefined) throw new Error(`no grammar for ${file.language} files`);
    const parser = await this.parserFor(grammar);
    const tree = parser.parse(file.text);
    if (tree === null) throw new Error(`the ${grammar} parser returned no tree for ${file.path}`);
    try {
      return extract(grammar, file, tree.rootNode);
    } finally {
      tree.delete();
    }
  }

  private parserFor(grammar: Grammar): Promise<Parser> {
    let parser = this.parsers.get(grammar);
    if (parser === undefined) {
      parser = this.load(grammar);
      this.parsers.set(grammar, parser);
    }
    return parser;
  }

  private async load(grammar: Grammar): Promise<Parser> {
    this.runtime ??= import("web-tree-sitter").then(async (runtime) => {
      await runtime.Parser.init();
      return runtime;
    });
    const runtime = await this.runtime;
    const language: Language = await runtime.Language.load(this.resolve(GRAMMAR_FILES[grammar]));
    const parser = new runtime.Parser();
    parser.setLanguage(language);
    return parser;
  }
}

/**
 * Uses the tree-sitter parser for the languages it supports and the regex outline when it
 * fails, for example when a grammar cannot be loaded. `onFallback` hears about each failure
 * reason once.
 */
export class FallbackSourceParser implements SourceParser {
  private readonly reported = new Set<string>();

  constructor(
    private readonly primary: SourceParser,
    private readonly onFallback?: (reason: string) => void,
  ) {}

  supports(language: string): boolean {
    return this.primary.supports(language);
  }

  async parse(file: SourceFile): Promise<ParsedSource> {
    try {
      return await this.primary.parse(file);
    } catch (error) {
      const reason = `${file.language}: ${error instanceof Error ? error.message : String(error)}`;
      if (!this.reported.has(reason)) {
        this.reported.add(reason);
        this.onFallback?.(reason);
      }
      return regexParse(file);
    }
  }
}

/** The approximate, line-based result for a file (the fallback of ADR 0009). */
export function regexParse(file: SourceFile): ParsedSource {
  return {
    language: file.language,
    parser: "regex",
    symbols: declarationLines(file.language, file.text).map((entry) => ({
      kind: "declaration",
      name: regexName(entry.text),
      line: entry.line,
      depth: Math.min(4, Math.floor(entry.indent / 2)),
      signature: entry.text,
    })),
    imports: regexImports(file.language, file.text),
    hasErrors: false,
  };
}

/** The outline packing tier's text: one `L<line>: <signature>` line per symbol, indented by depth. */
export function renderOutline(parsed: ParsedSource): string {
  return parsed.symbols
    .slice(0, MAX_OUTLINE_LINES)
    .map(
      (symbol) =>
        `L${String(symbol.line)}: ${"  ".repeat(Math.min(4, symbol.depth))}${symbol.signature}`,
    )
    .join("\n");
}

function regexName(line: string): string {
  const keyword =
    /\b(?:class|interface|enum|record|function\*?|type|namespace|module|fun|def|object|message|service|rpc)\s+([\w$]+)/.exec(
      line,
    );
  if (keyword?.[1] !== undefined) return keyword[1];
  const call = /([\w$]+)\s*(?:<[^>]*>)?\s*(?:=\s*(?:async\s*)?)?\(/.exec(line);
  return call?.[1] ?? "";
}

// ---- Extraction ---------------------------------------------------------------------------

interface Found {
  readonly kind: SourceSymbolKind;
  readonly name: string;
  /** Where the declaration starts, including `export` and annotations. */
  readonly start: Node;
  /** Where the signature ends: the start of the body, or the end of `start`. */
  readonly bodyStart?: number;
}

function extract(grammar: Grammar, file: SourceFile, root: Node): ParsedSource {
  const symbols: SourceSymbol[] = [];
  const imports: SourceImport[] = [];
  const java = grammar === "java";
  const stack: { node: Node; depth: number }[] = [{ node: root, depth: 0 }];
  while (stack.length > 0) {
    const item = stack.pop();
    if (item === undefined) break;
    const { node, depth } = item;
    let childDepth = depth;
    const found = java ? javaSymbol(node) : scriptSymbol(node);
    if (found !== undefined && symbols.length < MAX_SYMBOLS) {
      symbols.push({
        kind: found.kind,
        name: found.name,
        line: found.start.startPosition.row + 1,
        depth,
        signature: signature(file.text, found),
      });
      childDepth = depth + 1;
    }
    const imported = java ? javaImport(node) : scriptImport(node);
    if (imported !== undefined) imports.push(imported);
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child !== undefined) stack.push({ node: child, depth: childDepth });
    }
  }
  return {
    language: file.language,
    parser: "tree-sitter",
    symbols,
    imports,
    hasErrors: root.hasError,
  };
}

function signature(text: string, found: Found): string {
  const end = found.bodyStart ?? found.start.endIndex;
  return text
    .slice(found.start.startIndex, Math.max(found.start.startIndex, end))
    .replace(/\s+/g, " ")
    .replace(/\s*[{;]\s*$/, "")
    .trim()
    .slice(0, MAX_SIGNATURE);
}

const JAVA_KINDS: Readonly<Record<string, SourceSymbolKind>> = {
  class_declaration: "class",
  interface_declaration: "interface",
  enum_declaration: "enum",
  record_declaration: "record",
  annotation_type_declaration: "annotation-type",
  method_declaration: "method",
  constructor_declaration: "constructor",
  compact_constructor_declaration: "constructor",
};

const JAVA_TEST_ANNOTATIONS =
  /^@(?:Test|ParameterizedTest|RepeatedTest|TestFactory|TestTemplate)\b/;

function javaSymbol(node: Node): Found | undefined {
  let kind = JAVA_KINDS[node.type];
  if (kind === undefined) return undefined;
  const name = node.childForFieldName("name")?.text ?? "";
  if (kind === "method") {
    const modifiers = node.namedChildren.find((child) => child.type === "modifiers");
    const annotations = modifiers?.namedChildren ?? [];
    if (annotations.some((annotation) => JAVA_TEST_ANNOTATIONS.test(annotation.text))) {
      kind = "test";
    }
  }
  const body = node.childForFieldName("body");
  return { kind, name, start: node, ...(body === null ? {} : { bodyStart: body.startIndex }) };
}

function javaImport(node: Node): SourceImport | undefined {
  if (node.type !== "import_declaration") return undefined;
  const match = /^import\s+(static\s+)?([\w.$]+?)(\s*\.\s*\*)?\s*;/.exec(
    node.text.replace(/\s+/g, " "),
  );
  if (match?.[2] === undefined) return undefined;
  return {
    specifier: match[2],
    line: node.startPosition.row + 1,
    kind: match[3] !== undefined ? "wildcard" : match[1] !== undefined ? "static" : "module",
  };
}

const SCRIPT_KINDS: Readonly<Record<string, SourceSymbolKind>> = {
  class_declaration: "class",
  abstract_class_declaration: "class",
  class: "class",
  interface_declaration: "interface",
  type_alias_declaration: "type",
  enum_declaration: "enum",
  internal_module: "namespace",
  module: "namespace",
  function_declaration: "function",
  generator_function_declaration: "function",
  function_signature: "function",
  method_definition: "method",
  abstract_method_signature: "method",
};

const TEST_FUNCTIONS = new Set(["describe", "it", "test", "suite", "context"]);
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function"]);

/** The node a declaration starts at: its `export` statement, when it has one. */
function declarationStart(node: Node): Node {
  const parent = node.parent;
  return parent?.type === "export_statement" ? parent : node;
}

function scriptSymbol(node: Node): Found | undefined {
  const kind = SCRIPT_KINDS[node.type];
  if (kind !== undefined) {
    // An anonymous class expression is only a symbol when it is exported (`export default class`).
    if (node.type === "class" && node.parent?.type !== "export_statement") return undefined;
    const name = node.childForFieldName("name")?.text ?? "";
    const body = node.childForFieldName("body");
    return {
      kind: kind === "method" && name === "constructor" ? "constructor" : kind,
      name,
      start: declarationStart(node),
      ...(body === null ? {} : { bodyStart: body.startIndex }),
    };
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const declarator of node.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const value = declarator.childForFieldName("value");
      if (value === null || !FUNCTION_VALUES.has(value.type)) continue;
      const body = value.childForFieldName("body");
      return {
        kind: "function",
        name: declarator.childForFieldName("name")?.text ?? "",
        start: declarationStart(node),
        ...(body === null ? {} : { bodyStart: body.startIndex }),
      };
    }
    return undefined;
  }
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    const base =
      callee?.type === "identifier"
        ? callee.text
        : callee?.type === "member_expression"
          ? (callee.childForFieldName("object")?.text ?? "")
          : "";
    if (!TEST_FUNCTIONS.has(base)) return undefined;
    const title = node.childForFieldName("arguments")?.namedChildren[0];
    if (title === undefined) return undefined;
    const name = stringValue(title);
    if (name === undefined) return undefined;
    return { kind: "test", name, start: node, bodyStart: title.endIndex };
  }
  return undefined;
}

function scriptImport(node: Node): SourceImport | undefined {
  const line = node.startPosition.row + 1;
  if (node.type === "import_statement" || node.type === "export_statement") {
    const source = node.childForFieldName("source");
    const specifier = source === null ? undefined : stringValue(source);
    return specifier === undefined ? undefined : { specifier, line, kind: "module" };
  }
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    const dynamic = callee?.type === "import";
    if (!dynamic && !(callee?.type === "identifier" && callee.text === "require")) return undefined;
    const first = node.childForFieldName("arguments")?.namedChildren[0];
    const specifier = first === undefined ? undefined : stringValue(first);
    if (specifier === undefined) return undefined;
    return { specifier, line, kind: dynamic ? "dynamic" : "require" };
  }
  return undefined;
}

/** The value of a string literal, or of a template literal without substitutions. */
function stringValue(node: Node): string | undefined {
  if (node.type === "string") return node.text.slice(1, -1);
  if (
    node.type === "template_string" &&
    !node.namedChildren.some((c) => c.type === "template_substitution")
  ) {
    return node.text.slice(1, -1);
  }
  return undefined;
}
