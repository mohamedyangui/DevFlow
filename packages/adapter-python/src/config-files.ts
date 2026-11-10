/**
 * Small, read-only readers for the configuration formats of Python projects: TOML
 * (`pyproject.toml`, `Pipfile`, `ruff.toml`, lockfiles) and INI (`setup.cfg`, `tox.ini`,
 * `.flake8`, `mypy.ini`). They only find tables, keys and string values; nothing is evaluated,
 * and a construct they do not understand is skipped rather than guessed.
 */

export interface ConfigEntry {
  /** The key as written (dotted keys keep their dots, quotes removed). */
  readonly key: string;
  /** The raw value text; a multi-line array or string is joined with newlines. */
  readonly value: string;
  /** 1-based line of the key. */
  readonly line: number;
}

export interface ConfigTable {
  /** Table name: `project`, `tool.pytest.ini_options`, `options.extras_require`; `` for the top. */
  readonly name: string;
  /** 1-based line of the header (0 for the implicit top-level table). */
  readonly line: number;
  readonly entries: readonly ConfigEntry[];
}

// ---- TOML -----------------------------------------------------------------------------------

/** Removes a `#` comment that is outside a string. */
function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

/** Bracket depth change of a value fragment, ignoring brackets inside strings. */
function bracketDelta(text: string): number {
  let depth = 0;
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[" || char === "{") {
      depth += 1;
    } else if (char === "]" || char === "}") {
      depth -= 1;
    }
  }
  return depth;
}

function cleanKey(key: string): string {
  return key
    .split(".")
    .map((part) =>
      part
        .trim()
        .replace(/^"(.*)"$/, "$1")
        .replace(/^'(.*)'$/, "$1"),
    )
    .join(".");
}

const TABLE_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/;
const KEY_VALUE =
  /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=\s*(.*)$/;

/** Reads the tables of a TOML document. Arrays of tables (`[[package]]`) appear once each. */
export function readToml(text: string): ConfigTable[] {
  const tables: { name: string; line: number; entries: ConfigEntry[] }[] = [
    { name: "", line: 0, entries: [] },
  ];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const line = stripTomlComment(raw);
    if (line.trim() === "") continue;
    const header = TABLE_HEADER.exec(line);
    if (header !== null) {
      tables.push({ name: cleanKey(header[1] ?? ""), line: index + 1, entries: [] });
      continue;
    }
    const pair = KEY_VALUE.exec(line);
    if (pair === null) continue;
    const key = cleanKey(pair[1] ?? "");
    let value = (pair[2] ?? "").trim();
    const start = index;
    const multiline = /^("""|''')/.exec(value)?.[1];
    if (multiline !== undefined && !value.includes(multiline, 3)) {
      while (index + 1 < lines.length) {
        index += 1;
        const next = lines[index] ?? "";
        value += `\n${next}`;
        if (next.includes(multiline)) break;
      }
    } else {
      let depth = bracketDelta(value);
      while (depth > 0 && index + 1 < lines.length) {
        index += 1;
        const next = stripTomlComment(lines[index] ?? "");
        value += `\n${next}`;
        depth += bracketDelta(next);
      }
    }
    tables.at(-1)?.entries.push({ key, value, line: start + 1 });
  }
  return tables;
}

/** Every string literal in a TOML value (basic strings with escapes, and literal strings). */
export function tomlStrings(value: string): string[] {
  const out: string[] = [];
  const pattern = /"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g;
  for (const match of value.matchAll(pattern)) {
    const basic = match[1];
    out.push(basic === undefined ? (match[2] ?? "") : basic.replace(/\\(.)/g, "$1"));
  }
  return out;
}

/** The value as a single string, when it is one. */
export function tomlString(value: string): string | undefined {
  const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\s*$/.exec(value);
  if (match === null) return undefined;
  return match[1] === undefined ? match[2] : match[1].replace(/\\(.)/g, "$1");
}

// ---- INI ------------------------------------------------------------------------------------

/**
 * Reads an INI file as `setup.cfg`, `tox.ini`, `.flake8` and `mypy.ini` use it: `[section]`
 * headers, `key = value` or `key: value`, and continuation lines indented below a key.
 */
export function readIni(text: string): ConfigTable[] {
  const tables: { name: string; line: number; entries: ConfigEntry[] }[] = [
    { name: "", line: 0, entries: [] },
  ];
  let last: { key: string; value: string; line: number } | undefined;
  const flush = () => {
    if (last !== undefined) tables.at(-1)?.entries.push({ ...last, value: last.value.trim() });
    last = undefined;
  };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (/^\s*[#;]/.test(raw) || raw.trim() === "") continue;
    const header = /^\[([^\]]+)\]\s*$/.exec(raw);
    if (header !== null) {
      flush();
      tables.push({ name: (header[1] ?? "").trim(), line: index + 1, entries: [] });
      continue;
    }
    if (/^\s/.test(raw) && last !== undefined) {
      last.value += `\n${raw.trim()}`;
      continue;
    }
    const pair = /^([^=:\s][^=:]*?)\s*[=:]\s*(.*)$/.exec(raw);
    if (pair === null) continue;
    flush();
    last = { key: (pair[1] ?? "").trim(), value: pair[2] ?? "", line: index + 1 };
  }
  flush();
  return tables;
}

// ---- Queries --------------------------------------------------------------------------------

/** The table with this exact name. */
export function table(tables: readonly ConfigTable[], name: string): ConfigTable | undefined {
  return tables.find((candidate) => candidate.name === name);
}

/**
 * Where a table, or a key that configures it, first appears: `[tool.ruff]`, `[tool.ruff.lint]`,
 * or a dotted key such as `ruff.line-length = 100` under `[tool]`. Undefined when absent.
 */
export function tableLine(tables: readonly ConfigTable[], name: string): number | undefined {
  for (const candidate of tables) {
    if (candidate.name === name || candidate.name.startsWith(`${name}.`)) return candidate.line;
    if (name.startsWith(candidate.name === "" ? "" : `${candidate.name}.`)) {
      const rest = candidate.name === "" ? name : name.slice(candidate.name.length + 1);
      const entry = candidate.entries.find((e) => e.key === rest || e.key.startsWith(`${rest}.`));
      if (entry !== undefined) return entry.line;
    }
  }
  return undefined;
}

/** A key of a table. */
export function entry(
  tables: readonly ConfigTable[],
  tableName: string,
  key: string,
): ConfigEntry | undefined {
  return table(tables, tableName)?.entries.find((candidate) => candidate.key === key);
}
