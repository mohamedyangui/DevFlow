#!/usr/bin/env node
/**
 * Writes schemas/task.schema.json and schemas/config.schema.json from the Zod sources in
 * packages/core. Requires a build (`pnpm build`). tests/repo/json-schemas.test.ts fails when
 * the committed files drift from the sources.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const coreEntry = new URL("../packages/core/dist/index.js", import.meta.url);
if (!existsSync(coreEntry)) {
  console.error("packages/core is not built yet. Run `pnpm build` first.");
  process.exit(1);
}
const core = await import(coreEntry.href);

const outputDirectory = new URL("../schemas/", import.meta.url);
mkdirSync(outputDirectory, { recursive: true });

const outputs = {
  "task.schema.json": core.taskFileJsonSchema(),
  "config.schema.json": core.projectConfigJsonSchema(),
};
for (const [name, schema] of Object.entries(outputs)) {
  writeFileSync(new URL(name, outputDirectory), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote schemas/${name}`);
}
