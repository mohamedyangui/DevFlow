import { describe, expect, it } from "vitest";
import {
  type ConsumerRepository,
  type ContractChange,
  ConsumerIndex,
  compareContractBuiltin,
  contractImpact,
  findConsumers,
  matchEndpoint,
  pathSegments,
  protoTarget,
  protocCamelCase,
  parseProto,
  scanFile,
} from "../src/index.js";
import {
  OPENAPI_BASE,
  OPENAPI_HEAD,
  PROTO_BASE,
  PROTO_HEAD,
  REPOSITORY,
  languageOf,
} from "./impact-fixture.js";

const repo: ConsumerRepository = {
  files: Object.entries(REPOSITORY).map(([path, text]) => ({
    path,
    language: languageOf(path),
    text,
  })),
  contracts: new Map([
    ["api/openapi.yaml", [OPENAPI_BASE, OPENAPI_HEAD]],
    ["proto/shop/v1/orders.proto", [PROTO_BASE, PROTO_HEAD]],
  ]),
};

const openApiChange = (method: string, path: string): ContractChange => ({
  kind: "openapi",
  rule: "operation-removed",
  compatibility: "breaking",
  decidedBy: "builtin-rules",
  location: { file: "api/openapi.yaml", path, method },
  message: `${method.toUpperCase()} ${path}: the operation was removed`,
});

const protoChange = (symbol: string, rule = "field-removed"): ContractChange => ({
  kind: "protobuf",
  rule,
  compatibility: "breaking",
  decidedBy: "builtin-rules",
  location: { file: "proto/shop/v1/orders.proto", symbol },
  message: `${symbol} changed`,
});

const summary = (refs: ReturnType<typeof findConsumers>) =>
  refs.map(
    (ref) =>
      `${ref.path}:${String(ref.line)} ${ref.kind}${ref.via === undefined ? "" : `(${ref.via})`} ${ref.confidence} ${ref.match}`,
  );

describe("findConsumers: OpenAPI", () => {
  it("finds the Spring handler, the client calls, the operation-id call and the tests across languages", () => {
    const refs = findConsumers(openApiChange("delete", "/orders/{id}"), repo);
    expect(summary(refs)).toEqual([
      "services/orders/src/main/java/com/shop/orders/OrderController.java:15 spring-mapping exact @DeleteMapping DELETE /api/orders/{}",
      "services/orders/src/test/java/com/shop/orders/OrderControllerTest.java:8 test(java-client-call) exact delete DELETE /api/orders/{}",
      "tools/sync/orders_client.py:9 python-client-call pattern delete DELETE <base>/api/orders/{}",
      "web/src/api/orders.ts:13 ts-client-call exact delete DELETE /api/orders/{}",
      "web/src/api/orders.ts:17 operation-id-call pattern .deleteOrder(...) (operationId deleteOrder)",
      "web/test/orders.test.ts:5 test(ts-client-call) pattern fetch DELETE /api/orders/42",
    ]);
  });

  it("does not take other methods, other paths, comments or generated code for consumers", () => {
    const refs = findConsumers(openApiChange("get", "/orders/{id}"), repo);
    expect(summary(refs)).toEqual([
      "services/orders/src/main/java/com/shop/orders/OrderController.java:12 spring-mapping exact @GetMapping GET /api/orders/{}",
      "services/orders/src/test/java/com/shop/orders/OrderControllerTest.java:13 test(java-client-call) pattern get GET /api/orders/o-1",
      "web/src/api/orders.ts:8 ts-client-call pattern fetch GET <base>/orders/{}",
    ]);
  });

  it("finds the consumers of every operation when the whole document changes", () => {
    const change: ContractChange = {
      ...openApiChange("get", "/x"),
      rule: "contract-removed",
      location: { file: "api/openapi.yaml" },
    };
    const paths = new Set(findConsumers(change, repo).map((ref) => ref.path));
    expect(paths).toContain("services/orders/src/main/java/com/shop/orders/OrderController.java");
    expect(paths).toContain("web/src/api/orders.ts");
  });

  it("uses the operation id of the base version for a removed operation", () => {
    const refs = findConsumers(openApiChange("delete", "/orders/{id}"), {
      ...repo,
      contracts: new Map([["api/openapi.yaml", [OPENAPI_HEAD]]]),
    });
    expect(refs.some((ref) => ref.kind === "operation-id-call")).toBe(false);
  });
});

describe("findConsumers: Protobuf", () => {
  it("finds imports of the generated code in Java, TypeScript and Python files that name the declaration", () => {
    const refs = findConsumers(protoChange("shop.v1.Order.total"), repo);
    expect(summary(refs)).toEqual([
      "services/orders/src/main/java/com/shop/orders/OrderGrpcService.java:3 generated-import exact import com.shop.orders.v1.OrderServiceGrpc;",
      "services/orders/src/main/java/com/shop/orders/OrderGrpcService.java:4 generated-import exact import com.shop.orders.v1.OrdersProto.Order;",
      "tools/sync/orders_client.py:3 generated-import exact from shop.v1 import orders_pb2, orders_pb2_grpc",
      'web/src/api/orders.ts:2 generated-import exact import "../gen/shop/v1/orders_pb"',
    ]);
  });

  it("lists every importer when the change concerns the whole file", () => {
    const refs = findConsumers(protoChange("shop.v2", "package-changed"), repo);
    expect(refs.map((ref) => ref.path)).toContain("tools/sync/customers.py");
  });

  it("matches services through their stubs", () => {
    const refs = findConsumers(protoChange("shop.v1.OrderService.GetOrder", "rpc-removed"), repo);
    expect(new Set(refs.map((ref) => ref.path))).toEqual(
      new Set([
        "services/orders/src/main/java/com/shop/orders/OrderGrpcService.java",
        "tools/sync/orders_client.py",
      ]),
    );
  });

  it("derives the generated Java names like protoc", () => {
    expect(protocCamelCase("order_service_v2")).toBe("OrderServiceV2");
    const target = protoTarget("a/order.proto", [
      parseProto(
        'syntax = "proto3";\npackage shop;\nmessage Order {}\noption java_multiple_files = true;',
      ),
    ]);
    expect(target.javaOuterClass).toBe("OrderOuterClass");
    expect(target.javaPackage).toBe("shop");
    expect(target.javaMultipleFiles).toBe(true);
    const java = scanFile(
      "src/A.java",
      "java",
      "import shop.Order;\nimport shop.*;\nclass A { Order o; }",
    );
    expect(java?.imports.map((ref) => [ref.specifier, ref.wildcard])).toEqual([
      ["shop.Order", false],
      ["shop", true],
    ]);
    const refs = findConsumers(
      {
        ...protoChange("shop.Order.id"),
        location: { file: "a/order.proto", symbol: "shop.Order.id" },
      },
      {
        files: [
          {
            path: "src/A.java",
            language: "java",
            text: "import shop.Order;\nimport shop.*;\nclass A { Order o; }",
          },
        ],
        contracts: new Map([
          [
            "a/order.proto",
            [
              'syntax = "proto3";\npackage shop;\nmessage Order {}\noption java_multiple_files = true;',
            ],
          ],
        ]),
      },
    );
    expect(refs.map((ref) => [ref.line, ref.confidence])).toEqual([
      [1, "exact"],
      [2, "pattern"],
    ]);
  });

  it("takes a bare TypeScript module name for a pattern only under a generated-looking directory", () => {
    const contracts = new Map([["proto/orders.proto", [PROTO_HEAD]]]);
    const change = {
      ...protoChange("shop.v1.Order.id"),
      location: { file: "proto/orders.proto", symbol: "shop.v1.Order.id" },
    };
    const refs = findConsumers(change, {
      contracts,
      files: [
        {
          path: "src/a.ts",
          language: "typescript",
          text: 'import { Order } from "./gen/orders";\n',
        },
        {
          path: "src/b.ts",
          language: "typescript",
          text: 'import { Order } from "./pages/orders";\n',
        },
      ],
    });
    expect(refs.map((ref) => [ref.path, ref.confidence])).toEqual([["src/a.ts", "pattern"]]);
  });
});

describe("heuristics", () => {
  it("normalizes paths: origins, queries and path variables", () => {
    expect(pathSegments("https://x.example/api/orders/{orderId}?expand=1")).toEqual([
      "api",
      "orders",
      "{}",
    ]);
    expect(pathSegments("/orders/{id:\\d+}/")).toEqual(["orders", "{}"]);
    expect(pathSegments("orders")).toBeUndefined();
  });

  it("reads Spring mappings with class prefixes, path and method attributes, Kotlin and arrays", () => {
    const java = scanFile(
      "A.java",
      "java",
      `@RequestMapping(value = {"/v1", "/v2"})
public class A {
  @RequestMapping(path = "/items/{id}", method = {RequestMethod.PUT, RequestMethod.PATCH}, produces = "/not/a/path")
  void a() {}
  @PostMapping
  void b() {}
}`,
    );
    expect(java?.mappings.map((m) => `${m.method ?? "*"} /${m.segments.join("/")}`)).toEqual([
      "put /v1/items/{}",
      "patch /v1/items/{}",
      "put /v2/items/{}",
      "patch /v2/items/{}",
      "post /v1",
      "post /v2",
    ]);
    const kotlin = scanFile(
      "A.kt",
      "kotlin",
      `@RestController
@RequestMapping("/orders")
class OrderController(private val s: S) {
  @GetMapping("/{id}")
  fun get(@PathVariable id: String) = s.get(id)
}`,
    );
    expect(
      kotlin?.mappings.map((m) => `${m.method ?? "*"} /${m.segments.join("/")} L${String(m.line)}`),
    ).toEqual(["get /orders/{} L4"]);
  });

  it("reads TypeScript calls: fetch options, axios config objects, generics, templates and concatenation", () => {
    const ts = scanFile(
      "a.ts",
      "typescript",
      `fetch("/orders", { method: "POST", body });
axios({ url: \`/orders/\${id}\`, method: "put" });
this.http.get<Order[]>(base + "/orders?page=" + page);
api.request({ url: "/orders" });
map.get("key");
fetch(url);
fetch(\`\${path}\`);`,
    );
    expect(
      ts?.calls.map(
        (c) =>
          `${c.via} ${c.method ?? "*"} ${c.leadingHole ? "<base>" : ""}/${c.segments.join("/")}`,
      ),
    ).toEqual([
      "fetch post /orders",
      "axios put /orders/{}",
      "get get <base>/orders",
      "request * /orders",
    ]);
  });

  it("reads Java client calls: RestTemplate, WebClient and MockMvc", () => {
    const java = scanFile(
      "B.java",
      "java",
      `rest.getForObject("/orders/{id}", Order.class, id);
rest.exchange("/orders/" + id, HttpMethod.DELETE, null, Void.class);
client.post().uri("/orders").retrieve();
mvc.perform(put("/orders/1"));
map.get("x");`,
    );
    expect(java?.calls.map((c) => `${c.via} ${c.method ?? "*"} /${c.segments.join("/")}`)).toEqual([
      "getForObject get /orders/{}",
      "exchange delete /orders/{}",
      "uri post /orders",
      "put put /orders/1",
    ]);
  });

  it("reads Python calls and imports, f-strings and parenthesized import lists", () => {
    const py = scanFile(
      "c.py",
      "python",
      `from shop.v1 import (
    orders_pb2,
    orders_pb2_grpc as grpc,
)
import shop.v1.orders_pb2 as pb
# requests.get("/orders/commented")
session.post(f"{BASE}/orders/{order['id']}/items", json=x)
requests.get("/orders", params={"a": 1})
def get(self, key): pass`,
    );
    expect(py?.imports.map((ref) => `${ref.specifier}@${String(ref.line)}`)).toEqual([
      "shop.v1@1",
      "shop.v1.orders_pb2@1",
      "shop.v1.orders_pb2_grpc@1",
      "shop.v1.orders_pb2@5",
    ]);
    expect(
      py?.calls.map(
        (c) =>
          `${c.method ?? "*"} ${c.leadingHole ? "<base>" : ""}/${c.segments.join("/")} L${String(c.line)}`,
      ),
    ).toEqual(["post <base>/orders/{}/items L7", "get /orders L8"]);
  });

  it("decides exact and pattern matches", () => {
    const call = (segments: string[], method?: string, leadingHole = false) => ({
      mechanism: "ts-client-call" as const,
      method,
      segments,
      leadingHole,
      via: "fetch",
      line: 1,
    });
    const target = { method: "get", segments: ["orders", "{}"] };
    const servers = [["api"]];
    expect(matchEndpoint(call(["orders", "{}"], "get"), target, servers, true)).toBe("exact");
    expect(matchEndpoint(call(["api", "orders", "{}"], "get"), target, servers, true)).toBe(
      "exact",
    );
    expect(matchEndpoint(call(["v9", "orders", "{}"], "get"), target, servers, true)).toBe(
      "pattern",
    );
    expect(matchEndpoint(call(["orders", "{}"]), target, servers, true)).toBe("pattern");
    expect(matchEndpoint(call(["orders", "{}"], "get", true), target, servers, true)).toBe(
      "pattern",
    );
    expect(matchEndpoint(call(["orders", "7"], "get"), target, servers, true)).toBe("pattern");
    expect(matchEndpoint(call(["orders", "7"], "get"), target, servers, false)).toBeUndefined();
    expect(matchEndpoint(call(["orders", "{}"], "post"), target, servers, true)).toBeUndefined();
    expect(matchEndpoint(call(["customers", "{}"], "get"), target, servers, true)).toBeUndefined();
    expect(matchEndpoint(call(["{}"], "get"), target, servers, true)).toBeUndefined();
  });
});

describe("contractImpact", () => {
  it("lists the consumers of every breaking change of real diffs, with a limit", () => {
    const diffs = [
      compareContractBuiltin({ file: "api/openapi.yaml", base: OPENAPI_BASE, head: OPENAPI_HEAD }),
      compareContractBuiltin({
        file: "proto/shop/v1/orders.proto",
        base: PROTO_BASE,
        head: PROTO_HEAD,
      }),
    ];
    const index = new ConsumerIndex(repo);
    const impact = contractImpact(diffs, index, [], 2);
    expect(
      impact.map((entry) => [entry.rule, entry.target, entry.consumers.length, entry.omitted]),
    ).toEqual([
      ["operation-removed", "DELETE /orders/{id}", 2, 4],
      ["field-removed", "shop.v1.Order (proto/shop/v1/orders.proto)", 2, 2],
    ]);
  });

  it("marks tests from the modules' test roots", () => {
    const refs = findConsumers(
      openApiChange("delete", "/orders/{id}"),
      {
        files: [
          {
            path: "qa/checks/delete.ts",
            language: "typescript",
            text: 'axios.delete("/orders/1");',
          },
        ],
      },
      [
        {
          moduleId: "qa",
          adapterId: "javascript",
          root: "qa",
          languages: [],
          frameworks: [],
          testFrameworks: [],
          qualityTools: [],
          sourceRoots: [],
          testRoots: ["qa/checks"],
          contracts: [],
        },
      ],
    );
    expect(refs.map((ref) => [ref.kind, ref.via])).toEqual([["test", "ts-client-call"]]);
  });
});
