import { rm, symlink } from "node:fs/promises";
import path from "node:path";
import { PathGuard, ProjectConfig, SecretRedactor } from "@devflow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Bm25Index,
  WorkspaceRepository,
  buildContext,
  discoverFiles,
  importsOf,
  languageOf,
  looksLikeOpenApi,
  moduleOf,
  outlineOf,
  rankFiles,
  roleOf,
  scanOpenApi,
  scanProtobuf,
  suffixIndexOf,
  taskIdentifiers,
  taskQueryItems,
  tokenize,
  type ContextModule,
} from "../src/index.js";
import { SHOP, task, workspace } from "./fixture.js";

let root: string;
let guard: PathGuard;

beforeAll(async () => {
  root = await workspace(SHOP);
  guard = await PathGuard.create(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("discoverFiles", () => {
  it("honours ignore files and always-excluded directories, and skips sensitive files", async () => {
    const result = await discoverFiles(guard, { maxFileBytes: 1024 * 1024 });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain("backend/src/main/java/com/shop/orders/OrderController.java");
    expect(paths).toContain("keep.log");
    expect(paths).not.toContain("debug.log");
    expect(paths).not.toContain("ignored-dir/file.ts");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".devflow/runs/"))).toBe(false);
    expect(paths).toContain(".devflow/rules/style.md");
    expect(paths).not.toContain(".env");
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: ".env", reason: "sensitive" },
        { path: "config/credentials.json", reason: "sensitive" },
      ]),
    );
    expect(paths).toEqual([...paths].sort());
  });

  it("never walks Python virtual environments, tox environments or bytecode caches", async () => {
    const dir = await workspace({
      "shop/orders.py": "def total(): return 1\n",
      ".venv/Lib/site-packages/requests/api.py": "def get(): pass\n",
      ".tox/py312/lib/site.py": "x = 1\n",
      "shop/__pycache__/orders.py": "stale = True\n",
    });
    try {
      const result = await discoverFiles(await PathGuard.create(dir), { maxFileBytes: 1000 });
      expect(result.files.map((f) => f.path)).toEqual(["shop/orders.py"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports large and binary files, and applies include and exclude globs", async () => {
    const dir = await workspace({
      "a.ts": "x".repeat(2000),
      "b.ts": "export const b = 1;\n",
      "logo.png": Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      "docs/guide.md": "# Guide\n",
    });
    try {
      const local = await PathGuard.create(dir);
      const result = await discoverFiles(local, { maxFileBytes: 1000 });
      expect(result.files.map((f) => f.path)).toEqual(["b.ts", "docs/guide.md"]);
      expect(result.skipped).toEqual(
        expect.arrayContaining([
          { path: "a.ts", reason: "too-large" },
          { path: "logo.png", reason: "binary" },
        ]),
      );
      const filtered = await discoverFiles(local, {
        maxFileBytes: 1000,
        include: ["**/*.ts", "**/*.md"],
        exclude: ["docs/**"],
      });
      expect(filtered.files.map((f) => f.path)).toEqual(["b.ts"]);
      const limited = await discoverFiles(local, { maxFileBytes: 1000, maxFiles: 1 });
      expect(limited.truncated).toBe(true);
      expect(limited.files).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never follows symbolic links", async ({ skip }) => {
    const dir = await workspace({ "real/a.ts": "export {};\n" });
    try {
      try {
        await symlink(path.join(dir, "real"), path.join(dir, "linked"), "junction");
      } catch {
        skip("this system does not allow creating links");
      }
      const result = await discoverFiles(await PathGuard.create(dir), { maxFileBytes: 1000 });
      expect(result.files.map((f) => f.path)).toEqual(["real/a.ts"]);
      expect(result.skipped).toEqual([{ path: "linked", reason: "symlink" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("classification", () => {
  it.each([
    ["backend/src/main/java/a/Order.java", "source", "java"],
    ["backend/src/test/java/a/OrderTest.java", "test", "java"],
    ["web/src/a.spec.ts", "test", "typescript"],
    ["web/src/__tests__/a.ts", "test", "typescript"],
    ["proto/a.proto", "contract", "protobuf"],
    ["api/openapi.yaml", "contract", "yaml"],
    ["target/generated-sources/A.java", "generated", "java"],
    ["web/src/gen/a_pb.ts", "generated", "typescript"],
    ["pom.xml", "configuration", "xml"],
    ["web/tsconfig.build.json", "configuration", "json"],
    ["docs/guide.md", "documentation", "markdown"],
    ["AGENTS.md", "instructions", "markdown"],
    [".devflow/rules/a.md", "instructions", "markdown"],
    ["LICENSE", "other", null],
    ["src/shop/orders.py", "source", "python"],
    ["tests/test_orders.py", "test", "python"],
    ["shop/orders_test.py", "test", "python"],
    ["conftest.py", "test", "python"],
    ["pyproject.toml", "configuration", "toml"],
    ["setup.py", "configuration", "python"],
    ["requirements-dev.txt", "configuration", null],
    ["requirements/base.txt", "configuration", null],
    ["uv.lock", "generated", null],
    ["shop/orders_pb2.py", "generated", "python"],
  ])("%s is %s (%s)", (file, role, language) => {
    expect(roleOf(file)).toBe(role);
    expect(languageOf(file)).toBe(language);
  });

  it("maps a file to the module with the longest root", () => {
    const modules: ContextModule[] = [
      { id: "root", root: ".", adapter: "none", source: "default" },
      { id: "backend", root: "backend", adapter: "java", source: "config" },
      { id: "orders", root: "backend/orders", adapter: "java", source: "config" },
    ];
    expect(moduleOf("backend/orders/A.java", modules)).toBe("orders");
    expect(moduleOf("backend/B.java", modules)).toBe("backend");
    expect(moduleOf("backendx/C.java", modules)).toBe("root");
    expect(moduleOf("web/a.ts", modules.slice(1))).toBeNull();
  });
});

describe("contract discovery (ADR 0017)", () => {
  it("scans Protobuf declarations without comments or nested messages", () => {
    expect(scanProtobuf("proto/orders.proto", SHOP["proto/orders.proto"] ?? "")).toEqual({
      kind: "protobuf",
      path: "proto/orders.proto",
      syntax: "proto3",
      package: "shop.orders.v1",
      imports: ["google/protobuf/timestamp.proto"],
      javaPackage: "com.shop.orders.v1",
      javaOuterClassname: null,
      messages: ["OrderCreated"],
      enums: ["OrderStatus"],
      services: ["OrderEvents"],
    });
  });

  it("scans OpenAPI documents and recognizes them by content", () => {
    const text = SHOP["api/shop-api.yaml"] ?? "";
    expect(looksLikeOpenApi(text)).toBe(true);
    expect(looksLikeOpenApi('{\n  "openapi": "3.1.0"\n}')).toBe(true);
    expect(looksLikeOpenApi("name: not an api\n")).toBe(false);
    expect(scanOpenApi("api/shop-api.yaml", text)).toEqual({
      kind: "openapi",
      path: "api/shop-api.yaml",
      specVersion: "3.0.3",
      title: "Shop API",
      paths: ["/api/orders", "/api/invoices"],
      operationIds: ["listOrders", "listInvoices"],
    });
    expect(scanOpenApi("x.yaml", "a: [")).toBeNull();
    expect(scanOpenApi("x.yaml", "a: 1\n")).toBeNull();
  });
});

describe("outlines and imports", () => {
  it("lists declarations with line numbers", () => {
    const outline = outlineOf(
      "java",
      SHOP["backend/src/main/java/com/shop/orders/OrderController.java"] ?? "",
    );
    expect(outline.split("\n")).toEqual([
      "L5: @RestController",
      "L6: public class OrderController",
      'L9:   @GetMapping("/api/orders")',
      "L10:   public List<OrderDto> list()",
    ]);
    expect(outlineOf("typescript", SHOP["web/src/orders/api.ts"] ?? "")).toBe(
      "L2: export async function fetchOrders(page: number)",
    );
    expect(outlineOf(null, "anything")).toBe("");
  });

  it("resolves Java and relative TypeScript imports to repository files", () => {
    const files = new Set([
      "backend/src/main/java/com/shop/orders/OrderService.java",
      "web/src/http.ts",
      "web/src/orders/api.ts",
    ]);
    const suffixes = suffixIndexOf([...files]);
    expect(
      importsOf(
        "backend/X.java",
        "java",
        "import com.shop.orders.OrderService;\n",
        files,
        suffixes,
      ),
    ).toEqual(["backend/src/main/java/com/shop/orders/OrderService.java"]);
    expect(
      importsOf(
        "web/src/orders/api.ts",
        "typescript",
        SHOP["web/src/orders/api.ts"] ?? "",
        files,
        suffixes,
      ),
    ).toEqual(["web/src/http.ts"]);
  });
});

describe("ranking (ADR 0008)", () => {
  it("tokenizes identifiers and drops stopwords", () => {
    expect(tokenize("OrderController.findAll returns the orders_page")).toEqual([
      "order",
      "controller",
      "find",
      "return",
      "order",
      "page",
    ]);
    expect(tokenize("HTTPServer v2")).toEqual(["http", "server"]);
  });

  it("scores documents with BM25", () => {
    const index = new Bm25Index([
      { id: "a", tokens: ["order", "page", "order"] },
      { id: "b", tokens: ["invoice"] },
    ]);
    const result = index.search(["order", "missing"]);
    expect([...result.keys()]).toEqual(["a"]);
    expect(result.get("a")?.terms).toEqual(["order"]);
  });

  it("extracts identifiers, paths and routes from the task", () => {
    const identifiers = taskIdentifiers(taskQueryItems(task()));
    expect(identifiers).toEqual(
      expect.arrayContaining([
        { value: "OrderController", source: "description", kind: "identifier" },
        { value: "/api/orders", source: "title", kind: "route" },
        { value: "OrderCreated", source: "AC-2", kind: "identifier" },
      ]),
    );
  });

  it("ranks the files the task is about first, with reasons", async () => {
    const pack = await buildContext({
      guard,
      task: task(),
      redactor: new SecretRedactor(),
      trusted: true,
    });
    const order = pack.files.filter((file) => file.mode !== "listed").map((file) => file.path);
    expect(order[0]).toBe("backend/src/main/java/com/shop/orders/OrderController.java");
    expect(order.indexOf("backend/src/main/java/com/shop/billing/InvoiceService.java")).toBe(-1);
    const controller = pack.files[0];
    expect(controller?.reasons).toEqual(
      expect.arrayContaining([
        "file name matches `OrderController` from description",
        expect.stringMatching(/^matched .*`order`/),
      ]),
    );
    const test = pack.files.find(
      (file) => file.path === "backend/src/test/java/com/shop/orders/OrderControllerTest.java",
    );
    expect(test?.reasons).toContain(
      "test of `backend/src/main/java/com/shop/orders/OrderController.java`",
    );
    const proto = pack.files.find((file) => file.path === "proto/orders.proto");
    expect(proto?.reasons).toContain("defines message `OrderCreated` mentioned in AC-2");
    const api = pack.files.find((file) => file.path === "api/shop-api.yaml");
    expect(api?.reasons).toEqual(
      expect.arrayContaining(["defines path `/api/orders` mentioned in title"]),
    );
  });

  it("applies the task scope", () => {
    const candidates = [
      {
        path: "a/Order.java",
        role: "source" as const,
        language: "java",
        module: "a",
        text: "order",
        outline: "",
      },
      {
        path: "b/Order.java",
        role: "source" as const,
        language: "java",
        module: "b",
        text: "order",
        outline: "",
      },
    ];
    const scoped = rankFiles(candidates, {
      task: task({ scope: { modules: [], include: ["b/**"], exclude: [] } }),
      contracts: [],
    });
    expect(scoped[0]?.path).toBe("b/Order.java");
    expect(scoped[0]?.reasons).toContain("in the task scope (`b/**`)");
    const excluded = rankFiles(candidates, {
      task: task({ scope: { modules: [], include: [], exclude: ["a/**"] } }),
      contracts: [],
    });
    expect(excluded.map((file) => file.path)).toEqual(["b/Order.java"]);
  });
});

describe("buildContext", () => {
  it("packs files to the budget, never includes sensitive files, and is deterministic", async () => {
    const options = { guard, task: task(), redactor: new SecretRedactor(), trusted: true };
    const pack = await buildContext(options);
    expect(pack.usedTokens).toBeLessThanOrEqual(pack.budgetTokens);
    expect(pack.files.map((file) => file.path)).not.toContain(".env");
    expect(pack.files.map((file) => file.path)).not.toContain("config/credentials.json");
    expect(pack.stats.skipped.sensitive).toBe(2);
    expect(pack.modules).toEqual([{ id: "root", root: ".", adapter: "none", source: "default" }]);
    expect(pack.contracts.map((contract) => contract.path).sort()).toEqual([
      "api/shop-api.yaml",
      "proto/orders.proto",
    ]);
    expect(JSON.stringify(await buildContext(options))).toBe(JSON.stringify(pack));

    const small = await buildContext({ ...options, budgetTokens: 400 });
    expect(small.usedTokens).toBeLessThanOrEqual(400);
    expect(small.files.some((file) => file.mode === "full")).toBe(true);
  });

  it("lists generated files such as lockfiles, never includes their content", async () => {
    const root = await workspace({
      "package.json": '{ "name": "shop", "type": "module" }\n',
      "src/orders.js": "export function listOrders(page, size) { return []; }\n",
      "pnpm-lock.yaml": `lockfileVersion: '9.0'\n${"  page-size-orders: 1.0.0 optional\n".repeat(400)}`,
    });
    const pack = await buildContext({
      guard: await PathGuard.create(root),
      task: task(),
      redactor: new SecretRedactor(),
      trusted: true,
    });
    const lock = pack.files.find((file) => file.path === "pnpm-lock.yaml");
    expect(lock).toMatchObject({ mode: "listed", role: "generated", tokens: 0 });
    expect(lock).not.toHaveProperty("content");
    expect(pack.files.find((file) => file.path === "src/orders.js")?.mode).toBe("full");
  });

  it("loads instructions in precedence order, nearest AGENTS.md first", async () => {
    const pack = await buildContext({
      guard,
      task: task(),
      redactor: new SecretRedactor(),
      trusted: false,
    });
    expect(pack.instructions.map((i) => [i.path, i.rank, i.trust])).toEqual([
      [".devflow/rules/style.md", 4, "repository"],
      ["backend/AGENTS.md", 5, "repository"],
      ["AGENTS.md", 5, "repository"],
      ["README.md", 7, "repository"],
    ]);
    expect(pack.warnings).toContain(
      "the workspace is not trusted: project rules are included as repository content only",
    );
    const trusted = await buildContext({
      guard,
      task: task(),
      redactor: new SecretRedactor(),
      trusted: true,
    });
    expect(trusted.instructions[0]?.trust).toBe("trusted-config");
  });

  it("redacts secrets in packed content", async () => {
    const token = ["gh", "p_", "A".repeat(30), "b1c2d3"].join("");
    const dir = await workspace({ "src/Order.java": `class Order { String t = "${token}"; }\n` });
    try {
      const pack = await buildContext({
        guard: await PathGuard.create(dir),
        task: task(),
        redactor: new SecretRedactor(),
        trusted: false,
      });
      const file = pack.files.find((f) => f.path === "src/Order.java");
      expect(file?.mode).toBe("full");
      expect(file?.content).not.toContain(token);
      expect(file?.content).toContain("«REDACTED:github-token:");
      expect(file?.redactions).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses declared modules and lists the rest of the relevant modules", async () => {
    const config = ProjectConfig.parse({
      version: 1,
      modules: [
        { id: "backend", path: "backend", adapter: "java" },
        { id: "web", path: "web", adapter: "javascript" },
        { id: "ghost", path: "ghost", adapter: "java" },
      ],
      context: { exclude: ["api/**"] },
    });
    const pack = await buildContext({
      guard,
      task: task(),
      redactor: new SecretRedactor(),
      trusted: true,
      config,
    });
    expect(pack.modules.map((m) => m.id)).toEqual(["backend", "web", "ghost"]);
    expect(pack.warnings).toContain("module ghost: ghost does not exist");
    expect(pack.files.map((file) => file.path)).not.toContain("api/shop-api.yaml");
    const invoice = pack.files.find(
      (file) => file.path === "backend/src/main/java/com/shop/billing/InvoiceService.java",
    );
    expect(invoice).toMatchObject({
      mode: "listed",
      module: "backend",
      reasons: ["in module backend"],
    });
  });
});

describe("WorkspaceRepository", () => {
  it("reads, lists and globs through the path guard, hiding sensitive files", async () => {
    const repo = new WorkspaceRepository(guard, { maxFileBytes: 1024 * 1024 });
    expect(await repo.exists("backend/pom.xml")).toBe(true);
    expect(await repo.exists(".env")).toBe(false);
    expect(await repo.exists("../outside")).toBe(false);
    expect(await repo.readText("web/package.json")).toContain('"web"');
    await expect(repo.readText(".env")).rejects.toMatchObject({
      code: "REPOSITORY_FILE_UNREADABLE",
      details: { reason: "sensitive" },
    });
    const top = (await repo.list(".")).map((entry) => entry.path);
    expect(top).toContain("backend");
    expect(top).not.toContain(".env");
    expect(top).not.toContain("node_modules");
    const pom = (await repo.list("backend")).find((entry) => entry.path === "backend/pom.xml");
    expect(pom).toMatchObject({ kind: "file", sizeBytes: expect.any(Number) as unknown });
    expect(Math.abs((pom?.modifiedMs ?? 0) - Date.now())).toBeLessThan(24 * 3600 * 1000);
    expect(await repo.glob(["**/*.java"], { cwd: "backend" })).toEqual([
      "backend/src/main/java/com/shop/billing/InvoiceService.java",
      "backend/src/main/java/com/shop/orders/OrderController.java",
      "backend/src/main/java/com/shop/orders/OrderService.java",
      "backend/src/test/java/com/shop/orders/OrderControllerTest.java",
    ]);
  });
});
