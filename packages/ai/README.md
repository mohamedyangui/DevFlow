# @devflowai/ai

The LLM gateway and the provider adapters that implement the `LlmProvider` port of
`@devflowai/core` ([ADR 0010](../../docs/adr/0010-llm-providers.md)). It depends only on
`@devflowai/core`, `zod` and the official `@anthropic-ai/sdk`.

**Implemented (Phase 2):**

- **`LlmGateway.generateStructured`**, the only path to a model. For each call it:
  - redacts the prompt and writes a redaction audit entry for each value removed;
  - checks the run's token budgets and the step's call budget with an estimate
    (characters / 4, plus the full output allowance) before anything is sent;
  - applies a per-call timeout and the caller's cancellation signal;
  - retries rate limits, overload, 5xx, 408, 409, network errors and timeouts (three
    attempts in total, exponential backoff with jitter, `retry-after` honoured up to 60 s);
  - parses the answer as JSON, validates it with the step's Zod schema, and asks once for a
    repair when it does not match;
  - writes one `llm-call` audit entry per provider call (provider, model, template, prompt
    hash, files in the prompt, tokens, outcome).

  A refusal (`LLM_REFUSED`), an answer cut off at the output limit (`LLM_OUTPUT_TRUNCATED`) or
  an answer that stays invalid (`LLM_OUTPUT_INVALID`) is an error, never a value.

- **`BudgetTracker`**: input and output tokens per run, model calls per step. Exceeding a limit
  raises `BUDGET_EXCEEDED`; usage can be persisted and a resumed run can raise the limits.
  Cost limits need a price table and arrive in Phase 4.
- **`AnthropicProvider`**: the Messages API through the official SDK, imported on first use.
  The key comes from `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`); SDK retries are off
  because the gateway owns them. No model id is built in: the caller always names the model.
- **`FakeProvider`**: scripted replies for unit tests.
- **`ReplayProvider`**: replays recorded responses by request hash (the audit log's
  `promptSha256`), or records a delegate's responses into a cassette.
- **`untrustedBlock`**: wraps repository or issue text in labelled delimiters whose id is
  derived from the content, so the content cannot close its own block.

**Not implemented yet:** the OpenAI provider, the price table and cost budgets (Phase 4).

```ts
import { BudgetTracker, LlmGateway, createProvider } from "@devflowai/ai";
import { SecretRedactor } from "@devflowai/core";
import { z } from "zod";

const gateway = new LlmGateway({
  provider: await createProvider({ name: "anthropic" }),
  redactor: new SecretRedactor(),
  budget: new BudgetTracker(),
});
const { value } = await gateway.generateStructured({
  step: "analysis",
  templateId: "requirements-analysis",
  templateVersion: "1",
  model: process.env.DEVFLOW_MODEL ?? "",
  system: "...",
  user: "...",
  files: [],
  schema: z.strictObject({ summary: z.string() }),
  schemaName: "analysis",
  maxOutputTokens: 4_000,
});
```

The provider tests run the Anthropic provider against a local HTTP stand-in. A test against
the real API runs only when both `ANTHROPIC_API_KEY` and `DEVFLOW_LIVE_MODEL` are set;
otherwise it is reported as skipped.
