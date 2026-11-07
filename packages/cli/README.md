# @devflow/cli

The `devflow` command.

**Implemented:**

| Command                                                              | Description                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devflow --version`                                                  | Print the version.                                                                                                                                                |
| `devflow task validate <file> [--json] [--strict]`                   | Parse, normalize and lint a YAML, JSON or Markdown task file. Exit code 0 when valid, 1 when invalid, 2 for usage errors or an unusable file.                     |
| `devflow trust [directory] [--yes \| --status \| --revoke] [--json]` | Review the workspace configuration and trust the workspace, show its status, or revoke it. Exit code 0 when trusted (or revoked), 1 when not, 2 for usage errors. |

Every other command in [docs/specs/cli.md](../../docs/specs/cli.md) is planned and **not
implemented yet**.
