import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { FakeProvider } from "@devflow/ai";
import {
  type ApprovedCommand,
  CommandSpec,
  EngineeringReport,
  type ExecutionResult,
  type GitDiff,
  type GitInspection,
  type GitWorkspace,
  type PolicyDecision,
  StaticToolchainProbe,
  substituteParameters,
} from "@devflow/core";
import { describe, expect, it, vi } from "vitest";
import {
  ReviewContracts,
  RunStore,
  type TestRunner,
  type WorkflowServices,
  startRun,
} from "../src/index.js";
import {
  OPENAPI_BASE as IMPACT_OPENAPI_BASE,
  PROTO_BASE as IMPACT_PROTO_BASE,
  REPOSITORY as IMPACT_REPOSITORY,
} from "../../contracts/test/impact-fixture.js";
import { analysisAnswer, isAnalysis, services, settings, task, workspace } from "./helpers.js";

/**
 * Review mode compares the contract files a change touches (ADR 0021): the base version read
 * through git, the head version from the working tree. oasdiff and buf are not installed here:
 * the tool path runs with a fake policy and executor.
 */

const BASE = "a".repeat(40);
const HEAD = "c".repeat(40);

const OPENAPI_BASE = `openapi: 3.0.3
info: { title: Shop, version: "1" }
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  total: { type: integer }
                  status: { type: string }
  /orders/{id}:
    delete:
      responses:
        "204": { description: deleted }
`;

const OPENAPI_HEAD = `openapi: 3.0.3
info: { title: Shop, version: "2" }
paths:
  /orders:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  status: { type: string, format: uuid }
                  note: { type: string }
`;

const PROTO_BASE = 'syntax = "proto3";\npackage shop;\nmessage Order { string id = 1; }\n';
const PROTO_HEAD =
  'syntax = "proto3";\npackage shop;\nmessage Order { string id = 1; string note = 2; }\n';

type DiffFile = GitDiff["files"][number];

const modified = (file: string): DiffFile => ({
  path: file,
  change: "modified",
  additions: 1,
  deletions: 1,
  binary: false,
  tracked: true,
});

/** A repository whose diff and base versions are given. */
class ContractGit implements GitWorkspace {
  readonly shown: string[] = [];

  constructor(
    private readonly files: DiffFile[],
    private readonly baseFiles: Record<string, string>,
  ) {}

  inspect(): Promise<GitInspection> {
    return Promise.resolve({
      kind: "repository",
      head: HEAD,
      branch: "feature",
      changes: this.files.map((f) => f.path),
    });
  }
  currentBranch(): Promise<string | null> {
    return Promise.resolve("feature");
  }
  freeBranchName(base: string): Promise<string> {
    return Promise.resolve(base);
  }
  createBranch(): Promise<void> {
    return Promise.reject(new Error("a review never creates a branch"));
  }
  commit(): Promise<string> {
    return Promise.reject(new Error("a review never commits"));
  }
  mergeBase(): Promise<string> {
    return Promise.resolve(BASE);
  }
  diff(base: string): Promise<GitDiff> {
    return Promise.resolve({
      base,
      head: HEAD,
      files: this.files,
      patch: "",
      patchTruncated: false,
    });
  }
  remoteUrl(): Promise<string | null> {
    return Promise.resolve(null);
  }
  show(commit: string, file: string): Promise<string | null> {
    expect(commit).toBe(BASE);
    this.shown.push(file);
    return Promise.resolve(this.baseFiles[file] ?? null);
  }
}

const testRunner: TestRunner = {
  modules: [],
  gates: () => Promise.resolve([]),
  run: () => Promise.resolve({ gates: [], denials: [] }),
};

function reviewer(): FakeProvider {
  return new FakeProvider((request) => {
    if (isAnalysis(request)) return analysisAnswer();
    return JSON.stringify({ summary: "The API changes.", findings: [] });
  });
}

async function setUp(root: string): Promise<ContractGit> {
  await mkdir(path.join(root, "api"), { recursive: true });
  await writeFile(path.join(root, "api", "openapi.yaml"), OPENAPI_HEAD);
  await writeFile(path.join(root, "api", "shop.proto"), PROTO_HEAD);
  return new ContractGit(
    [modified("api/openapi.yaml"), modified("api/shop.proto"), modified("src/orders.ts")],
    { "api/openapi.yaml": OPENAPI_BASE, "api/shop.proto": PROTO_BASE },
  );
}

async function review(root: string, overrides: Partial<WorkflowServices>, skipGates?: string) {
  const svc = await services(root, reviewer(), {
    testRunner: () => Promise.resolve(testRunner),
    ...overrides,
  });
  const outcome = await startRun(
    {
      task: task(),
      taskFile: null,
      mode: "review",
      goal: "review",
      settings: settings(),
      review: { base: "main", ...(skipGates === undefined ? {} : { skipGates }) },
    },
    svc,
  );
  const store = await RunStore.open(root, outcome.runId);
  const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
  const contracts = ReviewContracts.parse(
    JSON.parse(await store.readText("artifacts/review-contracts.json")),
  );
  return { outcome, store, report, contracts };
}

describe("review mode: contract compatibility", () => {
  it("compares changed contracts with the built-in rules and confirms breaking changes", async () => {
    const root = await workspace();
    const git = await setUp(root);
    const { outcome, report, contracts, store } = await review(root, { git });

    expect(outcome.status).toBe("completed");
    expect(git.shown).toEqual(["api/openapi.yaml", "api/shop.proto"]);
    expect(
      contracts.contracts.map((diff) => [diff.file, diff.kind, diff.decidedBy, diff.summary]),
    ).toEqual([
      ["api/openapi.yaml", "openapi", "builtin-rules", { breaking: 2, nonBreaking: 1, unknown: 1 }],
      ["api/shop.proto", "protobuf", "builtin-rules", { breaking: 0, nonBreaking: 1, unknown: 0 }],
    ]);

    const findings = report.findings.filter((finding) => finding.title.startsWith("Breaking"));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      title: "Breaking OpenAPI contract change in api/openapi.yaml: 2 breaking change(s)",
      severity: "high",
      category: "compatibility",
      source: "deterministic",
      verification: "confirmed",
      location: { path: "api/openapi.yaml" },
    });
    expect(
      findings[0]?.evidence.map((item) => [item.kind, item.deterministic, item.description]),
    ).toEqual([
      [
        "tool-report",
        true,
        '[response-property-removed, decided by builtin-rules] GET /orders: the 200 response (application/json) property "total" was removed',
      ],
      [
        "tool-report",
        true,
        "[operation-removed, decided by builtin-rules] DELETE /orders/{id}: the operation was removed",
      ],
      [
        "note",
        true,
        "no consumer of the breaking changes was found by the heuristics (Spring mappings, HTTP client calls, operation ids, generated-code imports); that does not prove there is none",
      ],
    ]);
    // A confirmed high finding fails the review.
    expect(report.verdict).toBe("failed_verification");

    // The undecided change is a manual check, never a finding.
    expect(report.manualChecks.join("\n")).toContain(
      'Check the contract changes in api/openapi.yaml that the rules could not decide (compatibility unknown): GET /orders: the format of the 200 response (application/json) property "status" changed',
    );
    expect(report.findings.some((finding) => finding.title.includes("shop.proto"))).toBe(false);
    expect(await store.readText("report.md")).toContain("Breaking OpenAPI contract change");
  });

  it("lets oasdiff decide when it is installed and allowed, and buf when it is not", async () => {
    const root = await workspace();
    const git = await setUp(root);
    const evaluate = vi.fn((request: { spec: unknown; params?: Record<string, string> }) => {
      const spec = CommandSpec.parse(request.spec);
      const args = substituteParameters(spec, request.params ?? {});
      if (typeof args === "string") throw new Error(args);
      const decision: PolicyDecision =
        spec.executable === "buf"
          ? {
              allowed: false,
              reason: "approval-required",
              message: "approval required",
              fingerprint: "f",
            }
          : {
              allowed: true,
              command: { commandId: spec.id, spec, args } as unknown as ApprovedCommand,
            };
      return Promise.resolve(decision);
    });
    const run = vi.fn((command: ApprovedCommand) =>
      Promise.resolve<ExecutionResult>({
        record: {
          commandId: command.commandId,
          argv: [command.spec.executable, ...command.args],
          cwd: ".",
          invocation: "direct",
          approval: { via: "allowlist-flag" },
          startedAt: "2026-11-10T10:00:00.000Z",
          durationMs: 5,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath: ".devflow/x.out",
          stderrPath: ".devflow/x.err",
          outputTruncated: false,
        },
        stdout: JSON.stringify([
          {
            id: "api-removed-without-deprecation",
            level: 3,
            operation: "DELETE",
            path: "/orders/{id}",
            text: "api removed",
          },
        ]),
        stderr: "",
        invocation: {
          strategy: "direct",
          file: "oasdiff",
          args: [],
          windowsVerbatimArguments: false,
        },
      }),
    );
    const contractTools = vi.fn(() =>
      Promise.resolve({
        toolchain: new StaticToolchainProbe(["oasdiff", "buf"]),
        policy: { evaluate },
        executor: { run },
        logDir: "unused",
      }),
    );
    const { contracts, report, store } = await review(root, { git, contractTools });

    expect(contractTools).toHaveBeenCalledTimes(1);
    const [openapi, proto] = contracts.contracts;
    expect(openapi).toMatchObject({ decidedBy: "tool:oasdiff", summary: { breaking: 1 } });
    // The base version is copied into the run for the tool; the head is the working tree file.
    const args = run.mock.calls[0]?.[0].args ?? [];
    expect(args[1]).toBe(store.workspacePath("contracts/base/api/openapi.yaml"));
    expect(args[2]).toBe("api/openapi.yaml");
    expect(proto?.decidedBy).toBe("builtin-rules");
    expect(proto?.notes[0]).toContain(
      "buf did not decide: denied by the command policy (approval-required)",
    );
    const finding = report.findings.find((item) => item.title.startsWith("Breaking"));
    expect(finding?.evidence[0]?.description).toBe(
      "[api-removed-without-deprecation, decided by tool:oasdiff] DELETE /orders/{id}: api removed",
    );
  });

  it("never runs contract tools when the gates are skipped", async () => {
    const root = await workspace();
    const git = await setUp(root);
    const contractTools = vi.fn();
    const { contracts } = await review(root, { git, contractTools }, "a fork's code is not run");
    expect(contractTools).not.toHaveBeenCalled();
    expect(contracts.contracts.every((diff) => diff.decidedBy === "builtin-rules")).toBe(true);
  });

  it("reports added and deleted contracts, and contracts it cannot compare", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "api"), { recursive: true });
    await writeFile(path.join(root, "api", "new.proto"), PROTO_BASE);
    const git = new ContractGit(
      [
        { ...modified("api/new.proto"), change: "added" },
        { ...modified("api/old.proto"), change: "deleted" },
      ],
      { "api/old.proto": PROTO_BASE },
    );
    const { contracts, report } = await review(root, { git });
    expect(contracts.contracts.map((diff) => [diff.file, diff.changes.map((c) => c.rule)])).toEqual(
      [
        ["api/new.proto", ["contract-added"]],
        ["api/old.proto", ["contract-removed"]],
      ],
    );
    expect(report.findings.map((finding) => finding.title)).toContain(
      "Breaking Protobuf contract change in api/old.proto: 1 breaking change(s)",
    );

    // Without a way to read the base version, the contract is a manual check.
    const root2 = await workspace();
    await mkdir(path.join(root2, "api"), { recursive: true });
    await writeFile(path.join(root2, "api", "shop.proto"), PROTO_HEAD);
    const blind = new ContractGit([modified("api/shop.proto")], {});
    const noShow: GitWorkspace = {
      inspect: () => blind.inspect(),
      currentBranch: () => blind.currentBranch(),
      freeBranchName: (name) => blind.freeBranchName(name),
      createBranch: () => blind.createBranch(),
      commit: () => blind.commit(),
      mergeBase: () => blind.mergeBase(),
      diff: (base) => blind.diff(base),
      remoteUrl: () => blind.remoteUrl(),
    };
    const second = await review(root2, { git: noShow });
    expect(second.contracts.skipped).toEqual([
      { path: "api/shop.proto", reason: "the base version cannot be read without git" },
    ]);
    expect(second.report.manualChecks.join("\n")).toContain(
      "Check the contract api/shop.proto yourself: it was not compared",
    );
  });
});

describe("review mode: change impact", () => {
  it("lists the consumers of each breaking change in the finding evidence and the Impact section", async () => {
    // The mini repository of the contracts package: a Spring controller, a Java gRPC service,
    // a TypeScript client and a Python module consume one OpenAPI document and one .proto.
    const root = await workspace(IMPACT_REPOSITORY);
    const git = new ContractGit(
      [modified("api/openapi.yaml"), modified("proto/shop/v1/orders.proto")],
      {
        "api/openapi.yaml": IMPACT_OPENAPI_BASE,
        "proto/shop/v1/orders.proto": IMPACT_PROTO_BASE,
      },
    );
    const { outcome, report, contracts, store } = await review(root, { git });
    expect(outcome.status).toBe("completed");

    expect(contracts.impact?.map((entry) => [entry.file, entry.rule, entry.target])).toEqual([
      ["api/openapi.yaml", "operation-removed", "DELETE /orders/{id}"],
      ["proto/shop/v1/orders.proto", "field-removed", "shop.v1.Order (proto/shop/v1/orders.proto)"],
    ]);
    const [openapi, proto] = contracts.impact ?? [];
    expect(openapi?.consumers.map((ref) => [ref.path, ref.kind, ref.confidence])).toEqual([
      [
        "services/orders/src/main/java/com/shop/orders/OrderController.java",
        "spring-mapping",
        "exact",
      ],
      ["services/orders/src/test/java/com/shop/orders/OrderControllerTest.java", "test", "exact"],
      ["tools/sync/orders_client.py", "python-client-call", "pattern"],
      ["web/src/api/orders.ts", "ts-client-call", "exact"],
      ["web/src/api/orders.ts", "operation-id-call", "pattern"],
      ["web/test/orders.test.ts", "test", "pattern"],
    ]);
    // Generated code is never a consumer.
    expect(proto?.consumers.map((ref) => ref.path)).toEqual([
      "services/orders/src/main/java/com/shop/orders/OrderGrpcService.java",
      "services/orders/src/main/java/com/shop/orders/OrderGrpcService.java",
      "tools/sync/orders_client.py",
      "web/src/api/orders.ts",
    ]);

    // The report carries the impact, and the findings list the consumers as file evidence.
    expect(report.impact).toEqual(contracts.impact);
    const finding = report.findings.find((item) => item.title.includes("api/openapi.yaml"));
    expect(finding?.verification).toBe("confirmed");
    expect(finding?.recommendation).toContain("the consumers found are listed as evidence");
    const consumers = (finding?.evidence ?? []).filter((item) => item.kind === "file");
    expect(consumers.map((item) => [item.path, item.line])).toContainEqual([
      "services/orders/src/main/java/com/shop/orders/OrderController.java",
      15,
    ]);
    expect(consumers.map((item) => item.description)).toContain(
      "consumer of DELETE /orders/{id}: python-client-call, pattern match only, may be a false positive: delete DELETE <base>/api/orders/{}",
    );
    expect(report.manualChecks.join(" ")).toContain("found by a pattern only");

    const markdown = await store.readText("report.md");
    expect(markdown).toContain("## Impact");
    expect(markdown).toContain(
      "- `services/orders/src/main/java/com/shop/orders/OrderController.java:15` java, spring-mapping, exact: @DeleteMapping DELETE /api/orders/{}",
    );
    expect(markdown).toContain(
      "- `tools/sync/orders_client.py:9` python, python-client-call, pattern only:",
    );
  }, 30_000);

  it("searches no consumer when no change is breaking", async () => {
    const root = await workspace();
    const git = await setUp(root);
    await writeFile(path.join(root, "api", "openapi.yaml"), OPENAPI_BASE);
    const { report, contracts } = await review(root, { git });
    expect(contracts.impact).toBeUndefined();
    expect(report.impact).toBeUndefined();
  });
});
