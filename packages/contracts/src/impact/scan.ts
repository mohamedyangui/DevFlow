import type { ConsumerMechanism, SourceImport } from "@devflow/core";
import {
  type LanguageFamily,
  LineIndex,
  argumentText,
  familyOf,
  maskComments,
  readUrlExpression,
  splitTopLevel,
  stringLiterals,
} from "./lexical.js";

/**
 * What one source file offers to the consumer finder (ADR 0022): the HTTP routes it serves
 * (Spring mappings), the HTTP calls it makes, the member calls it makes (for operation ids),
 * and its imports. Extracted once per file with regular expressions over the text with its
 * comments masked; nothing is executed.
 */

/** A path made of segments; `{}` is a path variable or a non-literal part. */
export type Segments = readonly string[];

export interface HttpEndpoint {
  readonly mechanism: ConsumerMechanism;
  /** Lower-case HTTP method, or undefined when the code does not say. */
  readonly method: string | undefined;
  readonly segments: Segments;
  /** A client call whose URL starts with a variable (a base URL): it was stripped. */
  readonly leadingHole: boolean;
  /** How the code expressed it, e.g. `@GetMapping` or `fetch`. */
  readonly via: string;
  readonly line: number;
}

export interface ImportRef {
  /** Java/Kotlin: the qualified name; TS/JS: the module specifier; Python: the module path. */
  readonly specifier: string;
  readonly line: number;
  readonly wildcard: boolean;
  /** How it is shown: the import statement, shortened. */
  readonly shown: string;
}

export interface ScannedFile {
  readonly path: string;
  readonly language: string;
  readonly family: LanguageFamily;
  /** The text with comments masked. */
  readonly code: string;
  readonly mappings: readonly HttpEndpoint[];
  readonly calls: readonly HttpEndpoint[];
  /** Member call names (`.getOrder(`) and their first line. */
  readonly memberCalls: ReadonlyMap<string, number>;
  readonly imports: readonly ImportRef[];
}

const HTTP_VERBS = ["get", "post", "put", "delete", "patch", "head", "options"];
const MAX_ENDPOINTS = 2000;

/** Scans a source file; undefined for a language the finder does not read. */
export function scanFile(
  path: string,
  language: string,
  text: string,
  imports?: readonly SourceImport[],
): ScannedFile | undefined {
  const family = familyOf(language);
  if (family === undefined) return undefined;
  const code = maskComments(text, family);
  const lines = new LineIndex(code);
  const jvm = language === "java" || language === "kotlin";
  return {
    path,
    language,
    family,
    code,
    mappings: jvm ? springMappings(code, lines) : [],
    calls: jvm
      ? javaCalls(code, lines)
      : family === "python"
        ? scriptCalls(code, lines, "python")
        : scriptCalls(code, lines, "c"),
    memberCalls: memberCalls(code, lines),
    imports: importsOf(language, code, lines, imports),
  };
}

// ---- Paths -----------------------------------------------------------------------------------

/**
 * The segments of a URL path: scheme and host removed, query and fragment removed, every
 * `{...}` written `{}`. Undefined when it is not an absolute path or URL.
 */
export function pathSegments(url: string): Segments | undefined {
  let rest = url.trim();
  const origin = /^(?:https?:)?\/\/[^/?#]*/i.exec(rest);
  if (origin !== null) rest = rest.slice(origin[0].length) || "/";
  if (!rest.startsWith("/")) return undefined;
  rest = rest.replace(/[?#].*$/s, "");
  return rest
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => segment.replace(/\{[^}]*\}/g, "{}"));
}

/** `/orders/{}` for display. */
export function showSegments(segments: Segments): string {
  return `/${segments.join("/")}`;
}

// ---- Spring ------------------------------------------------------------------------------

const MAPPING = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g;

/**
 * Spring MVC/WebFlux handler mappings. A class-level `@RequestMapping` is a prefix for the
 * mappings of the class declared after it (the last `class` declared before a method
 * mapping). Paths come from string literals only; constants are not resolved.
 */
function springMappings(code: string, lines: LineIndex): HttpEndpoint[] {
  const classes = [...code.matchAll(/\b(?:class|interface|object)\s+[A-Za-z_$][\w$]*/g)].map(
    (match) => match.index,
  );
  const prefixes = new Map<number, { paths: string[]; methods: string[] }>();
  const methodMappings: { at: number; name: string; paths: string[]; methods: string[] }[] = [];
  for (const match of code.matchAll(MAPPING)) {
    const name = match[1] ?? "Request";
    let end = match.index + match[0].length;
    let args = "";
    const open = /^\s*\(/.exec(code.slice(end, end + 200));
    if (open !== null) {
      const start = end + open[0].length;
      args = argumentText(code, start);
      end = start + args.length + 1;
    }
    const { paths, methods } = mappingArguments(args);
    const verb = name === "Request" ? methods : [name.toLowerCase()];
    // A class-level mapping is followed by a class declaration before any `(` or `{`.
    const after = code.slice(end, end + 500);
    const declaration = /^(?:\s*@[\w.]+(?:\([^)]*\))?)*[\s\w]*?\b(class|interface|object)\b/.exec(
      after,
    );
    if (declaration !== null) {
      const at = classes.find((offset) => offset >= end);
      if (at !== undefined) prefixes.set(at, { paths, methods: verb });
    } else {
      methodMappings.push({ at: match.index, name, paths, methods: verb });
    }
  }
  const out: HttpEndpoint[] = [];
  for (const mapping of methodMappings) {
    const owner = classes.filter((offset) => offset < mapping.at).at(-1);
    const prefix = owner === undefined ? undefined : prefixes.get(owner);
    const bases = prefix === undefined || prefix.paths.length === 0 ? [""] : prefix.paths;
    const own = mapping.paths.length === 0 ? [""] : mapping.paths;
    const methods = mapping.methods.length > 0 ? mapping.methods : (prefix?.methods ?? []);
    for (const base of bases) {
      for (const path of own) {
        const segments = pathSegments(`/${base}/${path}`.replace(/\/+/g, "/"));
        if (segments === undefined) continue;
        for (const method of methods.length > 0 ? methods : [undefined]) {
          if (out.length >= MAX_ENDPOINTS) return out;
          out.push({
            mechanism: "spring-mapping",
            method,
            segments,
            leadingHole: false,
            via: `@${mapping.name}Mapping`,
            line: lines.lineOf(mapping.at),
          });
        }
      }
    }
  }
  return out;
}

/** The paths (`value`, `path` or the positional argument) and methods of a mapping. */
function mappingArguments(args: string): { paths: string[]; methods: string[] } {
  const paths: string[] = [];
  const methods: string[] = [];
  for (const part of splitTopLevel(args)) {
    const named = /^\s*(\w+)\s*=([\s\S]*)$/.exec(part);
    const key = named?.[1];
    const value = named?.[2] ?? part;
    if (key === undefined || key === "value" || key === "path") {
      paths.push(...stringLiterals(value));
    } else if (key === "method") {
      for (const verb of value.matchAll(/\bRequestMethod\s*\.\s*([A-Z]+)\b|\b([A-Z]+)\b/g)) {
        const name = (verb[1] ?? verb[2] ?? "").toLowerCase();
        if (HTTP_VERBS.includes(name)) methods.push(name);
      }
    }
  }
  return { paths, methods };
}

// ---- HTTP calls --------------------------------------------------------------------------

function endpoint(
  mechanism: ConsumerMechanism,
  via: string,
  method: string | undefined,
  url: { template: string; leadingHole: boolean },
  line: number,
): HttpEndpoint | undefined {
  let template = url.template;
  let leadingHole = url.leadingHole;
  if (leadingHole) {
    // `${base}/orders`: the base URL is stripped; `${path}` alone says nothing.
    if (!template.startsWith("{}/")) return undefined;
    template = template.slice(2);
  } else if (template.startsWith("{}/")) {
    template = template.slice(2);
    leadingHole = true;
  }
  const segments = pathSegments(template);
  if (segments === undefined || segments.every((segment) => segment === "{}")) return undefined;
  return { mechanism, method, segments, leadingHole, via, line };
}

/** `method: "POST"` in a call's options, lower case. */
function methodOption(args: string): string | undefined {
  const found = /\bmethod\s*:\s*["'`](\w+)["'`]/i.exec(args)?.[1]?.toLowerCase();
  return found !== undefined && HTTP_VERBS.includes(found) ? found : undefined;
}

/**
 * TypeScript/JavaScript and Python calls: `fetch(url, { method })`, `axios(url | { url,
 * method })`, `x.request({ url, method })`, and `<anything>.get|post|...(url)` (axios, the
 * Angular `HttpClient`, supertest, `requests`, `httpx`, sessions and clients). The URL must be
 * a literal path or URL, possibly built with templates, f-strings or `+`.
 */
function scriptCalls(code: string, lines: LineIndex, family: LanguageFamily): HttpEndpoint[] {
  const out: HttpEndpoint[] = [];
  const mechanism: ConsumerMechanism =
    family === "python" ? "python-client-call" : "ts-client-call";
  const call =
    /\b(fetch|axios|request|get|post|put|delete|patch|head|options)\s*(?:<[^<>()]{0,200}>)?\s*\(/g;
  for (const match of code.matchAll(call)) {
    if (out.length >= MAX_ENDPOINTS) break;
    const name = match[1] ?? "";
    const start = match.index + match[0].length;
    const before = code.slice(Math.max(0, match.index - 1), match.index);
    const member = before === ".";
    if (family === "python" && name === "fetch") continue;
    if (/^(get|post|put|delete|patch|head|options)$/.test(name) && !member) continue;
    if (name === "request" && !member && family === "python") continue;
    const args = argumentText(code, start);
    let url: ReturnType<typeof readUrlExpression>;
    let method: string | undefined;
    if (HTTP_VERBS.includes(name)) {
      url = readUrlExpression(code, start, family);
      method = name;
    } else if (/^\s*\{/.test(args)) {
      // `axios({ url: "/x", method: "post" })`
      const key = /\burl\s*:\s*/.exec(args);
      if (key === null) continue;
      url = readUrlExpression(code, start + key.index + key[0].length, family);
      method = methodOption(args);
    } else {
      url = readUrlExpression(code, start, family);
      method =
        methodOption(args) ?? (name === "fetch" ? "get" : name === "axios" ? "get" : undefined);
    }
    if (url === undefined) continue;
    const found = endpoint(mechanism, name, method, url, lines.lineOf(match.index));
    if (found !== undefined) out.push(found);
  }
  return out;
}

const REST_TEMPLATE: Readonly<Record<string, string | undefined>> = {
  getForObject: "get",
  getForEntity: "get",
  postForObject: "post",
  postForEntity: "post",
  postForLocation: "post",
  patchForObject: "patch",
  exchange: undefined,
};

/**
 * Java and Kotlin calls: RestTemplate (`getForObject`, `exchange` with `HttpMethod.X`...),
 * WebClient and WebTestClient (`.get().uri(url)`), and the MockMvc, RestAssured and
 * similar builders (`get(url)`, `.post(url)`). The URL must be a literal, possibly with `+`.
 */
function javaCalls(code: string, lines: LineIndex): HttpEndpoint[] {
  const out: HttpEndpoint[] = [];
  const call =
    /\b(get|post|put|delete|patch|head|options|uri|getForObject|getForEntity|postForObject|postForEntity|postForLocation|patchForObject|exchange)\s*\(/g;
  for (const match of code.matchAll(call)) {
    if (out.length >= MAX_ENDPOINTS) break;
    const name = match[1] ?? "";
    const start = match.index + match[0].length;
    const url = readUrlExpression(code, start, "c");
    if (url === undefined) continue;
    let method: string | undefined;
    if (HTTP_VERBS.includes(name)) {
      method = name;
    } else if (name === "uri") {
      const before = code.slice(Math.max(0, match.index - 200), match.index);
      const verb = [
        ...before.matchAll(
          /\.(get|post|put|delete|patch|head|options)\s*\(\s*\)|HttpMethod\s*\.\s*([A-Z]+)/g,
        ),
      ].at(-1);
      method = (verb?.[1] ?? verb?.[2])?.toLowerCase();
    } else if (name === "exchange") {
      method = /HttpMethod\s*\.\s*([A-Z]+)/.exec(argumentText(code, start))?.[1]?.toLowerCase();
    } else {
      method = REST_TEMPLATE[name];
    }
    const found = endpoint("java-client-call", name, method, url, lines.lineOf(match.index));
    if (found !== undefined) out.push(found);
  }
  return out;
}

/** `.name(` member calls, first line of each name. */
function memberCalls(code: string, lines: LineIndex): Map<string, number> {
  const out = new Map<string, number>();
  for (const match of code.matchAll(/\.\s*([A-Za-z_$][\w$]*)\s*(?:<[^<>()]{0,200}>)?\s*\(/g)) {
    const name = match[1] ?? "";
    if (!out.has(name)) out.set(name, lines.lineOf(match.index));
    if (out.size >= 20_000) break;
  }
  return out;
}

// ---- Imports -----------------------------------------------------------------------------

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat;
}

/**
 * Imports: Java/Kotlin qualified names, TS/JS module specifiers (from a parser when the
 * caller gives its imports, otherwise from regular expressions), and Python modules with the
 * names imported from them (`from a.b import c` gives `a.b` and `a.b.c`).
 */
function importsOf(
  language: string,
  code: string,
  lines: LineIndex,
  parsed?: readonly SourceImport[],
): ImportRef[] {
  if (language === "python") return pythonImports(code, lines);
  if (parsed !== undefined) {
    return parsed.map((entry) => ({
      specifier: entry.specifier,
      line: entry.line,
      wildcard: entry.kind === "wildcard",
      shown: `import ${entry.specifier}${entry.kind === "wildcard" ? ".*" : ""}`,
    }));
  }
  const out: ImportRef[] = [];
  if (language === "java" || language === "kotlin") {
    for (const match of code.matchAll(
      /^[ \t]*import\s+(?:static\s+)?([\w.$]+?)(\.\*)?\s*;?[ \t]*$/gm,
    )) {
      out.push({
        specifier: match[1] ?? "",
        line: lines.lineOf(match.index),
        wildcard: match[2] !== undefined,
        shown: shorten(match[0]),
      });
    }
  } else {
    const pattern =
      /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|^[ \t]*import\s+)(["'])([^"'\n]+)\1/gm;
    for (const match of code.matchAll(pattern)) {
      out.push({
        specifier: match[2] ?? "",
        line: lines.lineOf(match.index),
        wildcard: false,
        shown: `import "${match[2] ?? ""}"`,
      });
    }
  }
  return out.filter((entry) => entry.specifier !== "");
}

function pythonImports(code: string, lines: LineIndex): ImportRef[] {
  const out: ImportRef[] = [];
  const from = /^[ \t]*from\s+([\w.]+)\s+import\s+(\([^)]*\)|[^\n]*)/gm;
  for (const match of code.matchAll(from)) {
    const module = match[1] ?? "";
    const line = lines.lineOf(match.index);
    const shown = shorten(match[0]);
    out.push({ specifier: module, line, wildcard: false, shown });
    const names = (match[2] ?? "").replace(/[()\\]/g, " ");
    for (const part of names.split(",")) {
      const name = /^\s*([A-Za-z_]\w*)/.exec(part)?.[1];
      if (name === undefined) continue;
      const dotted = module.endsWith(".") ? `${module}${name}` : `${module}.${name}`;
      out.push({ specifier: dotted, line, wildcard: false, shown });
    }
  }
  for (const match of code.matchAll(/^[ \t]*import\s+([^\n]+)/gm)) {
    const line = lines.lineOf(match.index);
    for (const part of (match[1] ?? "").split(",")) {
      const module = /^\s*([\w.]+)/.exec(part)?.[1];
      if (module !== undefined) {
        out.push({ specifier: module, line, wildcard: false, shown: shorten(match[0]) });
      }
    }
  }
  return out;
}
