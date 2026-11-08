import { parseJsonOrUndefined } from "@devflow/core";

/**
 * Parses JSON with comments and trailing commas, as `tsconfig.json` allows. Comments and
 * commas inside strings are kept. Returns undefined when the text is not valid even then.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let index = 0;
  const length = text.length;
  while (index < length) {
    const char = text[index] ?? "";
    const next = text[index + 1] ?? "";
    if (char === '"') {
      let end = index + 1;
      while (end < length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) return undefined;
      index = end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return parseJsonOrUndefined(removeTrailingCommas(out.replace(/^\uFEFF/, "")));
}

function removeTrailingCommas(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === ",") {
      let ahead = index + 1;
      while (ahead < text.length && /\s/.test(text[ahead] ?? "")) ahead += 1;
      if (text[ahead] === "}" || text[ahead] === "]") {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}
