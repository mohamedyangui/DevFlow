# ADR 0007: Workspace trust outside the repository; local execution only for trusted repositories

- **Status:** Accepted, 2026-11-06. Implements refinement 3 of the Phase 1 approval.
  Implementation of `devflow trust` and the trust store in Phase 2.

## Context

Building or testing a repository runs that repository's code: npm lifecycle scripts, Maven
and Gradle plugins, Gradle build scripts, test code. Until the container backend exists
(Phase 6), DevFlow runs these commands directly on the host, with the user's privileges.
Repository files, including `.devflow/config.yaml`, are written by whoever controls the
repository and are therefore untrusted.

## Decision

1. **Local build execution is restricted to approved, trusted repositories.** DevFlow will not
   run any build, test, lint or analysis command in a workspace the user has not explicitly
   trusted with `devflow trust`. Without trust, every gate is reported as `not_executed` with
   the reason "workspace not trusted". It is never reported as passed.
2. **Trust is stored outside the repository**, in `~/.devflow/trust.json`, keyed by the
   workspace's real path and the hash of `.devflow/config.yaml`. A repository cannot declare
   itself trusted. Changing the configuration invalidates trust.
3. **Commands are approved by fingerprint.** The fingerprint covers the executable, the argv
   template, the working directory, and the body of the script it runs (the `package.json`
   script text, or the hash of the Maven/Gradle wrapper). If a `test` script changes, approval
   is required again.
4. **The trust prompt states the residual risk** in plain words (below) and shows the exact
   commands.
5. **In CI** there is no prompt. Commands must be pre-approved with an explicit allowlist flag;
   otherwise they are not executed.

## Residual risks

These remain even for trusted repositories and are documented in the
[security model](../specs/security-model.md):

- **A trusted build runs arbitrary code with the user's privileges.** DevFlow makes execution
  explicit, approved, time-bounded and scrubbed of secrets from the environment. It cannot make
  a malicious build safe.
- **No network or filesystem isolation in local mode.** A build can read files outside the
  workspace (for example `~/.ssh`) and reach the network. Environment scrubbing removes tokens
  from the child's environment but not from disk.
- **Trust is a point-in-time decision.** Pulling new commits can change test code and
  dependencies without changing `.devflow/config.yaml` or the script text. The fingerprint
  catches changed scripts and wrappers, not changed test sources or dependency versions.
- **Dependency installation is out of scope.** DevFlow never runs `npm install` or
  equivalent on its own; installs the user ran earlier may have executed lifecycle scripts.

The container backend (Phase 6, `--network none`, resource limits) narrows but does not
remove these risks.

## Consequences

- The first run in a new repository always involves a deliberate trust decision.
- Reports distinguish "not executed because untrusted" from "failed", so a missing trust
  decision never looks like a test failure or a pass.

## Alternatives considered

- **Trust declared in the repository.** Rejected: an attacker controls that file.
- **Running untrusted builds by default with a warning.** Rejected: warnings are ignored.
- **Requiring Docker for every build now.** Rejected for the MVP: many users lack Docker, and
  wrappers and caches need careful mounting. It is the Phase 6 backend.
