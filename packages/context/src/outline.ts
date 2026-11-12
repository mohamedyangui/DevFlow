import path from "node:path";
import type { SourceImport } from "@devflow-ai/core";

/**
 * Lightweight, regex-based outlines and import extraction. They feed ranking and the
 * "outline" packing tier; they are deliberately approximate and never used for edits. For
 * Java, TypeScript and JavaScript the tree-sitter `SourceParser` replaces them, and they
 * remain its fallback (ADR 0009).
 */

const MAX_OUTLINE_LINES = 150;
const MAX_LINE_LENGTH = 200;

const CONTROL_KEYWORDS =
  /^(if|else|for|while|do|switch|case|return|throw|new|catch|try|finally|break|continue|yield|await|import|package|using|from|select|when)\b/;

const DECLARATIONS: Record<string, readonly RegExp[]> = {
  java: [
    /^(?:@interface|(?:(?:public|protected|private|abstract|static|final|sealed|non-sealed|strictfp)\s+)*(?:class|interface|enum|record)\s+\w)/,
    /^(?:(?:public|protected|private|static|final|abstract|synchronized|default|native)\s+)*(?:<[^>]+>\s+)?[\w.$<>[\],? ]+\s+\w+\s*\([^;{]*\)?\s*(?:throws\s+[\w.,\s]+)?\s*\{?\s*$/,
    /^@(?:Get|Post|Put|Delete|Patch|Request)Mapping\b|^@(?:Rest)?Controller\b|^@(?:Service|Repository|Component|Entity|Configuration|Test|ParameterizedTest|Path|GET|POST|PUT|DELETE)\b/,
  ],
  kotlin: [
    /^(?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|annotation|inner|value|override|suspend|inline)\s+)*(?:class|interface|object|fun|typealias)\s+[\w<]/,
  ],
  typescript: [
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|enum|type|namespace|module)\s+[\w$]/,
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]/,
    /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+)?=>/,
    /^(?:(?:public|private|protected|static|readonly|async|abstract|override|get|set)\s+)*[\w$]+\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
    /^(?:describe|it|test)\s*\(\s*["'`]/,
  ],
  python: [/^(?:async\s+)?def\s+\w+|^class\s+\w+/],
  go: [/^func\s|^type\s+\w+\s+(?:struct|interface)\b/],
  protobuf: [/^(?:message|enum|service|rpc|oneof)\s+\w/],
  markdown: [/^#{1,6}\s+\S/],
};
DECLARATIONS.javascript = DECLARATIONS.typescript ?? [];
DECLARATIONS.groovy = DECLARATIONS.java ?? [];
DECLARATIONS.scala = DECLARATIONS.kotlin ?? [];
DECLARATIONS.csharp = DECLARATIONS.java ?? [];

/** A declaration line found by the regex outline. */
export interface DeclarationLine {
  /** 1-based line number. */
  readonly line: number;
  /** Leading whitespace of the line, at most 8 characters. */
  readonly indent: number;
  /** The trimmed line without a trailing `{`, at most 200 characters. */
  readonly text: string;
}

/** Lines that look like declarations, for languages with patterns (approximate). */
export function declarationLines(language: string | null, text: string): DeclarationLine[] {
  const patterns = language === null ? undefined : DECLARATIONS[language];
  if (patterns === undefined) return [];
  const lines = text.split(/\r?\n/);
  const out: DeclarationLine[] = [];
  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (language !== "markdown" && CONTROL_KEYWORDS.test(trimmed)) continue;
    if (!patterns.some((pattern) => pattern.test(trimmed))) continue;
    out.push({
      line: index + 1,
      indent: Math.min(8, raw.length - raw.trimStart().length),
      text: trimmed.replace(/\s*\{\s*$/, "").slice(0, MAX_LINE_LENGTH),
    });
    if (out.length >= MAX_OUTLINE_LINES) break;
  }
  return out;
}

/** Declaration lines with their 1-based line numbers, e.g. `L12: public class OrderController`. */
export function outlineOf(language: string | null, text: string): string {
  return declarationLines(language, text)
    .map((entry) => `L${String(entry.line)}: ${" ".repeat(entry.indent)}${entry.text}`)
    .join("\n");
}

const JVM_LANGUAGES = new Set(["java", "kotlin", "groovy", "scala"]);
const SCRIPT_LANGUAGES = new Set(["typescript", "javascript", "vue"]);

/** Imports found by regular expressions, line by line (approximate). */
export function regexImports(language: string | null, text: string): SourceImport[] {
  const lineAt = lineIndex(text);
  const out: SourceImport[] = [];
  if (language !== null && JVM_LANGUAGES.has(language)) {
    for (const match of text.matchAll(/^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;?\s*$/gm)) {
      out.push({
        specifier: match[2] ?? "",
        line: lineAt(match.index),
        kind: match[3] !== undefined ? "wildcard" : match[1] !== undefined ? "static" : "module",
      });
    }
  } else if (language !== null && SCRIPT_LANGUAGES.has(language)) {
    const pattern = /(from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;
    for (const match of text.matchAll(pattern)) {
      const prefix = match[1] ?? "";
      out.push({
        specifier: match[2] ?? "",
        line: lineAt(match.index),
        kind: prefix.startsWith("require")
          ? "require"
          : /^import\s*\(/.test(prefix)
            ? "dynamic"
            : "module",
      });
    }
  } else if (language === "python") {
    for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      out.push({
        specifier: match[1] ?? match[2] ?? "",
        line: lineAt(match.index),
        kind: "module",
      });
    }
  } else if (language === "protobuf") {
    for (const match of text.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']/gm)) {
      out.push({ specifier: match[1] ?? "", line: lineAt(match.index), kind: "module" });
    }
  }
  return out.filter((entry) => entry.specifier !== "");
}

/**
 * Repository-relative files that imports refer to, resolved by convention: Java and Kotlin
 * imports to `<package path>/<Name>.<ext>` suffixes, relative JavaScript/TypeScript imports to
 * files, Python modules to `.py` paths, Protobuf imports to `.proto` paths.
 */
export function resolveImports(
  relative: string,
  language: string | null,
  imports: readonly SourceImport[],
  files: ReadonlySet<string>,
  suffixIndex: ReadonlyMap<string, readonly string[]>,
): string[] {
  const found = new Set<string>();
  const bySuffix = (suffix: string): void => {
    for (const candidate of suffixIndex.get(suffix.slice(suffix.lastIndexOf("/") + 1)) ?? []) {
      if (candidate === suffix || candidate.endsWith(`/${suffix}`)) found.add(candidate);
    }
  };

  if (language !== null && JVM_LANGUAGES.has(language)) {
    for (const entry of imports) {
      if (entry.kind === "wildcard") continue;
      const parts = entry.specifier.split(".");
      if (entry.kind === "static") parts.pop();
      if (parts.length < 2) continue;
      const base = parts.join("/");
      for (const extension of ["java", "kt", "groovy", "scala"]) bySuffix(`${base}.${extension}`);
    }
  } else if (language !== null && SCRIPT_LANGUAGES.has(language)) {
    const directory = path.posix.dirname(relative);
    for (const entry of imports) {
      if (!/^\.{1,2}\//.test(entry.specifier)) continue;
      const target = path.posix.normalize(path.posix.join(directory, entry.specifier));
      if (target.startsWith("..")) continue;
      const stem = target.replace(/\.(m|c)?js$/, "");
      const candidates = [
        target,
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"].map(
          (ext) => `${stem}${ext}`,
        ),
        `${target}/index.ts`,
        `${target}/index.js`,
      ];
      const hit = candidates.find((candidate) => files.has(candidate));
      if (hit !== undefined) found.add(hit);
    }
  } else if (language === "python") {
    for (const entry of imports) {
      if (entry.specifier.startsWith(".")) continue;
      bySuffix(`${entry.specifier.replaceAll(".", "/")}.py`);
    }
  } else if (language === "protobuf") {
    for (const entry of imports) bySuffix(entry.specifier);
  }
  found.delete(relative);
  return [...found].sort();
}

/** The files a file imports, from its text (regex extraction, then {@link resolveImports}). */
export function importsOf(
  relative: string,
  language: string | null,
  text: string,
  files: ReadonlySet<string>,
  suffixIndex: ReadonlyMap<string, readonly string[]>,
): string[] {
  return resolveImports(relative, language, regexImports(language, text), files, suffixIndex);
}

/** Maps a string index to its 1-based line number. */
function lineIndex(text: string): (index: number) => number {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

/** Index of repository files by base name, for import suffix matching. */
export function suffixIndexOf(paths: readonly string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of paths) {
    const name = file.slice(file.lastIndexOf("/") + 1);
    const list = index.get(name);
    if (list === undefined) index.set(name, [file]);
    else list.push(file);
  }
  return index;
}
