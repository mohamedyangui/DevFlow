/**
 * Lexical helpers of the consumer finder (ADR 0022): comment masking, line numbers, and a
 * reader for the URL expression of an HTTP call. They read text only; nothing is executed,
 * and every loop is bounded by the input length.
 */

export type LanguageFamily = "c" | "python";

/** Java, Kotlin, TypeScript and JavaScript share C-style comments; Python uses `#`. */
export function familyOf(language: string): LanguageFamily | undefined {
  if (["java", "kotlin", "typescript", "javascript"].includes(language)) return "c";
  if (language === "python") return "python";
  return undefined;
}

/**
 * The text with its comments replaced by spaces (line breaks kept), so offsets and line
 * numbers stay valid. String literals are kept: URLs live in them.
 */
export function maskComments(text: string, family: LanguageFamily): string {
  const out: string[] = [];
  let i = 0;
  const blank = (from: number, to: number): void => {
    out.push(text.slice(from, to).replace(/[^\n]/g, " "));
  };
  while (i < text.length) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);
    if (family === "c" && char === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (family === "c" && char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (family === "python" && char === "#") {
      const end = text.indexOf("\n", i);
      const stop = end === -1 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (char === '"' || char === "'" || (char === "`" && family === "c")) {
      const stop = stringEnd(text, i, family);
      out.push(text.slice(i, stop));
      i = stop;
    } else {
      out.push(char);
      i += 1;
    }
  }
  return out.join("");
}

/** The offset just past the string literal that starts at `start` (a quote character). */
function stringEnd(text: string, start: number, family: LanguageFamily): number {
  const quote = text.charAt(start);
  const triple =
    (family === "python" || quote === '"') && text.startsWith(quote.repeat(3), start)
      ? quote.repeat(3)
      : undefined;
  if (triple !== undefined) {
    const end = text.indexOf(triple, start + 3);
    return end === -1 ? text.length : end + 3;
  }
  let i = start + 1;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === "\\") i += 2;
    else if (char === quote) return i + 1;
    else if (char === "\n" && quote !== "`") return i;
    else i += 1;
  }
  return text.length;
}

/** Maps offsets to 1-based line numbers. */
export class LineIndex {
  private readonly starts: number[] = [0];

  constructor(text: string) {
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.starts.push(i + 1);
  }

  lineOf(offset: number): number {
    let low = 0;
    let high = this.starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.starts[middle] ?? 0) <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}

/** A URL expression: literal text and holes (`{}`) for every non-literal part. */
export interface UrlExpression {
  /** The literal parts joined, every hole written `{}`. */
  readonly template: string;
  /** Whether the expression starts with a hole (a base URL variable, usually). */
  readonly leadingHole: boolean;
  /** Offset just past the expression. */
  readonly end: number;
}

/** At most this many characters are read for one call argument. */
const MAX_EXPRESSION = 2000;

const PYTHON_PREFIX = /^[rRbBuUfF]{1,2}(?=["'])/;

/**
 * Reads the expression that starts at `start` (an argument of a call): string literals
 * concatenated with `+`, template literals (`${...}`), Python f-strings (`{...}`). Every
 * non-literal operand becomes a hole. Undefined when the expression has no string literal.
 */
export function readUrlExpression(
  text: string,
  start: number,
  family: LanguageFamily,
): UrlExpression | undefined {
  const limit = Math.min(text.length, start + MAX_EXPRESSION);
  let i = skipSpace(text, start, limit);
  let template = "";
  let literal = false;
  let leadingHole = false;
  let first = true;
  for (;;) {
    if (i >= limit) return undefined;
    let char = text.charAt(i);
    let prefix = "";
    if (family === "python") {
      prefix = PYTHON_PREFIX.exec(text.slice(i, i + 3))?.[0] ?? "";
      char = text.charAt(i + prefix.length);
    }
    if (char === '"' || char === "'" || (char === "`" && family === "c")) {
      const read = readLiteral(text, i + prefix.length, family, /f/i.test(prefix), limit);
      if (read === undefined) return undefined;
      template += read.value;
      literal = true;
      i = read.end;
    } else {
      const end = operandEnd(text, i, limit);
      if (end === i) return undefined;
      template += "{}";
      if (first) leadingHole = true;
      i = end;
    }
    first = false;
    i = skipSpace(text, i, limit);
    if (text.charAt(i) !== "+") break;
    i = skipSpace(text, i + 1, limit);
  }
  return literal ? { template, leadingHole, end: i } : undefined;
}

function skipSpace(text: string, i: number, limit: number): number {
  let at = i;
  while (at < limit && /\s/.test(text.charAt(at))) at += 1;
  return at;
}

/** Reads one string literal; `${...}` (template literals) and `{...}` (f-strings) are holes. */
function readLiteral(
  text: string,
  start: number,
  family: LanguageFamily,
  formatted: boolean,
  limit: number,
): { value: string; end: number } | undefined {
  const quote = text.charAt(start);
  const triple =
    family === "python" && text.startsWith(quote.repeat(3), start) ? quote.repeat(3) : "";
  let i = start + (triple === "" ? 1 : 3);
  let value = "";
  while (i < limit) {
    const char = text.charAt(i);
    if (triple !== "" ? text.startsWith(triple, i) : char === quote) {
      return { value, end: i + (triple === "" ? 1 : 3) };
    }
    if (char === "\n" && quote !== "`" && triple === "") return undefined;
    if (char === "\\") {
      value += text.charAt(i + 1);
      i += 2;
    } else if (quote === "`" && char === "$" && text.charAt(i + 1) === "{") {
      const end = closing(text, i + 1, limit);
      if (end === undefined) return undefined;
      value += "{}";
      i = end + 1;
    } else if (formatted && char === "{") {
      if (text.charAt(i + 1) === "{") {
        value += "{";
        i += 2;
      } else {
        const end = closing(text, i, limit);
        if (end === undefined) return undefined;
        value += "{}";
        i = end + 1;
      }
    } else if (formatted && char === "}" && text.charAt(i + 1) === "}") {
      value += "}";
      i += 2;
    } else {
      value += char;
      i += 1;
    }
  }
  return undefined;
}

/** The offset of the `}` that closes the `{` at `open`, skipping nested braces. */
function closing(text: string, open: number, limit: number): number | undefined {
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const char = text.charAt(i);
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

/**
 * The end of a non-literal operand: up to a top-level `+`, `,`, `)`, `]`, `}` or `;`, with
 * nested brackets and strings skipped.
 */
function operandEnd(text: string, start: number, limit: number): number {
  let depth = 0;
  let i = start;
  while (i < limit) {
    const char = text.charAt(i);
    if (char === '"' || char === "'" || char === "`") {
      const close = text.indexOf(char, i + 1);
      if (close === -1 || close > limit) return limit;
      i = close + 1;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && (char === "+" || char === "," || char === ";")) {
      return i;
    }
    i += 1;
  }
  return i;
}

/**
 * The text of the argument list that starts just after `(` at `open`, up to its `)`
 * (bounded), for looking up options such as `method: "POST"`.
 */
export function argumentText(text: string, open: number, max = MAX_EXPRESSION): string {
  const limit = Math.min(text.length, open + max);
  let depth = 0;
  for (let i = open; i < limit; i++) {
    const char = text.charAt(i);
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) return text.slice(open, i);
      depth -= 1;
    }
  }
  return text.slice(open, limit);
}

/** Splits an argument list at its top-level commas. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quote !== undefined) {
      current += char;
      if (char === "\\") {
        current += text.charAt(i + 1);
        i += 1;
      } else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** The contents of the double-quoted string literals of a Java or Kotlin snippet. */
export function stringLiterals(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    out.push((match[1] ?? "").replace(/\\(.)/g, "$1"));
  }
  return out;
}
