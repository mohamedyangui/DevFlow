import { isNode, type Document, type LineCounter } from "yaml";
import type { IssuePath } from "./issues.js";

/**
 * Returns the 1-based line of the deepest node that exists along `path`, or `undefined` when
 * not even the first segment exists.
 */
export function locateYamlPath(
  doc: Document,
  lineCounter: LineCounter,
  path: IssuePath,
  lineOffset = 0,
): number | undefined {
  for (let length = path.length; length > 0; length--) {
    const node: unknown = doc.getIn(path.slice(0, length), true);
    if (isNode(node) && node.range !== undefined && node.range !== null) {
      return lineCounter.linePos(node.range[0]).line + lineOffset;
    }
  }
  return undefined;
}

/**
 * First line of a YAML parser message, without the " at line N, column M:" suffix that the
 * parser adds when `prettyErrors` is on (the line is reported separately).
 */
export function yamlMessage(text: string): string {
  return (text.split("\n")[0] ?? text).replace(/ at line \d+, column \d+:?$/, "");
}
