import { LineCounter, isMap, isNode, isScalar, isSeq, parseDocument, type Document } from "yaml";

/**
 * The OpenAPI 3.x model of the built-in rules (ADR 0021): the parsed document, its operations
 * with their parameters, and local `$ref` resolution. JSON and YAML are both read with the YAML
 * parser (JSON is YAML 1.2). External references are never fetched: they are reported as
 * unresolved, and the rules say `unknown` where they matter.
 */

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/** At most this many `$ref` hops are followed for one reference. */
const MAX_REF_HOPS = 32;

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface OpenApiParameter {
  /** `query:limit`, `header:x-trace` (lower case), or `path:#0` for the first path variable. */
  readonly key: string;
  readonly name: string;
  readonly in: string;
  readonly required: boolean;
  /** The parameter object (after `$ref` resolution). */
  readonly node: JsonObject;
  readonly pointer: string;
}

export interface OpenApiOperation {
  /** `get /pets/{}`: the method and the path with its variables unnamed. */
  readonly key: string;
  readonly path: string;
  readonly method: string;
  readonly operationId: string | undefined;
  readonly node: JsonObject;
  readonly pointer: string;
  readonly parameters: readonly OpenApiParameter[];
  /** Parameter references that could not be resolved. */
  readonly unresolvedParameters: readonly string[];
}

/** A resolved node: its value, the pointer it was found at, or why it could not be resolved. */
export type Resolved =
  | { readonly ok: true; readonly node: unknown; readonly pointer: string; readonly ref?: string }
  | { readonly ok: false; readonly ref: string; readonly reason: string };

export class OpenApiDocument {
  readonly version: string;
  readonly root: JsonObject;
  readonly operations: readonly OpenApiOperation[];
  private readonly yaml: Document;
  private readonly lines: LineCounter;

  private constructor(root: JsonObject, version: string, yaml: Document, lines: LineCounter) {
    this.root = root;
    this.version = version;
    this.yaml = yaml;
    this.lines = lines;
    this.operations = this.collectOperations();
  }

  /**
   * Parses an OpenAPI document. Returns a reason instead when the text is not YAML or JSON, or
   * not an OpenAPI or Swagger document.
   */
  static parse(text: string): { document: OpenApiDocument } | { error: string } {
    const lines = new LineCounter();
    let yaml: Document;
    let value: unknown;
    try {
      yaml = parseDocument(text, { lineCounter: lines, uniqueKeys: false, prettyErrors: false });
      if (yaml.errors.length > 0) {
        return { error: `not valid YAML or JSON: ${yaml.errors[0]?.message ?? "parse error"}` };
      }
      value = yaml.toJS({ maxAliasCount: 50 });
    } catch (error) {
      return { error: `not valid YAML or JSON: ${(error as Error).message}` };
    }
    if (!isObject(value)) return { error: "the document is not a mapping" };
    const version = value.openapi ?? value.swagger;
    if (typeof version !== "string" && typeof version !== "number") {
      return { error: 'the document has no "openapi" or "swagger" version' };
    }
    return { document: new OpenApiDocument(value, String(version), yaml, lines) };
  }

  /** Whether the document is OpenAPI 3.x, the version the built-in rules support. */
  get supported(): boolean {
    return typeof this.root.openapi === "string" && /^3\.\d+/.test(this.root.openapi);
  }

  /**
   * The 1-based line of the node at a JSON pointer, when the pointer exists: the line of its
   * key for a mapping entry, of the item for a sequence entry.
   */
  lineOf(pointer: string): number | undefined {
    const segments = pointerSegments(pointer);
    if (segments === undefined) return undefined;
    const last = segments.at(-1);
    const parent: unknown =
      segments.length <= 1 ? this.yaml.contents : this.yaml.getIn(segments.slice(0, -1), true);
    let node: unknown;
    if (last === undefined) {
      node = this.yaml.contents;
    } else if (isMap(parent)) {
      node = parent.items.find(
        (pair) => isScalar(pair.key) && String(pair.key.value) === last,
      )?.key;
    } else if (isSeq(parent) && /^(0|[1-9]\d*)$/.test(last)) {
      node = parent.items[Number(last)];
    }
    if (!isNode(node)) return undefined;
    const start = node.range?.[0];
    return start === undefined ? undefined : this.lines.linePos(start).line;
  }

  /**
   * Follows `$ref`s from a node. Local references (`#/...`) are resolved inside this
   * document; anything else is unresolved. Chains are followed, cycles are reported.
   */
  resolve(node: unknown, pointer: string): Resolved {
    let current = node;
    let at = pointer;
    let lastRef: string | undefined;
    const seen = new Set<string>();
    for (let hop = 0; hop <= MAX_REF_HOPS; hop++) {
      if (!isObject(current) || typeof current.$ref !== "string") {
        return lastRef === undefined
          ? { ok: true, node: current, pointer: at }
          : { ok: true, node: current, pointer: at, ref: lastRef };
      }
      const ref = current.$ref;
      if (!ref.startsWith("#")) {
        return { ok: false, ref, reason: "external references are not resolved" };
      }
      if (seen.has(ref)) return { ok: false, ref, reason: "the reference is circular" };
      seen.add(ref);
      const target = this.at(ref.slice(1));
      if (target === undefined) {
        return { ok: false, ref, reason: "the reference points to nothing in the document" };
      }
      current = target;
      at = ref.slice(1);
      lastRef = ref;
    }
    return { ok: false, ref: lastRef ?? "", reason: "the reference chain is too long" };
  }

  /** The value at a JSON pointer (`/components/schemas/Pet`), or undefined. */
  at(pointer: string): unknown {
    const segments = pointerSegments(pointer);
    if (segments === undefined) return undefined;
    let current: unknown = this.root;
    for (const segment of segments) {
      if (Array.isArray(current)) {
        if (!/^(0|[1-9]\d*)$/.test(segment)) return undefined;
        current = current[Number(segment)];
      } else if (isObject(current) && Object.hasOwn(current, segment)) {
        current = current[segment];
      } else {
        return undefined;
      }
    }
    return current;
  }

  private collectOperations(): OpenApiOperation[] {
    const operations: OpenApiOperation[] = [];
    const paths = this.root.paths;
    if (!isObject(paths)) return operations;
    for (const [route, rawItem] of Object.entries(paths)) {
      const itemPointer = `/paths/${escapePointer(route)}`;
      const item = this.resolve(rawItem, itemPointer);
      if (!item.ok || !isObject(item.node)) continue;
      const shared: unknown[] = Array.isArray(item.node.parameters) ? item.node.parameters : [];
      for (const method of HTTP_METHODS) {
        const operation = item.node[method];
        if (!isObject(operation)) continue;
        const pointer = `${item.pointer}/${method}`;
        const own: unknown[] = Array.isArray(operation.parameters) ? operation.parameters : [];
        const { parameters, unresolved } = this.parameters(route, [
          ...shared.map((node, index) => ({
            node,
            pointer: `${item.pointer}/parameters/${String(index)}`,
          })),
          ...own.map((node, index) => ({
            node,
            pointer: `${pointer}/parameters/${String(index)}`,
          })),
        ]);
        operations.push({
          key: operationKey(method, route),
          path: route,
          method,
          operationId:
            typeof operation.operationId === "string" ? operation.operationId : undefined,
          node: operation,
          pointer,
          parameters,
          unresolvedParameters: unresolved,
        });
      }
    }
    return operations;
  }

  /** Path-level then operation-level parameters; an operation's own parameter wins. */
  private parameters(
    route: string,
    entries: readonly { node: unknown; pointer: string }[],
  ): { parameters: OpenApiParameter[]; unresolved: string[] } {
    const variables = pathVariables(route);
    const byKey = new Map<string, OpenApiParameter>();
    const unresolved: string[] = [];
    for (const entry of entries) {
      const resolved = this.resolve(entry.node, entry.pointer);
      if (!resolved.ok) {
        unresolved.push(resolved.ref);
        continue;
      }
      const node = resolved.node;
      if (!isObject(node) || typeof node.name !== "string" || typeof node.in !== "string") continue;
      const location = node.in;
      let key: string;
      if (location === "path") {
        const index = variables.indexOf(node.name);
        key = index === -1 ? `path:${node.name}` : `path:#${String(index)}`;
      } else if (location === "header") {
        key = `header:${node.name.toLowerCase()}`;
      } else {
        key = `${location}:${node.name}`;
      }
      byKey.set(key, {
        key,
        name: node.name,
        in: location,
        required: location === "path" || node.required === true,
        node,
        pointer: resolved.pointer,
      });
    }
    return { parameters: [...byKey.values()], unresolved };
  }
}

/** `get /pets/{}`: path variables are unnamed, so renaming one is not a new operation. */
export function operationKey(method: string, route: string): string {
  return `${method} ${route.replace(/\{[^}/]*\}/g, "{}")}`;
}

export function pathVariables(route: string): string[] {
  return [...route.matchAll(/\{([^}/]*)\}/g)].map((match) => match[1] ?? "");
}

/** Escapes one JSON pointer segment (RFC 6901). */
export function escapePointer(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** The segments of a JSON pointer (`/a/b~1c`), or undefined when it is not one. */
function pointerSegments(pointer: string): string[] | undefined {
  let text: string;
  try {
    text = decodeURIComponent(pointer);
  } catch {
    return undefined;
  }
  if (text === "") return [];
  if (!text.startsWith("/")) return undefined;
  return text
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
}
