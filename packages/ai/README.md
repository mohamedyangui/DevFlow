# @devflow/ai

**Status: not implemented.** The package exists so that its boundaries (it may depend only on
`@devflow/core`) are enforced from the start. It exports nothing yet.

Planned:

| Phase | Component                                                                      |
| ----- | ------------------------------------------------------------------------------ |
| 2     | LLM gateway: redaction, budgets, retries, timeouts, structured-output checking |
| 2     | Anthropic provider (official SDK, lazily loaded)                               |
| 2     | Fake provider (scripted) and Replay provider (recorded cassettes) for tests    |
| 4     | OpenAI provider, price table and cost tracking                                 |

Providers implement the `LlmProvider` port from `@devflow/core`. They work at the JSON Schema
level; validation against Zod schemas happens centrally in the gateway (ADR 0010).
