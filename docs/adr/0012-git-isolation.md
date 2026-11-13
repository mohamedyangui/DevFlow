# ADR 0012: Dedicated local branch, commits per phase, never push

- **Status:** Accepted, 2026-11-06 (decision D6). Phase 1 defines the `workflow.git`
  configuration schema. Phase 4 implements the branch isolation: the clean-tree check, the
  dedicated branch and the commits per phase (`GitClient` in `@devflowai/core`, used by test and
  implement mode). Worktree isolation is not implemented; a run configured for it does not
  start (`GIT_ISOLATION_UNSUPPORTED`).
- **Deciders:** Mohamed Yangui

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

## Implementation notes

- The tree is checked when the run starts and again just before the first file is written;
  the branch is created then, after the plan is approved, so a rejected or cancelled plan
  leaves no branch. Changes under `.devflow/` (the run directory) do not count.
- A commit is made when a person approves what it contains, and contains exactly those
  files: other changes in the working tree stay uncommitted. A rejected change is restored
  instead. A failed commit does not stop the run; the report lists the files.
- DevFlow writes, runs gates and commits only while the run's branch is checked out.
- Without a repository (or without git, or without a first commit), the run continues and
  its changes stay in the working tree; the report says why.

## Consequences

- The user reviews a normal branch with readable commits, and can discard it with one command.
- Before each write, DevFlow checks the file's content hash, so edits the user makes during a
  run are not overwritten.

## Alternatives considered

- **Worktree by default.** Rejected: forces dependency installation and network access.
- **Uncommitted changes in the user's branch.** Rejected: mixes DevFlow's changes with the
  user's.
