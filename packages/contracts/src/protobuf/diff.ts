import type { ContractChange, ContractCompatibility } from "../schemas.js";
import type {
  ProtoEnum,
  ProtoField,
  ProtoFile,
  ProtoMessage,
  ProtoRange,
  ProtoReserved,
  ProtoService,
} from "./parse.js";

/**
 * The built-in Protobuf rules (ADR 0021), close to buf's `WIRE_JSON` category: a change is
 * `breaking` when generated code or serialized data of the base version can no longer be
 * read with the head version (wire format or JSON names). Types are compared by name,
 * resolved inside the file; names are compared relative to the package, so a package rename
 * is one change, not one per type.
 */

interface Indexed {
  readonly file: ProtoFile;
  readonly messages: ReadonlyMap<string, ProtoMessage>;
  readonly enums: ReadonlyMap<string, ProtoEnum>;
  readonly services: ReadonlyMap<string, ProtoService>;
  /** Package-relative names of the messages and enums of the file. */
  readonly types: ReadonlySet<string>;
}

function index(file: ProtoFile): Indexed {
  const messages = new Map<string, ProtoMessage>();
  const enums = new Map<string, ProtoEnum>();
  const visit = (message: ProtoMessage): void => {
    messages.set(message.path, message);
    for (const nested of message.enums) enums.set(nested.path, nested);
    for (const nested of message.messages) visit(nested);
  };
  for (const message of file.messages) visit(message);
  for (const item of file.enums) enums.set(item.path, item);
  return {
    file,
    messages,
    enums,
    services: new Map(file.services.map((service) => [service.name, service])),
    types: new Set([...messages.keys(), ...enums.keys()]),
  };
}

const SCALARS = new Set([
  "double",
  "float",
  "int32",
  "int64",
  "uint32",
  "uint64",
  "sint32",
  "sint64",
  "fixed32",
  "fixed64",
  "sfixed32",
  "sfixed64",
  "bool",
  "string",
  "bytes",
]);

/**
 * A type name as written, resolved to its package-relative name when it is declared in the
 * file (innermost scope first, as protoc does); scalar and imported types are kept as written,
 * without a leading dot.
 */
export function resolveType(type: string, scope: string, indexed: Indexed): string {
  const map = /^map<([^,]+),([^>]+)>$/.exec(type);
  if (map !== null) {
    return `map<${resolveType(map[1] ?? "", scope, indexed)},${resolveType(map[2] ?? "", scope, indexed)}>`;
  }
  if (SCALARS.has(type)) return type;
  const pkg = indexed.file.package;
  if (type.startsWith(".")) {
    const absolute = type.slice(1);
    if (pkg !== null && absolute.startsWith(`${pkg}.`)) {
      const relative = absolute.slice(pkg.length + 1);
      if (indexed.types.has(relative)) return relative;
    }
    return absolute;
  }
  const parts = scope === "" ? [] : scope.split(".");
  for (let i = parts.length; i >= 0; i--) {
    const candidate = [...parts.slice(0, i), type].join(".");
    if (indexed.types.has(candidate)) return candidate;
  }
  if (pkg !== null) {
    // A name qualified with (part of) the package, searched from the innermost package scope.
    const segments = pkg.split(".");
    for (let i = segments.length; i >= 0; i--) {
      const full = [...segments.slice(0, i), type].join(".");
      if (!full.startsWith(`${pkg}.`)) continue;
      const relative = full.slice(pkg.length + 1);
      if (indexed.types.has(relative)) return relative;
    }
  }
  return type;
}

function covers(ranges: readonly ProtoRange[], number: number): boolean {
  return ranges.some((range) => number >= range.from && number <= range.to);
}

/** Whether every number of `range` is in `ranges`. */
function coversRange(ranges: readonly ProtoRange[], range: ProtoRange): boolean {
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  let next = range.from;
  for (const candidate of sorted) {
    if (candidate.from > next) break;
    if (candidate.to >= next) next = candidate.to + 1;
    if (next > range.to) return true;
  }
  return next > range.to;
}

function cardinality(label: ProtoField["label"]): string {
  if (label === "repeated" || label === "map") return "repeated";
  if (label === "required") return "required";
  return "singular";
}

export class ProtobufComparison {
  readonly changes: ContractChange[] = [];
  readonly notes: string[] = [];
  private readonly base: Indexed;
  private readonly head: Indexed;
  private readonly file: string;

  constructor(base: ProtoFile, head: ProtoFile, file: string) {
    this.base = index(base);
    this.head = index(head);
    this.file = file;
  }

  run(): this {
    const before = this.base.file.package;
    const after = this.head.file.package;
    if (before !== after) {
      this.add(
        "package-changed",
        "breaking",
        `the package changed from ${before ?? "(none)"} to ${after ?? "(none)"}: every fully qualified name changes`,
        { side: "head", symbol: after ?? "(none)", line: 1 },
      );
    }
    this.compareMessages();
    this.compareEnums();
    this.compareServices();
    return this;
  }

  private symbol(side: "base" | "head", path: string): string {
    const pkg = (side === "base" ? this.base : this.head).file.package;
    return pkg === null ? path : `${pkg}.${path}`;
  }

  private add(
    rule: string,
    compatibility: ContractCompatibility,
    message: string,
    where: { side: "base" | "head"; symbol: string; line: number },
  ): void {
    this.changes.push({
      kind: "protobuf",
      rule,
      compatibility,
      decidedBy: "builtin-rules",
      location: { file: this.file, symbol: where.symbol, line: where.line },
      message,
    });
  }

  // ---- Messages -----------------------------------------------------------------------------

  private compareMessages(): void {
    for (const [path, message] of this.base.messages) {
      const next = this.head.messages.get(path);
      if (next === undefined) {
        if (this.parentRemoved(path, this.base.messages, this.head.messages)) continue;
        this.add(
          "message-removed",
          "breaking",
          `message ${this.symbol("base", path)} was removed`,
          { side: "base", symbol: this.symbol("base", path), line: message.line },
        );
        continue;
      }
      this.compareFields(message, next);
    }
    for (const [path, message] of this.head.messages) {
      if (this.base.messages.has(path)) continue;
      if (this.parentRemoved(path, this.head.messages, this.base.messages)) continue;
      this.add("message-added", "non-breaking", `message ${this.symbol("head", path)} was added`, {
        side: "head",
        symbol: this.symbol("head", path),
        line: message.line,
      });
    }
  }

  /** Whether an enclosing message is missing on the other side too (reported once, there). */
  private parentRemoved(
    path: string,
    present: ReadonlyMap<string, unknown>,
    other: ReadonlyMap<string, unknown>,
  ): boolean {
    const parts = path.split(".");
    for (let i = parts.length - 1; i > 0; i--) {
      const parent = parts.slice(0, i).join(".");
      if (present.has(parent) && !other.has(parent)) return true;
    }
    return false;
  }

  private compareFields(base: ProtoMessage, head: ProtoMessage): void {
    const byNumber = new Map(head.fields.map((field) => [field.number, field]));
    const byName = new Map(head.fields.map((field) => [field.name, field]));
    const baseNumbers = new Set(base.fields.map((field) => field.number));
    const baseNames = new Map(base.fields.map((field) => [field.name, field]));
    const symbolOf = (side: "base" | "head", field: ProtoField, message: ProtoMessage) =>
      this.symbol(side, `${message.path}.${field.name}`);

    for (const field of base.fields) {
      const next = byNumber.get(field.number);
      if (next === undefined) {
        const moved = byName.get(field.name);
        if (moved !== undefined && !baseNumbers.has(moved.number)) {
          this.add(
            "field-number-changed",
            "breaking",
            `field ${symbolOf("head", moved, head)} changed its number from ${String(field.number)} to ${String(moved.number)}`,
            { side: "head", symbol: symbolOf("head", moved, head), line: moved.line },
          );
          continue;
        }
        this.fieldRemoved(field, base, head.reserved);
        continue;
      }
      const at = { side: "head" as const, symbol: symbolOf("head", next, head), line: next.line };
      const beforeType = resolveType(field.type, base.path, this.base);
      const afterType = resolveType(next.type, head.path, this.head);
      if (next.name !== field.name) {
        this.add(
          "field-number-reused",
          "breaking",
          `field number ${String(field.number)} of ${this.symbol("head", head.path)} was "${field.name}" (${beforeType}) and is now "${next.name}" (${afterType})`,
          at,
        );
        continue;
      }
      if (beforeType !== afterType) {
        this.add(
          "field-type-changed",
          "breaking",
          `field ${at.symbol} changed its type from ${beforeType} to ${afterType}`,
          at,
        );
      }
      const was = cardinality(field.label);
      const now = cardinality(next.label);
      if (was !== now) {
        this.add(
          "field-cardinality-changed",
          "breaking",
          `field ${at.symbol} changed from ${was} to ${now}`,
          at,
        );
      } else if ((field.label === "optional") !== (next.label === "optional")) {
        this.add(
          "field-presence-changed",
          "unknown",
          `field ${at.symbol} ${next.label === "optional" ? "now has" : "no longer has"} explicit presence (optional); the wire format is the same, generated code changes`,
          at,
        );
      }
      if (field.oneof !== next.oneof) {
        this.add(
          "field-oneof-changed",
          "breaking",
          `field ${at.symbol} moved from ${field.oneof === null ? "no oneof" : `oneof ${field.oneof}`} to ${next.oneof === null ? "no oneof" : `oneof ${next.oneof}`}`,
          at,
        );
      }
    }

    for (const field of head.fields) {
      if (baseNumbers.has(field.number)) continue;
      const previous = baseNames.get(field.name);
      if (previous !== undefined && !byNumber.has(previous.number)) continue; // number changed
      const at = { side: "head" as const, symbol: symbolOf("head", field, head), line: field.line };
      if (covers(base.reserved.ranges, field.number)) {
        this.add(
          "reserved-number-reused",
          "breaking",
          `field ${at.symbol} uses number ${String(field.number)}, which was reserved`,
          at,
        );
      } else if (base.reserved.names.includes(field.name)) {
        this.add(
          "reserved-name-reused",
          "breaking",
          `field ${at.symbol} uses the name "${field.name}", which was reserved`,
          at,
        );
      } else if (field.label === "required") {
        this.add(
          "required-field-added",
          "breaking",
          `required field ${at.symbol} was added: data written without it can no longer be read`,
          at,
        );
      } else {
        this.add("field-added", "non-breaking", `field ${at.symbol} was added`, at);
      }
    }
    this.compareReserved(base.reserved, head.reserved, head.path, head.line, "message");
  }

  private fieldRemoved(field: ProtoField, base: ProtoMessage, reserved: ProtoReserved): void {
    const symbol = this.symbol("base", `${base.path}.${field.name}`);
    const numberReserved = covers(reserved.ranges, field.number);
    const nameReserved = reserved.names.includes(field.name);
    const at = { side: "base" as const, symbol, line: field.line };
    if (numberReserved && nameReserved) {
      this.add(
        "field-removed-reserved",
        "non-breaking",
        `field ${symbol} (${String(field.number)}) was removed, and its number and name are reserved`,
        at,
      );
      return;
    }
    const missing = [
      numberReserved ? undefined : `its number ${String(field.number)}`,
      nameReserved ? undefined : `its name "${field.name}"`,
    ]
      .filter((part) => part !== undefined)
      .join(" and ");
    this.add(
      "field-removed",
      "breaking",
      `field ${symbol} was removed without reserving ${missing}`,
      at,
    );
  }

  /** Reservations taken back: the numbers or names could then be reused with another meaning. */
  private compareReserved(
    base: ProtoReserved,
    head: ProtoReserved,
    path: string,
    line: number,
    what: "message" | "enum",
  ): void {
    const symbol = this.symbol("head", path);
    for (const range of base.ranges) {
      if (coversRange(head.ranges, range)) continue;
      const text =
        range.from === range.to
          ? String(range.from)
          : `${String(range.from)} to ${String(range.to)}`;
      this.add(
        "reserved-range-removed",
        "breaking",
        `${what} ${symbol} no longer reserves ${text}`,
        { side: "head", symbol, line },
      );
    }
    for (const name of base.names) {
      if (head.names.includes(name)) continue;
      this.add(
        "reserved-name-removed",
        "breaking",
        `${what} ${symbol} no longer reserves the name "${name}"`,
        { side: "head", symbol, line },
      );
    }
  }

  // ---- Enums --------------------------------------------------------------------------------

  private compareEnums(): void {
    for (const [path, item] of this.base.enums) {
      const next = this.head.enums.get(path);
      if (next === undefined) {
        if (this.parentRemoved(path, this.base.messages, this.head.messages)) continue;
        this.add("enum-removed", "breaking", `enum ${this.symbol("base", path)} was removed`, {
          side: "base",
          symbol: this.symbol("base", path),
          line: item.line,
        });
        continue;
      }
      this.compareValues(item, next);
    }
    for (const [path, item] of this.head.enums) {
      if (this.base.enums.has(path)) continue;
      if (this.parentRemoved(path, this.head.messages, this.base.messages)) continue;
      this.add("enum-added", "non-breaking", `enum ${this.symbol("head", path)} was added`, {
        side: "head",
        symbol: this.symbol("head", path),
        line: item.line,
      });
    }
  }

  private compareValues(base: ProtoEnum, head: ProtoEnum): void {
    const headNumbers = new Set(head.values.map((value) => value.number));
    const baseNumbers = new Set(base.values.map((value) => value.number));
    for (const value of base.values) {
      const symbol = this.symbol("base", `${base.path}.${value.name}`);
      if (!headNumbers.has(value.number)) {
        const numberReserved = covers(head.reserved.ranges, value.number);
        const nameReserved = head.reserved.names.includes(value.name);
        const at = { side: "base" as const, symbol, line: value.line };
        if (numberReserved && nameReserved) {
          this.add(
            "enum-value-removed-reserved",
            "non-breaking",
            `enum value ${symbol} (${String(value.number)}) was removed, and its number and name are reserved`,
            at,
          );
        } else {
          this.add(
            "enum-value-removed",
            "breaking",
            `enum value ${symbol} (${String(value.number)}) was removed`,
            at,
          );
        }
        continue;
      }
      const names = head.values.filter((other) => other.number === value.number);
      if (!names.some((other) => other.name === value.name)) {
        const renamed = names[0];
        this.add(
          "enum-value-renamed",
          "breaking",
          `enum value ${String(value.number)} of ${this.symbol("head", head.path)} was renamed from ${value.name} to ${renamed?.name ?? "?"}; JSON and text formats use the name`,
          {
            side: "head",
            symbol: this.symbol("head", `${head.path}.${renamed?.name ?? value.name}`),
            line: renamed?.line ?? head.line,
          },
        );
      }
    }
    for (const value of head.values) {
      if (baseNumbers.has(value.number)) continue;
      const symbol = this.symbol("head", `${head.path}.${value.name}`);
      const at = { side: "head" as const, symbol, line: value.line };
      if (covers(base.reserved.ranges, value.number)) {
        this.add(
          "reserved-number-reused",
          "breaking",
          `enum value ${symbol} uses number ${String(value.number)}, which was reserved`,
          at,
        );
      } else if (base.reserved.names.includes(value.name)) {
        this.add(
          "reserved-name-reused",
          "breaking",
          `enum value ${symbol} uses the name "${value.name}", which was reserved`,
          at,
        );
      } else {
        this.add("enum-value-added", "non-breaking", `enum value ${symbol} was added`, at);
      }
    }
    this.compareReserved(base.reserved, head.reserved, head.path, head.line, "enum");
  }

  // ---- Services -----------------------------------------------------------------------------

  private compareServices(): void {
    for (const [name, service] of this.base.services) {
      const next = this.head.services.get(name);
      const symbol = this.symbol("base", name);
      if (next === undefined) {
        this.add("service-removed", "breaking", `service ${symbol} was removed`, {
          side: "base",
          symbol,
          line: service.line,
        });
        continue;
      }
      const rpcs = new Map(next.rpcs.map((rpc) => [rpc.name, rpc]));
      for (const rpc of service.rpcs) {
        const after = rpcs.get(rpc.name);
        const rpcSymbol = this.symbol("head", `${name}.${rpc.name}`);
        if (after === undefined) {
          this.add(
            "rpc-removed",
            "breaking",
            `rpc ${this.symbol("base", `${name}.${rpc.name}`)} was removed`,
            {
              side: "base",
              symbol: this.symbol("base", `${name}.${rpc.name}`),
              line: rpc.line,
            },
          );
          continue;
        }
        const at = { side: "head" as const, symbol: rpcSymbol, line: after.line };
        for (const part of ["request", "response"] as const) {
          const before = resolveType(rpc[`${part}Type`], "", this.base);
          const now = resolveType(after[`${part}Type`], "", this.head);
          if (before !== now) {
            this.add(
              `rpc-${part}-type-changed`,
              "breaking",
              `rpc ${rpcSymbol} changed its ${part} type from ${before} to ${now}`,
              at,
            );
          }
          if (rpc[`${part}Stream`] !== after[`${part}Stream`]) {
            this.add(
              "rpc-streaming-changed",
              "breaking",
              `rpc ${rpcSymbol} ${after[`${part}Stream`] ? "now streams" : "no longer streams"} its ${part}`,
              at,
            );
          }
        }
      }
      const before = new Set(service.rpcs.map((rpc) => rpc.name));
      for (const rpc of next.rpcs) {
        if (before.has(rpc.name)) continue;
        const rpcSymbol = this.symbol("head", `${name}.${rpc.name}`);
        this.add("rpc-added", "non-breaking", `rpc ${rpcSymbol} was added`, {
          side: "head",
          symbol: rpcSymbol,
          line: rpc.line,
        });
      }
    }
    for (const [name, service] of this.head.services) {
      if (this.base.services.has(name)) continue;
      const symbol = this.symbol("head", name);
      this.add("service-added", "non-breaking", `service ${symbol} was added`, {
        side: "head",
        symbol,
        line: service.line,
      });
    }
  }
}
