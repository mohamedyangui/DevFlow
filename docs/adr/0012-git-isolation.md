# ADR 0012: Dedicated local branch, commits per phase, never push

- **Status:** Accepted, 2026-11-06 (decision D6). Implementation in Phase 4. Phase 1 defines
  only the `workflow.git` configuration schema.

## Context

DevFlow modifies source code in implement and test modes. Users must be able to see exactly
what changed, discard it, and keep working on their own branch without interference.

## Decision

- Before modifying code, DevFlow requires a **clean working tree** and creates a dedicated local
  branch, `<branchPrefix><task-id>` (default prefix `devflow/`).
- It commits **per phase** by default: tests, then implementation, then each repair attempt.
  Commits on the DevFlow branch run with hooks disabled by default, because hooks would be
  unapproved code execution; the verification gates take their place.
- Worktrees are **opt-in** (`workflow.git.isolation: worktree`), because a fresh worktree lacks
  installed dependencies.
- DevFlow **never pushes** without explicit user authorization, never force-pushes, and never
  merges pull requests. Push and draft-PR creation (Phase 5) require an explicit flag and
  confirmation.

## Consequences

- The user reviews a normal branch with readable commits, and can discard it with one command.
- Before each write, DevFlow checks the file's content hash, so edits the user makes during a
  run are not overwritten.

## Alternatives considered

- **Worktree by default.** Rejected: forces dependency installation and network access.
- **Uncommitted changes in the user's branch.** Rejected: mixes DevFlow's changes with the
  user's.
