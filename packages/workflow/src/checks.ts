import { type ContextPack, moduleOf } from "@devflow-ai/context";
import {
  type ClarificationQuestion,
  type Contradiction,
  type Dependency,
  type EdgeCase,
  ImplementationPlan,
  ModuleId,
  type PathGuard,
  RepoPath,
  type TaskContract,
  createPathMatcher,
  isDevflowError,
} from "@devflow-ai/core";
import type {
  AnalysisWire,
  ClarificationRecord,
  PlanCheck,
  PlanWire,
  RequirementsAnalysis,
} from "./schemas.js";

/**
 * Deterministic checks applied to model answers before anything is persisted. The model's
 * answer is data: unknown ids and paths are dropped (and the drop is recorded), and plan
 * problems that would make the plan unusable are errors.
 */

export function taskIds(task: TaskContract): Set<string> {
  return new Set([
    ...task.requirements.functional.map((r) => r.id),
    ...task.requirements.nonFunctional.map((r) => r.id),
    ...task.acceptanceCriteria.map((c) => c.id),
  ]);
}

function packPaths(pack: ContextPack): Set<string> {
  return new Set(pack.files.map((file) => file.path));
}

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?.!\s]+$/, "")
    .trim();
}

function nextQuestionNumber(existing: readonly { id: string }[]): number {
  let max = 0;
  for (const question of existing) {
    const n = Number(question.id.slice(2));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max + 1;
}

/** Turns the model's analysis into the persisted artifact and the new clarification questions. */
export function checkAnalysis(input: {
  wire: AnalysisWire;
  task: TaskContract;
  pack: ContextPack;
  iteration: number;
  previous: readonly ClarificationRecord[];
  taskIssues: RequirementsAnalysis["taskIssues"];
}): { analysis: RequirementsAnalysis; newQuestions: ClarificationRecord[] } {
  const { wire, task, pack, iteration, previous } = input;
  const ids = taskIds(task);
  const paths = packPaths(pack);
  const checks: string[] = [];

  const requirementNotes = wire.requirementNotes.filter((note) => {
    if (ids.has(note.id)) return true;
    checks.push(`dropped a note about "${note.id}", which is not an id of the task`);
    return false;
  });

  const seen = new Set(previous.map((question) => normalizeQuestion(question.question)));
  let next = nextQuestionNumber(previous);
  const newQuestions: ClarificationRecord[] = [];
  for (const question of wire.questions) {
    const key = normalizeQuestion(question.question);
    if (seen.has(key)) {
      checks.push(`dropped a question that was already asked: "${question.question}"`);
      continue;
    }
    seen.add(key);
    const relatedIds = question.relatedIds.filter((id) => ids.has(id));
    if (relatedIds.length !== question.relatedIds.length) {
      checks.push(`Q-${next}: removed unknown related ids`);
    }
    newQuestions.push({
      id: `Q-${next}`,
      question: question.question,
      blocking: question.blocking,
      relatedIds,
      askedInIteration: iteration,
      answer: null,
    });
    next += 1;
  }

  const acIds = new Set(task.acceptanceCriteria.map((criterion) => criterion.id));
  const known = (list: readonly string[], label: string, allowed: ReadonlySet<string> = ids) => {
    const kept = [...new Set(list.filter((id) => allowed.has(id)))];
    if (kept.length !== new Set(list).size) checks.push(`${label}: removed unknown ids`);
    return kept;
  };

  const edgeCases: EdgeCase[] = [];
  for (const edge of wire.edgeCases) {
    const id = `EC-${String(edgeCases.length + 1)}`;
    edgeCases.push({
      id,
      description: edge.description,
      relatedIds: known(edge.relatedIds, id),
      coveredBy: known(edge.coveredBy, `${id} coveredBy`, acIds),
    });
  }

  // Every contradiction is resolved by a person: it is linked to a blocking question, an
  // existing one about the same ids when there is one, otherwise a new one.
  const allQuestions = [...previous, ...newQuestions];
  const contradictions: Contradiction[] = [];
  for (const conflict of wire.contradictions) {
    const id = `CT-${String(contradictions.length + 1)}`;
    const conflicting = known(conflict.ids, id);
    if (conflicting.length === 0) {
      checks.push(
        `dropped a contradiction that names no id of the task: "${conflict.description}"`,
      );
      continue;
    }
    const linked = allQuestions.find(
      (question) =>
        question.blocking && conflicting.every((ref) => question.relatedIds.includes(ref)),
    );
    let questionId = linked?.id;
    if (questionId === undefined) {
      questionId = `Q-${String(next)}`;
      next += 1;
      const question: ClarificationRecord = {
        id: questionId,
        question: `${conflicting.join(" and ")} conflict: ${conflict.description} ${conflict.question}`,
        blocking: true,
        relatedIds: conflicting,
        askedInIteration: iteration,
        answer: null,
      };
      newQuestions.push(question);
      allQuestions.push(question);
      checks.push(`${id}: added blocking question ${questionId} so that a person resolves it`);
    }
    contradictions.push({ id, ids: conflicting, description: conflict.description, questionId });
  }

  const dependencies: Dependency[] = wire.dependencies.map((dependency, index) => {
    const id = `DEP-${String(index + 1)}`;
    return {
      id,
      kind: dependency.kind,
      description: dependency.description,
      relatedIds: known(dependency.relatedIds, id),
    };
  });

  const affectedFiles: { path: string; reason: string }[] = [];
  for (const file of wire.affectedFiles) {
    if (RepoPath.safeParse(file.path).success && paths.has(file.path)) {
      affectedFiles.push(file);
    } else {
      checks.push(`dropped affected file "${file.path}", which is not in the repository context`);
    }
  }

  const questions: ClarificationQuestion[] = newQuestions.map(
    ({ askedInIteration, answer, ...question }) => question,
  );
  return {
    analysis: {
      schemaVersion: 1,
      taskId: task.id,
      iteration,
      summary: wire.summary,
      taskIssues: input.taskIssues,
      requirementNotes,
      questions,
      assumptions: wire.assumptions.filter((text) => text.trim() !== ""),
      risks: wire.risks,
      edgeCases,
      contradictions,
      dependencies,
      affectedFiles,
      checks,
    },
    newQuestions,
  };
}

/**
 * Builds an `ImplementationPlan` from the model's answer and checks it against the task, the
 * repository and the path guard. Errors make the plan unusable; warnings are reported with it.
 */
export async function checkPlan(input: {
  wire: PlanWire;
  task: TaskContract;
  pack: ContextPack;
  guard: PathGuard;
}): Promise<{ plan: ImplementationPlan; checks: PlanCheck[] }> {
  const { wire, task, pack, guard } = input;
  const checks: PlanCheck[] = [];
  const error = (code: string, message: string, location?: string): void => {
    checks.push({
      severity: "error",
      code,
      message,
      ...(location === undefined ? {} : { location }),
    });
  };
  const warning = (code: string, message: string, location?: string): void => {
    checks.push({
      severity: "warning",
      code,
      message,
      ...(location === undefined ? {} : { location }),
    });
  };
  const ids = taskIds(task);
  const paths = packPaths(pack);
  const acIds = new Set(task.acceptanceCriteria.map((c) => c.id));
  const caseInsensitive = process.platform === "win32" || process.platform === "darwin";
  const excluded = createPathMatcher(task.scope.exclude, { caseInsensitive });
  const included = createPathMatcher(task.scope.include, { caseInsensitive });
  const fallbackModule = pack.modules[0]?.id ?? "root";

  const relevantFiles = wire.relevantFiles.filter((file, index) => {
    if (RepoPath.safeParse(file.path).success && paths.has(file.path)) return true;
    warning(
      "unknown-relevant-file",
      `"${file.path}" is not in the repository context and was dropped`,
      `relevantFiles[${index}]`,
    );
    return false;
  });

  const changes: ImplementationPlan["changes"] = [];
  const seenTargets = new Set<string>();
  for (const [index, change] of wire.changes.entries()) {
    const location = `changes[${index}]`;
    if (!RepoPath.safeParse(change.path).success) {
      error(
        "invalid-path",
        `"${change.path}" is not a repository-relative path`,
        `${location}.path`,
      );
      continue;
    }
    let exists: boolean;
    try {
      const checked = await guard.check(change.path, { access: "write", origin: "model" });
      exists = checked.exists;
    } catch (rejection) {
      if (!isDevflowError(rejection)) throw rejection;
      error(
        "path-not-writable",
        `"${change.path}" cannot be changed: ${rejection.message}`,
        `${location}.path`,
      );
      continue;
    }
    if ((change.action === "modify" || change.action === "delete") && !exists) {
      error(
        "missing-file",
        `"${change.path}" does not exist, so it cannot be ${change.action === "modify" ? "modified" : "deleted"}`,
        `${location}.path`,
      );
    }
    if (change.action === "create" && exists) {
      error(
        "file-exists",
        `"${change.path}" already exists; plan a modification instead`,
        `${location}.path`,
      );
    }
    const excludedBy = excluded.match(change.path);
    if (excludedBy !== undefined) {
      error(
        "out-of-scope",
        `"${change.path}" is excluded by the task scope (${excludedBy})`,
        `${location}.path`,
      );
    }
    if (task.scope.include.length > 0 && included.match(change.path) === undefined) {
      warning(
        "outside-include",
        `"${change.path}" is outside the task's scope.include`,
        `${location}.path`,
      );
    }
    const target = `${change.action}:${change.path}`;
    if (seenTargets.has(target)) {
      warning(
        "duplicate-change",
        `"${change.path}" is planned twice for ${change.action}`,
        location,
      );
    }
    seenTargets.add(target);

    const derived = moduleOf(change.path, pack.modules);
    const claimed =
      change.module !== null && ModuleId.safeParse(change.module).success
        ? change.module
        : undefined;
    if (claimed !== undefined && derived !== null && claimed !== derived) {
      warning(
        "module-corrected",
        `module "${claimed}" corrected to "${derived}" from the path`,
        `${location}.module`,
      );
    }
    const satisfies = change.satisfies.filter((id) => ids.has(id));
    if (satisfies.length !== change.satisfies.length) {
      warning(
        "unknown-ids",
        "unknown requirement or criterion ids were removed",
        `${location}.satisfies`,
      );
    }
    changes.push({
      id: `CH-${changes.length + 1}`,
      module: derived ?? claimed ?? fallbackModule,
      path: change.path,
      action: change.action,
      description: change.description,
      satisfies,
    });
  }

  const testStrategy: ImplementationPlan["testStrategy"] = [];
  for (const [index, entry] of wire.testStrategy.entries()) {
    if (!acIds.has(entry.acId)) {
      warning(
        "unknown-criterion",
        `"${entry.acId}" is not an acceptance criterion of the task`,
        `testStrategy[${index}]`,
      );
      continue;
    }
    const target =
      entry.targetFile !== null && RepoPath.safeParse(entry.targetFile).success
        ? entry.targetFile
        : undefined;
    if (entry.targetFile !== null && target === undefined) {
      warning(
        "invalid-path",
        `test file "${entry.targetFile}" is not a repository-relative path`,
        `testStrategy[${index}].targetFile`,
      );
    }
    testStrategy.push({
      acId: entry.acId,
      level: entry.level,
      intent: entry.intent,
      approach: entry.approach,
      ...(target === undefined ? {} : { targetFile: target }),
    });
  }

  for (const criterion of task.acceptanceCriteria) {
    if (
      criterion.verification === "automated" &&
      !testStrategy.some((entry) => entry.acId === criterion.id)
    ) {
      warning("untested-criterion", `${criterion.id} has no test strategy entry`);
    }
  }
  for (const requirement of task.requirements.functional) {
    if (requirement.priority !== "must") continue;
    const covered =
      changes.some((change) => change.satisfies.includes(requirement.id)) ||
      task.acceptanceCriteria.some(
        (criterion) =>
          criterion.covers.includes(requirement.id) &&
          (changes.some((change) => change.satisfies.includes(criterion.id)) ||
            testStrategy.some((entry) => entry.acId === criterion.id)),
      );
    if (!covered)
      warning("uncovered-requirement", `${requirement.id} is not addressed by any change or test`);
  }
  if (changes.length === 0 && !checks.some((check) => check.severity === "error")) {
    warning("no-changes", "the plan does not change any file");
  }

  const openQuestions: ClarificationQuestion[] = wire.openQuestions.map((question, index) => ({
    id: `Q-${index + 1}`,
    question: question.question,
    blocking: question.blocking,
    relatedIds: question.relatedIds.filter((id) => ids.has(id)),
  }));

  const plan = ImplementationPlan.parse({
    taskId: task.id,
    summary: wire.summary,
    approach: wire.approach,
    relevantFiles,
    changes,
    interfaceChanges: wire.interfaceChanges,
    testStrategy,
    risks: wire.risks,
    regressionWatch: wire.regressionWatch.filter((text) => text.trim() !== ""),
    openQuestions,
  });
  return { plan, checks };
}
