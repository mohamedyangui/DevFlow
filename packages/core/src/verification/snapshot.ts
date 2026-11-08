import { z } from "zod";
import { IsoDateTime } from "../schemas/primitives.js";
import { GateResult, type ResultStatus } from "../schemas/verification.js";

/**
 * The results of one verification, as `devflow verify` saves them
 * (`.devflow/runs/verify/<id>/verification.json`). A later verification can be compared with
 * it: that is the baseline the red/green and regression rules of
 * docs/specs/verification-and-evidence.md are applied to.
 */
export const VerificationSnapshot = z.strictObject({
  version: z.literal(1),
  createdAt: IsoDateTime,
  devflowVersion: z.string().min(1).optional(),
  /** The commit the workspace was at, when known. Uncommitted changes are not recorded. */
  gitCommit: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .optional(),
  gates: z.array(GateResult),
});
export type VerificationSnapshot = z.infer<typeof VerificationSnapshot>;

/** One test whose status differs, or does not, between two verifications. */
export interface TestChange {
  readonly gateId: string;
  readonly testId: string;
  readonly before: ResultStatus;
  readonly after: ResultStatus;
}

export interface SnapshotComparison {
  /** Passed in the baseline, failed now. */
  readonly regressions: readonly TestChange[];
  /** Failed in the baseline, passed now. */
  readonly fixed: readonly TestChange[];
  /** Failed in both. Not attributable to the change. */
  readonly stillFailing: readonly TestChange[];
  /** Any other change of status (for example passed, then not executed). */
  readonly otherChanges: readonly TestChange[];
  /** Tests reported now but not in the baseline. */
  readonly added: readonly { readonly gateId: string; readonly testId: string }[];
  /** Tests in the baseline that are not reported now. */
  readonly missing: readonly { readonly gateId: string; readonly testId: string }[];
  /** Gates whose status changed. */
  readonly gateChanges: readonly {
    readonly gateId: string;
    readonly before: ResultStatus;
    readonly after: ResultStatus;
  }[];
  /** Gates that ran a different command than in the baseline: their tests may not compare. */
  readonly commandChanges: readonly string[];
}

/**
 * Compares two verifications test by test (by gate id and test id). A comparison is evidence
 * only for tests that ran both times: a test that did not run, now or before, never counts as a
 * regression or a fix. Flaky tests are not detected here; the workflow reruns failures.
 */
export function compareSnapshots(
  baseline: VerificationSnapshot,
  current: VerificationSnapshot,
): SnapshotComparison {
  const key = (gateId: string, testId: string) => JSON.stringify([gateId, testId]);
  const before = new Map<string, { gateId: string; testId: string; status: ResultStatus }>();
  for (const gate of baseline.gates) {
    for (const test of gate.tests) {
      before.set(key(gate.gateId, test.id), {
        gateId: gate.gateId,
        testId: test.id,
        status: test.status,
      });
    }
  }
  const regressions: TestChange[] = [];
  const fixed: TestChange[] = [];
  const stillFailing: TestChange[] = [];
  const otherChanges: TestChange[] = [];
  const added: { gateId: string; testId: string }[] = [];
  const seen = new Set<string>();
  for (const gate of current.gates) {
    for (const test of gate.tests) {
      const id = key(gate.gateId, test.id);
      seen.add(id);
      const previous = before.get(id);
      if (previous === undefined) {
        added.push({ gateId: gate.gateId, testId: test.id });
        continue;
      }
      const change = {
        gateId: gate.gateId,
        testId: test.id,
        before: previous.status,
        after: test.status,
      };
      if (previous.status === "passed" && test.status === "failed") regressions.push(change);
      else if (previous.status === "failed" && test.status === "passed") fixed.push(change);
      else if (previous.status === "failed" && test.status === "failed") stillFailing.push(change);
      else if (previous.status !== test.status) otherChanges.push(change);
    }
  }
  const missing = [...before.entries()]
    .filter(([id]) => !seen.has(id))
    .map(([, test]) => ({ gateId: test.gateId, testId: test.testId }));

  const baselineGates = new Map(baseline.gates.map((gate) => [gate.gateId, gate]));
  const gateChanges: { gateId: string; before: ResultStatus; after: ResultStatus }[] = [];
  const commandChanges: string[] = [];
  for (const gate of current.gates) {
    const previous = baselineGates.get(gate.gateId);
    if (previous === undefined) continue;
    if (previous.status !== gate.status) {
      gateChanges.push({ gateId: gate.gateId, before: previous.status, after: gate.status });
    }
    if (previous.commandId !== gate.commandId) commandChanges.push(gate.gateId);
  }
  return {
    regressions,
    fixed,
    stillFailing,
    otherChanges,
    added,
    missing,
    gateChanges,
    commandChanges,
  };
}
