# @devflow/cli

The `devflow` command.

**Implemented:**

| Command                                                              | Description                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devflow --version`                                                  | Print the version.                                                                                                                                                |
| `devflow task validate <file> [--json] [--strict]`                   | Parse, normalize and lint a YAML, JSON or Markdown task file. Exit code 0 when valid, 1 when invalid, 2 for usage errors or an unusable file.                     |
| `devflow trust [directory] [--yes \| --status \| --revoke] [--json]` | Review the workspace configuration and trust the workspace, show its status, or revoke it. Exit code 0 when trusted (or revoked), 1 when not, 2 for usage errors. |
| `devflow init`                                                       | Write `.devflow/config.yaml` and a rules template, and add `.devflow/runs/` to `.gitignore`. Never overwrites.                                                    |
| `devflow analyze --task <file>` / `devflow plan --task <file>`       | Start an assist run: requirements analysis, then (for `plan`) an implementation plan for review.                                                                  |
| `devflow approve` / `reject --feedback` / `answer`                   | Decide on a paused run: approve or reject the plan, answer clarification questions.                                                                               |
| `devflow resume` / `cancel` / `status` / `report`                    | Continue an interrupted run (with higher limits), cancel it, show runs, print a report.                                                                           |

Exit codes: 0 success, 1 negative result (failed or interrupted run), 2 usage error, 3 waiting
for a person, 4 budget exceeded, 70 internal error, 130 interrupted by Ctrl+C. The full reference
is [docs/specs/cli.md](../../docs/specs/cli.md); commands of later phases are listed there as
planned and do not exist yet.
