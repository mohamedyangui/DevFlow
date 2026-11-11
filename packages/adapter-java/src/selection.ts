import type { ModuleProfile, TestToSelect } from "@devflow/core";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const SOURCE_FILE = /^([A-Za-z_$][A-Za-z0-9_$]*)\.(java|kt|groovy)$/;
const SOURCE_ROOTS = new Set(["java", "kotlin", "groovy"]);

/**
 * The filter value that selects one test method (`LanguageAdapter.testSelection`): Surefire's
 * `test=Class#method` for Maven, and for Gradle the fully qualified `package.Class.method` when
 * the file is under a `java`, `kotlin` or `groovy` source directory (otherwise `*Class.method`).
 * The class is the file name, as Java requires for a public class. A name that is not a
 * method identifier, or a file that is not a JVM source file, cannot be selected.
 */
export function javaTestSelection(profile: ModuleProfile, test: TestToSelect): string | undefined {
  const tool = profile.buildTool?.id;
  if (tool !== "maven" && tool !== "gradle") return undefined;
  if (!IDENTIFIER.test(test.name)) return undefined;
  const segments = test.file.split("/");
  const fileName = segments.pop() ?? "";
  const source = SOURCE_FILE.exec(fileName);
  const className = source?.[1];
  if (className === undefined) return undefined;
  if (tool === "maven") return `test=${className}#${test.name}`;

  let root = -1;
  segments.forEach((segment, index) => {
    if (SOURCE_ROOTS.has(segment)) root = index;
  });
  const wildcard = `*${className}.${test.name}`;
  if (root === -1) return wildcard;
  const packageParts = segments.slice(root + 1);
  if (!packageParts.every((part) => IDENTIFIER.test(part))) return wildcard;
  return [...packageParts, className, test.name].join(".");
}
