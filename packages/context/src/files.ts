import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDevflowError, type PathGuard } from "@devflow/core";
import type { SkipReason } from "./schemas.js";

export type LoadedText =
  | { readonly ok: true; readonly text: string; readonly sha256: string }
  | { readonly ok: false; readonly reason: SkipReason };

/**
 * Reads a file for use in a prompt: the path guard's `prompt` access refuses sensitive files
 * and links leaving the workspace; content with NUL bytes or invalid UTF-8 is binary.
 */
export async function readTextForPrompt(
  guard: PathGuard,
  relative: string,
  maxBytes: number,
): Promise<LoadedText> {
  let absolute: string;
  try {
    const checked = await guard.check(relative, { access: "prompt", origin: "internal" });
    if (!checked.exists) return { ok: false, reason: "unreadable" };
    absolute = checked.absolute;
  } catch (error) {
    if (isDevflowError(error) && error.details.reason === "sensitive") {
      return { ok: false, reason: "sensitive" };
    }
    return { ok: false, reason: "unreadable" };
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (bytes.length > maxBytes) return { ok: false, reason: "too-large" };
  if (bytes.subarray(0, 8000).includes(0)) return { ok: false, reason: "binary" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "binary" };
  }
  return { ok: true, text, sha256: createHash("sha256").update(bytes).digest("hex") };
}

/** A rough token estimate (about four characters per token), used for budgeting only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
