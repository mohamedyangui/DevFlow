import { createHash } from "node:crypto";
import type { LlmRequest } from "@devflowai/core";

/**
 * JSON with object keys sorted at every level, so equal values always produce the same text.
 * `undefined` properties are dropped, as `JSON.stringify` does.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = sortKeys(child);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * The SHA-256 of a request's canonical JSON. The gateway records it as `promptSha256` in the
 * audit log, and the replay provider uses it as the cassette key, so an audit entry points
 * at the recorded exchange it came from.
 */
export function requestFingerprint(request: LlmRequest): string {
  return sha256Hex(canonicalJson(request));
}
