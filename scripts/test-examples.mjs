// Runs the real builds of the example repositories (tests/examples), which are skipped in
// `pnpm test`. They need Java 21 or newer, Node.js with npm, and network access to Maven
// Central, services.gradle.org and the npm registry. The Python examples use the Python on
// PATH and are skipped when pytest or mypy is not installed for it (nothing is installed).
// Usage: pnpm test:examples [vitest args]
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitest = path.join(root, "node_modules", "vitest", "vitest.mjs");
const result = spawnSync(
  process.execPath,
  [vitest, "run", "tests/examples", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit", env: { ...process.env, DEVFLOW_EXAMPLE_BUILDS: "1" } },
);
process.exit(result.status ?? 1);
