import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function readJson(relativePath: string): unknown {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

/** Reads JSON with comments (tsconfig files). Removes full-line `//` comments only. */
export function readJsonc(relativePath: string): unknown {
  const text = readFileSync(path.join(repoRoot, relativePath), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(text);
}

export interface BuildConfig {
  readonly references?: readonly { readonly path: string }[];
}

export interface RootManifest {
  readonly version: string;
  readonly engines: { readonly node: string };
  readonly devflow: {
    readonly npmScope: string;
    readonly packageBoundaries: Readonly<Record<string, readonly string[] | "*">>;
  };
}

export interface PackageManifest {
  readonly name: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly license?: string;
  readonly type?: string;
  readonly engines?: { readonly node?: string };
  readonly exports?: Record<string, Record<string, string>>;
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export function packageDirectories(): string[] {
  return readdirSync(path.join(repoRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
