/**
 * Reads the structure of a source file: its declarations and its imports (ADR 0009). It feeds
 * ranking and outlines; it is never used to edit code. Implementations must not execute
 * anything from the file and must return a result for any text, including invalid code.
 */
export interface SourceParser {
  /** Whether this parser reads files of a language, as named by the context engine. */
  supports(language: string): boolean;
  parse(file: SourceFile): Promise<ParsedSource>;
}

export interface SourceFile {
  /** Repository-relative path; the extension selects a dialect (`.tsx`, `.jsx`). */
  readonly path: string;
  readonly language: string;
  readonly text: string;
}

export type SourceSymbolKind =
  | "class"
  | "interface"
  | "enum"
  | "record"
  | "annotation-type"
  | "type"
  | "namespace"
  | "function"
  | "method"
  | "constructor"
  | "test"
  /** A declaration whose kind the parser does not tell apart (the regex fallback). */
  | "declaration";

export interface SourceSymbol {
  readonly kind: SourceSymbolKind;
  /** The declared name, or the title of a test or suite. Empty when it is not known. */
  readonly name: string;
  /** 1-based line where the declaration starts (its first annotation or modifier). */
  readonly line: number;
  /** Nesting level among the symbols: 0 for top-level declarations. */
  readonly depth: number;
  /** The declaration without its body, on one line, at most 200 characters. */
  readonly signature: string;
}

export interface SourceImport {
  /**
   * What is imported, as written: a module specifier (`./http.js`, `react`) or a qualified
   * Java or Kotlin name (`com.shop.orders.OrderService`).
   */
  readonly specifier: string;
  /** 1-based line of the import. */
  readonly line: number;
  /**
   * `static` and `wildcard` are Java imports (`import static a.B.c;`, `import a.b.*;`);
   * `dynamic` is `import("…")`; `require` is a CommonJS `require("…")` call.
   */
  readonly kind: "module" | "static" | "wildcard" | "dynamic" | "require";
}

export interface ParsedSource {
  readonly language: string;
  /** `tree-sitter` for a full parse, `regex` for the approximate line-based fallback. */
  readonly parser: "tree-sitter" | "regex";
  readonly symbols: readonly SourceSymbol[];
  readonly imports: readonly SourceImport[];
  /** The file has syntax errors: the symbols and imports may be incomplete. */
  readonly hasErrors: boolean;
}
