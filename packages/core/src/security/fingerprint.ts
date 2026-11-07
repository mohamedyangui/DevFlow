import { createHash } from "node:crypto";
import type { CommandSpec } from "../schemas/command.js";

/**
 * Command fingerprints (ADR 0007). A fingerprint identifies what an approval covers: the
 * executable, the argument template, the working directory, the extra environment, the
 * parameter patterns, and the content of everything the command runs on the user's behalf
 * (a wrapper script and its JAR, a `package.json` script body). If any of these changes, the
 * fingerprint changes and the command needs approval again.
 *
 * Parameter *values* are not part of the fingerprint: they are constrained by their declared
 * anchored patterns, which are.
 */

/** Content a command runs, bound into its fingerprint. */
export type CommandBinding =
  /** A file the command executes or loads, identified by its hash (wrappers, wrapper JARs). */
  | { readonly kind: "file"; readonly path: string; readonly sha256: string }
  /** A script body, e.g. the `test` script of a `package.json`. */
  | {
      readonly kind: "script";
      readonly path: string;
      readonly name: string;
      readonly body: string;
    };

export function fingerprintCommand(spec: CommandSpec, bindings: readonly CommandBinding[]): string {
  const canonical = {
    v: 1,
    executable: spec.executable,
    args: spec.args,
    cwd: spec.cwd,
    env: Object.entries(spec.env).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    parameters: spec.parameters
      .map((p) => [p.name, p.pattern, p.maxLength] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    network: spec.network,
    bindings: bindings
      .map((b) =>
        b.kind === "file"
          ? ["file", b.path, b.sha256]
          : ["script", b.path, b.name, createHash("sha256").update(b.body, "utf8").digest("hex")],
      )
      .sort((a, b) => {
        const left = a.join("\u0000");
        const right = b.join("\u0000");
        return left < right ? -1 : left > right ? 1 : 0;
      }),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
