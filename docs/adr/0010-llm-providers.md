# ADR 0010: Official provider SDKs behind `LlmProvider`

- **Status:** Accepted, 2026-11-06. The `LlmProvider` port exists in `@devflow/core` (Phase 1).
  The gateway and the Anthropic, Fake and Replay providers are implemented in `@devflow/ai`
  (Phase 2, decision D2); OpenAI arrives in Phase 4.
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
- No model id is built in. The model always comes from the command line, the configuration
  (`ai.models`) or the `DEVFLOW_MODEL` environment variable, so DevFlow never silently uses a
  model the user did not choose, and a retired id never needs a release to change. Prices
  arrive with the price table in Phase 4; until then budgets count tokens and calls, and
  `costUsd` is recorded as null.

## Implementation notes (Phase 2)

- The gateway estimates input tokens as characters / 4 and checks the budget with that
  estimate plus the full output allowance before every call.
- Transient failures (rate limits, overload, 5xx, 408, 409, network errors, timeouts) are
  retried up to three attempts in total with exponential backoff and jitter; a `retry-after`
  header is honoured up to 60 seconds. SDK-level retries are disabled so budgets and audit
  entries see every call.
- Structured output: providers receive a JSON Schema generated from the step's Zod schema.
  The Anthropic provider reduces it to the subset the API accepts (closed objects, no length,
  range or pattern constraints, which are restated in descriptions); the gateway validates the
  answer with the full Zod schema.
- The replay key is the SHA-256 of the request's canonical JSON, the same value the audit log
  records as `promptSha256`.

## Consequences

- Swapping or adding a provider touches only `@devflow/ai`.
- Provider SDK upgrades are isolated and covered by replay tests.

## Alternatives considered

- **Raw `fetch`.** Rejected: re-implements retries, streaming and types.
- **LangChain, Vercel AI SDK.** Rejected: large dependency surface and abstraction lock-in for
  a narrow need.
