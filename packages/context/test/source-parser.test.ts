import { rm } from "node:fs/promises";
import { PathGuard, SecretRedactor, type SourceFile, type SourceParser } from "@devflowai/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FallbackSourceParser,
  TreeSitterSourceParser,
  buildContext,
  grammarFor,
  importsOf,
  regexParse,
  renderOutline,
  resolveImports,
  suffixIndexOf,
} from "../src/index.js";
import { SHOP, task, workspace } from "./fixture.js";

/** The pinned tree-sitter grammars (ADR 0009), parsed for real. */
const parser = new TreeSitterSourceParser();

function file(path: string, language: string, lines: string[]): SourceFile {
  return { path, language, text: lines.join("\n") };
}

const symbols = async (source: SourceFile) =>
  (await parser.parse(source)).symbols.map(
    (s) => `${s.kind} ${s.name} L${String(s.line)} d${String(s.depth)}`,
  );

describe("TreeSitterSourceParser", () => {
  it("reads Java declarations, test methods and imports", async () => {
    const source = file("src/test/java/com/shop/OrderControllerTest.java", "java", [
      "package com.shop;",
      "import com.shop.orders.OrderService;",
      "import static org.junit.jupiter.api.Assertions.assertEquals;",
      "import java.util.*;",
      "@RestController",
      "public class OrderController {",
      "  OrderController(OrderService service) {}",
      '  @GetMapping("/api/orders")',
      "  public List<Order> list(@RequestParam int page) { return List.of(); }",
      "  @Test",
      "  void ac1_returnsSecondPage() {}",
      "  record Page(int number) {}",
      "  enum Status { OPEN }",
      "}",
      "interface Repo<T> { T find(long id); }",
    ]);
    const parsed = await parser.parse(source);
    expect(parsed).toMatchObject({ language: "java", parser: "tree-sitter", hasErrors: false });
    expect(parsed.symbols.map((s) => [s.kind, s.name, s.line, s.depth])).toEqual([
      ["class", "OrderController", 5, 0],
      ["constructor", "OrderController", 7, 1],
      ["method", "list", 8, 1],
      ["test", "ac1_returnsSecondPage", 10, 1],
      ["record", "Page", 12, 1],
      ["enum", "Status", 13, 1],
      ["interface", "Repo", 15, 0],
      ["method", "find", 15, 1],
    ]);
    expect(parsed.symbols[0]?.signature).toBe("@RestController public class OrderController");
    expect(parsed.symbols[2]?.signature).toBe(
      '@GetMapping("/api/orders") public List<Order> list(@RequestParam int page)',
    );
    expect(parsed.symbols[7]?.signature).toBe("T find(long id)");
    expect(parsed.imports).toEqual([
      { specifier: "com.shop.orders.OrderService", line: 2, kind: "module" },
      { specifier: "org.junit.jupiter.api.Assertions.assertEquals", line: 3, kind: "static" },
      { specifier: "java.util", line: 4, kind: "wildcard" },
    ]);
  });

  it("reads TypeScript declarations and every kind of import", async () => {
    const source = file("web/src/orders/service.ts", "typescript", [
      'import { http } from "../http.js";',
      'import type { Order } from "./order";',
      'export * from "./types";',
      "export interface Page<T> { items: T[] }",
      "export type Id = string;",
      "export enum Status { Open }",
      "export class OrderService {",
      "  constructor(private readonly repo: Repo) {}",
      "  async page(n: number): Promise<Page<Order>> { return this.repo.find(n); }",
      "}",
      "export const handler = async (req: Request) => http.get(req.url);",
      "export default function main() {}",
      'const lazy = await import("./lazy.js");',
    ]);
    const parsed = await parser.parse(source);
    expect(parsed.hasErrors).toBe(false);
    expect(await symbols(source)).toEqual([
      "interface Page L4 d0",
      "type Id L5 d0",
      "enum Status L6 d0",
      "class OrderService L7 d0",
      "constructor constructor L8 d1",
      "method page L9 d1",
      "function handler L11 d0",
      "function main L12 d0",
    ]);
    expect(parsed.symbols.find((s) => s.name === "handler")?.signature).toBe(
      "export const handler = async (req: Request) =>",
    );
    expect(parsed.symbols.find((s) => s.name === "page")?.signature).toBe(
      "async page(n: number): Promise<Page<Order>>",
    );
    expect(parsed.imports.map((i) => [i.specifier, i.kind, i.line])).toEqual([
      ["../http.js", "module", 1],
      ["./order", "module", 2],
      ["./types", "module", 3],
      ["./lazy.js", "dynamic", 13],
    ]);
  });

  it("parses TSX with the TSX grammar, and JSX with the JavaScript grammar", async () => {
    const tsx = file("web/src/App.tsx", "typescript", [
      'import { Button } from "./Button";',
      'export function App(): JSX.Element { return <Button label="x" />; }',
      "export const Card = ({ title }: { title: string }) => <div>{title}</div>;",
    ]);
    expect(grammarFor(tsx)).toBe("tsx");
    expect(grammarFor({ path: "a.ts", language: "typescript" })).toBe("typescript");
    expect(grammarFor({ path: "a.py", language: "python" })).toBeUndefined();
    const parsed = await parser.parse(tsx);
    expect(parsed.hasErrors).toBe(false);
    expect(await symbols(tsx)).toEqual(["function App L2 d0", "function Card L3 d0"]);

    const jsx = file("web/src/Card.jsx", "javascript", [
      "export const Card = ({ title }) => <div>{title}</div>;",
    ]);
    expect((await parser.parse(jsx)).hasErrors).toBe(false);
  });

  it("reads JavaScript requires and nested test titles", async () => {
    const source = file("test/runner.test.cjs", "javascript", [
      'const fs = require("node:fs");',
      'const util = require("./util.cjs");',
      'describe("runner", () => {',
      '  it("AC-1: starts", () => {});',
      "  it.skip(`AC-2: stops`, () => {});",
      "});",
      "module.exports = class Runner { start() {} };",
    ]);
    const parsed = await parser.parse(source);
    expect(await symbols(source)).toEqual([
      "test runner L3 d0",
      "test AC-1: starts L4 d1",
      "test AC-2: stops L5 d1",
      "method start L7 d0",
    ]);
    expect(parsed.symbols[1]?.signature).toBe('it("AC-1: starts"');
    expect(parsed.imports).toEqual([
      { specifier: "node:fs", line: 1, kind: "require" },
      { specifier: "./util.cjs", line: 2, kind: "require" },
    ]);
  });

  it("still returns symbols for invalid code, and slices non-ASCII text correctly", async () => {
    const broken = await parser.parse(
      file("Broken.java", "java", ["public class Broken {", "  void a( {", "  class Inner {}"]),
    );
    expect(broken.hasErrors).toBe(true);
    expect(broken.symbols.some((s) => s.name === "Broken")).toBe(true);

    const accents = await parser.parse(
      file("zoe.ts", "typescript", ["// é 😀 ü", "export class Zoë { méthode(): void {} }"]),
    );
    expect(accents.symbols.map((s) => s.signature)).toEqual([
      "export class Zoë",
      "méthode(): void",
    ]);
  });

  it("renders outlines with line numbers and indentation by depth", async () => {
    const parsed = await parser.parse(
      file(
        "backend/src/main/java/com/shop/orders/OrderController.java",
        "java",
        (SHOP["backend/src/main/java/com/shop/orders/OrderController.java"] ?? "").split("\n"),
      ),
    );
    expect(renderOutline(parsed).split("\n")).toEqual([
      "L5: @RestController public class OrderController",
      'L9:   @GetMapping("/api/orders") public List<OrderDto> list()',
    ]);
  });

  it("resolves its imports to the same files as the regex extraction", async () => {
    const files = new Set([
      "backend/src/main/java/com/shop/orders/OrderController.java",
      "backend/src/main/java/com/shop/orders/OrderService.java",
      "web/src/http.ts",
      "web/src/orders/api.ts",
    ]);
    const suffixes = suffixIndexOf([...files]);
    for (const [path, language] of [
      ["backend/src/main/java/com/shop/orders/OrderController.java", "java"],
      ["web/src/orders/api.ts", "typescript"],
    ] as const) {
      const text = SHOP[path] ?? "";
      const parsed = await parser.parse({ path, language, text });
      const resolved = resolveImports(path, language, parsed.imports, files, suffixes);
      expect(resolved.length).toBe(1);
      expect(resolved).toEqual(importsOf(path, language, text, files, suffixes));
    }
  });
});

describe("FallbackSourceParser", () => {
  it("uses the regex outline when a grammar cannot be loaded, and reports it once", async () => {
    const reasons: string[] = [];
    const missing = new TreeSitterSourceParser({
      resolveGrammar: () => {
        throw new Error("grammar not installed");
      },
    });
    const fallback = new FallbackSourceParser(missing, (reason) => reasons.push(reason));
    const source = file("A.java", "java", [
      "import com.shop.B;",
      "public class A {",
      "  void run() {",
      "  }",
      "}",
    ]);
    const first = await fallback.parse(source);
    await fallback.parse(source);
    expect(first).toEqual(regexParse(source));
    expect(first.parser).toBe("regex");
    expect(first.symbols.map((s) => [s.name, s.line, s.depth, s.signature])).toEqual([
      ["A", 2, 0, "public class A"],
      ["run", 3, 1, "void run()"],
    ]);
    expect(first.imports).toEqual([{ specifier: "com.shop.B", line: 1, kind: "module" }]);
    expect(reasons).toEqual(["java: grammar not installed"]);
  });
});

describe("buildContext with a source parser", () => {
  let root: string;
  let guard: PathGuard;

  beforeAll(async () => {
    root = await workspace(SHOP);
    guard = await PathGuard.create(root);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("parses only the languages the parser supports, and warns when it fails", async () => {
    const seen: string[] = [];
    const failing: SourceParser = {
      supports: (language) => language === "java" || language === "typescript",
      parse: (source) => {
        seen.push(source.path);
        return Promise.reject(new Error("broken grammar"));
      },
    };
    const pack = await buildContext({
      guard,
      task: task(),
      redactor: new SecretRedactor(),
      trusted: true,
      sourceParser: failing,
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((path) => /\.(java|ts)$/.test(path))).toBe(true);
    expect(pack.warnings.filter((w) => w.startsWith("the source parser failed"))).toEqual([
      "the source parser failed (java: broken grammar); regex outlines are used instead",
      "the source parser failed (typescript: broken grammar); regex outlines are used instead",
    ]);
  });

  it("puts tree-sitter outlines in the outline tier by default", async () => {
    const pack = await buildContext({
      guard,
      task: task(),
      redactor: new SecretRedactor(),
      trusted: true,
      budgetTokens: 250,
    });
    const outlined = pack.files.filter((f) => f.mode === "outline" && f.language === "java");
    expect(outlined.map((entry) => entry.content)).toContain(
      ["L3: class OrderControllerTest", "L4:   @Test void listsOrders()"].join("\n"),
    );
    expect(pack.warnings.some((w) => w.startsWith("the source parser failed"))).toBe(false);
  });
});
