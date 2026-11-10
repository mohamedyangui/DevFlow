import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContractDiff,
  MAX_FIELD_NUMBER,
  ProtoParseError,
  compareContractBuiltin,
  parseProto,
} from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/protobuf/${name}`, import.meta.url), "utf8");

function diff(base: string | null, head: string | null): ContractDiff {
  const result = compareContractBuiltin({ file: "proto/shop.proto", base, head });
  expect(result.kind).toBe("protobuf");
  expect(ContractDiff.safeParse(result).success).toBe(true);
  return result;
}

function rules(result: ContractDiff): string[] {
  return result.changes.map((change) => `${change.compatibility} ${change.rule}`);
}

/** A proto3 file with the given body after the package line. */
const proto = (body: string, pkg = "shop.v1") => `syntax = "proto3";\npackage ${pkg};\n${body}\n`;

describe("Protobuf parser", () => {
  it("reads the fixture: package, imports, nested types, fields, reservations, services", () => {
    const file = parseProto(fixture("orders.base.proto"));
    expect(file.syntax).toBe("proto3");
    expect(file.package).toBe("shop.v1");
    expect(file.imports).toEqual(["google/protobuf/timestamp.proto"]);
    expect(file.messages.map((message) => message.name)).toEqual([
      "Order",
      "Refund",
      "GetOrderRequest",
      "ListOrdersRequest",
    ]);
    const order = file.messages[0];
    expect(order?.reserved).toEqual({
      ranges: [
        { from: 4, to: 4 },
        { from: 20, to: 29 },
      ],
      names: ["legacy_total"],
    });
    expect(order?.messages.map((message) => message.path)).toEqual(["Order.Item"]);
    expect(order?.enums.map((item) => item.path)).toEqual(["Order.Status"]);
    expect(order?.fields.find((field) => field.name === "labels")).toMatchObject({
      type: "map<string,string>",
      label: "map",
      number: 8,
    });
    expect(order?.fields.find((field) => field.name === "voucher")).toMatchObject({
      oneof: "payment",
      number: 10,
    });
    expect(order?.fields.find((field) => field.name === "coupon")?.label).toBe("optional");
    expect(order?.fields.find((field) => field.name === "items")).toMatchObject({
      label: "repeated",
      type: "Item",
      line: 18,
    });
    expect(file.enums[0]?.values.map((value) => value.name)).toEqual([
      "CHANNEL_UNSPECIFIED",
      "CHANNEL_WEB",
      "CHANNEL_STORE",
    ]);
    expect(file.services[0]?.rpcs).toEqual([
      expect.objectContaining({
        name: "GetOrder",
        requestType: "GetOrderRequest",
        responseType: "Order",
      }),
      expect.objectContaining({ name: "ListOrders", responseStream: true, requestStream: false }),
      expect.objectContaining({ name: "CancelOrder" }),
    ]);
  });

  it("tolerates proto2: required, groups, extensions, extend, defaults", () => {
    const file = parseProto(`
      syntax = "proto2";
      package legacy;
      message Search {
        required string query = 1 [default = "*"];
        optional group Result = 2 {
          optional string url = 3;
        }
        extensions 100 to max;
        reserved 10 to max;
      }
      extend Search { optional int32 weight = 100; }
    `);
    expect(file.syntax).toBe("proto2");
    const search = file.messages[0];
    expect(search?.fields).toEqual([
      expect.objectContaining({ name: "query", label: "required", number: 1 }),
      expect.objectContaining({ name: "result", type: "Result", number: 2 }),
    ]);
    expect(search?.messages[0]?.fields[0]?.name).toBe("url");
    expect(search?.reserved.ranges).toEqual([{ from: 10, to: MAX_FIELD_NUMBER }]);
  });

  it("defaults to proto2 without a syntax line, and reads editions", () => {
    expect(parseProto("message A {}").syntax).toBe("proto2");
    expect(parseProto('edition = "2023";\nmessage A { reserved foo; }').syntax).toBe(
      "editions:2023",
    );
  });

  it("skips options, aggregate values, comments and strings with braces", () => {
    const file = parseProto(`
      syntax = 'proto3'; // trailing
      option (my.option) = { a: 1 b: { c: "}" } };
      /* message Hidden {} */
      message A {
        option (x).y = true;
        string s = 1 [(validate.rules).string = { min_len: 1 }, json_name = "S"];
        int32 n = 0x2;
        enum E { option allow_alias = true; E0 = 0; E1 = 1; E_ALIAS = 1; NEG = -1; }
      }
      service S { option (svc) = "v"; rpc M (stream A) returns (A) {} }
    `);
    expect(file.messages.map((message) => message.name)).toEqual(["A"]);
    expect(file.messages[0]?.fields.map((field) => [field.name, field.number])).toEqual([
      ["s", 1],
      ["n", 2],
    ]);
    expect(file.messages[0]?.enums[0]?.values.map((value) => value.number)).toEqual([0, 1, 1, -1]);
    expect(file.services[0]?.rpcs[0]).toMatchObject({ requestStream: true, responseStream: false });
  });

  it("reports where it stopped", () => {
    expect(() => parseProto("message A {\n  string s = ;\n}")).toThrow(ProtoParseError);
    expect(() => parseProto("message A {\n  string s = ;\n}")).toThrow(/^line 2:/);
    expect(() => parseProto("message A {")).toThrow(/"}" expected/);
    expect(() => parseProto('import "a.proto')).toThrow(/unterminated string/);
    expect(() => parseProto("/* open")).toThrow(/unterminated comment/);
    expect(() => parseProto("}")).toThrow(/unexpected/);
  });
});

describe("Protobuf built-in rules: the orders fixture", () => {
  const result = diff(fixture("orders.base.proto"), fixture("orders.head.proto"));
  const at = (rule: string) =>
    result.changes
      .filter((change) => change.rule === rule)
      .map((change) => `${change.compatibility} ${change.location.symbol ?? ""}`);

  it("finds every change, decided by the built-in rules", () => {
    expect(result.decidedBy).toBe("builtin-rules");
    expect(at("field-removed")).toEqual(["breaking shop.v1.Order.note"]);
    expect(at("field-removed-reserved")).toEqual(["non-breaking shop.v1.Order.total_cents"]);
    expect(at("field-type-changed")).toEqual([
      "breaking shop.v1.Order.labels",
      "breaking shop.v1.Order.Item.quantity",
    ]);
    expect(at("field-oneof-changed")).toEqual(["breaking shop.v1.Order.voucher"]);
    expect(at("field-presence-changed")).toEqual(["unknown shop.v1.Order.coupon"]);
    expect(at("field-number-reused")).toEqual(["breaking shop.v1.Order.buyer"]);
    expect(at("field-added")).toEqual(["non-breaking shop.v1.Order.currency"]);
    expect(at("reserved-number-reused")).toEqual(["breaking shop.v1.Order.region_code"]);
    expect(at("reserved-name-removed")).toEqual(["breaking shop.v1.Order"]);
    expect(at("message-removed")).toEqual(["breaking shop.v1.Refund"]);
    expect(at("message-added")).toEqual([
      "non-breaking shop.v1.OrderView",
      "non-breaking shop.v1.Address",
    ]);
    expect(at("enum-value-renamed")).toEqual(["breaking shop.v1.Order.Status.STATUS_SETTLED"]);
    expect(at("enum-value-removed")).toEqual(["breaking shop.v1.Order.Status.STATUS_SHIPPED"]);
    expect(at("enum-value-added")).toEqual(["non-breaking shop.v1.Order.Status.STATUS_CANCELLED"]);
    expect(at("enum-value-removed-reserved")).toEqual([
      "non-breaking shop.v1.Channel.CHANNEL_STORE",
    ]);
    expect(at("enum-added")).toEqual(["non-breaking shop.v1.Region"]);
    expect(at("rpc-response-type-changed")).toEqual(["breaking shop.v1.OrderService.GetOrder"]);
    expect(at("rpc-streaming-changed")).toEqual(["breaking shop.v1.OrderService.ListOrders"]);
    expect(at("rpc-removed")).toEqual(["breaking shop.v1.OrderService.CancelOrder"]);
    expect(at("rpc-added")).toEqual(["non-breaking shop.v1.OrderService.Ping"]);
    expect(at("service-removed")).toEqual(["breaking shop.v1.RefundService"]);
    expect(at("service-added")).toEqual(["non-breaking shop.v1.AdminService"]);
    expect(result.changes).toHaveLength(24);
  });

  it("does not report a type written differently but resolving to the same name", () => {
    // created_at: google.protobuf.Timestamp, then .google.protobuf.Timestamp.
    expect(result.changes.some((change) => change.location.symbol?.endsWith("created_at"))).toBe(
      false,
    );
  });

  it("locates removals in the base version and the rest in the head version", () => {
    const removed = result.changes.find((change) => change.rule === "field-removed");
    expect(removed?.location).toEqual({
      file: "proto/shop.proto",
      symbol: "shop.v1.Order.note",
      line: 21,
    });
    const added = result.changes.find((change) => change.rule === "field-added");
    expect(added?.location.line).toBe(26);
  });
});

describe("Protobuf built-in rules, one by one", () => {
  it("identical files have no change", () => {
    const text = fixture("orders.base.proto");
    expect(diff(text, text).changes).toEqual([]);
  });

  it("field removed without reservation (breaking), with only its number reserved (breaking)", () => {
    const base = proto("message A { string a = 1; string b = 2; }");
    const head = proto("message A { reserved 2; string a = 1; }");
    expect(rules(diff(base, proto("message A { string a = 1; }")))).toEqual([
      "breaking field-removed",
    ]);
    const partly = diff(base, head);
    expect(rules(partly)).toEqual(["breaking field-removed"]);
    expect(partly.changes[0]?.message).toContain('its name "b"');
    expect(partly.changes[0]?.message).not.toContain("its number");
  });

  it("field removed with number and name reserved (non-breaking)", () => {
    const base = proto("message A { string a = 1; string b = 2; }");
    const head = proto('message A { reserved 2 to 3; reserved "b"; string a = 1; }');
    expect(rules(diff(base, head))).toEqual(["non-breaking field-removed-reserved"]);
  });

  it("field number reused with another name (breaking)", () => {
    expect(
      rules(diff(proto("message A { string a = 1; }"), proto("message A { int64 z = 1; }"))),
    ).toEqual(["breaking field-number-reused"]);
  });

  it("field number changed (breaking)", () => {
    expect(
      rules(diff(proto("message A { string a = 1; }"), proto("message A { string a = 2; }"))),
    ).toEqual(["breaking field-number-changed"]);
  });

  it("field type changed (breaking); nested and qualified names resolve to the same type", () => {
    expect(
      rules(diff(proto("message A { int32 a = 1; }"), proto("message A { sint32 a = 1; }"))),
    ).toEqual(["breaking field-type-changed"]);
    const base = proto("message A { message B {} B b = 1; C c = 2; } message C {}");
    const head = proto("message A { message B {} A.B b = 1; .shop.v1.C c = 2; } message C {}");
    expect(diff(base, head).changes).toEqual([]);
    const moved = proto("message A { message B {} C b = 1; C c = 2; } message C {}");
    expect(rules(diff(base, moved))).toEqual(["breaking field-type-changed"]);
  });

  it("cardinality changed (breaking), presence changed (unknown)", () => {
    expect(
      rules(
        diff(proto("message A { string a = 1; }"), proto("message A { repeated string a = 1; }")),
      ),
    ).toEqual(["breaking field-cardinality-changed"]);
    expect(
      rules(
        diff(proto("message A { string a = 1; }"), proto("message A { optional string a = 1; }")),
      ),
    ).toEqual(["unknown field-presence-changed"]);
  });

  it("oneof membership changed (breaking)", () => {
    expect(
      rules(
        diff(
          proto("message A { string a = 1; }"),
          proto("message A { oneof choice { string a = 1; } }"),
        ),
      ),
    ).toEqual(["breaking field-oneof-changed"]);
  });

  it("field added (non-breaking); reusing a reserved number or name (breaking)", () => {
    const base = proto('message A { reserved 5; reserved "old"; string a = 1; }');
    expect(
      rules(
        diff(base, proto('message A { reserved 5; reserved "old"; string a = 1; string b = 2; }')),
      ),
    ).toEqual(["non-breaking field-added"]);
    expect(
      rules(diff(base, proto('message A { reserved "old"; string a = 1; string b = 5; }'))),
    ).toEqual(["breaking reserved-number-reused", "breaking reserved-range-removed"]);
    expect(
      rules(diff(base, proto("message A { reserved 5; string a = 1; string old = 2; }"))),
    ).toEqual(["breaking reserved-name-reused", "breaking reserved-name-removed"]);
  });

  it("a required field added in proto2 (breaking)", () => {
    const base = 'syntax = "proto2"; message A { optional string a = 1; }';
    const head = 'syntax = "proto2"; message A { optional string a = 1; required int32 b = 2; }';
    expect(rules(diff(base, head))).toEqual(["breaking required-field-added"]);
  });

  it("a reservation narrowed (breaking) or widened (no change)", () => {
    const base = proto("message A { reserved 2 to 10; }");
    expect(rules(diff(base, proto("message A { reserved 2 to 5; }")))).toEqual([
      "breaking reserved-range-removed",
    ]);
    expect(diff(base, proto("message A { reserved 2 to 4, 5 to max; }")).changes).toEqual([]);
  });

  it("message removed (breaking) once, not once per nested type; message added", () => {
    const base = proto("message A { message B { message C {} } enum E { E0 = 0; } }");
    expect(rules(diff(base, proto("")))).toEqual(["breaking message-removed"]);
    expect(rules(diff(proto(""), base))).toEqual(["non-breaking message-added"]);
  });

  it("enum removed (breaking), added (non-breaking)", () => {
    const base = proto("enum E { E0 = 0; }");
    expect(rules(diff(base, proto("")))).toEqual(["breaking enum-removed"]);
    expect(rules(diff(proto(""), base))).toEqual(["non-breaking enum-added"]);
  });

  it("enum value removed (breaking), renamed (breaking), alias kept (no change)", () => {
    const base = proto("enum E { E0 = 0; E1 = 1; }");
    expect(rules(diff(base, proto("enum E { E0 = 0; }")))).toEqual(["breaking enum-value-removed"]);
    expect(rules(diff(base, proto("enum E { E0 = 0; ONE = 1; }")))).toEqual([
      "breaking enum-value-renamed",
    ]);
    expect(
      diff(base, proto("enum E { option allow_alias = true; E0 = 0; E1 = 1; ONE = 1; }")).changes,
    ).toEqual([]);
  });

  it("enum value removed with reservation (non-breaking), added (non-breaking)", () => {
    const base = proto("enum E { E0 = 0; E1 = 1; }");
    expect(rules(diff(base, proto('enum E { reserved 1; reserved "E1"; E0 = 0; }')))).toEqual([
      "non-breaking enum-value-removed-reserved",
    ]);
    expect(rules(diff(base, proto("enum E { E0 = 0; E1 = 1; E2 = 2; }")))).toEqual([
      "non-breaking enum-value-added",
    ]);
  });

  it("service and rpc removed (breaking) and added (non-breaking)", () => {
    const messages = "message R {} message S {}";
    const base = proto(`${messages} service A { rpc M(R) returns (S); } service B {}`);
    const head = proto(`${messages} service A { rpc N(R) returns (S); } service C {}`);
    expect(rules(diff(base, head))).toEqual([
      "breaking rpc-removed",
      "non-breaking rpc-added",
      "breaking service-removed",
      "non-breaking service-added",
    ]);
  });

  it("rpc request or response type changed, streaming changed (breaking)", () => {
    const messages = "message R {} message S {}";
    const base = proto(`${messages} service A { rpc M(R) returns (S); }`);
    expect(rules(diff(base, proto(`${messages} service A { rpc M(S) returns (S); }`)))).toEqual([
      "breaking rpc-request-type-changed",
    ]);
    expect(rules(diff(base, proto(`${messages} service A { rpc M(R) returns (R); }`)))).toEqual([
      "breaking rpc-response-type-changed",
    ]);
    expect(
      rules(diff(base, proto(`${messages} service A { rpc M(stream R) returns (S); }`))),
    ).toEqual(["breaking rpc-streaming-changed"]);
  });

  it("package changed (breaking) once; names are compared inside the package", () => {
    const body = "message A { string a = 1; }";
    expect(rules(diff(proto(body, "shop.v1"), proto(body, "shop.v2")))).toEqual([
      "breaking package-changed",
    ]);
  });

  it("an unreadable version is unknown, with the reason", () => {
    const result = diff(proto("message A {}"), proto("message A {"));
    expect(rules(result)).toEqual(["unknown unparseable"]);
    expect(result.notes[0]).toMatch(/^the head version cannot be read: line \d+/);
  });

  it("notes that editions presence features are not read", () => {
    const text = 'edition = "2023";\nmessage A { string a = 1; }';
    expect(diff(text, text).notes[0]).toContain("edition 2023");
  });

  it("a contract file deleted (breaking) or added (non-breaking)", () => {
    expect(rules(diff(proto(""), null))).toEqual(["breaking contract-removed"]);
    expect(rules(diff(null, proto("")))).toEqual(["non-breaking contract-added"]);
  });
});
