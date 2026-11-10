import { XMLParser } from "fast-xml-parser";

/**
 * A small, ordered XML element tree on top of fast-xml-parser, the same reader as the Java
 * adapter's (adapters depend only on core, so it is not shared). pytest's JUnit XML reports are
 * parsed with entity declarations refused: the format does not use them, and refusing them
 * rules out entity-expansion attacks from files in an untrusted repository. Truncated
 * documents are refused too.
 */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** The element's own text, concatenated and trimmed. */
  readonly text: string;
}

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
  commentPropName: false,
  cdataPropName: false,
});

/** Parses a document and returns its root element, or undefined when it is not usable XML. */
export function parseXml(text: string): XmlElement | undefined {
  if (/<!ENTITY/i.test(text)) return undefined;
  if (!isWellFormed(text)) return undefined;
  let nodes: unknown;
  try {
    nodes = parser.parse(text);
  } catch {
    return undefined;
  }
  const elements = Array.isArray(nodes) ? convert(nodes) : [];
  return elements[0];
}

const XML_NAME = /^[\p{L}_:][\p{L}\p{N}_.:·-]*$/u;

/** The index of the `>` that ends the tag starting before `from`, skipping quoted values. */
function tagEnd(text: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "<") {
      return -1;
    } else if (char === ">") {
      return index;
    }
  }
  return -1;
}

/** The index of the `>` that ends a `<!DOCTYPE`, including an internal subset in brackets. */
function doctypeEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
    } else if (char === ">" && depth <= 0) {
      return index;
    }
  }
  return -1;
}

/**
 * Structural well-formedness: properly nested and closed tags, exactly one root element, and
 * nothing but whitespace, comments and processing instructions around it. fast-xml-parser
 * accepts truncated documents silently, and a report cut off by a crashed or still-running
 * build must not be read as complete.
 */
export function isWellFormed(text: string): boolean {
  const stack: string[] = [];
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let rootSeen = false;
  while (index < text.length) {
    const open = text.indexOf("<", index);
    const between = open === -1 ? text.slice(index) : text.slice(index, open);
    if (stack.length === 0 && between.trim() !== "") return false;
    if (open === -1) break;
    if (text.startsWith("<!--", open)) {
      const end = text.indexOf("-->", open + 4);
      if (end === -1) return false;
      index = end + 3;
    } else if (text.startsWith("<![CDATA[", open)) {
      const end = text.indexOf("]]>", open + 9);
      if (stack.length === 0 || end === -1) return false;
      index = end + 3;
    } else if (text.startsWith("<?", open)) {
      const end = text.indexOf("?>", open + 2);
      if (end === -1) return false;
      index = end + 2;
    } else if (text.startsWith("<!DOCTYPE", open)) {
      const end = doctypeEnd(text, open + 9);
      if (rootSeen || end === -1) return false;
      index = end + 1;
    } else if (text.startsWith("<!", open)) {
      return false;
    } else {
      const end = tagEnd(text, open + 1);
      if (end === -1) return false;
      const body = text.slice(open + 1, end);
      if (body.startsWith("/")) {
        if (stack.pop() !== body.slice(1).trim()) return false;
      } else {
        const name = /^[^\s/>]+/.exec(body)?.[0];
        if (name === undefined || !XML_NAME.test(name)) return false;
        if (stack.length === 0) {
          if (rootSeen) return false;
          rootSeen = true;
        }
        if (!body.endsWith("/")) stack.push(name);
      }
      index = end + 1;
    }
  }
  return rootSeen && stack.length === 0;
}

function convert(nodes: readonly unknown[]): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of nodes) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    const name = Object.keys(record).find((key) => key !== ":@" && key !== "#text");
    if (name === undefined) continue;
    const body = record[name];
    const rawAttributes = record[":@"];
    const attributes: Record<string, string> = {};
    if (typeof rawAttributes === "object" && rawAttributes !== null) {
      for (const [key, value] of Object.entries(rawAttributes as Record<string, unknown>)) {
        if (typeof value === "string") attributes[key] = value;
        else if (typeof value === "number" || typeof value === "boolean")
          attributes[key] = String(value);
      }
    }
    const childNodes = Array.isArray(body) ? (body as unknown[]) : [];
    const text = childNodes
      .map((child) =>
        typeof child === "object" && child !== null && "#text" in child
          ? String((child as Record<string, unknown>)["#text"])
          : "",
      )
      .join("")
      .trim();
    out.push({ name, attributes, children: convert(childNodes), text });
  }
  return out;
}

/** The first direct child with this name. */
export function child(element: XmlElement | undefined, name: string): XmlElement | undefined {
  return element?.children.find((c) => c.name === name);
}

/** Every direct child with this name. */
export function children(element: XmlElement | undefined, name: string): XmlElement[] {
  return element === undefined ? [] : element.children.filter((c) => c.name === name);
}

/** The text of a direct child, or undefined when absent or empty. */
export function childText(element: XmlElement | undefined, name: string): string | undefined {
  const text = child(element, name)?.text;
  return text === undefined || text === "" ? undefined : text;
}

/** Follows a path of child names, e.g. `["build", "plugins", "plugin"]`, collecting every match. */
export function path(element: XmlElement | undefined, names: readonly string[]): XmlElement[] {
  let current: XmlElement[] = element === undefined ? [] : [element];
  for (const name of names) current = current.flatMap((c) => children(c, name));
  return current;
}

/** Every descendant (not the element itself) with this name, in document order. */
export function descendants(element: XmlElement | undefined, name: string): XmlElement[] {
  if (element === undefined) return [];
  const out: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const c of node.children) {
      if (c.name === name) out.push(c);
      visit(c);
    }
  };
  visit(element);
  return out;
}
