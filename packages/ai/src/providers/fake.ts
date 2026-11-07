import type { LlmProvider, LlmRequest, LlmResponse } from "@devflow/core";

/** What a scripted step returns: a full response, just the answer text, or an error to throw. */
export type FakeReply = LlmResponse | string | Error;

export type FakeScript = (request: LlmRequest, index: number) => FakeReply | Promise<FakeReply>;

/**
 * A scripted provider for tests (ADR 0010). Each call runs the script with the request and
 * the call's index; strings become `end_turn` responses with token usage estimated from the
 * text. Every request is kept in {@link requests} for assertions.
 */
export class FakeProvider implements LlmProvider {
  readonly id: string;
  readonly requests: LlmRequest[] = [];
  private readonly script: FakeScript;

  constructor(script: FakeScript, options: { id?: string } = {}) {
    this.script = script;
    this.id = options.id ?? "fake";
  }

  /** Replies in order; a call past the end of the list fails the test loudly. */
  static sequence(replies: readonly FakeReply[], options: { id?: string } = {}): FakeProvider {
    return new FakeProvider((_request, index) => {
      const reply = replies[index];
      if (reply === undefined) {
        throw new Error(`FakeProvider: no scripted reply for call ${index + 1}`);
      }
      return reply;
    }, options);
  }

  async generate(request: LlmRequest, signal: AbortSignal): Promise<LlmResponse> {
    signal.throwIfAborted();
    const index = this.requests.length;
    this.requests.push(request);
    const reply = await this.script(request, index);
    if (reply instanceof Error) throw reply;
    if (typeof reply !== "string") return reply;
    let inputChars = request.system.length;
    for (const message of request.messages) inputChars += message.content.length;
    return {
      text: reply,
      model: request.model,
      stopReason: "end_turn",
      usage: { inputTokens: Math.ceil(inputChars / 4), outputTokens: Math.ceil(reply.length / 4) },
    };
  }
}
