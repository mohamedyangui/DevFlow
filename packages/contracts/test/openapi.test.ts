import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ContractDiff,
  OpenApiDocument,
  compareContractBuiltin,
  contractKindOf,
  externalRefs,
  type ContractChange,
} from "../src/index.js";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/openapi/${name}`, import.meta.url), "utf8");

type Json = Record<string, unknown>;

function spec(paths: Json, schemas: Json = {}, extra: Json = {}): string {
  return JSON.stringify({
    openapi: "3.0.3",
    info: { title: "test", version: "1" },
    paths,
    components: { schemas, ...extra },
  });
}

function diff(base: string | null, head: string | null): ContractDiff {
  const result = compareContractBuiltin({ file: "api/openapi.yaml", kind: "openapi", base, head });
  // Every result satisfies its own schema (counts, kinds).
  expect(ContractDiff.safeParse(result).success).toBe(true);
  return result;
}

/** `compatibility rule` of every change, for compact assertions. */
function rules(result: ContractDiff): string[] {
  return result.changes.map((change) => `${change.compatibility} ${change.rule}`);
}

function only(result: ContractDiff, rule: string): ContractChange {
  const found = result.changes.filter((change) => change.rule === rule);
  expect(found).toHaveLength(1);
  const [change] = found;
  if (change === undefined) throw new Error(`no ${rule}`);
  return change;
}

const ok = { "200": { description: "ok" } };

/** One operation with a JSON response schema. */
function getWithResponse(schema: unknown, schemas: Json = {}): string {
  return spec(
    {
      "/items": {
        get: {
          responses: {
            "200": { description: "ok", content: { "application/json": { schema } } },
          },
        },
      },
    },
    schemas,
  );
}

/** One operation with a JSON request body schema. */
function postWithBody(schema: unknown, required = true, schemas: Json = {}): string {
  return spec(
    {
      "/items": {
        post: {
          requestBody: { required, content: { "application/json": { schema } } },
          responses: ok,
        },
      },
    },
    schemas,
  );
}

function getWithParameters(parameters: unknown[], path = "/items"): string {
  return spec({ [path]: { get: { parameters, responses: ok } } });
}

describe("OpenAPI parsing", () => {
  it("reads YAML and JSON documents and lists their operations", () => {
    for (const name of ["petstore.base.yaml", "petstore.head.json"]) {
      const parsed = OpenApiDocument.parse(fixture(name));
      if (!("document" in parsed)) throw new Error(parsed.error);
      expect(parsed.document.supported).toBe(true);
      expect(parsed.document.operations.length).toBeGreaterThanOrEqual(3);
    }
    const parsed = OpenApiDocument.parse(fixture("petstore.base.yaml"));
    if (!("document" in parsed)) throw new Error(parsed.error);
    expect(parsed.document.operations.map((op) => op.key)).toEqual([
      "get /pets",
      "post /pets",
      "get /pets/{}",
      "delete /pets/{}",
    ]);
    // Path-level and referenced parameters are resolved.
    expect(parsed.document.operations[0]?.parameters.map((param) => param.key)).toEqual([
      "query:limit",
      "header:x-trace",
    ]);
    expect(parsed.document.lineOf("/paths/~1pets/get")).toBe(7);
  });

  it("refuses text that is not an OpenAPI document", () => {
    expect(OpenApiDocument.parse("a: [")).toHaveProperty("error");
    expect(OpenApiDocument.parse("- 1\n- 2\n")).toEqual({ error: "the document is not a mapping" });
    expect(OpenApiDocument.parse("title: x\n")).toHaveProperty("error");
  });

  it("resolves local references, follows chains and reports cycles and external ones", () => {
    const parsed = OpenApiDocument.parse(
      JSON.stringify({
        openapi: "3.1.0",
        paths: {},
        components: {
          schemas: {
            A: { $ref: "#/components/schemas/B" },
            B: { type: "string" },
            Loop1: { $ref: "#/components/schemas/Loop2" },
            Loop2: { $ref: "#/components/schemas/Loop1" },
            "a/b": { type: "integer" },
          },
        },
      }),
    );
    if (!("document" in parsed)) throw new Error(parsed.error);
    const { document } = parsed;
    expect(document.resolve({ $ref: "#/components/schemas/A" }, "/x")).toEqual({
      ok: true,
      node: { type: "string" },
      pointer: "/components/schemas/B",
      ref: "#/components/schemas/B",
    });
    expect(document.resolve({ $ref: "#/components/schemas/a~1b" }, "/x")).toMatchObject({
      ok: true,
      node: { type: "integer" },
    });
    expect(document.resolve({ $ref: "#/components/schemas/Loop1" }, "/x")).toMatchObject({
      ok: false,
      reason: "the reference is circular",
    });
    expect(document.resolve({ $ref: "common.yaml#/Pet" }, "/x")).toMatchObject({
      ok: false,
      reason: "external references are not resolved",
    });
    expect(document.resolve({ $ref: "#/components/schemas/Missing" }, "/x")).toMatchObject({
      ok: false,
    });
  });

  it("finds external references", () => {
    expect(externalRefs(getWithResponse({ $ref: "https://example.com/pet.yaml" }))).toEqual([
      "https://example.com/pet.yaml",
    ]);
    expect(externalRefs(fixture("petstore.base.yaml"))).toEqual([]);
  });

  it("detects contract files like context discovery does", () => {
    expect(contractKindOf("api/orders.proto")).toBe("protobuf");
    expect(contractKindOf("api/openapi.yaml")).toBe("openapi");
    expect(contractKindOf("api/swagger.v2.json")).toBe("openapi");
    expect(contractKindOf("api/pets.yml", "openapi: 3.0.0\npaths: {}\n")).toBe("openapi");
    expect(contractKindOf("api/pets.json", null, '{ "openapi": "3.0.0" }')).toBe("openapi");
    expect(contractKindOf("config/app.yaml", "server: 1\n")).toBeNull();
    expect(contractKindOf("src/index.ts", "openapi: 3.0.0")).toBeNull();
  });
});

describe("OpenAPI built-in rules: the petstore fixture", () => {
  const result = diff(fixture("petstore.base.yaml"), fixture("petstore.head.json"));
  const find = (rule: string, method: string, path: string, text?: string) =>
    result.changes.filter(
      (change) =>
        change.rule === rule &&
        change.location.method === method &&
        change.location.path === path &&
        (text === undefined || change.message.includes(text)),
    );

  it("decides every change with the built-in rules", () => {
    expect(result.decidedBy).toBe("builtin-rules");
    expect(result.changes.every((change) => change.decidedBy === "builtin-rules")).toBe(true);
    expect(result.summary.breaking).toBeGreaterThan(0);
  });

  it("reports the removed operation, not the renamed path variable", () => {
    expect(find("operation-removed", "delete", "/pets/{id}")).toHaveLength(1);
    expect(find("operation-removed", "get", "/pets/{id}")).toHaveLength(0);
    expect(find("operation-added", "get", "/pets/{petId}/photos")).toHaveLength(1);
    const removed = find("operation-removed", "delete", "/pets/{id}")[0];
    expect(removed?.location.pointer).toBe("/paths/~1pets~1{id}/delete");
    expect(removed?.location.line).toBe(53);
  });

  it("reports parameter changes", () => {
    expect(find("request-parameter-became-required", "get", "/pets", '"limit"')).toHaveLength(1);
    expect(find("request-parameter-added", "get", "/pets", '"offset"')).toHaveLength(1);
    expect(find("request-parameter-required-added", "post", "/pets", '"tenant"')).toHaveLength(1);
  });

  it("follows $refs into shared schemas for every operation that uses them", () => {
    for (const [method, path] of [
      ["get", "/pets"],
      ["post", "/pets"],
      ["get", "/pets/{petId}"],
    ] as const) {
      expect(find("response-property-removed", method, path, 'tag"').length).toBeGreaterThan(0);
      expect(find("type-changed", method, path, 'id"').length).toBeGreaterThan(0);
      expect(find("response-property-added", method, path, 'nickname"').length).toBeGreaterThan(0);
      expect(find("response-enum-value-added", method, path, "pending").length).toBeGreaterThan(0);
    }
    const tag = find("response-property-removed", "get", "/pets/{petId}", '"tag"')[0];
    // A removal points into the base document, at the shared schema.
    expect(tag?.location.pointer).toBe("/components/schemas/Pet/properties/tag");
    expect(tag?.location.line).toBe(87);
  });

  it("compares request bodies as inputs", () => {
    expect(find("request-enum-value-removed", "post", "/pets", "bird")).toHaveLength(1);
    expect(find("request-property-required-added", "post", "/pets", '"species"')).toHaveLength(1);
  });

  it("reports a removed error response as unknown", () => {
    const removed = find("response-status-removed", "get", "/pets/{petId}");
    expect(removed.map((change) => change.compatibility)).toEqual(["unknown"]);
  });

  it("terminates on the Pet -> Owner -> Pet reference cycle", () => {
    // Pet is already being compared when owner.pets[] reaches it again: the cycle is cut.
    expect(result.changes.filter((change) => change.message.includes("owner.pets"))).toEqual([]);
    expect(find("response-property-removed", "get", "/pets/{petId}", '"tag"')).toHaveLength(1);
    expect(result.changes.length).toBeLessThan(100);
  });
});

describe("OpenAPI built-in rules, one by one", () => {
  it("operation removed (breaking) and added (non-breaking)", () => {
    const base = spec({ "/a": { get: { responses: ok } }, "/b": { get: { responses: ok } } });
    const head = spec({ "/a": { get: { responses: ok } }, "/c": { post: { responses: ok } } });
    expect(rules(diff(base, head))).toEqual([
      "breaking operation-removed",
      "non-breaking operation-added",
    ]);
    expect(only(diff(base, head), "operation-removed").location).toMatchObject({
      file: "api/openapi.yaml",
      path: "/b",
      method: "get",
      pointer: "/paths/~1b/get",
    });
  });

  it("identical documents have no change", () => {
    const text = fixture("petstore.base.yaml");
    expect(diff(text, text).changes).toEqual([]);
  });

  it("required parameter added (breaking), optional added (non-breaking)", () => {
    const base = getWithParameters([]);
    const head = getWithParameters([
      { name: "a", in: "query", required: true, schema: { type: "string" } },
      { name: "b", in: "query", schema: { type: "string" } },
    ]);
    expect(rules(diff(base, head))).toEqual([
      "breaking request-parameter-required-added",
      "non-breaking request-parameter-added",
    ]);
  });

  it("parameter became required (breaking) or optional (non-breaking)", () => {
    const optional = getWithParameters([{ name: "a", in: "header", schema: { type: "string" } }]);
    const required = getWithParameters([
      { name: "A", in: "header", required: true, schema: { type: "string" } },
    ]);
    expect(rules(diff(optional, required))).toEqual(["breaking request-parameter-became-required"]);
    expect(rules(diff(required, optional))).toEqual([
      "non-breaking request-parameter-became-optional",
    ]);
  });

  it("parameter removed (unknown)", () => {
    const base = getWithParameters([{ name: "a", in: "query", schema: { type: "string" } }]);
    expect(rules(diff(base, getWithParameters([])))).toEqual(["unknown request-parameter-removed"]);
  });

  it("parameter type changed (breaking), enum value removed (breaking)", () => {
    const base = getWithParameters([
      { name: "a", in: "query", schema: { type: "integer" } },
      { name: "b", in: "query", schema: { type: "string", enum: ["x", "y"] } },
    ]);
    const head = getWithParameters([
      { name: "a", in: "query", schema: { type: "string" } },
      { name: "b", in: "query", schema: { type: "string", enum: ["x"] } },
    ]);
    expect(rules(diff(base, head))).toEqual([
      "breaking type-changed",
      "breaking request-enum-value-removed",
    ]);
  });

  it("parameters given as content are compared through their schema", () => {
    const param = (type: string) => ({
      name: "filter",
      in: "query",
      content: { "application/json": { schema: { type } } },
    });
    expect(
      rules(diff(getWithParameters([param("object")]), getWithParameters([param("array")]))),
    ).toEqual(["breaking type-changed"]);
  });

  it("renaming a path variable is not a change", () => {
    const base = getWithParameters(
      [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      "/items/{id}",
    );
    const head = getWithParameters(
      [{ name: "itemId", in: "path", required: true, schema: { type: "string" } }],
      "/items/{itemId}",
    );
    expect(diff(base, head).changes).toEqual([]);
  });

  it("request body added: required (breaking), optional (non-breaking)", () => {
    const none = spec({ "/items": { post: { responses: ok } } });
    expect(rules(diff(none, postWithBody({ type: "object" }, true)))).toEqual([
      "breaking request-body-required-added",
    ]);
    expect(rules(diff(none, postWithBody({ type: "object" }, false)))).toEqual([
      "non-breaking request-body-added",
    ]);
  });

  it("request body became required (breaking), removed (unknown)", () => {
    expect(
      rules(diff(postWithBody({ type: "object" }, false), postWithBody({ type: "object" }, true))),
    ).toEqual(["breaking request-body-became-required"]);
    const none = spec({ "/items": { post: { responses: ok } } });
    expect(rules(diff(postWithBody({ type: "object" }), none))).toEqual([
      "unknown request-body-removed",
    ]);
  });

  it("request media type removed (breaking) and added (non-breaking)", () => {
    const body = (media: string) =>
      spec({
        "/items": {
          post: {
            requestBody: { content: { [media]: { schema: { type: "object" } } } },
            responses: ok,
          },
        },
      });
    expect(rules(diff(body("application/json"), body("application/xml")))).toEqual([
      "breaking request-media-type-removed",
      "non-breaking request-media-type-added",
    ]);
  });

  it("request property became required (breaking), new required property (breaking)", () => {
    const base = postWithBody({ type: "object", properties: { a: { type: "string" } } });
    const head = postWithBody({
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "string" } },
    });
    expect(rules(diff(base, head))).toEqual([
      "breaking request-property-became-required",
      "breaking request-property-required-added",
    ]);
  });

  it("request property became optional or was added as optional (non-breaking)", () => {
    const base = postWithBody({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    });
    const head = postWithBody({
      type: "object",
      properties: { a: { type: "string" }, b: { type: "string" } },
    });
    expect(rules(diff(base, head))).toEqual([
      "non-breaking request-property-became-optional",
      "non-breaking request-property-added",
    ]);
  });

  it("request property removed (unknown)", () => {
    const base = postWithBody({ type: "object", properties: { a: { type: "string" } } });
    expect(rules(diff(base, postWithBody({ type: "object", properties: {} })))).toEqual([
      "unknown request-property-removed",
    ]);
  });

  it("read-only properties do not count in requests", () => {
    const base = postWithBody({
      type: "object",
      properties: { id: { type: "string", readOnly: true } },
    });
    const head = postWithBody({
      type: "object",
      required: ["id"],
      properties: { id: { type: "string", readOnly: true } },
    });
    expect(diff(base, head).changes).toEqual([]);
  });

  it("response property removed (breaking), added (non-breaking)", () => {
    const base = getWithResponse({ type: "object", properties: { a: { type: "string" } } });
    const head = getWithResponse({ type: "object", properties: { b: { type: "string" } } });
    expect(rules(diff(base, head))).toEqual([
      "breaking response-property-removed",
      "non-breaking response-property-added",
    ]);
  });

  it("response property became optional (breaking) or required (non-breaking)", () => {
    const required = getWithResponse({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" } },
    });
    const optional = getWithResponse({ type: "object", properties: { a: { type: "string" } } });
    expect(rules(diff(required, optional))).toEqual(["breaking response-property-became-optional"]);
    expect(rules(diff(optional, required))).toEqual([
      "non-breaking response-property-became-required",
    ]);
  });

  it("write-only properties do not count in responses", () => {
    const base = getWithResponse({
      type: "object",
      properties: { secret: { type: "string", writeOnly: true } },
    });
    expect(diff(base, getWithResponse({ type: "object", properties: {} })).changes).toEqual([]);
  });

  it("nested property paths and array items are followed", () => {
    const base = getWithResponse({
      type: "array",
      items: {
        type: "object",
        properties: { owner: { type: "object", properties: { name: { type: "string" } } } },
      },
    });
    const head = getWithResponse({
      type: "array",
      items: { type: "object", properties: { owner: { type: "object", properties: {} } } },
    });
    const change = only(diff(base, head), "response-property-removed");
    expect(change.message).toContain('"[].owner.name"');
    expect(change.location.pointer).toBe(
      "/paths/~1items/get/responses/200/content/application~1json/schema/items/properties/owner/properties/name",
    );
  });

  it("type changed (breaking); type added or removed (unknown)", () => {
    expect(
      rules(diff(getWithResponse({ type: "string" }), getWithResponse({ type: "integer" }))),
    ).toEqual(["breaking type-changed"]);
    expect(rules(diff(getWithResponse({ type: "string" }), getWithResponse({})))).toEqual([
      "unknown type-constraint-changed",
    ]);
  });

  it("nullable: in responses adding null breaks, in requests removing it breaks", () => {
    expect(
      rules(
        diff(
          getWithResponse({ type: "string" }),
          getWithResponse({ type: "string", nullable: true }),
        ),
      ),
    ).toEqual(["breaking response-nullable-added"]);
    expect(
      rules(
        diff(getWithResponse({ type: ["string", "null"] }), getWithResponse({ type: "string" })),
      ),
    ).toEqual(["non-breaking response-nullable-removed"]);
    expect(
      rules(
        diff(postWithBody({ type: "string", nullable: true }), postWithBody({ type: "string" })),
      ),
    ).toEqual(["breaking request-nullable-removed"]);
    expect(
      rules(diff(postWithBody({ type: "string" }), postWithBody({ type: ["null", "string"] }))),
    ).toEqual(["non-breaking request-nullable-added"]);
  });

  it("format changed (unknown)", () => {
    expect(
      rules(
        diff(
          getWithResponse({ type: "string", format: "date" }),
          getWithResponse({ type: "string", format: "date-time" }),
        ),
      ),
    ).toEqual(["unknown format-changed"]);
  });

  it("enum values: requests break on removal, responses may break on addition", () => {
    const values = (...list: string[]) => ({ type: "string", enum: list });
    expect(rules(diff(postWithBody(values("a", "b")), postWithBody(values("a", "c"))))).toEqual([
      "breaking request-enum-value-removed",
      "non-breaking request-enum-value-added",
    ]);
    expect(
      rules(diff(getWithResponse(values("a", "b")), getWithResponse(values("a", "c")))),
    ).toEqual(["non-breaking response-enum-value-removed", "unknown response-enum-value-added"]);
  });

  it("enum list added or removed", () => {
    const free = { type: "string" };
    const listed = { type: "string", enum: ["a"] };
    expect(rules(diff(postWithBody(free), postWithBody(listed)))).toEqual([
      "breaking request-enum-added",
    ]);
    expect(rules(diff(postWithBody(listed), postWithBody(free)))).toEqual([
      "non-breaking request-enum-removed",
    ]);
    expect(rules(diff(getWithResponse(free), getWithResponse(listed)))).toEqual([
      "non-breaking response-enum-added",
    ]);
    expect(rules(diff(getWithResponse(listed), getWithResponse(free)))).toEqual([
      "unknown response-enum-removed",
    ]);
  });

  it("allOf members are merged before comparing", () => {
    const schemas = (props: Json, required: string[]) => ({
      Base: { type: "object", required, properties: props },
    });
    const schema = {
      allOf: [{ $ref: "#/components/schemas/Base" }, { properties: { extra: { type: "string" } } }],
    };
    const base = getWithResponse(schema, schemas({ id: { type: "string" } }, ["id"]));
    const head = getWithResponse(schema, schemas({}, []));
    expect(rules(diff(base, head))).toEqual(["breaking response-property-removed"]);
  });

  it("oneOf/anyOf alternatives that changed are unknown; equal ones are not reported", () => {
    const one = (...types: string[]) => ({ oneOf: types.map((type) => ({ type })) });
    expect(
      rules(diff(getWithResponse(one("string", "integer")), getWithResponse(one("string")))),
    ).toEqual(["unknown schema-alternatives-changed"]);
    expect(diff(getWithResponse(one("string")), getWithResponse(one("string"))).changes).toEqual(
      [],
    );
  });

  it("success response removed (breaking), other response removed (unknown), response added", () => {
    const responses = (codes: string[]) =>
      spec({
        "/a": {
          get: {
            responses: Object.fromEntries(codes.map((code) => [code, { description: code }])),
          },
        },
      });
    expect(rules(diff(responses(["200", "404"]), responses(["201"])))).toEqual([
      "breaking response-success-status-removed",
      "unknown response-status-removed",
      "non-breaking response-status-added",
    ]);
  });

  it("response media type removed (breaking) and added (non-breaking)", () => {
    const response = (media: string) =>
      spec({
        "/a": { get: { responses: { "200": { description: "ok", content: { [media]: {} } } } } },
      });
    expect(rules(diff(response("application/json"), response("text/csv")))).toEqual([
      "breaking response-media-type-removed",
      "non-breaking response-media-type-added",
    ]);
  });

  it("unresolved references are unknown unless both versions use the same one", () => {
    const external = getWithResponse({ $ref: "common.yaml#/Pet" });
    expect(diff(external, external).changes).toEqual([]);
    expect(rules(diff(external, getWithResponse({ $ref: "common.yaml#/Pet2" })))).toEqual([
      "unknown unresolved-reference",
    ]);
    expect(
      rules(
        diff(
          getWithResponse({ type: "object" }),
          getWithResponse({ $ref: "#/components/schemas/Nope" }),
        ),
      ),
    ).toEqual(["unknown unresolved-reference"]);
    const params = (ref: string) => getWithParameters([{ $ref: ref }]);
    expect(rules(diff(params("p.yaml#/A"), params("p.yaml#/B")))).toEqual([
      "unknown unresolved-reference",
    ]);
  });

  it("self-referencing schemas terminate", () => {
    const schemas = (extra: Json) => ({
      Node: {
        type: "object",
        properties: {
          value: { type: "string" },
          next: { $ref: "#/components/schemas/Node" },
          ...extra,
        },
      },
    });
    const base = getWithResponse({ $ref: "#/components/schemas/Node" }, schemas({}));
    const head = getWithResponse(
      { $ref: "#/components/schemas/Node" },
      schemas({ more: { type: "string" } }),
    );
    expect(rules(diff(base, head))).toEqual(["non-breaking response-property-added"]);
  });

  it("a contract added or deleted", () => {
    const text = getWithResponse({ type: "string" });
    expect(rules(diff(null, text))).toEqual(["non-breaking contract-added"]);
    const deleted = diff(text, null);
    expect(rules(deleted)).toEqual(["breaking contract-removed"]);
    expect(deleted).toMatchObject({ base: "present", head: "absent" });
  });

  it("an unreadable version is unknown, with the reason", () => {
    const result = diff(getWithResponse({ type: "string" }), "openapi: [");
    expect(rules(result)).toEqual(["unknown unparseable"]);
    expect(result.notes[0]).toContain("the head version cannot be read");
  });

  it("Swagger 2.0 is not compared by the built-in rules (unknown)", () => {
    const swagger = JSON.stringify({ swagger: "2.0", paths: {} });
    expect(rules(diff(swagger, swagger))).toEqual(["unknown unsupported-version"]);
  });

  it("stops on pathological documents and says so", () => {
    // 200 operations x 120 properties each: more schema comparisons than the limit.
    const properties = Object.fromEntries(
      Array.from({ length: 120 }, (_, i) => [`p${String(i)}`, { type: "string" }]),
    );
    const paths = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [
        `/r${String(i)}`,
        {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "#/components/schemas/Big" } } },
              },
            },
          },
        },
      ]),
    );
    const text = spec(paths, { Big: { type: "object", properties } });
    const result = diff(text, text);
    expect(rules(result)).toEqual(["unknown comparison-incomplete"]);
    expect(result.notes[0]).toContain("too large");
  });
});
