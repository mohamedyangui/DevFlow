import { readdirSync } from "node:fs";
import path from "node:path";
import { loadTaskFile, type TaskContract } from "@devflow-ai/core";
import { describe, expect, it } from "vitest";
import { repoRoot } from "./helpers.js";

const examplesDir = path.join(repoRoot, "examples", "tasks");
const exampleFiles = readdirSync(examplesDir).sort();

describe("example task files", () => {
  it.each(exampleFiles)("%s is valid and has no warnings", async (file) => {
    const result = await loadTaskFile(path.join(examplesDir, file));
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("the YAML and Markdown versions of the same task produce the same contract structure", async () => {
    const structure = (contract: TaskContract | undefined) => ({
      id: contract?.id,
      title: contract?.title,
      description: contract?.description,
      functional: contract?.requirements.functional,
      nonFunctional: contract?.requirements.nonFunctional,
      acceptance: contract?.acceptanceCriteria.map((ac) => ({
        id: ac.id,
        covers: ac.covers,
        testIntent: ac.testIntent,
        testLevel: ac.testLevel,
        verification: ac.verification,
      })),
      constraints: contract?.constraints,
      scope: contract?.scope,
      testing: contract?.testing,
      definitionOfDone: contract?.definitionOfDone,
    });
    const yaml = await loadTaskFile(path.join(examplesDir, "add-pagination.task.yaml"));
    const markdown = await loadTaskFile(path.join(examplesDir, "add-pagination.task.md"));
    expect(structure(markdown.contract)).toEqual(structure(yaml.contract));
  });
});
