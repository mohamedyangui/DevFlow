import path from "node:path";

/**
 * Lightweight, regex-based outlines and import extraction. They feed ranking and the
 * "outline" packing tier; they are deliberately approximate and never used for edits. A
 * parser-based `SourceParser` replaces them after the Phase 3 spike (ADR 0009).
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

/** Declaration lines with their 1-based line numbers, e.g. `L12: public class OrderController`. */
export function outlineOf(language: string | null, text: string): string {
  const patterns = language === null ? undefined : DECLARATIONS[language];
  if (patterns === undefined) return "";
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("*")) continue;
    if (language !== "markdown" && CONTROL_KEYWORDS.test(trimmed)) continue;
    if (!patterns.some((pattern) => pattern.test(trimmed))) continue;
    const indent = Math.min(8, raw.length - raw.trimStart().length);
    const shown = trimmed.replace(/\s*\{\s*$/, "").slice(0, MAX_LINE_LENGTH);
    out.push(`L${index + 1}: ${" ".repeat(indent)}${shown}`);
    if (out.length >= MAX_OUTLINE_LINES) break;
  }
  return out.join("\n");
}

/**
 * Repository-relative files a file imports, resolved by convention: Java and Kotlin imports
 * to `<package path>/<Name>.<ext>` suffixes, relative JavaScript/TypeScript imports to files,
 * Python modules to `.py` paths, Protobuf imports to `.proto` paths.
 */
export function importsOf(
  relative: string,
  language: string | null,
  text: string,
  files: ReadonlySet<string>,
  suffixIndex: ReadonlyMap<string, readonly string[]>,
): string[] {
  const found = new Set<string>();
  const bySuffix = (suffix: string): void => {
    for (const candidate of suffixIndex.get(suffix.slice(suffix.lastIndexOf("/") + 1)) ?? []) {
      if (candidate === suffix || candidate.endsWith(`/${suffix}`)) found.add(candidate);
    }
  };

  if (
    language === "java" ||
    language === "kotlin" ||
    language === "groovy" ||
    language === "scala"
  ) {
    for (const match of text.matchAll(/^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;?\s*$/gm)) {
      const parts = (match[2] ?? "").split(".");
      if (match[1] !== undefined) parts.pop();
      if (match[3] !== undefined || parts.length < 2) continue;
      const base = parts.join("/");
      for (const extension of ["java", "kt", "groovy", "scala"]) bySuffix(`${base}.${extension}`);
    }
  } else if (language === "typescript" || language === "javascript" || language === "vue") {
    const pattern =
      /(?:from\s+|import\s*\(\s*|require\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
    const directory = path.posix.dirname(relative);
    for (const match of text.matchAll(pattern)) {
      const target = path.posix.normalize(path.posix.join(directory, match[1] ?? ""));
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
    for (const match of text.matchAll(/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm)) {
      const module = match[1] ?? match[2] ?? "";
      if (module.startsWith(".") || module === "") continue;
      bySuffix(`${module.replaceAll(".", "/")}.py`);
    }
  } else if (language === "protobuf") {
    for (const match of text.matchAll(/^\s*import\s+(?:public\s+|weak\s+)?["']([^"']+)["']/gm)) {
      bySuffix(match[1] ?? "");
    }
  }
  found.delete(relative);
  return [...found].sort();
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
