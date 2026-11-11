/**
 * An in-house `.proto` parser for the built-in rules (ADR 0021): proto3, proto2 and editions
 * syntax, read for what compatibility needs (package, imports, messages with nested types,
 * fields with numbers, types and labels, oneofs, `reserved` numbers and names, enums with their
 * values, services and their rpcs). Simple file-level options (`option java_package = "...";`)
 * are kept for change impact (ADR 0022); other options are skipped. Nothing is compiled or
 * executed.
 */

export interface ProtoRange {
  readonly from: number;
  readonly to: number;
}

export interface ProtoReserved {
  readonly ranges: readonly ProtoRange[];
  readonly names: readonly string[];
}

export type ProtoLabel = "optional" | "required" | "repeated" | "map" | null;

export interface ProtoField {
  readonly name: string;
  readonly number: number;
  /** The type as written: `int32`, `Order.Item`, `.shop.v1.Money`, `map<string, int32>`. */
  readonly type: string;
  readonly label: ProtoLabel;
  /** The oneof the field belongs to, or null. */
  readonly oneof: string | null;
  readonly line: number;
}

export interface ProtoMessage {
  readonly name: string;
  /** The name inside the package: `Order`, `Order.Item`. */
  readonly path: string;
  readonly fields: readonly ProtoField[];
  readonly reserved: ProtoReserved;
  readonly messages: readonly ProtoMessage[];
  readonly enums: readonly ProtoEnum[];
  readonly line: number;
}

export interface ProtoEnumValue {
  readonly name: string;
  readonly number: number;
  readonly line: number;
}

export interface ProtoEnum {
  readonly name: string;
  readonly path: string;
  readonly values: readonly ProtoEnumValue[];
  readonly reserved: ProtoReserved;
  readonly line: number;
}

export interface ProtoRpc {
  readonly name: string;
  readonly requestType: string;
  readonly requestStream: boolean;
  readonly responseType: string;
  readonly responseStream: boolean;
  readonly line: number;
}

export interface ProtoService {
  readonly name: string;
  readonly rpcs: readonly ProtoRpc[];
  readonly line: number;
}

export interface ProtoFile {
  /** `proto2`, `proto3` (the default when absent is proto2), or `editions:<edition>`. */
  readonly syntax: string;
  readonly package: string | null;
  readonly imports: readonly string[];
  readonly messages: readonly ProtoMessage[];
  readonly enums: readonly ProtoEnum[];
  readonly services: readonly ProtoService[];
  /**
   * File-level options with a plain name and a string, identifier or number value, e.g.
   * `java_package`, `java_outer_classname`, `java_multiple_files` (values as written).
   */
  readonly options: Readonly<Record<string, string>>;
}

/** A `.proto` text the parser cannot read, with the line where it stopped. */
export class ProtoParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(`line ${String(line)}: ${message}`);
    this.name = "ProtoParseError";
    this.line = line;
  }
}

/** The largest field number, the value of `max` in a message's `reserved` range. */
export const MAX_FIELD_NUMBER = 536_870_911;
/** The largest enum value, the value of `max` in an enum's `reserved` range. */
export const MAX_ENUM_NUMBER = 2_147_483_647;

/** Inputs larger than this are refused: a contract file is far smaller. */
const MAX_SOURCE_LENGTH = 4 * 1024 * 1024;
const MAX_NESTING = 64;

type TokenKind = "ident" | "number" | "string" | "symbol";

interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly line: number;
}

/** Splits a `.proto` text into tokens; comments and whitespace are dropped. */
export function tokenize(source: string): Token[] {
  if (source.length > MAX_SOURCE_LENGTH) {
    throw new ProtoParseError("the file is too large to parse", 1);
  }
  const tokens: Token[] = [];
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const char = source.charAt(i);
    if (char === "\n") {
      line += 1;
      i += 1;
    } else if (/\s/.test(char)) {
      i += 1;
    } else if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
    } else if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) throw new ProtoParseError("unterminated comment", line);
      for (let j = i; j < end; j++) if (source[j] === "\n") line += 1;
      i = end + 2;
    } else if (char === '"' || char === "'") {
      const start = line;
      let j = i + 1;
      let text = "";
      while (j < source.length && source[j] !== char) {
        if (source[j] === "\n") throw new ProtoParseError("unterminated string", start);
        if (source[j] === "\\" && j + 1 < source.length) {
          text += source.charAt(j + 1);
          j += 2;
        } else {
          text += source.charAt(j);
          j += 1;
        }
      }
      if (j >= source.length) throw new ProtoParseError("unterminated string", start);
      tokens.push({ kind: "string", text, line: start });
      i = j + 1;
    } else if (/[A-Za-z_.]/.test(char)) {
      const match = /^\.?[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(
        source.slice(i, i + 4096),
      );
      if (match === null) {
        tokens.push({ kind: "symbol", text: char, line });
        i += 1;
      } else {
        tokens.push({ kind: "ident", text: match[0], line });
        i += match[0].length;
      }
    } else if (/[0-9]/.test(char) || (char === "-" && /[0-9]/.test(source[i + 1] ?? ""))) {
      const match = /^-?(?:0[xX][0-9A-Fa-f]+|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?)/.exec(
        source.slice(i, i + 256),
      );
      const text = match?.[0] ?? char;
      tokens.push({ kind: "number", text, line });
      i += text.length;
    } else {
      tokens.push({ kind: "symbol", text: char, line });
      i += 1;
    }
  }
  return tokens;
}

/** Parses a `.proto` file. @throws ProtoParseError when the text is not valid enough to read. */
export function parseProto(source: string): ProtoFile {
  return new Parser(tokenize(source)).file();
}

class Parser {
  private readonly tokens: readonly Token[];
  private index = 0;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens;
  }

  file(): ProtoFile {
    let syntax = "proto2";
    let pkg: string | null = null;
    const imports: string[] = [];
    const messages: ProtoMessage[] = [];
    const enums: ProtoEnum[] = [];
    const services: ProtoService[] = [];
    const options = new Map<string, string>();
    while (!this.done()) {
      const token = this.peek();
      if (this.accept(";")) continue;
      if (token.kind !== "ident") {
        throw new ProtoParseError(`unexpected "${token.text}"`, token.line);
      }
      switch (token.text) {
        case "syntax": {
          this.next();
          this.expect("=");
          syntax = this.string();
          this.expect(";");
          break;
        }
        case "edition": {
          this.next();
          this.expect("=");
          syntax = `editions:${this.string()}`;
          this.expect(";");
          break;
        }
        case "package": {
          this.next();
          pkg = this.ident();
          this.expect(";");
          break;
        }
        case "import": {
          this.next();
          if (this.peek().text === "public" || this.peek().text === "weak") this.next();
          imports.push(this.string());
          this.expect(";");
          break;
        }
        case "message":
          messages.push(this.message("", 0));
          break;
        case "enum":
          enums.push(this.enumeration(""));
          break;
        case "service":
          services.push(this.service());
          break;
        case "option": {
          const name = this.peekAt(1);
          const value = this.peekAt(3);
          if (
            name.kind === "ident" &&
            this.peekAt(2).kind === "symbol" &&
            this.peekAt(2).text === "=" &&
            value.kind !== "symbol" &&
            this.peekAt(4).kind === "symbol" &&
            this.peekAt(4).text === ";"
          ) {
            options.set(name.text, value.text);
          }
          this.skipStatement();
          break;
        }
        default:
          // option, extend, and anything else that does not change compatibility here.
          this.skipStatement();
      }
    }
    return {
      syntax,
      package: pkg,
      imports,
      messages,
      enums,
      services,
      options: Object.fromEntries(options),
    };
  }

  private message(parent: string, depth: number): ProtoMessage {
    const start = this.expectWord("message");
    if (depth > MAX_NESTING)
      throw new ProtoParseError("messages are nested too deeply", start.line);
    const name = this.ident();
    const path = parent === "" ? name : `${parent}.${name}`;
    this.expect("{");
    const body = this.messageBody(path, depth, null);
    return { name, path, ...body, line: start.line };
  }

  /** The inside of a message (or of a group or a oneof), up to and including its `}`. */
  private messageBody(
    path: string,
    depth: number,
    oneof: string | null,
  ): Omit<ProtoMessage, "name" | "path" | "line"> {
    const fields: ProtoField[] = [];
    const messages: ProtoMessage[] = [];
    const enums: ProtoEnum[] = [];
    const ranges: ProtoRange[] = [];
    const names: string[] = [];
    for (;;) {
      if (this.done()) throw new ProtoParseError(`"}" expected to close ${path}`, this.lastLine());
      if (this.accept("}")) break;
      if (this.accept(";")) continue;
      const token = this.peek();
      if (token.kind !== "ident")
        throw new ProtoParseError(`unexpected "${token.text}"`, token.line);
      if (token.text === "message" && oneof === null) {
        messages.push(this.message(path, depth + 1));
      } else if (token.text === "enum" && oneof === null) {
        enums.push(this.enumeration(path));
      } else if (token.text === "oneof" && oneof === null && this.peekAt(1).kind === "ident") {
        this.next();
        const group = this.ident();
        this.expect("{");
        const inner = this.messageBody(path, depth, group);
        fields.push(...inner.fields);
        messages.push(...inner.messages);
      } else if (token.text === "reserved") {
        this.next();
        this.reserved(ranges, names, MAX_FIELD_NUMBER);
      } else if (
        token.text === "option" ||
        token.text === "extensions" ||
        token.text === "extend"
      ) {
        this.skipStatement();
      } else {
        const field = this.field(path, depth, oneof);
        fields.push(field.field);
        if (field.group !== undefined) messages.push(field.group);
      }
    }
    return { fields, reserved: { ranges, names }, messages, enums };
  }

  private field(
    path: string,
    depth: number,
    oneof: string | null,
  ): { field: ProtoField; group?: ProtoMessage } {
    const start = this.peek();
    let label: ProtoLabel = null;
    if (
      ["optional", "required", "repeated"].includes(start.text) &&
      this.peekAt(1).kind === "ident"
    ) {
      label = start.text as "optional" | "required" | "repeated";
      this.next();
    }
    let type: string;
    if (this.peek().text === "map" && this.peekAt(1).text === "<") {
      this.next();
      this.expect("<");
      const key = this.ident();
      this.expect(",");
      const value = this.ident();
      this.expect(">");
      type = `map<${key},${value}>`;
      label = "map";
    } else {
      type = this.ident();
    }
    if (type === "group") {
      // proto2 group: `optional group Result = 1 { ... }` is a field and a nested message.
      const name = this.ident();
      this.expect("=");
      const number = this.integer();
      this.skipOptions();
      this.expect("{");
      const groupPath = `${path}.${name}`;
      const body = this.messageBody(groupPath, depth + 1, null);
      return {
        field: { name: name.toLowerCase(), number, type: name, label, oneof, line: start.line },
        group: { name, path: groupPath, ...body, line: start.line },
      };
    }
    const name = this.ident();
    this.expect("=");
    const number = this.integer();
    this.skipOptions();
    this.expect(";");
    return { field: { name, number, type, label, oneof, line: start.line } };
  }

  private enumeration(parent: string): ProtoEnum {
    const start = this.expectWord("enum");
    const name = this.ident();
    const path = parent === "" ? name : `${parent}.${name}`;
    this.expect("{");
    const values: ProtoEnumValue[] = [];
    const ranges: ProtoRange[] = [];
    const names: string[] = [];
    for (;;) {
      if (this.done()) throw new ProtoParseError(`"}" expected to close ${path}`, this.lastLine());
      if (this.accept("}")) break;
      if (this.accept(";")) continue;
      const token = this.peek();
      if (token.text === "option") {
        this.skipStatement();
      } else if (token.text === "reserved") {
        this.next();
        this.reserved(ranges, names, MAX_ENUM_NUMBER);
      } else {
        const value = this.ident();
        this.expect("=");
        const number = this.integer();
        this.skipOptions();
        this.expect(";");
        values.push({ name: value, number, line: token.line });
      }
    }
    return { name, path, values, reserved: { ranges, names }, line: start.line };
  }

  private service(): ProtoService {
    const start = this.expectWord("service");
    const name = this.ident();
    this.expect("{");
    const rpcs: ProtoRpc[] = [];
    for (;;) {
      if (this.done()) throw new ProtoParseError(`"}" expected to close ${name}`, this.lastLine());
      if (this.accept("}")) break;
      if (this.accept(";")) continue;
      const token = this.peek();
      if (token.text !== "rpc") {
        this.skipStatement();
        continue;
      }
      this.next();
      const rpc = this.ident();
      this.expect("(");
      const requestStream = this.streamKeyword();
      const requestType = this.ident();
      this.expect(")");
      this.expectWord("returns");
      this.expect("(");
      const responseStream = this.streamKeyword();
      const responseType = this.ident();
      this.expect(")");
      if (this.peek().text === "{") this.skipBlock();
      else this.expect(";");
      rpcs.push({
        name: rpc,
        requestType,
        requestStream,
        responseType,
        responseStream,
        line: token.line,
      });
    }
    return { name, rpcs, line: start.line };
  }

  private streamKeyword(): boolean {
    if (this.peek().text === "stream" && this.peekAt(1).kind === "ident") {
      this.next();
      return true;
    }
    return false;
  }

  /** `reserved 2, 9 to 11, 40 to max;` or `reserved "foo", "bar";` (or bare names, editions). */
  private reserved(ranges: ProtoRange[], names: string[], max: number): void {
    for (;;) {
      const token = this.next();
      if (token.kind === "string") {
        names.push(token.text);
      } else if (token.kind === "number") {
        const from = toInteger(token);
        let to = from;
        if (this.peek().text === "to") {
          this.next();
          const end = this.next();
          to = end.text === "max" ? max : toInteger(end);
        }
        ranges.push({ from, to });
      } else if (token.kind === "ident") {
        names.push(token.text);
      } else {
        throw new ProtoParseError(`unexpected "${token.text}" in reserved`, token.line);
      }
      if (this.accept(";")) return;
      this.expect(",");
    }
  }

  /** `[deprecated = true, (custom) = { ... }]` after a field or an enum value. */
  private skipOptions(): void {
    if (this.peek().text !== "[") return;
    let depth = 0;
    do {
      const token = this.next();
      if (token.kind !== "symbol") continue;
      if (token.text === "[" || token.text === "{") depth += 1;
      else if (token.text === "]" || token.text === "}") depth -= 1;
    } while (depth > 0);
  }

  /** Skips one statement: up to a `;` at depth 0, or a whole `{ ... }` block. */
  private skipStatement(): void {
    let depth = 0;
    for (;;) {
      const token = this.next();
      if (token.kind !== "symbol") continue;
      if (token.text === "{") depth += 1;
      else if (token.text === "}") {
        depth -= 1;
        if (depth === 0) {
          this.accept(";");
          return;
        }
        if (depth < 0) throw new ProtoParseError('unexpected "}"', token.line);
      } else if (token.text === ";" && depth === 0) {
        return;
      }
    }
  }

  private skipBlock(): void {
    this.expect("{");
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind !== "symbol") continue;
      if (token.text === "{") depth += 1;
      else if (token.text === "}") depth -= 1;
    }
    this.accept(";");
  }

  private ident(): string {
    const token = this.next();
    if (token.kind !== "ident") {
      throw new ProtoParseError(`a name was expected, not "${token.text}"`, token.line);
    }
    return token.text;
  }

  private string(): string {
    const token = this.next();
    if (token.kind !== "string") {
      throw new ProtoParseError(`a string was expected, not "${token.text}"`, token.line);
    }
    let text = token.text;
    while (this.peek().kind === "string") text += this.next().text;
    return text;
  }

  private integer(): number {
    return toInteger(this.next());
  }

  private expect(symbol: string): void {
    const token = this.next();
    if (token.text !== symbol || token.kind === "string") {
      throw new ProtoParseError(`"${symbol}" expected, not "${token.text}"`, token.line);
    }
  }

  private expectWord(word: string): Token {
    const token = this.next();
    if (token.kind !== "ident" || token.text !== word) {
      throw new ProtoParseError(`"${word}" expected, not "${token.text}"`, token.line);
    }
    return token;
  }

  private accept(symbol: string): boolean {
    const token = this.tokens[this.index];
    if (token?.kind !== "symbol" || token.text !== symbol) return false;
    this.index += 1;
    return true;
  }

  private done(): boolean {
    return this.index >= this.tokens.length;
  }

  private peek(): Token {
    return this.peekAt(0);
  }

  private peekAt(offset: number): Token {
    return (
      this.tokens[this.index + offset] ?? { kind: "symbol", text: "<end>", line: this.lastLine() }
    );
  }

  private next(): Token {
    const token = this.tokens[this.index];
    if (token === undefined) throw new ProtoParseError("unexpected end of file", this.lastLine());
    this.index += 1;
    return token;
  }

  private lastLine(): number {
    return this.tokens.at(-1)?.line ?? 1;
  }
}

function toInteger(token: Token): number {
  if (token.kind !== "number" || !/^-?(?:0[xX][0-9A-Fa-f]+|[0-9]+)$/.test(token.text)) {
    throw new ProtoParseError(`an integer was expected, not "${token.text}"`, token.line);
  }
  const negative = token.text.startsWith("-");
  const digits = negative ? token.text.slice(1) : token.text;
  const value = /^0[xX]/.test(digits)
    ? Number.parseInt(digits.slice(2), 16)
    : /^0[0-7]+$/.test(digits)
      ? Number.parseInt(digits, 8)
      : Number.parseInt(digits, 10);
  return negative ? -value : value;
}
