import {
  DevflowError,
  ErrorCode,
  WorkflowMode,
  WorkflowState,
  isTerminalState,
} from "@devflow/core";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENTED_MODES,
  MODE_TRANSITIONS,
  TRANSITIONS,
  assertModeImplemented,
  assertTransition,
  isTransitionAllowed,
} from "../src/index.js";

const STATES = WorkflowState.options;
const MODES = WorkflowMode.options;

describe("transition table", () => {
  it("has an entry for every state and no successor for terminal states", () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const state of STATES) {
      if (isTerminalState(state)) expect(TRANSITIONS[state]).toEqual([]);
    }
  });

  it("allows in each mode only edges of the table", () => {
    for (const mode of MODES) {
      for (const edge of MODE_TRANSITIONS[mode]) {
        const [from, to] = edge.split("->") as [WorkflowState, WorkflowState];
        expect(TRANSITIONS[from]).toContain(to);
      }
    }
  });

  it("checks every pair of states exhaustively", () => {
    for (const mode of MODES) {
      for (const from of STATES) {
        for (const to of STATES) {
          const expected = isTerminalState(from)
            ? false
            : to === "FAILED" || to === "CANCELLED"
              ? true
              : TRANSITIONS[from].includes(to) && MODE_TRANSITIONS[mode].has(`${from}->${to}`);
          expect(isTransitionAllowed(mode, from, to), `${mode}: ${from} -> ${to}`).toBe(expected);
        }
      }
    }
  });

  it("never lets assist mode reach a step that changes code", () => {
    for (const from of STATES) {
      for (const to of ["TEST_DESIGN", "IMPLEMENTATION", "VERIFICATION", "REVIEW"] as const) {
        expect(isTransitionAllowed("assist", from, to)).toBe(false);
      }
    }
  });

  it("lets any non-terminal state fail or be cancelled", () => {
    for (const from of STATES.filter((state) => !isTerminalState(state))) {
      expect(isTransitionAllowed("assist", from, "FAILED")).toBe(true);
      expect(isTransitionAllowed("assist", from, "CANCELLED")).toBe(true);
    }
    expect(isTransitionAllowed("assist", "COMPLETED", "FAILED")).toBe(false);
  });

  it("throws INVALID_TRANSITION with the edge in the details", () => {
    let error: unknown;
    try {
      assertTransition("assist", "PLANNING", "IMPLEMENTATION");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DevflowError);
    expect((error as DevflowError).code).toBe(ErrorCode.InvalidTransition);
    expect((error as DevflowError).details).toEqual({
      mode: "assist",
      from: "PLANNING",
      to: "IMPLEMENTATION",
    });
    expect(() => {
      assertTransition("assist", "PLANNING", "AWAITING_PLAN_APPROVAL");
    }).not.toThrow();
  });

  it("implements every mode", () => {
    expect(IMPLEMENTED_MODES).toEqual(["assist", "test", "implement", "review"]);
    expect(() => {
      for (const mode of IMPLEMENTED_MODES) assertModeImplemented(mode);
    }).not.toThrow();
  });
});
