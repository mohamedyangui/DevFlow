import type { TaskContract } from "../schemas/task.js";
import { TaskIssueCode, formatIssuePath, type IssuePath, type ValidationIssue } from "./issues.js";

/**
 * Deterministic checks on a normalized task contract. They run before any model is involved
 * and never invent content: they only report what is missing or inconsistent.
 *
 * Errors make the contract unusable (broken references, ambiguous ids). Warnings flag gaps
 * that requirements analysis must address, such as missing acceptance criteria. A task
 * without acceptance criteria is still loadable, because detecting that gap is part of
 * DevFlow's job (assist mode).
 */
export function lintTask(contract: TaskContract): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const error = (code: ValidationIssue["code"], message: string, path: IssuePath): void => {
    issues.push({ severity: "error", code, message, path });
  };
  const warning = (code: ValidationIssue["code"], message: string, path: IssuePath): void => {
    issues.push({ severity: "warning", code, message, path });
  };

  // Duplicate ids.
  const checkDuplicates = (ids: readonly string[], basePath: IssuePath): void => {
    const firstIndex = new Map<string, number>();
    ids.forEach((id, index) => {
      const first = firstIndex.get(id);
      if (first === undefined) firstIndex.set(id, index);
      else {
        error(
          TaskIssueCode.DuplicateId,
          `${id} is already used by ${formatIssuePath([...basePath, first])}`,
          [...basePath, index, "id"],
        );
      }
    });
  };
  const { functional, nonFunctional } = contract.requirements;
  checkDuplicates(
    functional.map((r) => r.id),
    ["requirements", "functional"],
  );
  checkDuplicates(
    nonFunctional.map((r) => r.id),
    ["requirements", "nonFunctional"],
  );
  checkDuplicates(
    contract.acceptanceCriteria.map((ac) => ac.id),
    ["acceptanceCriteria"],
  );

  // References from acceptance criteria to requirements.
  const requirementIds = new Set([...functional, ...nonFunctional].map((r) => r.id));
  contract.acceptanceCriteria.forEach((ac, acIndex) => {
    ac.covers.forEach((ref, refIndex) => {
      if (!requirementIds.has(ref)) {
        error(
          TaskIssueCode.UnknownRequirementRef,
          `${ac.id} covers ${ref}, but no requirement has that id`,
          ["acceptanceCriteria", acIndex, "covers", refIndex],
        );
      }
    });
    if ((ac.given !== undefined || ac.when !== undefined) && ac.then === undefined) {
      warning(
        TaskIssueCode.IncompleteGivenWhenThen,
        `${ac.id} has a "given"/"when" clause but no "then" clause describing the expected outcome`,
        ["acceptanceCriteria", acIndex],
      );
    }
  });

  // Coverage and completeness.
  if (contract.acceptanceCriteria.length === 0) {
    warning(
      TaskIssueCode.NoAcceptanceCriteria,
      "the task has no acceptance criteria; requirements analysis will ask for them before any code is changed",
      ["acceptanceCriteria"],
    );
  } else if (functional.length > 0) {
    const anyCoverage = contract.acceptanceCriteria.some((ac) => ac.covers.length > 0);
    if (!anyCoverage) {
      warning(
        TaskIssueCode.NoTraceability,
        'no acceptance criterion declares which requirements it "covers", so requirement coverage cannot be traced',
        ["acceptanceCriteria"],
      );
    } else {
      const covered = new Set(contract.acceptanceCriteria.flatMap((ac) => ac.covers));
      functional.forEach((requirement, index) => {
        if (!covered.has(requirement.id)) {
          warning(
            TaskIssueCode.UncoveredRequirement,
            `${requirement.id} is not covered by any acceptance criterion`,
            ["requirements", "functional", index],
          );
        }
      });
    }
  }
  if (contract.definitionOfDone.length === 0) {
    warning(TaskIssueCode.EmptyDefinitionOfDone, "the task has no definition of done", [
      "definitionOfDone",
    ]);
  }

  return issues;
}
