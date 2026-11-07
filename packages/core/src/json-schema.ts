import { z } from "zod";
import { ProjectConfig } from "./schemas/config.js";
import { TaskFile } from "./schemas/task.js";

/**
 * JSON Schemas generated from the Zod sources, for editor completion in task files and
 * `.devflow/config.yaml`. The published copies in `schemas/` are produced by
 * `pnpm schemas:generate` and checked for drift by tests/repo/json-schemas.test.ts.
 */
export function taskFileJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(TaskFile, { io: "input" });
}

export function projectConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProjectConfig, { io: "input" });
}
