import { readFileSync } from "node:fs";

/** Reads the CLI version from its package.json (works from both src/ and dist/). */
export function readCliVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version?: unknown };
  return typeof manifest.version === "string" ? manifest.version : "0.0.0-unknown";
}
