import type {
  AcceptanceCriterion,
  FunctionalRequirement,
  NonFunctionalRequirement,
  TaskContract,
  TaskFile,
  TaskSource,
} from "../schemas/task.js";

/**
 * Turns a schema-valid `TaskFile` into a `TaskContract`:
 * - assigns ids to items that have none (explicit ids are never changed);
 * - expands string shorthands into full objects;
 * - makes every default explicit.
 *
 * Array order is preserved, so issue paths computed on the contract also point at the right
 * place in the source file. Duplicate explicit ids are kept as-is and reported by the linter.
 */
export function normalizeTask(file: TaskFile, source: TaskSource): TaskContract {
  const functionalInputs = file.requirements?.functional ?? [];
  const functionalIds = assignIds(functionalInputs, "FR", (input) =>
    typeof input === "string" ? undefined : input.id,
  );
  const functional = functionalInputs.map((input, index): FunctionalRequirement =>
    typeof input === "string"
      ? { id: at(functionalIds, index), text: input, priority: "must" }
      : { id: at(functionalIds, index), text: input.text, priority: input.priority ?? "must" },
  );

  const nonFunctionalInputs = file.requirements?.nonFunctional ?? [];
  const nonFunctionalIds = assignIds(nonFunctionalInputs, "NFR", (input) =>
    typeof input === "string" ? undefined : input.id,
  );
  const nonFunctional = nonFunctionalInputs.map((input, index): NonFunctionalRequirement =>
    typeof input === "string"
      ? { id: at(nonFunctionalIds, index), text: input, category: "other" }
      : {
          id: at(nonFunctionalIds, index),
          text: input.text,
          category: input.category ?? "other",
        },
  );

  const acInputs = file.acceptanceCriteria ?? [];
  const acIds = assignIds(acInputs, "AC", (input) =>
    typeof input === "string" ? undefined : input.id,
  );
  const acceptanceCriteria = acInputs.map((input, index): AcceptanceCriterion => {
    const id = at(acIds, index);
    if (typeof input === "string") {
      return {
        id,
        statement: input,
        covers: [],
        verification: "automated",
        testIntent: "feature",
      };
    }
    return {
      id,
      statement: input.statement ?? composeGivenWhenThen(input),
      ...(input.given === undefined ? {} : { given: input.given }),
      ...(input.when === undefined ? {} : { when: input.when }),
      ...(input.then === undefined ? {} : { then: input.then }),
      covers: input.covers ?? [],
      verification: input.verification ?? "automated",
      ...(input.testLevel === undefined ? {} : { testLevel: input.testLevel }),
      testIntent: input.testIntent ?? "feature",
    };
  });

  return {
    schemaVersion: 1,
    id: file.id,
    title: file.title,
    description: (file.description ?? "").trim(),
    source,
    requirements: { functional, nonFunctional },
    acceptanceCriteria,
    constraints: file.constraints ?? [],
    scope: {
      modules: file.scope?.modules ?? [],
      include: file.scope?.include ?? [],
      exclude: file.scope?.exclude ?? [],
    },
    testing: {
      levels: file.testing?.levels ?? [],
      testFirst: file.testing?.testFirst ?? true,
      ...(file.testing?.notes === undefined ? {} : { notes: file.testing.notes }),
    },
    definitionOfDone: file.definitionOfDone ?? [],
    metadata: file.metadata ?? {},
  };
}

/**
 * Returns an id for every item: the explicit id when present, otherwise the lowest
 * `<prefix>-<n>` not used by any explicit or previously assigned id.
 */
function assignIds<T>(
  items: readonly T[],
  prefix: string,
  explicitId: (item: T) => string | undefined,
): string[] {
  const used = new Set<string>();
  for (const item of items) {
    const id = explicitId(item);
    if (id !== undefined) used.add(id);
  }
  let next = 1;
  return items.map((item) => {
    const id = explicitId(item);
    if (id !== undefined) return id;
    while (used.has(`${prefix}-${next}`)) next++;
    const assigned = `${prefix}-${next}`;
    used.add(assigned);
    return assigned;
  });
}

function composeGivenWhenThen(clauses: {
  readonly given?: string | undefined;
  readonly when?: string | undefined;
  readonly then?: string | undefined;
}): string {
  const parts = [
    clauses.given === undefined ? undefined : `given ${clauses.given}`,
    clauses.when === undefined ? undefined : `when ${clauses.when}`,
    clauses.then === undefined ? undefined : `then ${clauses.then}`,
  ].filter((part): part is string => part !== undefined);
  const sentence = parts.join(", ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function at(values: readonly string[], index: number): string {
  const value = values[index];
  if (value === undefined) throw new Error(`internal error: no id assigned at index ${index}`);
  return value;
}
