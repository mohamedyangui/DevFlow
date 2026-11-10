import type { ContractChange, ContractCompatibility } from "../schemas.js";
import {
  type JsonObject,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
  escapePointer,
  isObject,
} from "./document.js";

/**
 * The built-in OpenAPI rules (ADR 0021). A change is `breaking` when a client written against
 * the base version can fail against the head version, `non-breaking` when it cannot, and
 * `unknown` when the rules cannot tell (an unresolved reference, a changed `oneOf`, a removed
 * request property). Request schemas are compared as inputs (narrowing breaks), response
 * schemas as outputs (removing or loosening breaks).
 */

type Direction = "request" | "response";

/** A node and the JSON pointer it was found at, in its own document. */
interface Side {
  readonly node: unknown;
  readonly pointer: string;
}

/** A schema with its `allOf` members merged. */
interface Effective {
  readonly types: readonly string[] | undefined;
  readonly format: string | undefined;
  readonly enumValues: readonly unknown[] | undefined;
  readonly properties: ReadonlyMap<string, Side>;
  readonly required: ReadonlySet<string>;
  readonly items: Side | undefined;
  readonly alternatives: unknown;
  readonly unresolved: readonly string[];
}

/** Schema comparisons per diff, so that a pathological document cannot run forever. */
const MAX_SCHEMA_COMPARISONS = 20_000;
const MAX_SCHEMA_DEPTH = 64;

interface Where {
  readonly side: "base" | "head";
  readonly pointer: string;
  readonly operation?: OpenApiOperation | undefined;
}

export class OpenApiComparison {
  readonly changes: ContractChange[] = [];
  readonly notes: string[] = [];
  private readonly base: OpenApiDocument;
  private readonly head: OpenApiDocument;
  private readonly file: string;
  private comparisons = 0;
  private stopped = false;

  constructor(base: OpenApiDocument, head: OpenApiDocument, file: string) {
    this.base = base;
    this.head = head;
    this.file = file;
  }

  run(): this {
    const headOperations = new Map(this.head.operations.map((op) => [op.key, op]));
    const baseOperations = new Map(this.base.operations.map((op) => [op.key, op]));
    for (const op of this.base.operations) {
      const next = headOperations.get(op.key);
      if (next === undefined) {
        this.add("operation-removed", "breaking", `${label(op)}: the operation was removed`, {
          side: "base",
          pointer: op.pointer,
          operation: op,
        });
      } else {
        this.compareOperation(op, next);
      }
    }
    for (const op of this.head.operations) {
      if (baseOperations.has(op.key)) continue;
      this.add("operation-added", "non-breaking", `${label(op)}: the operation was added`, {
        side: "head",
        pointer: op.pointer,
        operation: op,
      });
    }
    return this;
  }

  private add(
    rule: string,
    compatibility: ContractCompatibility,
    message: string,
    where: Where,
  ): void {
    const document = where.side === "base" ? this.base : this.head;
    const line = document.lineOf(where.pointer);
    const op = where.operation;
    this.changes.push({
      kind: "openapi",
      rule,
      compatibility,
      decidedBy: "builtin-rules",
      location: {
        file: this.file,
        ...(op === undefined ? {} : { path: op.path, method: op.method }),
        pointer: where.pointer,
        ...(line === undefined ? {} : { line }),
      },
      message,
    });
  }

  // ---- Operations ---------------------------------------------------------------------------

  private compareOperation(base: OpenApiOperation, head: OpenApiOperation): void {
    const name = label(head);
    const unresolved = new Set([...base.unresolvedParameters, ...head.unresolvedParameters]);
    const changedRefs = [...unresolved].filter(
      (ref) => !base.unresolvedParameters.includes(ref) || !head.unresolvedParameters.includes(ref),
    );
    if (changedRefs.length > 0) {
      this.add(
        "unresolved-reference",
        "unknown",
        `${name}: the parameters use references that were not resolved (${changedRefs.join(", ")}); compare them yourself`,
        { side: "head", pointer: head.pointer, operation: head },
      );
    }
    this.compareParameters(base, head);
    this.compareRequestBody(base, head);
    this.compareResponses(base, head);
  }

  private compareParameters(base: OpenApiOperation, head: OpenApiOperation): void {
    const name = label(head);
    const next = new Map(head.parameters.map((param) => [param.key, param]));
    const previous = new Map(base.parameters.map((param) => [param.key, param]));
    for (const param of base.parameters) {
      const after = next.get(param.key);
      if (after === undefined) {
        this.add(
          "request-parameter-removed",
          "unknown",
          `${name}: the ${param.in} parameter "${param.name}" was removed; clients that still send it may be rejected or ignored`,
          { side: "base", pointer: param.pointer, operation: head },
        );
        continue;
      }
      if (!param.required && after.required) {
        this.add(
          "request-parameter-became-required",
          "breaking",
          `${name}: the ${after.in} parameter "${after.name}" became required`,
          { side: "head", pointer: after.pointer, operation: head },
        );
      } else if (param.required && !after.required) {
        this.add(
          "request-parameter-became-optional",
          "non-breaking",
          `${name}: the ${after.in} parameter "${after.name}" became optional`,
          { side: "head", pointer: after.pointer, operation: head },
        );
      }
      const before = parameterSchema(param);
      const now = parameterSchema(after);
      if (before !== undefined && now !== undefined) {
        this.compareSchema(before, now, {
          direction: "request",
          subject: `the ${after.in} parameter "${after.name}"`,
          property: "",
          base,
          head,
          seen: new Set(),
          depth: 0,
        });
      }
    }
    for (const param of head.parameters) {
      if (previous.has(param.key)) continue;
      this.add(
        param.required ? "request-parameter-required-added" : "request-parameter-added",
        param.required ? "breaking" : "non-breaking",
        `${name}: the ${param.required ? "required" : "optional"} ${param.in} parameter "${param.name}" was added`,
        { side: "head", pointer: param.pointer, operation: head },
      );
    }
  }

  private compareRequestBody(base: OpenApiOperation, head: OpenApiOperation): void {
    const name = label(head);
    const before = this.base.resolve(base.node.requestBody, `${base.pointer}/requestBody`);
    const after = this.head.resolve(head.node.requestBody, `${head.pointer}/requestBody`);
    if (!before.ok || !after.ok) {
      if (sameUnresolved(before, after)) return;
      this.unresolved(name, "the request body", before, after, head);
      return;
    }
    const b = isObject(before.node) ? before.node : undefined;
    const h = isObject(after.node) ? after.node : undefined;
    if (b === undefined && h === undefined) return;
    if (b === undefined && h !== undefined) {
      const required = h.required === true;
      this.add(
        required ? "request-body-required-added" : "request-body-added",
        required ? "breaking" : "non-breaking",
        `${name}: a ${required ? "required" : "optional"} request body was added`,
        { side: "head", pointer: after.pointer, operation: head },
      );
      return;
    }
    if (b !== undefined && h === undefined) {
      this.add(
        "request-body-removed",
        "unknown",
        `${name}: the request body was removed; clients that still send one may be rejected`,
        { side: "base", pointer: before.pointer, operation: head },
      );
      return;
    }
    if (b === undefined || h === undefined) return;
    if (b.required !== true && h.required === true) {
      this.add(
        "request-body-became-required",
        "breaking",
        `${name}: the request body became required`,
        { side: "head", pointer: after.pointer, operation: head },
      );
    }
    this.compareContent(
      { node: b.content, pointer: `${before.pointer}/content` },
      { node: h.content, pointer: `${after.pointer}/content` },
      { direction: "request", subject: "the request body", base, head },
    );
  }

  private compareResponses(base: OpenApiOperation, head: OpenApiOperation): void {
    const name = label(head);
    const before = isObject(base.node.responses) ? base.node.responses : {};
    const after = isObject(head.node.responses) ? head.node.responses : {};
    for (const status of Object.keys(before)) {
      const basePointer = `${base.pointer}/responses/${escapePointer(status)}`;
      const headPointer = `${head.pointer}/responses/${escapePointer(status)}`;
      if (!Object.hasOwn(after, status)) {
        const success = status.startsWith("2");
        this.add(
          success ? "response-success-status-removed" : "response-status-removed",
          success ? "breaking" : "unknown",
          `${name}: the ${status} response was removed`,
          { side: "base", pointer: basePointer, operation: head },
        );
        continue;
      }
      const b = this.base.resolve(before[status], basePointer);
      const h = this.head.resolve(after[status], headPointer);
      if (!b.ok || !h.ok) {
        if (!sameUnresolved(b, h)) this.unresolved(name, `the ${status} response`, b, h, head);
        continue;
      }
      if (!isObject(b.node) || !isObject(h.node)) continue;
      this.compareContent(
        { node: b.node.content, pointer: `${b.pointer}/content` },
        { node: h.node.content, pointer: `${h.pointer}/content` },
        { direction: "response", subject: `the ${status} response`, base, head },
      );
    }
    for (const status of Object.keys(after)) {
      if (Object.hasOwn(before, status)) continue;
      this.add("response-status-added", "non-breaking", `${name}: a ${status} response was added`, {
        side: "head",
        pointer: `${head.pointer}/responses/${escapePointer(status)}`,
        operation: head,
      });
    }
  }

  /** Media types of a request body or a response, and their schemas. */
  private compareContent(
    before: Side,
    after: Side,
    context: {
      direction: Direction;
      subject: string;
      base: OpenApiOperation;
      head: OpenApiOperation;
    },
  ): void {
    const { direction, subject, base, head } = context;
    const name = label(head);
    const b = isObject(before.node) ? before.node : {};
    const h = isObject(after.node) ? after.node : {};
    for (const media of Object.keys(b)) {
      const basePointer = `${before.pointer}/${escapePointer(media)}`;
      if (!Object.hasOwn(h, media)) {
        this.add(
          `${direction}-media-type-removed`,
          "breaking",
          `${name}: ${subject} no longer ${direction === "request" ? "accepts" : "returns"} ${media}`,
          { side: "base", pointer: basePointer, operation: head },
        );
        continue;
      }
      const headPointer = `${after.pointer}/${escapePointer(media)}`;
      const bMedia = b[media];
      const hMedia = h[media];
      if (!isObject(bMedia) || !isObject(hMedia)) continue;
      if (bMedia.schema === undefined || hMedia.schema === undefined) continue;
      this.compareSchema(
        { node: bMedia.schema, pointer: `${basePointer}/schema` },
        { node: hMedia.schema, pointer: `${headPointer}/schema` },
        {
          direction,
          subject: `${subject} (${media})`,
          property: "",
          base,
          head,
          seen: new Set(),
          depth: 0,
        },
      );
    }
    for (const media of Object.keys(h)) {
      if (Object.hasOwn(b, media)) continue;
      this.add(
        `${direction}-media-type-added`,
        "non-breaking",
        `${name}: ${subject} now ${direction === "request" ? "accepts" : "returns"} ${media}`,
        { side: "head", pointer: `${after.pointer}/${escapePointer(media)}`, operation: head },
      );
    }
  }

  private unresolved(
    name: string,
    subject: string,
    before: ReturnType<OpenApiDocument["resolve"]>,
    after: ReturnType<OpenApiDocument["resolve"]>,
    head: OpenApiOperation,
  ): void {
    const refs = [before, after].flatMap((side) =>
      side.ok ? [] : [`${side.ref} (${side.reason})`],
    );
    this.add(
      "unresolved-reference",
      "unknown",
      `${name}: ${subject} uses a reference that was not resolved: ${refs.join(", ")}; compare it yourself`,
      { side: "head", pointer: head.pointer, operation: head },
    );
  }

  // ---- Schemas ------------------------------------------------------------------------------

  private compareSchema(
    before: Side,
    after: Side,
    context: {
      readonly direction: Direction;
      readonly subject: string;
      /** Dotted property path inside the schema, empty at its root. */
      readonly property: string;
      readonly base: OpenApiOperation;
      readonly head: OpenApiOperation;
      readonly seen: ReadonlySet<string>;
      readonly depth: number;
    },
  ): void {
    if (this.stopped) return;
    this.comparisons += 1;
    if (this.comparisons > MAX_SCHEMA_COMPARISONS) {
      this.stopped = true;
      this.notes.push(
        `the schemas are too large to compare whole: the comparison stopped after ${String(MAX_SCHEMA_COMPARISONS)} schema comparisons`,
      );
      this.add(
        "comparison-incomplete",
        "unknown",
        "the schema comparison stopped before the end; compare the remaining schemas yourself",
        { side: "head", pointer: "" },
      );
      return;
    }
    const { direction, head } = context;
    const name = label(head);
    const what =
      context.property === ""
        ? `${context.subject} schema`
        : `${context.subject} property "${context.property}"`;
    const b = this.base.resolve(before.node, before.pointer);
    const h = this.head.resolve(after.node, after.pointer);
    if (!b.ok || !h.ok) {
      if (!sameUnresolved(b, h)) this.unresolved(name, what, b, h, head);
      return;
    }
    if (!isObject(b.node) || !isObject(h.node)) return;
    const key = `${direction}|${b.pointer}|${h.pointer}`;
    if (context.seen.has(key) || context.depth > MAX_SCHEMA_DEPTH) return;
    const seen = new Set(context.seen).add(key);

    const bs = effective(this.base, b.node, b.pointer, 0);
    const hs = effective(this.head, h.node, h.pointer, 0);
    const headAt: Where = { side: "head", pointer: h.pointer, operation: head };
    const baseAt: Where = { side: "base", pointer: b.pointer, operation: head };

    const refsBefore = [...bs.unresolved].sort().join(", ");
    const refsAfter = [...hs.unresolved].sort().join(", ");
    if (refsBefore !== refsAfter) {
      this.add(
        "unresolved-reference",
        "unknown",
        `${name}: ${what} uses references that were not resolved (${refsAfter || refsBefore}); compare it yourself`,
        headAt,
      );
    }
    if (
      canonical(this.base, bs.alternatives, 0, new Set()) !==
      canonical(this.head, hs.alternatives, 0, new Set())
    ) {
      this.add(
        "schema-alternatives-changed",
        "unknown",
        `${name}: the oneOf/anyOf alternatives of ${what} changed; the built-in rules do not compare alternatives`,
        headAt,
      );
    }

    this.compareTypes(bs, hs, { direction, name, what, headAt });

    if (bs.format !== hs.format) {
      this.add(
        "format-changed",
        "unknown",
        `${name}: the format of ${what} changed from ${bs.format ?? "none"} to ${hs.format ?? "none"}`,
        headAt,
      );
    }

    this.compareEnums(bs, hs, { direction, name, what, headAt });

    // Read-only properties are never sent, write-only properties never returned.
    const skip = (document: OpenApiDocument, side: Side | undefined): boolean => {
      if (side === undefined) return false;
      const target = document.resolve(side.node, side.pointer);
      if (!target.ok || !isObject(target.node)) return false;
      return direction === "request"
        ? target.node.readOnly === true
        : target.node.writeOnly === true;
    };

    for (const [property, side] of bs.properties) {
      const path = context.property === "" ? property : `${context.property}.${property}`;
      const subject = `${context.subject} property "${path}"`;
      const next = hs.properties.get(property);
      if (next === undefined) {
        if (skip(this.base, side)) continue;
        this.add(
          `${direction}-property-removed`,
          direction === "response" ? "breaking" : "unknown",
          direction === "response"
            ? `${name}: ${subject} was removed`
            : `${name}: ${subject} was removed; clients that still send it may be rejected or ignored`,
          { ...baseAt, pointer: side.pointer },
        );
        continue;
      }
      const wasRequired = bs.required.has(property);
      const isRequired = hs.required.has(property);
      if (!skip(this.head, next) && wasRequired !== isRequired) {
        const at = { ...headAt, pointer: next.pointer };
        if (direction === "request") {
          this.add(
            isRequired ? "request-property-became-required" : "request-property-became-optional",
            isRequired ? "breaking" : "non-breaking",
            `${name}: ${subject} became ${isRequired ? "required" : "optional"}`,
            at,
          );
        } else {
          this.add(
            isRequired ? "response-property-became-required" : "response-property-became-optional",
            isRequired ? "non-breaking" : "breaking",
            `${name}: ${subject} became ${isRequired ? "required" : "optional"}`,
            at,
          );
        }
      }
      this.compareSchema(side, next, {
        ...context,
        property: path,
        seen,
        depth: context.depth + 1,
      });
    }
    for (const [property, side] of hs.properties) {
      if (bs.properties.has(property) || skip(this.head, side)) continue;
      const path = context.property === "" ? property : `${context.property}.${property}`;
      const subject = `${context.subject} property "${path}"`;
      const at = { ...headAt, pointer: side.pointer };
      if (direction === "request" && hs.required.has(property)) {
        this.add(
          "request-property-required-added",
          "breaking",
          `${name}: the required ${subject.replace(/^the /, "")} was added`,
          at,
        );
      } else {
        this.add(
          `${direction}-property-added`,
          "non-breaking",
          `${name}: ${subject} was added`,
          at,
        );
      }
    }
    if (bs.items !== undefined && hs.items !== undefined) {
      this.compareSchema(bs.items, hs.items, {
        ...context,
        property: `${context.property}[]`,
        seen,
        depth: context.depth + 1,
      });
    }
  }

  private compareTypes(
    bs: Effective,
    hs: Effective,
    context: { direction: Direction; name: string; what: string; headAt: Where },
  ): void {
    const { direction, name, what, headAt } = context;
    if (bs.types === undefined && hs.types === undefined) return;
    if (bs.types === undefined || hs.types === undefined) {
      this.add(
        "type-constraint-changed",
        "unknown",
        `${name}: the type of ${what} changed from ${bs.types?.join("|") ?? "unspecified"} to ${hs.types?.join("|") ?? "unspecified"}`,
        headAt,
      );
      return;
    }
    const before = bs.types.join("|");
    const after = hs.types.join("|");
    if (before === after) return;
    const nonNull = (types: readonly string[]) => types.filter((type) => type !== "null").join("|");
    if (nonNull(bs.types) === nonNull(hs.types)) {
      const nowNullable = hs.types.includes("null");
      const breaking = direction === "request" ? !nowNullable : nowNullable;
      this.add(
        `${direction}-nullable-${nowNullable ? "added" : "removed"}`,
        breaking ? "breaking" : "non-breaking",
        `${name}: ${what} ${nowNullable ? "can now be null" : "can no longer be null"}`,
        headAt,
      );
      return;
    }
    this.add(
      "type-changed",
      "breaking",
      `${name}: the type of ${what} changed from ${before} to ${after}`,
      headAt,
    );
  }

  private compareEnums(
    bs: Effective,
    hs: Effective,
    context: { direction: Direction; name: string; what: string; headAt: Where },
  ): void {
    const { direction, name, what, headAt } = context;
    if (bs.enumValues === undefined && hs.enumValues === undefined) return;
    if (bs.enumValues === undefined || hs.enumValues === undefined) {
      const added = hs.enumValues !== undefined;
      // A new list narrows the values: requests break. A removed list widens them: responses
      // may now return values clients do not expect.
      let compatibility: ContractCompatibility;
      if (direction === "request") compatibility = added ? "breaking" : "non-breaking";
      else compatibility = added ? "non-breaking" : "unknown";
      this.add(
        `${direction}-enum-${added ? "added" : "removed"}`,
        compatibility,
        `${name}: ${what} ${added ? "is now restricted to a list of values" : "is no longer restricted to a list of values"}`,
        headAt,
      );
      return;
    }
    const before = new Map(bs.enumValues.map((value) => [JSON.stringify(value), value]));
    const after = new Map(hs.enumValues.map((value) => [JSON.stringify(value), value]));
    const removed = [...before.keys()].filter((value) => !after.has(value));
    const added = [...after.keys()].filter((value) => !before.has(value));
    if (removed.length > 0) {
      this.add(
        `${direction}-enum-value-removed`,
        direction === "request" ? "breaking" : "non-breaking",
        `${name}: ${what} no longer ${direction === "request" ? "accepts" : "returns"} ${removed.join(", ")}`,
        headAt,
      );
    }
    if (added.length > 0) {
      this.add(
        `${direction}-enum-value-added`,
        direction === "request" ? "non-breaking" : "unknown",
        direction === "request"
          ? `${name}: ${what} now accepts ${added.join(", ")}`
          : `${name}: ${what} can now return ${added.join(", ")}; clients that check the values may not handle them`,
        headAt,
      );
    }
  }
}

/** Equal unresolved references on both sides are the same, unknown, thing: nothing to report. */
function sameUnresolved(
  before: ReturnType<OpenApiDocument["resolve"]>,
  after: ReturnType<OpenApiDocument["resolve"]>,
): boolean {
  return !before.ok && !after.ok && before.ref === after.ref;
}

function label(op: OpenApiOperation): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

function parameterSchema(param: OpenApiParameter): Side | undefined {
  if (param.node.schema !== undefined) {
    return { node: param.node.schema, pointer: `${param.pointer}/schema` };
  }
  const content = param.node.content;
  if (!isObject(content)) return undefined;
  const [media] = Object.keys(content);
  if (media === undefined) return undefined;
  const entry = content[media];
  if (!isObject(entry) || entry.schema === undefined) return undefined;
  return {
    node: entry.schema,
    pointer: `${param.pointer}/content/${escapePointer(media)}/schema`,
  };
}

function typesOf(schema: JsonObject): string[] | undefined {
  const raw = schema.type;
  const types: string[] =
    typeof raw === "string"
      ? [raw]
      : Array.isArray(raw)
        ? raw.filter((type): type is string => typeof type === "string")
        : [];
  if (types.length === 0) return undefined;
  if (schema.nullable === true) types.push("null");
  return [...new Set(types)].sort();
}

/** A schema with its `allOf` members merged (properties, required, type, enum, items). */
function effective(
  document: OpenApiDocument,
  schema: JsonObject,
  pointer: string,
  depth: number,
): Effective {
  const properties = new Map<string, Side>();
  const required = new Set<string>();
  const unresolved: string[] = [];
  let types = typesOf(schema);
  let format = typeof schema.format === "string" ? schema.format : undefined;
  let enumValues = Array.isArray(schema.enum) ? (schema.enum as unknown[]) : undefined;
  let items: Side | undefined =
    schema.items === undefined ? undefined : { node: schema.items, pointer: `${pointer}/items` };
  const alternatives: unknown[] = [];

  if (Array.isArray(schema.allOf) && depth < 16) {
    schema.allOf.forEach((member: unknown, index) => {
      const resolved = document.resolve(member, `${pointer}/allOf/${String(index)}`);
      if (!resolved.ok) {
        unresolved.push(resolved.ref);
        return;
      }
      if (!isObject(resolved.node)) return;
      const merged = effective(document, resolved.node, resolved.pointer, depth + 1);
      for (const [name, side] of merged.properties) properties.set(name, side);
      for (const name of merged.required) required.add(name);
      unresolved.push(...merged.unresolved);
      types ??= merged.types === undefined ? undefined : [...merged.types];
      format ??= merged.format;
      enumValues ??= merged.enumValues === undefined ? undefined : [...merged.enumValues];
      items ??= merged.items;
      if (merged.alternatives !== undefined) alternatives.push(merged.alternatives);
    });
  }
  if (isObject(schema.properties)) {
    for (const name of Object.keys(schema.properties)) {
      properties.set(name, {
        node: schema.properties[name],
        pointer: `${pointer}/properties/${escapePointer(name)}`,
      });
    }
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) if (typeof name === "string") required.add(name);
  }
  for (const keyword of ["oneOf", "anyOf"] as const) {
    if (schema[keyword] !== undefined) alternatives.push({ [keyword]: schema[keyword] });
  }
  return {
    types,
    format,
    enumValues,
    properties,
    required,
    items,
    alternatives: alternatives.length === 0 ? undefined : alternatives,
    unresolved,
  };
}

/**
 * A stable text for a value with its local references resolved (to a limited depth, cycles
 * cut), so two versions can be compared for equality. Key order does not matter.
 */
function canonical(
  document: OpenApiDocument,
  value: unknown,
  depth: number,
  seen: ReadonlySet<string>,
): string {
  if (depth > 12) return '"..."';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(document, item, depth + 1, seen)).join(",")}]`;
  }
  if (!isObject(value)) return value === undefined ? "null" : JSON.stringify(value);
  if (typeof value.$ref === "string") {
    const ref = value.$ref;
    if (seen.has(ref)) return JSON.stringify({ $ref: ref });
    const resolved = document.resolve(value, "");
    if (!resolved.ok) return JSON.stringify({ $ref: ref });
    return canonical(document, resolved.node, depth + 1, new Set(seen).add(ref));
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonical(document, value[key], depth + 1, seen)}`)
    .join(",")}}`;
}
