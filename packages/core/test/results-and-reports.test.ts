import { describe, expect, it } from "vitest";
import {
  EngineeringReport,
  Finding,
  GateResult,
  ProjectConfig,
  type ExecutionRecord,
  type GateResult as GateResultType,
} from "../src/index.js";

const execution = (exitCode: number, timedOut = false): ExecutionRecord => ({
  commandId: "backend:test",
  argv: ["./mvnw", "-B", "test"],
  cwd: "services/orders",
  invocation: "direct",
  approval: { via: "trust-store" },
  startedAt: "2026-11-06T10:00:00Z",
  durationMs: 1234,
  exitCode,
  signal: null,
  timedOut,
  stdoutPath: ".devflow/runs/r1/logs/backend-test.out.log",
  stderrPath: ".devflow/runs/r1/logs/backend-test.err.log",
  outputTruncated: false,
});

const passedTest = {
  id: "OrderControllerTest#ac1_returnsSecondPage",
  name: "ac1_returnsSecondPage",
  outcome: "passed",
  status: "passed",
  markers: ["AC-1"],
} as const;

const gate = (overrides: Partial<GateResultType>): unknown => ({
  gateId: "backend-test",
  commandId: "backend:test",
  required: true,
  status: "passed",
  execution: execution(0),
  tests: [passedTest],
  diagnostics: [],
  evidence: [],
  ...overrides,
});

function messages(
  schema: {
    safeParse(input: unknown): { success: boolean; error?: { issues: { message: string }[] } };
  },
  input: unknown,
): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.message);
}

describe("GateResult invariants", () => {
  it("accepts an executed, passing gate", () => {
    expect(messages(GateResult, gate({}))).toEqual([]);
  });

  it("refuses a passed gate without an execution record", () => {
    expect(messages(GateResult, gate({ execution: undefined }))).toContain(
      'a gate can only be "passed" if it was executed',
    );
  });

  it("refuses a passed gate with a non-zero exit code or a timeout", () => {
    expect(messages(GateResult, gate({ execution: execution(1) }))).toContain(
      "a passed gate requires exit code 0 and no timeout",
    );
    expect(messages(GateResult, gate({ execution: execution(0, true) }))).toContain(
      "a passed gate requires exit code 0 and no timeout",
    );
  });

  it("refuses a passed gate that contains a failed test", () => {
    const failed = { ...passedTest, outcome: "assertion_failure", status: "failed" };
    expect(messages(GateResult, gate({ tests: [failed] as never }))).toContain(
      'a passed gate cannot contain a "failed" test',
    );
  });

  it("requires a reason and no execution for gates that did not run", () => {
    expect(
      messages(GateResult, gate({ status: "not_executed", execution: undefined, tests: [] })),
    ).toEqual(['a "not_executed" gate must explain why']);
    expect(
      messages(
        GateResult,
        gate({ status: "not_executed", reason: "approval required", tests: [] }),
      ),
    ).toEqual(['a "not_executed" gate must not have an execution record']);
    expect(
      messages(
        GateResult,
        gate({
          status: "not_executed",
          reason: "toolchain unavailable",
          execution: undefined,
          tests: [],
        }),
      ),
    ).toEqual([]);
  });
});

describe("Finding invariants", () => {
  const base = {
    id: "F-1",
    title: "Possible N+1 query in OrderService.page",
    severity: "medium",
    category: "quality",
    source: "ai",
    verification: "unverified",
    confidence: 0.6,
    evidence: [],
    recommendation: "Fetch customers with a join.",
  } as const;

  it("accepts an unverified AI suspicion", () => {
    expect(messages(Finding, base)).toEqual([]);
  });

  it("refuses to confirm an AI finding without deterministic evidence", () => {
    expect(
      messages(Finding, {
        ...base,
        verification: "confirmed",
        evidence: [{ kind: "note", description: "the model is confident", deterministic: false }],
      }),
    ).toEqual(["a finding can only be confirmed with deterministic evidence"]);
  });

  it("allows confirming an AI finding with a failing test as evidence", () => {
    expect(
      messages(Finding, {
        ...base,
        verification: "confirmed",
        evidence: [
          {
            kind: "test-report",
            description: "OrderServiceTest#nPlusOne failed",
            deterministic: true,
          },
        ],
      }),
    ).toEqual([]);
  });

  it("requires AI findings to state a confidence", () => {
    const { confidence, ...withoutConfidence } = base;
    expect(messages(Finding, withoutConfidence)).toEqual(["AI findings must state a confidence"]);
  });
});

describe("EngineeringReport invariants", () => {
  const report = {
    schemaVersion: 1,
    run: {
      id: "2026-11-06T10-00-00Z_TASK-142",
      devflowVersion: "0.1.0",
      mode: "implement",
      state: "COMPLETED",
      startedAt: "2026-11-06T10:00:00Z",
      finishedAt: "2026-11-06T10:20:00Z",
    },
    verdict: "verified",
    task: { id: "TASK-142", title: "Pagination", source: { kind: "file", trust: "user" } },
    filesChanged: [],
    acceptanceMatrix: [
      {
        acId: "AC-1",
        requirementIds: ["FR-1"],
        verification: "automated",
        tests: [{ testId: passedTest.id, gateId: "backend-test", status: "passed" }],
        status: "verified",
      },
      { acId: "AC-2", requirementIds: [], verification: "manual", tests: [], status: "manual" },
    ],
    gates: [gate({})],
    findings: [],
    risks: [],
    assumptions: [],
    manualChecks: ["AC-2"],
  };

  it("accepts a verified report backed by evidence", () => {
    expect(messages(EngineeringReport, report)).toEqual([]);
  });

  it("refuses a verified verdict when a required gate did not pass", () => {
    const failing = gate({ status: "failed", execution: execution(1), tests: [] });
    expect(messages(EngineeringReport, { ...report, gates: [failing] })).toContain(
      'required gate "backend-test" did not pass',
    );
  });

  it("refuses a verified verdict without any gate", () => {
    expect(messages(EngineeringReport, { ...report, gates: [] })).toContain(
      "a verified verdict requires at least one executed verification gate",
    );
  });

  it("refuses to mark a criterion verified without tests", () => {
    const row = { ...report.acceptanceMatrix[0], tests: [] };
    expect(messages(EngineeringReport, { ...report, acceptanceMatrix: [row] })).toContain(
      "a criterion can only be verified by at least one executed test",
    );
  });

  it("refuses a verified verdict while an automated criterion is unverified", () => {
    const row = { ...report.acceptanceMatrix[0], tests: [], status: "unverified" };
    expect(messages(EngineeringReport, { ...report, acceptanceMatrix: [row] })).toContain(
      "acceptance criterion AC-1 is not verified",
    );
  });

  it("refuses a verified verdict for a failed run, and reports for non-terminal states", () => {
    expect(
      messages(EngineeringReport, { ...report, run: { ...report.run, state: "FAILED" } }),
    ).toContain("only a completed run can be verified");
    expect(
      messages(EngineeringReport, {
        ...report,
        verdict: "not_verified",
        run: { ...report.run, state: "VERIFICATION" },
      }),
    ).toContain("reports are produced for terminal states only");
  });

  it("refuses a verified verdict with a confirmed high-severity finding", () => {
    const finding = {
      id: "F-1",
      title: "Regression: OrderRepositoryIT#findAll",
      severity: "high",
      category: "regression",
      source: "deterministic",
      verification: "confirmed",
      evidence: [
        { kind: "test-report", description: "failed after the change", deterministic: true },
      ],
      recommendation: "Fix the query.",
    };
    expect(messages(EngineeringReport, { ...report, findings: [finding] })).toContain(
      'confirmed high finding "F-1" prevents a verified verdict',
    );
  });
});

describe("ProjectConfig", () => {
  it("fills defaults for a minimal configuration", () => {
    const config = ProjectConfig.parse({ version: 1 });
    expect(config.workflow).toEqual({
      requirePlanApproval: true,
      maxRepairAttempts: 2,
      git: { isolation: "branch", branchPrefix: "devflow/", commit: "per-phase" },
    });
    expect(config.verification).toEqual({ baseline: "auto", gates: [] });
    expect(config.security.additionalProtectedPaths).toEqual([]);
  });

  it("has no place for API keys", () => {
    const result = ProjectConfig.safeParse({
      version: 1,
      ai: { provider: "anthropic", apiKey: "sk-x" },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain("apiKey");
  });

  it("rejects duplicate gate and module ids", () => {
    const result = ProjectConfig.safeParse({
      version: 1,
      modules: [
        { id: "backend", path: "services/a", adapter: "java" },
        { id: "backend", path: "services/b", adapter: "java" },
      ],
      verification: {
        gates: [
          { id: "g", module: "backend", use: "test" },
          { id: "g", module: "backend", use: "lint" },
        ],
      },
    });
    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'duplicate gate id "g"',
      'duplicate module id "backend"',
    ]);
  });
});
