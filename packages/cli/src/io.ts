import { createInterface } from "node:readline/promises";
import type { LlmProvider } from "@devflow/core";
import { createColors } from "picocolors";

export interface CliOutput {
  write(text: string): void;
  readonly isTTY?: boolean;
}

/** Everything the CLI touches in its environment, injectable for tests. */
export interface CliIo {
  readonly stdout: CliOutput;
  readonly stderr: CliOutput;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * Asks the user a question and resolves with the answer. Absent when there is no interactive
   * terminal (CI, pipes): commands that need a confirmation then require an explicit flag.
   */
  readonly prompt?: (question: string) => Promise<string>;
  /**
   * Starts listening for Ctrl+C while a workflow command runs. The signal aborts on the first
   * Ctrl+C so the run stops cleanly and can be resumed; a second Ctrl+C ends the process.
   * Absent in tests.
   */
  readonly interrupts?: () => Interruption;
  /**
   * Creates the model provider for a run. Tests inject one; the CLI otherwise creates the
   * provider the run's settings name (`anthropic`, `replay`).
   */
  readonly createProvider?: (name: string, options: { cassette?: string }) => Promise<LlmProvider>;
  /** The `fetch` used for the GitHub API. Tests inject one; default: the global `fetch`. */
  readonly fetch?: typeof fetch;
}

export interface Interruption {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function processIo(): CliIo {
  const interactive = process.stdin.isTTY && process.stderr.isTTY;
  return {
    stdout: { write: (text) => process.stdout.write(text), isTTY: process.stdout.isTTY },
    stderr: { write: (text) => process.stderr.write(text), isTTY: process.stderr.isTTY },
    cwd: process.cwd(),
    env: process.env,
    ...(interactive ? { prompt: askOnTerminal } : {}),
    interrupts: listenForInterrupts,
  };
}

function listenForInterrupts(): Interruption {
  const controller = new AbortController();
  const onInterrupt = (): void => {
    process.stderr.write(
      "\nInterrupting: the run stops after saving its state (press Ctrl+C again to force).\n",
    );
    controller.abort();
  };
  process.once("SIGINT", onInterrupt);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off("SIGINT", onInterrupt);
    },
  };
}

/** Prompts on stderr so that stdout stays usable for the command's own output. */
async function askOnTerminal(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

export type Colors = ReturnType<typeof createColors>;

/** Colors only for interactive terminals, honouring NO_COLOR, FORCE_COLOR and TERM=dumb. */
export function colorsFor(output: CliOutput, env: CliIo["env"]): Colors {
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0";
  const disabled = env.NO_COLOR !== undefined || env.TERM === "dumb";
  return createColors(forced || (output.isTTY === true && !disabled));
}
