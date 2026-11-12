import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DevflowError,
  ErrorCode,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
} from "@devflow-ai/core";
import { z } from "zod";
import { requestFingerprint } from "../hash.js";

const RecordedResponse = z.strictObject({
  text: z.string(),
  model: z.string().min(1),
  stopReason: z.enum(["end_turn", "max_tokens", "refusal", "other"]),
  usage: z.strictObject({
    inputTokens: z.int().nonnegative(),
    outputTokens: z.int().nonnegative(),
    cacheReadTokens: z.int().nonnegative().optional(),
    cacheWriteTokens: z.int().nonnegative().optional(),
  }),
  providerRequestId: z.string().optional(),
});

const Interaction = z.strictObject({
  /** {@link requestFingerprint} of the request. */
  key: z.string().regex(/^[0-9a-f]{64}$/),
  /** The (already redacted) request, kept to explain cassette misses. */
  request: z.unknown(),
  response: RecordedResponse,
});

export const Cassette = z.strictObject({
  schemaVersion: z.literal(1),
  /** Provider id of the delegate that produced the recordings. */
  recordedWith: z.string().min(1),
  interactions: z.array(Interaction),
});
export type Cassette = z.infer<typeof Cassette>;

/**
 * Records and replays provider responses keyed by a hash of the request (ADR 0010).
 *
 * In replay mode a request must match a recording exactly; identical requests are served in
 * the order they were recorded. A request with no recording fails with
 * `REPLAY_CASSETTE_MISS` instead of reaching the network. In record mode every call goes to the
 * delegate and the cassette is rewritten (atomically) after each response, so a crashed run
 * keeps what it recorded.
 */
export class ReplayProvider implements LlmProvider {
  readonly id = "replay";
  readonly file: string;
  private readonly cassette: Cassette;
  private readonly delegate: LlmProvider | undefined;
  private readonly served = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(file: string, cassette: Cassette, delegate: LlmProvider | undefined) {
    this.file = file;
    this.cassette = cassette;
    this.delegate = delegate;
  }

  /** Opens a cassette for replay. */
  static async load(file: string): Promise<ReplayProvider> {
    return new ReplayProvider(file, await readCassette(file), undefined);
  }

  /** Starts a new cassette that records the delegate's responses. */
  static record(file: string, delegate: LlmProvider): ReplayProvider {
    return new ReplayProvider(
      file,
      { schemaVersion: 1, recordedWith: delegate.id, interactions: [] },
      delegate,
    );
  }

  get interactions(): number {
    return this.cassette.interactions.length;
  }

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    signal.throwIfAborted();
    const key = requestFingerprint(request);
    if (this.delegate !== undefined) {
      const response = await this.delegate.generate(request, signal);
      await this.append({ key, request, response: RecordedResponse.parse(response) });
      return response;
    }
    const matches = this.cassette.interactions.filter((interaction) => interaction.key === key);
    const index = this.served.get(key) ?? 0;
    const match = matches[index];
    if (match === undefined) {
      throw new DevflowError(
        ErrorCode.ReplayCassetteMiss,
        matches.length === 0
          ? `the cassette has no recording for this request (key ${key.slice(0, 12)})`
          : `the cassette has ${matches.length} recording(s) for this request and all were used`,
        {
          details: {
            cassette: this.file,
            key,
            templateHint: request.responseFormat?.name ?? null,
            recorded: this.cassette.interactions.length,
          },
        },
      );
    }
    this.served.set(key, index + 1);
    return toResponse(match.response);
  }

  private append(interaction: z.infer<typeof Interaction>): Promise<void> {
    const write = this.queue.then(async () => {
      this.cassette.interactions.push(interaction);
      await writeCassette(this.file, this.cassette);
    });
    this.queue = write.catch(() => undefined);
    return write;
  }
}

function toResponse(recorded: z.infer<typeof RecordedResponse>): LlmResponse {
  const { usage, providerRequestId, ...rest } = recorded;
  return {
    ...rest,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      ...(usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens }),
      ...(usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    },
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  };
}

async function readCassette(file: string): Promise<Cassette> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new DevflowError(ErrorCode.ReplayCassetteInvalid, `cannot read the cassette ${file}`, {
      details: { cassette: file, reason: (error as NodeJS.ErrnoException).code ?? "unknown" },
      cause: error,
    });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new DevflowError(ErrorCode.ReplayCassetteInvalid, `the cassette ${file} is not JSON`, {
      details: { cassette: file },
      cause: error,
    });
  }
  const parsed = Cassette.safeParse(json);
  if (!parsed.success) {
    throw new DevflowError(
      ErrorCode.ReplayCassetteInvalid,
      `the cassette ${file} does not match the cassette schema`,
      { details: { cassette: file, issues: parsed.error.issues.map((issue) => issue.message) } },
    );
  }
  return parsed.data;
}

async function writeCassette(file: string, cassette: Cassette): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cassette, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
