# @devflow/workflow

**Status: not implemented.** The package exists so that its boundaries are enforced from the
start: it may depend on `@devflow/core`, `@devflow/context` and `@devflow/ai`, and may not
start processes itself. It exports nothing yet.

Planned:

| Phase | Component                                                                                |
| ----- | ---------------------------------------------------------------------------------------- |
| 2     | Typed state machine, mode profiles, step runner, run store, approvals, resume            |
| 2     | Requirements analysis, planning, report generation (JSON source of truth, Markdown view) |
| 2     | Programmatic SDK entry point shared by the CLI and future IDE integrations               |
| 4     | Test design, implementation, bounded repair loop, regression detection, review           |

The workflow states and modes are already defined as schemas in `@devflow/core`
(`WorkflowState`, `WorkflowMode`). See [docs/architecture/overview.md](../../docs/architecture/overview.md).
