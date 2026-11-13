# ADR 0024: Optional trace export compatible with OpenTelemetry, without an OpenTelemetry SDK

- **Status:** Accepted, 2026-11-11. Implemented in Phase 6 in `@devflowai/workflow`
  (`src/trace.ts`, `otlp.ts`, `trace-export.ts`) and the CLI (`--trace`, `devflow trace`).
- **Deciders:** Mohamed Yangui

## Context

Teams that run DevFlow regularly want to see its runs next to their other telemetry: how long
each step takes, which model calls were made and what they cost, which gates ran and how they
ended. OpenTelemetry is the common format for that, and OTLP is what collectors accept.

A run already records everything needed, after the fact: `run.json` (state, settings, budget
usage), `events.jsonl` (step boundaries), `audit.jsonl` (model calls and commands) and the gate
artifacts. What it records also contains what must never leave the machine: prompts are hashed
but file paths, command arguments, plan and answer text, and command output are in the run
directory.

The OpenTelemetry JavaScript SDK would add several runtime dependencies for what is, here, one
JSON document per run.

## Decision

1. **A trace per run, built from the run store.** `readRunTrace` reads the run's records and
   `buildRunTrace` (pure) returns one root span for the run, a child span per workflow step
   (from `step-started` to `step-completed` or `step-failed`; a step still open at the end is
   `incomplete`, status unset), and under the step that was running, a span per model call
   and per command. Building the trace after the run means exporting never changes how a run
   behaves, and a finished run can be exported at any time.
2. **Metadata only, by allowlist.** Attributes are added one by one; no record is copied whole.
   Model call spans (`chat <model>`, kind client) carry `gen_ai.operation.name`,
   `gen_ai.provider.name`, `gen_ai.request.model` or `gen_ai.response.model`,
   `gen_ai.usage.input_tokens` / `output_tokens`, and `devflow.gen_ai.*` for cost, outcome,
   attempts and retries, with the prompt template id and version and the number of files
   included. Command spans carry the command id, purpose (`gate`, `contract-tool`, `command`),
   gate ids, `process.executable.name` (the file name of `argv[0]`, no directory and no other
   argument), the policy decision, status, `process.exit.code`, duration, timeout and backend.
   There is never a prompt, an answer, a task title or description, a file path or content, a
   command argument or output, or an error message: errors are reported by their code
   (`error.type`). Every string also goes through the redactor, with the credential-like
   environment values and the OTLP header values as known secrets.
3. **Audit entries gain the fields the trace needs.** Model call entries record their step,
   duration and number of attempts; command entries their backend. The fields are optional, so
   older runs still read and export (without those attributes).
4. **Deterministic ids.** The trace id is derived from the run id, each span id from the run id
   and the record it comes from (SHA-256, truncated). Exporting a run twice gives the same ids.
5. **OTLP/JSON with no new dependency.** `toOtlpRequest` encodes the trace as the JSON form of
   `ExportTraceServiceRequest` (opentelemetry-proto `trace/v1`): hex ids, Unix nanoseconds as
   decimal strings, 64-bit integers as strings, dollar amounts as doubles. The output is
   validated by a Zod schema of the subset DevFlow writes.
6. **Two targets.** `file` writes `trace.otlp.json` in the run directory (or the file given to
   `devflow trace --output`). `otlp` POSTs the request to the OTLP/HTTP traces endpoint with
   Node's `fetch`: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` as given, else
   `OTEL_EXPORTER_OTLP_ENDPOINT` + `/v1/traces`; headers from `OTEL_EXPORTER_OTLP_HEADERS` and
   `OTEL_EXPORTER_OTLP_TRACES_HEADERS`; timeout from `OTEL_EXPORTER_OTLP_(TRACES_)TIMEOUT`
   (default 10 s, at most 120 s). The endpoint must be `https`, except `http` for `localhost`,
   `127.0.0.1` and `[::1]`; credentials in the URL are refused; redirects are not followed;
   bodies over 4 MiB are not sent. Messages show the endpoint's origin and path, never its
   query or a header value.
7. **Opt-in by the user only.** The export is off by default and is turned on only by
   `--trace file|otlp|file,otlp` on a workflow command or by `DEVFLOW_TRACE_EXPORT`, never by
   the repository's configuration: a repository must not be able to make DevFlow send data
   anywhere. An unusable target or endpoint is refused before the run starts
   (`TRACE_EXPORT_REFUSED`).
8. **Failures only warn.** After a run, a failed write or send is a warning in the outcome; the
   run and its exit code are unchanged. A run that waits for a person is exported when it
   finishes. `devflow trace <run>` exports on demand and fails (exit 1, `TRACE_EXPORT_FAILED`)
   when the export fails.

## Consequences

- No runtime dependency is added, and the privacy properties are tested in one place: a
  scripted run with a fake secret and marker strings in the task, prompts, answers, arguments
  and output, whose export must contain none of them and only allowlisted attribute names.
- Spans are emitted once, when the run finishes, not live. A collector sees a run only after
  it ends (or when `devflow trace` is run).
- Only traces are exported; there are no metrics or logs, and no OTLP/protobuf or gRPC.
- Times come from the recorded timestamps, so span boundaries are as precise as the run store
  (milliseconds); a model call or command starts at its recorded end minus its duration.
- The `gen_ai.*` names follow the OpenTelemetry semantic conventions for generative AI, which
  are still in development; they may need renaming when the conventions are stable.

## Alternatives considered

- **The OpenTelemetry SDK and OTLP exporter packages.** Rejected: several dependencies for one
  document per run, and live instrumentation would spread through the workflow code.
- **Live spans during the run.** Rejected for now: the run store already holds the timeline,
  and building after the fact keeps the export out of the run's behaviour and failure modes.
- **Configuration in `.devflow/config.yaml`.** Rejected: a repository could then send data to an
  endpoint of its choosing.
