import { projectConfigJsonSchema, taskFileJsonSchema } from "@devflowai/core";
import { describe, expect, it } from "vitest";
import { readJson } from "./helpers.js";

describe("published JSON Schemas", () => {
  it.each([
    ["schemas/task.schema.json", taskFileJsonSchema],
    ["schemas/config.schema.json", projectConfigJsonSchema],
  ])(
    "%s matches the Zod source (run `pnpm build && pnpm schemas:generate` if this fails)",
    (file, generate) => {
      expect(readJson(file)).toEqual(generate());
    },
  );

  it("describes the task file for editors", () => {
    const schema = taskFileJsonSchema() as {
      title?: string;
      required?: string[];
      additionalProperties?: boolean;
    };
    expect(schema.title).toBe("DevFlow task file");
    expect(schema.required).toEqual(["id", "title"]);
    expect(schema.additionalProperties).toBe(false);
  });
});
