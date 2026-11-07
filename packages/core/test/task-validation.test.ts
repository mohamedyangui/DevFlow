import { describe, expect, it } from "vitest";
import {
  TaskIssueCode,
  normalizeTask,
  TaskFile,
  validateTaskInput,
  type TaskSource,
  type ValidationIssue,
} from "../src/index.js";

const source: TaskSource = { kind: "file", ref: "task.yaml", trust: "user" };

function codes(issues: readonly ValidationIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

function errorAt(issues: readonly ValidationIssue[], path: readonly (string | number)[]) {
  return issues.find(
    (issue) => issue.severity === "error" && JSON.stringify(issue.path) === JSON.stringify(path),
  );
}

describe("schema validation", () => {
  it("accepts a minimal task and reports the gaps as warnings", () => {
    const result = validateTaskInput({ id: "T-1", title: "Minimal" }, source);
    expect(result.valid).toBe(true);
    expect(codes(result.issues)).toEqual([
      TaskIssueCode.NoAcceptanceCriteria,
      TaskIssueCode.EmptyDefinitionOfDone,
    ]);
    expect(result.issues.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("reports missing required fields", () => {
    const result = validateTaskInput({ id: "T-1" }, source);
    expect(result.valid).toBe(false);
    expect(result.contract).toBeUndefined();
    expect(errorAt(result.issues, ["title"])?.message).toBe("required field is missing");
  });

  it("rejects unknown keys so typos are not silently ignored", () => {
    const result = validateTaskInput({ id: "T-1", title: "x", acceptanceCriterias: [] }, source);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.message).toContain("acceptanceCriterias");
  });

  it("explains malformed ids at the exact path", () => {
    const result = validateTaskInput(
      { id: "T-1", title: "x", acceptanceCriteria: [{ id: "AC1", statement: "s" }] },
      source,
    );
    expect(errorAt(result.issues, ["acceptanceCriteria", 0, "id"])?.message).toContain(
      "acceptance criterion id such as AC-1",
    );
  });

  it("requires ids in each requirement list to use the matching prefix", () => {
    const result = validateTaskInput(
      { id: "T-1", title: "x", requirements: { nonFunctional: [{ id: "FR-1", text: "t" }] } },
      source,
    );
    expect(errorAt(result.issues, ["requirements", "nonFunctional", 0, "id"])).toBeDefined();
  });

  it("requires a statement or a then clause on structured acceptance criteria", () => {
    const result = validateTaskInput(
      { id: "T-1", title: "x", acceptanceCriteria: [{ given: "a", when: "b" }] },
      source,
    );
    expect(errorAt(result.issues, ["acceptanceCriteria", 0])?.message).toContain('"then" clause');
  });

  it("explains values that match no allowed shape", () => {
    const result = validateTaskInput({ id: "T-1", title: "x", acceptanceCriteria: [42] }, source);
    expect(errorAt(result.issues, ["acceptanceCriteria", 0])?.message).toBe(
      "expected string or object, received number",
    );
  });

  it("reports the nested problem when an item has the object shape but a bad field", () => {
    const result = validateTaskInput(
      {
        id: "T-1",
        title: "x",
        acceptanceCriteria: [{ statement: 42 }, { then: "ok", verification: "sometimes" }],
      },
      source,
    );
    expect(errorAt(result.issues, ["acceptanceCriteria", 0, "statement"])?.message).toContain(
      "expected string",
    );
    expect(errorAt(result.issues, ["acceptanceCriteria", 1, "verification"])).toBeDefined();
    expect(errorAt(result.issues, ["acceptanceCriteria", 0])).toBeUndefined();
  });

  it("rejects scope globs that escape the repository", () => {
    const result = validateTaskInput(
      { id: "T-1", title: "x", scope: { include: ["../other-repo/**"] } },
      source,
    );
    expect(errorAt(result.issues, ["scope", "include", 0])?.message).toContain('".." segments');
  });

  it("rejects unsupported schema versions", () => {
    const result = validateTaskInput({ schemaVersion: 2, id: "T-1", title: "x" }, source);
    expect(errorAt(result.issues, ["schemaVersion"])).toBeDefined();
  });

  it("allows a $schema key for editor support", () => {
    const result = validateTaskInput(
      { $schema: "../schemas/task.schema.json", id: "T-1", title: "x" },
      source,
    );
    expect(result.valid).toBe(true);
  });
});

describe("normalizeTask", () => {
  const normalize = (input: unknown) => normalizeTask(TaskFile.parse(input), source);

  it("assigns the lowest free ids without changing explicit ones, preserving order", () => {
    const contract = normalize({
      id: "T-1",
      title: "x",
      acceptanceCriteria: ["first", { id: "AC-1", statement: "explicit" }, "third"],
    });
    expect(contract.acceptanceCriteria.map((ac) => ac.id)).toEqual(["AC-2", "AC-1", "AC-3"]);
    expect(contract.acceptanceCriteria.map((ac) => ac.statement)).toEqual([
      "first",
      "explicit",
      "third",
    ]);
  });

  it("composes a statement from Given/When/Then and keeps the clauses", () => {
    const contract = normalize({
      id: "T-1",
      title: "x",
      acceptanceCriteria: [
        { given: "25 orders", when: "page 2 is requested", then: "10 are shown" },
      ],
    });
    expect(contract.acceptanceCriteria[0]).toMatchObject({
      statement: "Given 25 orders, when page 2 is requested, then 10 are shown",
      given: "25 orders",
      when: "page 2 is requested",
      then: "10 are shown",
    });
  });

  it("makes every default explicit", () => {
    const contract = normalize({
      id: "T-1",
      title: "x",
      requirements: { functional: ["f"], nonFunctional: ["n"] },
      acceptanceCriteria: ["a"],
    });
    expect(contract.schemaVersion).toBe(1);
    expect(contract.requirements.functional[0]).toEqual({
      id: "FR-1",
      text: "f",
      priority: "must",
    });
    expect(contract.requirements.nonFunctional[0]).toEqual({
      id: "NFR-1",
      text: "n",
      category: "other",
    });
    expect(contract.acceptanceCriteria[0]).toEqual({
      id: "AC-1",
      statement: "a",
      covers: [],
      verification: "automated",
      testIntent: "feature",
    });
    expect(contract.testing).toEqual({ levels: [], testFirst: true });
    expect(contract.scope).toEqual({ modules: [], include: [], exclude: [] });
    expect(contract.description).toBe("");
    expect(contract.metadata).toEqual({});
  });
});

describe("lint", () => {
  const base = { id: "T-1", title: "x", definitionOfDone: ["done"] };

  it("produces no issues for a complete, consistent task", () => {
    const result = validateTaskInput(
      {
        ...base,
        requirements: { functional: [{ id: "FR-1", text: "f" }], nonFunctional: ["n"] },
        acceptanceCriteria: [{ statement: "a", covers: ["FR-1", "NFR-1"] }],
      },
      source,
    );
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("reports duplicate ids as errors", () => {
    const result = validateTaskInput(
      {
        ...base,
        acceptanceCriteria: [
          { id: "AC-1", statement: "a" },
          { id: "AC-1", statement: "b" },
        ],
      },
      source,
    );
    expect(result.valid).toBe(false);
    const duplicate = result.issues.find((issue) => issue.code === TaskIssueCode.DuplicateId);
    expect(duplicate?.path).toEqual(["acceptanceCriteria", 1, "id"]);
    expect(duplicate?.message).toBe("AC-1 is already used by acceptanceCriteria[0]");
  });

  it("reports references to unknown requirements as errors", () => {
    const result = validateTaskInput(
      {
        ...base,
        requirements: { functional: ["f"] },
        acceptanceCriteria: [{ statement: "a", covers: ["FR-1", "FR-9"] }],
      },
      source,
    );
    expect(result.valid).toBe(false);
    expect(errorAt(result.issues, ["acceptanceCriteria", 0, "covers", 1])?.code).toBe(
      TaskIssueCode.UnknownRequirementRef,
    );
  });

  it("warns when no criterion declares coverage", () => {
    const result = validateTaskInput(
      { ...base, requirements: { functional: ["f"] }, acceptanceCriteria: ["a"] },
      source,
    );
    expect(result.valid).toBe(true);
    expect(codes(result.issues)).toEqual([TaskIssueCode.NoTraceability]);
  });

  it("warns about functional requirements that no criterion covers", () => {
    const result = validateTaskInput(
      {
        ...base,
        requirements: { functional: ["f1", "f2"] },
        acceptanceCriteria: [{ statement: "a", covers: ["FR-1"] }],
      },
      source,
    );
    const uncovered = result.issues.find(
      (issue) => issue.code === TaskIssueCode.UncoveredRequirement,
    );
    expect(uncovered?.path).toEqual(["requirements", "functional", 1]);
    expect(uncovered?.message).toBe("FR-2 is not covered by any acceptance criterion");
  });

  it("warns about Given/When without Then", () => {
    const result = validateTaskInput(
      { ...base, acceptanceCriteria: [{ statement: "s", given: "g" }] },
      source,
    );
    expect(codes(result.issues)).toEqual([TaskIssueCode.IncompleteGivenWhenThen]);
  });
});
