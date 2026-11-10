import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { javaAdapter } from "@devflow/adapter-java";
import { javascriptAdapter } from "@devflow/adapter-javascript";
import { pythonAdapter } from "@devflow/adapter-python";
import { ExitCode, runCli, type CliIo } from "@devflow/cli";
import { WorkspaceRepository } from "@devflow/context";
import {
  AdapterRegistry,
  CommandPolicy,
  Executor,
  PathGuard,
  PathToolchainProbe,
  SecretRedactor,
  TrustStore,
  decideGate,
  defaultTrustStorePath,
  withExecutionLogs,
} from "@devflow/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "../repo/helpers.js";

/**
 * The example repositories built for real: `devflow verify` runs their Maven, Gradle, npm,
 * TypeScript and Python commands through the command policy and the executor, and reads the
 * reports the tools write. These builds download dependencies and take minutes, so they run only
 * with DEVFLOW_EXAMPLE_BUILDS=1 (`pnpm test:examples`). The Python examples never install
 * anything: they need pytest or mypy to be installed already and are skipped otherwise.
 */

const isWindows = process.platform === "win32";

function available(command: string, args: string[]): boolean {
  const result = spawnSync(command, args, { encoding: "utf8", shell: isWindows });
  return result.status === 0;
}

const examplesEnabled = process.env.DEVFLOW_EXAMPLE_BUILDS === "1";

function skipReason(): string | undefined {
  if (!examplesEnabled) {
    return "set DEVFLOW_EXAMPLE_BUILDS=1 to run the real builds";
  }
  if (!available("java", ["-version"])) return "Java is not on PATH";
  if (!available("npm", ["--version"])) return "npm is not on PATH";
  return undefined;
}

const reason = skipReason();
const title = (name: string) => `${name}${reason === undefined ? "" : ` (skipped: ${reason})`}`;
const BUILD_TIMEOUT = 20 * 60_000;

/** Build outputs and installed packages are never copied from the source tree. */
const NOT_COPIED = new Set([
  "node_modules",
  "target",
  "build",
  ".gradle",
  "runs",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
]);

let base: string;
let home: string;

beforeAll(async () => {
  if (!examplesEnabled) return;
  base = await realpath(await mkdtemp(path.join(tmpdir(), "devflow-examples-")));
  home = path.join(base, "home");
  await mkdir(home, { recursive: true });
});

afterAll(async () => {
  if (!examplesEnabled) return;
  await rm(base, { recursive: true, force: true, maxRetries: 3 });
});

/** Copies `examples/<name>` to a fresh directory and returns its path. */
async function copyExample(name: string): Promise<string> {
  const target = path.join(base, name);
  await cp(path.join(repoRoot, "examples", name), target, {
    recursive: true,
    filter: (source) => !NOT_COPIED.has(path.basename(source)),
  });
  return target;
}

function npmCi(dir: string): void {
  const result = spawnSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: dir,
    encoding: "utf8",
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(`npm ci failed in ${dir}:\n${result.stdout}\n${result.stderr}`);
  }
}

async function edit(file: string, from: string, to: string): Promise<void> {
  const text = await readFile(file, "utf8");
  if (!text.includes(from)) throw new Error(`"${from}" is not in ${file}`);
  await writeFile(file, text.replace(from, to));
}

function env(): Record<string, string | undefined> {
  return { ...process.env, DEVFLOW_HOME: home, DEVFLOW_USER: "tester", NO_COLOR: "1" };
}

interface Cli {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function cli(dir: string, args: string[]): Promise<Cli> {
  let stdout = "";
  let stderr = "";
  const io: CliIo = {
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
    cwd: dir,
    env: env(),
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

interface VerifyJson {
  outcome: string;
  verification: string | null;
  modules: { id: string; adapter: string; root: string }[];
  gates: {
    gateId: string;
    commandId: string;
    status: string;
    reason?: string;
    tests: { id: string; status: string }[];
    execution?: { exitCode: number | null; invocation?: { strategy: string } };
  }[];
  denials: { gateId: string; reason: string; fingerprint?: string }[];
  comparison: { regressions: { testId: string }[] } | null;
}

async function verify(dir: string, args: string[] = []): Promise<VerifyJson> {
  const result = await cli(dir, ["verify", "--json", ...args]);
  try {
    return JSON.parse(result.stdout) as VerifyJson;
  } catch {
    throw new Error(
      `devflow verify printed no JSON (exit ${String(result.code)}):\n${result.stderr}`,
    );
  }
}

/** Trusts the workspace and returns `--allow` arguments for every gate's command. */
async function approveAll(dir: string): Promise<string[]> {
  expect((await cli(dir, ["trust", "--yes"])).code).toBe(ExitCode.Success);
  const denied = await verify(dir);
  expect(denied.outcome).toBe("denied");
  expect(denied.denials.map((denial) => denial.reason)).toEqual(
    denied.gates.map(() => "approval-required"),
  );
  return denied.denials.flatMap((denial) =>
    denial.fingerprint === undefined ? [] : ["--allow", denial.fingerprint],
  );
}

const passed = (run: VerifyJson) =>
  run.gates.map((gate) => [gate.gateId, gate.status, gate.reason ?? ""]);

const testNames = (tests: readonly { id: string; status: string }[]) =>
  tests.map((test) => `${test.id} ${test.status}`).sort();

/**
 * Runs a module's filtered test command (`<module>:test-filter`) the way a targeted run does:
 * the command policy approves it with its parameter, the executor runs it, and the adapter
 * reads the reports.
 */
function runFiltered(dir: string, moduleId: string, params: Record<string, string>) {
  return runCommand(dir, moduleId, "test-filter", params);
}

/** Runs one command of a module's catalog (`<module>:<suffix>`) as a targeted run does. */
async function runCommand(
  dir: string,
  moduleId: string,
  suffix: string,
  params: Record<string, string> = {},
) {
  const guard = await PathGuard.create(dir);
  const repo = new WorkspaceRepository(guard, { maxFileBytes: 524_288, exclude: [] });
  const discovery = await new AdapterRegistry([
    javaAdapter,
    javascriptAdapter,
    pythonAdapter,
  ]).discover(repo);
  const module = discovery.modules.find((found) => found.profile.moduleId === moduleId);
  if (module === undefined) throw new Error(`no module ${moduleId} in ${dir}`);
  const toolchain = new PathToolchainProbe({ env: env() });
  const catalog = await module.adapter.commandCatalog(module.profile, toolchain, repo);
  const spec = catalog.find((command) => command.id === `${moduleId}:${suffix}`);
  if (spec === undefined) throw new Error(`no ${moduleId}:${suffix} command`);
  const trust = await TrustStore.open(defaultTrustStorePath(env()));
  const policy = (allowlist: string[]) =>
    new CommandPolicy({ guard, trust, configSha256: null, allowlist });
  const first = await policy([]).evaluate({ spec, params });
  if (first.allowed || first.fingerprint === undefined) {
    throw new Error("the filtered command should need an approval first");
  }
  const decision = await policy([first.fingerprint]).evaluate({ spec, params });
  if (!decision.allowed) throw new Error(decision.message);
  const redactor = new SecretRedactor();
  const executed = await new Executor({ guard, redactor, env: env() }).run(decision.command, {
    logDir: ".devflow/runs/filtered/logs",
  });
  const parsed = await module.adapter.parseResults(
    spec,
    executed.record,
    withExecutionLogs(repo, executed),
  );
  return {
    argv: decision.command.args,
    status: decideGate(spec, executed.record, parsed).status,
    tests: parsed.tests,
    diagnostics: parsed.diagnostics,
    output: `${executed.stdout}\n${executed.stderr}`,
  };
}

describe.skipIf(reason !== undefined)(title("example builds"), () => {
  it(
    "java-spring-boot: Maven wrapper with its JAR, a failing test as a regression, a Surefire selection",
    async () => {
      const dir = await copyExample("java-spring-boot");
      const allow = await approveAll(dir);

      const green = await verify(dir, allow);
      expect(passed(green)).toEqual([["java-test", "passed", ""]]);
      expect(green.gates[0]?.execution?.exitCode).toBe(0);
      expect(testNames(green.gates[0]?.tests ?? [])).toEqual([
        "com.shop.orders.OrderControllerTest#keepsTheOrderJsonShape passed",
        "com.shop.orders.OrderControllerTest#listsEveryOrder passed",
        "com.shop.orders.OrderServiceTest#returnsACopyThatCannotBeChanged passed",
        "com.shop.orders.OrderServiceTest#returnsOrdersOldestFirst passed",
      ]);

      await edit(
        path.join(dir, "src/test/java/com/shop/orders/OrderControllerTest.java"),
        'jsonPath("$", hasSize(2))',
        'jsonPath("$", hasSize(3))',
      );
      const red = await verify(dir, [...allow, "--baseline", green.verification ?? ""]);
      expect(red.outcome).toBe("failed");
      expect(red.gates[0]?.status).toBe("failed");
      expect(red.comparison?.regressions.map((r) => r.testId)).toEqual([
        "com.shop.orders.OrderControllerTest#listsEveryOrder",
      ]);

      const filtered = await runFiltered(dir, "java", { testSelector: "test=OrderServiceTest" });
      expect(filtered.argv).toContain("test=OrderServiceTest");
      expect(filtered.status).toBe("passed");
      expect(testNames(filtered.tests)).toEqual([
        "com.shop.orders.OrderServiceTest#returnsACopyThatCannotBeChanged passed",
        "com.shop.orders.OrderServiceTest#returnsOrdersOldestFirst passed",
      ]);
    },
    BUILD_TIMEOUT,
  );

  it(
    "java-gradle: Gradle wrapper, Kotlin DSL, a --tests filter",
    async () => {
      const dir = await copyExample("java-gradle");
      const allow = await approveAll(dir);

      const green = await verify(dir, allow);
      expect(passed(green)).toEqual([["java-test", "passed", ""]]);
      expect(testNames(green.gates[0]?.tests ?? [])).toEqual([
        "com.shop.pricing.PriceCalculatorTest#addsVat passed",
        "com.shop.pricing.PriceCalculatorTest#appliesTheDiscountBeforeVat passed",
        "com.shop.pricing.PriceCalculatorTest#rejectsDiscountsAboveOneHundredPercent passed",
        "com.shop.pricing.PriceCalculatorTest#roundsHalfUp passed",
        "com.shop.pricing.VatRateTest#acceptsZeroVat passed",
        "com.shop.pricing.VatRateTest#rejectsNegativeVat passed",
      ]);

      const filtered = await runFiltered(dir, "java", {
        testFilter: "com.shop.pricing.VatRateTest",
      });
      expect(filtered.status).toBe("passed");
      expect(testNames(filtered.tests)).toEqual([
        "com.shop.pricing.VatRateTest#acceptsZeroVat passed",
        "com.shop.pricing.VatRateTest#rejectsNegativeVat passed",
      ]);

      await edit(
        path.join(dir, "src/main/java/com/shop/pricing/PriceCalculator.java"),
        "(cents * percent + 50) / 100",
        "(cents * percent) / 100",
      );
      const red = await verify(dir, [...allow, "--baseline", green.verification ?? ""]);
      expect(red.outcome).toBe("failed");
      expect(red.comparison?.regressions.map((r) => r.testId)).toEqual([
        "com.shop.pricing.PriceCalculatorTest#roundsHalfUp",
      ]);
    },
    BUILD_TIMEOUT,
  );

  it(
    "nodejs-express: npm ci, Vitest with Supertest, a test name filter",
    async () => {
      const dir = await copyExample("nodejs-express");
      npmCi(dir);
      const allow = await approveAll(dir);

      const green = await verify(dir, allow);
      expect(passed(green)).toEqual([["javascript-test", "passed", ""]]);
      expect(testNames(green.gates[0]?.tests ?? [])).toEqual([
        "test/orders.test.js#GET /api/orders > lists every order, oldest first passed",
        "test/orders.test.js#POST /api/orders > creates an order passed",
        "test/orders.test.js#POST /api/orders > rejects an order without a customer passed",
      ]);

      const filtered = await runFiltered(dir, "javascript", { testNamePattern: "POST" });
      expect(filtered.status).toBe("passed");
      expect(filtered.tests.filter((test) => test.status === "passed")).toHaveLength(2);

      await edit(path.join(dir, "src/app.js"), "res.status(201)", "res.status(200)");
      const red = await verify(dir, [...allow, "--baseline", green.verification ?? ""]);
      expect(red.outcome).toBe("failed");
      expect(red.comparison?.regressions.map((r) => r.testId)).toEqual([
        "test/orders.test.js#POST /api/orders > creates an order",
      ]);
    },
    BUILD_TIMEOUT,
  );

  it(
    "fullstack-monorepo: configured modules and gates, a script-only Maven wrapper, tsc",
    async () => {
      const dir = await copyExample("fullstack-monorepo");
      npmCi(path.join(dir, "web"));
      const allow = await approveAll(dir);

      const green = await verify(dir, allow);
      expect(green.modules).toEqual([
        { id: "backend", adapter: "java", root: "backend" },
        { id: "web", adapter: "javascript", root: "web" },
      ]);
      expect(passed(green)).toEqual([
        ["backend-test", "passed", ""],
        ["web-test", "passed", ""],
        ["web-typecheck", "passed", ""],
      ]);
      expect(green.gates[0]?.tests).toHaveLength(3);
      expect(green.gates[1]?.tests).toHaveLength(4);

      await edit(
        path.join(dir, "web/src/orders.ts"),
        "export function formatTotal(cents: number): string {",
        "export function formatTotal(cents: number): number {",
      );
      const red = await verify(dir, [...allow, "--baseline", green.verification ?? ""]);
      expect(red.outcome).toBe("failed");
      const typecheck = red.gates.find((gate) => gate.gateId === "web-typecheck");
      expect(typecheck?.status).toBe("failed");
      expect(red.gates.find((gate) => gate.gateId === "backend-test")?.status).toBe("passed");
    },
    BUILD_TIMEOUT,
  );
});

/**
 * The Python examples run with the interpreter DevFlow picks on PATH (`python` on Windows,
 * `python3` elsewhere). Nothing is ever installed: when pytest or mypy is missing for that
 * interpreter, the tests that need it are skipped and their title says why.
 */
const python = isWindows ? "python" : "python3";

function pythonSkipReason(module?: string): string | undefined {
  if (!examplesEnabled) return "set DEVFLOW_EXAMPLE_BUILDS=1 to run the real builds";
  if (!available(python, ["--version"])) return `${python} is not on PATH`;
  if (module !== undefined && !available(python, ["-m", module, "--version"])) {
    return `${module} is not installed for ${python} (DevFlow never installs it)`;
  }
  return undefined;
}

const unittestReason = pythonSkipReason();
const pytestReason = pythonSkipReason("pytest");
const mypyReason = pythonSkipReason("mypy");
const pythonTitle = (name: string, why: string | undefined) =>
  `${name}${why === undefined ? "" : ` (skipped: ${why})`}`;

describe.skipIf(unittestReason !== undefined)(
  pythonTitle("python-unittest example", unittestReason),
  () => {
    it(
      "python-unittest: a plain project, unittest discovery, a regression, a -k filter",
      async () => {
        const dir = await copyExample("python-unittest");
        const allow = await approveAll(dir);

        const green = await verify(dir, allow);
        expect(green.modules).toEqual([{ id: "python", adapter: "python", root: "." }]);
        expect(passed(green)).toEqual([["python-test", "passed", ""]]);
        expect(testNames(green.gates[0]?.tests ?? [])).toEqual([
          "tests.test_stock.TestStock#test_ac1_reserves_items_in_stock passed",
          "tests.test_stock.TestStock#test_ac2_refuses_more_than_the_stock passed",
          "tests.test_stock.TestStock#test_receiving_adds_to_the_level passed",
          "tests.test_stock.TestStock#test_rejects_empty_deliveries passed",
        ]);

        const filtered = await runFiltered(dir, "python", { testPattern: "test_ac1" });
        expect(filtered.status, filtered.output).toBe("passed");
        expect(testNames(filtered.tests)).toEqual([
          "tests.test_stock.TestStock#test_ac1_reserves_items_in_stock passed",
        ]);

        await edit(
          path.join(dir, "inventory/stock.py"),
          "if quantity > level:",
          "if quantity > level + 1:",
        );
        const red = await verify(dir, [...allow, "--baseline", green.verification ?? ""]);
        expect(red.outcome).toBe("failed");
        expect(red.comparison?.regressions.map((r) => r.testId)).toEqual([
          "tests.test_stock.TestStock#test_ac2_refuses_more_than_the_stock",
        ]);
      },
      BUILD_TIMEOUT,
    );

    it.skipIf(mypyReason !== undefined)(
      pythonTitle("python-unittest: mypy, clean and then with a type error", mypyReason),
      async () => {
        const dir = await copyExample("python-unittest");
        expect((await cli(dir, ["trust", "--yes"])).code).toBe(ExitCode.Success);
        const clean = await runCommand(dir, "python", "typecheck");
        expect(clean.status, clean.output).toBe("passed");
        expect(clean.diagnostics).toEqual([]);

        await edit(
          path.join(dir, "inventory/stock.py"),
          "def level(self, sku: str) -> int:",
          "def level(self, sku: str) -> str:",
        );
        const broken = await runCommand(dir, "python", "typecheck");
        expect(broken.status, broken.output).toBe("failed");
        expect(broken.diagnostics.map((d) => [d.tool, d.severity, d.location?.path])).toEqual([
          ["mypy", "error", "inventory/stock.py"],
        ]);
      },
      BUILD_TIMEOUT,
    );
  },
);

describe.skipIf(pytestReason !== undefined)(
  pythonTitle("python-pytest example", pytestReason),
  () => {
    it(
      "python-pytest: src layout, a JUnit XML report, a regression, a -k filter",
      async () => {
        const dir = await copyExample("python-pytest");
        const allow = await approveAll(dir);

        const green = await verify(dir, allow);
        expect(passed(green)).toEqual([["python-test", "passed", ""]]);
        expect(green.gates[0]?.tests).toHaveLength(5);
        expect(testNames(green.gates[0]?.tests ?? [])).toContain(
          "tests.test_discounts#test_ac1_rounds_half_up passed",
        );

        const filtered = await runFiltered(dir, "python", { testExpression: "test_ac1" });
        expect(filtered.status, filtered.output).toBe("passed");
        expect(filtered.tests).toHaveLength(2);

        await edit(
          path.join(dir, "src/pricing/discounts.py"),
          "(cents * percent + 50) // 100",
          "(cents * percent) // 100",
        );
        const red = await verify(dir, [...allow, "--baseline", green.verification ?? ""]);
        expect(red.outcome).toBe("failed");
        expect(red.comparison?.regressions.map((r) => r.testId)).toEqual([
          "tests.test_discounts#test_ac1_rounds_half_up",
        ]);
      },
      BUILD_TIMEOUT,
    );
  },
);
