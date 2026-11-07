# ADR 0010: Official provider SDKs behind `LlmProvider`

- **Status:** Accepted, 2026-11-06. The `LlmProvider` port exists in `@devflow/core` (Phase 1).
  Anthropic, Fake and Replay providers arrive in Phase 2 (decision D2), OpenAI in Phase 4.
- **Deciders:** Mohamed Yangui

## Context

DevFlow must support Anthropic and OpenAI, keep provider-specific code isolated, and test the
workflow deterministically without network access or cost.

## Decision

- A small `LlmProvider` port: `generate(request, signal)` returning text, model, stop reason,
  token usage and the provider's request id. Structured output is requested with a JSON
  Schema generated from Zod (ADR 0011).
- Providers use the **official SDKs** (`@anthropic-ai/sdk`, `openai`), imported lazily so only
  the configured provider is loaded.
- **`FakeProvider`** returns scripted responses for unit tests.
- **`ReplayProvider`** records and replays responses keyed by a hash of the request, giving
  deterministic end-to-end tests in CI.
- A gateway in `@devflow/ai` wraps every provider: redaction, budget checks before the call,
  audit records, retries with backoff, response validation.
- API keys come from environment variables only, never from files in the repository.
- Default model ids and prices are taken from the providers' current documentation when the
  providers are implemented, and every value can be overridden in configuration.

## Consequences

- Swapping or adding a provider touches only `@devflow/ai`.
- Provider SDK upgrades are isolated and covered by replay tests.

## Alternatives considered

- **Raw `fetch`.** Rejected: re-implements retries, streaming and types.
- **LangChain, Vercel AI SDK.** Rejected: large dependency surface and abstraction lock-in for
  a narrow need.
