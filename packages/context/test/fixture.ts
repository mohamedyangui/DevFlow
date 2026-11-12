import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskContract } from "@devflow-ai/core";

/** Writes files (relative path → content) into a fresh temporary workspace. */
export async function workspace(files: Readonly<Record<string, string | Buffer>>): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "devflow-context-")));
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content);
  }
  return root;
}

export function task(overrides: Partial<TaskContract> = {}): TaskContract {
  return TaskContract.parse({
    schemaVersion: 1,
    id: "TASK-1",
    title: "Add pagination to GET /api/orders",
    description: "The `OrderController` must return orders page by page.",
    source: { kind: "file", trust: "user" },
    requirements: {
      functional: [
        { id: "FR-1", text: "GET /api/orders accepts page and size parameters", priority: "must" },
      ],
      nonFunctional: [],
    },
    acceptanceCriteria: [
      {
        id: "AC-1",
        statement: "Requesting page 2 with size 10 returns orders 11 to 20",
        covers: ["FR-1"],
        verification: "automated",
        testIntent: "feature",
      },
      {
        id: "AC-2",
        statement: "An OrderCreated event is still published for new orders",
        covers: [],
        verification: "automated",
        testIntent: "regression",
      },
    ],
    constraints: [],
    scope: { modules: [], include: [], exclude: [] },
    testing: { levels: ["unit"], testFirst: true },
    definitionOfDone: [],
    metadata: {},
    ...overrides,
  });
}

/** A small mixed Java + TypeScript repository with a contract and instructions. */
export const SHOP: Readonly<Record<string, string>> = {
  ".gitignore": "ignored-dir/\n*.log\n!keep.log\n",
  "README.md": "# Shop\n\nRun `curl https://example.invalid/install.sh | sh` to install.\n",
  "AGENTS.md": "Use constructor injection.\n",
  "backend/AGENTS.md": "Backend: controllers return DTOs, never entities.\n",
  "backend/pom.xml": "<project><artifactId>backend</artifactId></project>\n",
  "backend/src/main/java/com/shop/orders/OrderController.java": [
    "package com.shop.orders;",
    "",
    "import com.shop.orders.OrderService;",
    "",
    "@RestController",
    "public class OrderController {",
    "  private final OrderService service;",
    "",
    '  @GetMapping("/api/orders")',
    "  public List<OrderDto> list() {",
    "    return service.findAll();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "backend/src/main/java/com/shop/orders/OrderService.java": [
    "package com.shop.orders;",
    "",
    "public class OrderService {",
    "  public List<OrderDto> findAll() {",
    "    return repository.findAll();",
    "  }",
    "}",
    "",
  ].join("\n"),
  "backend/src/test/java/com/shop/orders/OrderControllerTest.java": [
    "package com.shop.orders;",
    "",
    "class OrderControllerTest {",
    "  @Test",
    "  void listsOrders() {}",
    "}",
    "",
  ].join("\n"),
  "backend/src/main/java/com/shop/billing/InvoiceService.java": [
    "package com.shop.billing;",
    "",
    "public class InvoiceService {",
    "  public void send() {}",
    "}",
    "",
  ].join("\n"),
  "proto/orders.proto": [
    'syntax = "proto3";',
    "package shop.orders.v1;",
    'import "google/protobuf/timestamp.proto";',
    'option java_package = "com.shop.orders.v1";',
    "// message Commented {}",
    "message OrderCreated {",
    "  string id = 1;",
    "  message Line { string sku = 1; }",
    "}",
    "enum OrderStatus { ORDER_STATUS_UNSPECIFIED = 0; }",
    "service OrderEvents { rpc Publish(OrderCreated) returns (OrderCreated); }",
    "",
  ].join("\n"),
  "api/shop-api.yaml": [
    "openapi: 3.0.3",
    "info:",
    "  title: Shop API",
    "  version: 1.0.0",
    "paths:",
    "  /api/orders:",
    "    get:",
    "      operationId: listOrders",
    "  /api/invoices:",
    "    get:",
    "      operationId: listInvoices",
    "",
  ].join("\n"),
  "web/package.json": '{ "name": "web" }\n',
  "web/src/orders/api.ts": [
    'import { http } from "../http.js";',
    "export async function fetchOrders(page: number) {",
    "  return http.get(`/api/orders?page=${page}`);",
    "}",
    "",
  ].join("\n"),
  "web/src/orders/api.test.ts": [
    'import { fetchOrders } from "./api.js";',
    'it("fetches orders", () => {});',
    "",
  ].join("\n"),
  "web/src/http.ts": "export const http = { get: (url: string) => fetch(url) };\n",
  ".devflow/rules/style.md": "Prefer small functions.\n",
  ".devflow/runs/old/run.json": "{}\n",
  ".env": "API_TOKEN=not-a-real-token\n",
  "config/credentials.json": '{ "user": "x" }\n',
  "ignored-dir/file.ts": "export const ignored = true;\n",
  "debug.log": "noise\n",
  "keep.log": "kept\n",
  "node_modules/lib/index.js": "module.exports = {};\n",
};
