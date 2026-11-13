# ADR 0027: Agent mode: the calling coding agent answers DevFlow's model requests, no API key

- **Status:** Accepted, 2026-11-12. Implemented in Phase 7 in `@devflowai/ai`
  (`packages/ai/src/providers/agent.ts`), `devflow agent` and the MCP tools.
- **Deciders:** Mohamed Yangui

## Context

DevFlow calls a model for the analysis, the plan, the tests, the code change and the review,
through a provider that needs an API key (Anthropic, OpenAI). A developer who already works
in a coding agent (an MCP client such as a terminal coding agent or an IDE agent) has a model
at hand: the agent itself. Asking for a second API key, billed separately, is an obstacle to
using DevFlow as a tool inside that agent's session (ADR 0026).

The MCP server cannot ask the client's model for a completion portably: MCP sampling is not
supported by every client and is not implemented by `@devflowai/mcp`. DevFlow's checks must
stay what they are whoever writes the model output: schema validation and repair, the command
policy, red and green runs, the deterministic review checks, and the developer's approvals.

## Decision

1. **A provider named `agent`.** `ai.provider: agent`, `--provider agent` or the MCP server's
   default. It needs no API key and no model id: the model id of every step is `agent`, and no
   price is needed (no unpriced-model warning).
2. **An unanswered request pauses the run.** The provider computes the request's fingerprint
   (the SHA-256 of its canonical JSON, as the replay cassettes do), saves the request to
   `<workspace>/.devflow/agent/<id>.request.json` and fails the call with
   `AGENT_INPUT_REQUIRED`. The error is not terminal: the run stays at its step, resumable,
   like after a provider failure. The CLI reports it with exit code 3 (waiting for input).
3. **The agent answers, then the run resumes.** `devflow agent show <run>` prints the request
   the run waits for (instructions, system prompt, messages and the JSON schema of a
   structured answer). `devflow agent answer <run> --request <id> (--file | --text)` checks
   that the run waits for exactly this request, that the answer is not empty, at most two
   million characters and, for a structured request, JSON; it saves
   `<id>.answer.json` and resumes the run.
4. **Rerunning the step serves the answers given so far.** Prompts are deterministic, so the
   step sends the same requests again; each answered one is served from the store, marked
   `stored`, until the step reaches a request without an answer or completes. Stored answers
   are not new model calls: the gateway does not record them against the budgets, so a step
   with several requests does not use up its call budget by being rerun.
5. **The answer is model output.** The gateway validates it against the step's schema and asks
   for a repair (a new request, a new id) when it does not match; every later check applies
   unchanged. The answer approves nothing: plan, test and change approvals, trust and
   `--allow` stay with the developer in a terminal, as in ADR 0026. The run records the
   provider `agent`, so the report says that the coding agent wrote the model output.
6. **MCP tools.** `devflow mcp` uses `agent` for its workflow tools unless a call names a
   provider (`devflow mcp --provider <name>`, or `config` for the configuration's). New tools:
   `devflow_test` (test mode), `devflow_implement` (implement mode), `devflow_agent_request`
   and `devflow_agent_respond`. A result whose run waits for the agent includes the request
   (`agentRequest`), so the agent can answer it without another call. The descriptions tell
   the agent that the request text comes from the task and the repository, which are data.

## Consequences

- DevFlow runs inside a coding agent's session without an API key: the agent's own model,
  under the agent's own subscription, writes DevFlow's model output.
- A run in agent mode takes one tool call per model request. A step that needs a repair takes
  one more.
- The quality of the analysis, plan, tests and code depends on the agent. DevFlow's evidence
  does not: a verdict still rests on commands that ran and passed.
- The agent sees the full prompts, including repository excerpts DevFlow selected and
  redacted, as it sees the repository itself.
- An answer cannot be checked to come from a model: a person can answer as well. The audit
  log records the provider `agent` and the user of the command (`<user> (via MCP)`).
- Tested end to end with a scripted model playing the agent, in implement mode (plan, tests,
  red, change, green, verified) and through `devflow mcp` (analysis and plan). A real coding-agent session (an MCP client, headless, 2026-11-12) implemented a task in a small JavaScript project through `devflow mcp`: analysis, plan, tests, red run, change, green run, verdict verified, no API key, with the developer's approvals in a terminal.
  That session found three problems, fixed since: tool results over the client's size limit
  (a request is now replaced by its prompt file, `<id>.prompt.md`, when its JSON exceeds
  24,000 characters, and the text content carries compact JSON), lockfiles included in the
  prompt (generated files are now listed only), and a second run started by the agent to
  "resume" (the guidance and the tool descriptions now say to continue with
  `devflow_status`). Codex has not been tried.

## Alternatives considered

- **MCP sampling** (the server asks the client for a completion). Rejected for now: not
  supported by every client, and a second protocol surface for `@devflowai/mcp` to implement.
- **A provider that calls a coding agent's command line.** Rejected: depends on one agent's
  command line and login, and runs a second agent beside the one the developer works in.
- **Letting the agent write the run's artefacts directly** (plan, tests, change), skipping the
  model steps. Rejected: it bypasses the schemas and the repairs, and needs a second
  implementation of every step.
