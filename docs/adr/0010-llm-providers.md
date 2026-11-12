# ADR 0010: Official provider SDKs behind `LlmProvider`

- **Status:** Accepted, 2026-11-06. The `LlmProvider` port exists in `@devflow-ai/core` (Phase 1).
  The gateway and the Anthropic, Fake and Replay providers are implemented in `@devflow-ai/ai`
  (Phase 2, decision D2), the OpenAI provider and cost tracking in Phase 4.
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
- A gateway in `@devflow-ai/ai` wraps every provider: redaction, budget checks before the call,
  audit records, retries with backoff, response validation.
- API keys come from environment variables only, never from files in the repository.
- No model id is built in. The model always comes from the command line, the configuration
  (`ai.models`) or the `DEVFLOW_MODEL` environment variable, so DevFlow never silently uses a
  model the user did not choose, and a retired id never needs a release to change.
- For the same reason **no price is built in either**. Prices come from the configuration
  (`ai.prices`, US dollars per million tokens by model id). A call to a model without a price
  has an unknown cost: it is recorded as `costUsd: null`, does not count against
  `maxCostUsdPerRun`, and the run starts with a warning naming the model. A built-in price
  list would go stale silently and make cost budgets and reports wrong.

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

## Implementation notes (Phase 4)

- The OpenAI provider uses the Responses API of the official `openai` SDK (pinned to 7.39.0),
  with the key from `OPENAI_API_KEY` (and `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` when set),
  `OPENAI_BASE_URL` for another endpoint, SDK retries disabled, and `store: false` so OpenAI
  does not keep the request for later retrieval. Sampling parameters are not sent.
- Structured output uses strict `json_schema` mode. Strict mode requires every property in
  `required` and does not accept `oneOf`, so on top of the reduction above optional properties
  are sent as nullable and `oneOf` as `anyOf`; the nulls the model returns for omitted
  properties are removed again before the gateway validates the answer with Zod (properties
  whose own schema accepts null keep it).
- A refusal content part, or an answer cut off by the content filter, is a refusal;
  `max_output_tokens` is `max_tokens`. Token usage includes cached input, with cache reads and
  writes reported separately, as for Anthropic.
- Cost: the gateway prices each call by the served model, else the requested one: uncached
  input, cache reads and cache writes (each at its own price, the input price by default) and
  output. The budget check before a call prices the estimate (input text / 4 plus the full
  output allowance), so a priced call that could overshoot `maxCostUsdPerRun` is refused
  before it is sent. The report shows the run's cost only when every call was priced.
- Per-step routing: `--model`, then `ai.models.<step>` (`analysis`, `planning`, `testDesign`,
  `implementation`, `review`), then `ai.models.default`, then `DEVFLOW_MODEL`.
- Tested against a local HTTP server standing in for each API, through the real SDKs. No live
  call to the OpenAI API has been made.

## Consequences

- Swapping or adding a provider touches only `@devflow-ai/ai`.
- Provider SDK upgrades are isolated and covered by replay tests.

## Alternatives considered

- **Raw `fetch`.** Rejected: re-implements retries, streaming and types.
- **LangChain, Vercel AI SDK.** Rejected: large dependency surface and abstraction lock-in for
  a narrow need.
