# @devflow/cli

The `devflow` command.

**Implemented (Phase 1):**

| Command                                            | Description                                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `devflow --version`                                | Print the version.                                                                                                                            |
| `devflow task validate <file> [--json] [--strict]` | Parse, normalize and lint a YAML, JSON or Markdown task file. Exit code 0 when valid, 1 when invalid, 2 for usage errors or an unusable file. |

Every other command in [docs/specs/cli.md](../../docs/specs/cli.md) is planned and **not
implemented yet**.
