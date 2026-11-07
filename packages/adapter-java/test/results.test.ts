import { validatedAdapter, type CommandSpec, type ExecutionRecord } from "@devflow/core";
import type { MemoryRepository } from "@devflow/core/testing";
import { describe, expect, it } from "vitest";
import {
  acceptanceMarkers,
  javaAdapter,
  parseCompilerOutput,
  parseJUnitXml,
} from "../src/index.js";
import { gradleRepo, springMavenRepo } from "./fixtures.js";

const adapter = validatedAdapter(javaAdapter);
const STARTED = "2026-03-01T10:00:00.000Z";
const FRESH = Date.parse("2026-03-01T10:00:05Z");
const STALE = Date.parse("2026-02-01T00:00:00Z");
const ROOT = "/memory/repo";

function execution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    commandId: "services-orders:test",
    argv: ["./mvnw", "test"],
    cwd: "services/orders",
    invocation: "direct",
    approval: { via: "allowlist-flag" },
    startedAt: STARTED,
    durationMs: 1000,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdoutPath: ".devflow/runs/r1/test.stdout.log",
    stderrPath: ".devflow/runs/r1/test.stderr.log",
    outputTruncated: false,
    ...overrides,
  };
}

async function command(repo: MemoryRepository, root: string, id: string): Promise<CommandSpec> {
  const candidate = (await adapter.detectModules(repo)).find((c) => c.root === root);
  if (candidate === undefined) throw new Error(`no module at ${root}`);
  const profile = await adapter.analyzeModule(candidate, repo);
  const catalog = await adapter.commandCatalog(
    profile,
    { platform: "linux", probe: () => Promise.resolve({ available: true }) },
    repo,
  );
  const found = catalog.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no command ${id}`);
  return found;
}

const CONTROLLER = "com.acme.orders.OrderControllerTest";
const SUREFIRE_REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="${CONTROLLER}" tests="5" failures="1" errors="2" skipped="1">
  <properties><property name="java.version" value="21"/></properties>
  <testcase name="ac1_returnsSecondPage" classname="${CONTROLLER}" time="0.012"/>
  <testcase name="ac2_ac3_rejectsBadPage" classname="${CONTROLLER}" time="0.5">
    <failure message="expected: &lt;2&gt; but was: &lt;1&gt;" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <2> but was: <1>
	at com.acme.orders.OrderControllerTest.ac2_ac3_rejectsBadPage(OrderControllerTest.java:20)]]></failure>
  </testcase>
  <testcase name="crashes" classname="${CONTROLLER}" time="0.1">
    <error message="boom" type="java.lang.IllegalStateException"/>
  </testcase>
  <testcase name="slow" classname="${CONTROLLER}" time="1.000">
    <error message="slow() timed out after 1 second" type="java.util.concurrent.TimeoutException"/>
  </testcase>
  <testcase name="later" classname="${CONTROLLER}" time="0">
    <skipped message="disabled"/>
  </testcase>
</testsuite>
`;

describe("acceptanceMarkers", () => {
  it("reads method-name prefixes and display-name markers", () => {
    expect(acceptanceMarkers("ac1_returnsSecondPage")).toEqual(["AC-1"]);
    expect(acceptanceMarkers("AC2_ac10_both()")).toEqual(["AC-2", "AC-10"]);
    expect(acceptanceMarkers("AC-3: returns the second page")).toEqual(["AC-3"]);
    expect(acceptanceMarkers("ac0_invalid", "back_ac1_notAPrefix", "AC-12345 too long")).toEqual(
      [],
    );
  });
});

describe("parseJUnitXml", () => {
  it("maps failures, errors, timeouts and skips to outcomes", () => {
    const cases = parseJUnitXml(SUREFIRE_REPORT);
    expect(cases?.map((c) => [c.name, c.outcome])).toEqual([
      ["ac1_returnsSecondPage", "passed"],
      ["ac2_ac3_rejectsBadPage", "assertion_failure"],
      ["crashes", "runtime_error"],
      ["slow", "timeout"],
      ["later", "skipped"],
    ]);
    expect(cases?.[1]?.message).toBe(
      "org.opentest4j.AssertionFailedError: expected: <2> but was: <1>",
    );
    expect(cases?.[0]?.durationMs).toBe(12);
  });

  it("refuses documents that are not complete JUnit reports", () => {
    expect(parseJUnitXml(SUREFIRE_REPORT.slice(0, 400))).toBeUndefined();
    expect(parseJUnitXml("<checkstyle/>")).toBeUndefined();
    expect(parseJUnitXml("not xml")).toBeUndefined();
  });
});

describe("parseResults: junit-xml", () => {
  it("reads only reports written by this run and links tests to files and criteria", async () => {
    const base = springMavenRepo();
    const repo = base.with({
      [`services/orders/target/surefire-reports/TEST-${CONTROLLER}.xml`]: {
        text: SUREFIRE_REPORT,
        modifiedMs: FRESH,
      },
      "services/orders/target/surefire-reports/TEST-com.acme.orders.OrderServiceTest.xml": {
        text: `<testsuite><testcase name="old" classname="com.acme.orders.OrderServiceTest"/></testsuite>`,
        modifiedMs: STALE,
      },
    });
    const parsed = await adapter.parseResults(
      await command(base, "services/orders", "services-orders:test"),
      execution({ exitCode: 1 }),
      repo,
    );
    expect(parsed.parse).toBe("parsed");
    expect(parsed.tests.map((t) => [t.id, t.status, t.markers])).toEqual([
      [`${CONTROLLER}#ac1_returnsSecondPage`, "passed", ["AC-1"]],
      [`${CONTROLLER}#ac2_ac3_rejectsBadPage`, "failed", ["AC-2", "AC-3"]],
      [`${CONTROLLER}#crashes`, "failed", []],
      [`${CONTROLLER}#slow`, "unverified", []],
      [`${CONTROLLER}#later`, "skipped", []],
    ]);
    expect(parsed.tests[0]?.file).toBe(
      "services/orders/src/test/java/com/acme/orders/OrderControllerTest.java",
    );
    expect(parsed.evidence.map((e) => e.kind)).toEqual(["execution", "tool-report"]);
  });

  it("is unparseable when no fresh report exists, even if old ones do", async () => {
    const base = springMavenRepo();
    const repo = base.with({
      [`services/orders/target/surefire-reports/TEST-${CONTROLLER}.xml`]: {
        text: SUREFIRE_REPORT,
        modifiedMs: STALE,
      },
    });
    const parsed = await adapter.parseResults(
      await command(base, "services/orders", "services-orders:test"),
      execution(),
      repo,
    );
    expect(parsed).toMatchObject({
      parse: "unparseable",
      tests: [],
      note: "no fresh JUnit XML report was written by this run",
    });
  });

  it("is unparseable when a fresh report is truncated", async () => {
    const base = springMavenRepo();
    const repo = base.with({
      [`services/orders/target/surefire-reports/TEST-${CONTROLLER}.xml`]: {
        text: SUREFIRE_REPORT.slice(0, 300),
        modifiedMs: FRESH,
      },
    });
    const parsed = await adapter.parseResults(
      await command(base, "services/orders", "services-orders:test"),
      execution(),
      repo,
    );
    expect(parsed.parse).toBe("unparseable");
    expect(parsed.tests).toEqual([]);
  });

  it("reports compiler errors when the tests did not compile", async () => {
    const base = springMavenRepo();
    const repo = base.with({
      ".devflow/runs/r1/test.stdout.log": [
        "[INFO] Compiling 3 source files",
        `[ERROR] ${ROOT}/services/orders/src/test/java/com/acme/orders/OrderControllerTest.java:[12,5] cannot find symbol`,
        "[ERROR] BUILD FAILURE",
      ].join("\n"),
    });
    const parsed = await adapter.parseResults(
      await command(base, "services/orders", "services-orders:test"),
      execution({ exitCode: 1 }),
      repo,
    );
    expect(parsed).toMatchObject({
      parse: "unparseable",
      note: "no test report was written by this run; the build failed with compiler errors",
      diagnostics: [
        {
          tool: "javac",
          severity: "error",
          message: "cannot find symbol",
          location: {
            path: "services/orders/src/test/java/com/acme/orders/OrderControllerTest.java",
            line: 12,
            column: 5,
          },
        },
      ],
    });
  });

  it("finds Gradle reports in every project of the build", async () => {
    const base = gradleRepo();
    const report = (cls: string, name: string) =>
      `<testsuite name="${cls}"><testcase name="${name}" classname="${cls}" time="0.1"/></testsuite>`;
    const repo = base.with({
      "app/build/test-results/test/TEST-com.shop.AppTest.xml": {
        text: report("com.shop.AppTest", "ac3_startsUp()"),
        modifiedMs: FRESH,
      },
      "lib/core/build/test-results/test/TEST-com.shop.core.MoneyTests.xml": {
        text: report("com.shop.core.MoneyTests", "adds()"),
        modifiedMs: FRESH,
      },
    });
    const parsed = await adapter.parseResults(
      await command(base, ".", "java:test"),
      execution({ cwd: "." }),
      repo,
    );
    expect(parsed.tests.map((t) => [t.id, t.file, t.markers])).toEqual([
      ["com.shop.AppTest#ac3_startsUp", "app/src/test/java/com/shop/AppTest.java", ["AC-3"]],
      ["com.shop.core.MoneyTests#adds", "lib/core/src/test/java/com/shop/core/MoneyTests.java", []],
    ]);
  });
});

describe("parseResults: quality tools", () => {
  it("reads Checkstyle reports with repository-relative locations", async () => {
    const base = springMavenRepo();
    const repo = base.with({
      "services/orders/target/checkstyle-result.xml": {
        text: `<?xml version="1.0"?>
<checkstyle version="10.17.0">
  <file name="${ROOT}/services/orders/src/main/java/com/acme/orders/OrdersApplication.java">
    <error line="3" column="1" severity="error" message="Missing a Javadoc comment." source="com.puppycrawl.tools.checkstyle.checks.javadoc.MissingJavadocTypeCheck"/>
  </file>
  <file name="/elsewhere/Other.java">
    <error line="1" severity="warning" message="Line is longer than 100 characters." source="com.puppycrawl.tools.checkstyle.checks.sizes.LineLengthCheck"/>
  </file>
</checkstyle>`,
        modifiedMs: FRESH,
      },
    });
    const parsed = await adapter.parseResults(
      await command(base, "services/orders", "services-orders:checkstyle"),
      execution({ exitCode: 1 }),
      repo,
    );
    expect(parsed.diagnostics).toEqual([
      {
        tool: "checkstyle",
        severity: "error",
        message: "Missing a Javadoc comment.",
        ruleId: "MissingJavadocType",
        location: {
          path: "services/orders/src/main/java/com/acme/orders/OrdersApplication.java",
          line: 3,
          column: 1,
        },
      },
      {
        tool: "checkstyle",
        severity: "warning",
        message: "Other.java: Line is longer than 100 characters.",
        ruleId: "LineLength",
      },
    ]);
  });

  it("reads SpotBugs reports and resolves source paths through the source directories", async () => {
    const base = springMavenRepo();
    const repo = base.with({
      "services/orders/target/spotbugsXml.xml": {
        text: `<BugCollection version="4.8.6">
  <Project projectName="orders"><SrcDir>${ROOT}/services/orders/src/main/java</SrcDir></Project>
  <BugInstance type="NP_NULL_ON_SOME_PATH" priority="1" rank="5" category="CORRECTNESS">
    <ShortMessage>Possible null pointer dereference</ShortMessage>
    <LongMessage>Possible null pointer dereference in OrdersApplication.run()</LongMessage>
    <Class classname="com.acme.orders.OrdersApplication">
      <SourceLine classname="com.acme.orders.OrdersApplication" sourcepath="com/acme/orders/OrdersApplication.java" start="1" end="3"/>
    </Class>
    <SourceLine classname="com.acme.orders.OrdersApplication" start="3" end="3" sourcepath="com/acme/orders/OrdersApplication.java"/>
  </BugInstance>
</BugCollection>`,
        modifiedMs: FRESH,
      },
    });
    const parsed = await adapter.parseResults(
      await command(base, "services/orders", "services-orders:spotbugs"),
      execution({ exitCode: 1 }),
      repo,
    );
    expect(parsed.diagnostics).toEqual([
      {
        tool: "spotbugs",
        severity: "error",
        message: "Possible null pointer dereference in OrdersApplication.run()",
        ruleId: "NP_NULL_ON_SOME_PATH",
        location: {
          path: "services/orders/src/main/java/com/acme/orders/OrdersApplication.java",
          line: 3,
        },
      },
    ]);
  });
});

describe("parseResults: compile", () => {
  it("uses the exit code and lists compiler diagnostics", async () => {
    const base = springMavenRepo();
    const compile = await command(base, "services/orders", "services-orders:compile");
    const ok = await adapter.parseResults(compile, execution(), base);
    expect(ok).toMatchObject({ parse: "parsed", diagnostics: [] });
    expect(ok.note).toContain("could not be read");

    const silentFailure = await adapter.parseResults(compile, execution({ exitCode: 1 }), base);
    expect(silentFailure.parse).toBe("unparseable");

    const killed = await adapter.parseResults(
      compile,
      execution({ exitCode: null, signal: "SIGKILL" }),
      base,
    );
    expect(killed.parse).toBe("unparseable");
  });
});

describe("parseCompilerOutput", () => {
  it("understands Maven, javac and kotlinc formats and removes duplicates", () => {
    const output = [
      `[ERROR] ${ROOT}/a/src/main/java/A.java:[10,5] cannot find symbol`,
      `[ERROR] ${ROOT}/a/src/main/java/A.java:[10,5] cannot find symbol`,
      `[WARNING] ${ROOT}/a/src/main/java/A.java:[3,8] unchecked conversion`,
      `${ROOT}/b/src/main/java/B.java:7: error: ';' expected`,
      `e: file://${ROOT}/c/src/main/kotlin/C.kt:4:9 Unresolved reference: foo`,
      "C:\\elsewhere\\D.java:2: error: class D is public",
      "[INFO] BUILD FAILURE",
    ].join("\n");
    expect(parseCompilerOutput(output, ROOT)).toEqual([
      {
        tool: "javac",
        severity: "error",
        message: "cannot find symbol",
        location: { path: "a/src/main/java/A.java", line: 10, column: 5 },
      },
      {
        tool: "javac",
        severity: "warning",
        message: "unchecked conversion",
        location: { path: "a/src/main/java/A.java", line: 3, column: 8 },
      },
      {
        tool: "javac",
        severity: "error",
        message: "';' expected",
        location: { path: "b/src/main/java/B.java", line: 7 },
      },
      {
        tool: "kotlinc",
        severity: "error",
        message: "Unresolved reference: foo",
        location: { path: "c/src/main/kotlin/C.kt", line: 4, column: 9 },
      },
      { tool: "javac", severity: "error", message: "D.java: class D is public" },
    ]);
  });

  it("matches Windows paths case-insensitively", () => {
    const output = "[ERROR] c:\\Work\\Repo\\src\\main\\java\\A.java:[1,1] boom";
    expect(parseCompilerOutput(output, "C:\\work\\repo")[0]?.location?.path).toBe(
      "src/main/java/A.java",
    );
  });
});
