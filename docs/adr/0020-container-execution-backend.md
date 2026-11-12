# ADR 0020: A container execution backend on `docker run`

- **Status:** Accepted, 2026-11-10. Implemented in Phase 6 in `@devflow-ai/core`
  (`src/security/execution-backend.ts`, `executor.ts`, `command-policy.ts`, `fingerprint.ts`)
  and the CLI (`--backend`). Narrows the residual risks of
  [ADR 0007](0007-workspace-trust.md); keeps [ADR 0018](0018-in-house-process-launcher.md).
- **Deciders:** Mohamed Yangui

## Context

A trusted build runs the repository's code with the user's privileges (ADR 0007): it can read
`~/.ssh`, reach the network and use all the memory and processes of the machine. Since Phase 2
DevFlow has said that a container backend would narrow this. The architecture proposal left an
`ExecutionBackend` seam for it, and `CommandSpec.network` was declared "enforced in container
mode".

Constraints: no new dependency (ADR 0018 keeps one module that starts processes), no shell,
the same command policy, and no silent change of behaviour for users who do not opt in.

## Decision

1. **Two backends, `local` (the default, unchanged) and `container`.** The backend is a
   property of the invocation, resolved once: the `--backend local|container` flag of the
   user's invocation, else `execution.backend` of the trusted project configuration, else
   `local`. The flag wins in both directions, as the precedence of the configuration spec
   says (the user's invocation over the project). A repository cannot weaken the user's
   choice: an explicit `--backend container` is never overridden by the configuration, and
   an untrusted configuration has no effect at all, since nothing runs in an untrusted
   workspace. There is no user-level configuration file yet; when there is, it will sit
   between the flag and the project.
2. **The approval binds the backend.** The command policy resolves the execution target
   (backend and image) for each command and adds it to the fingerprint, and the
   `ApprovedCommand` carries it, deeply frozen. Approving a command for the host does not
   approve it in a container, nor the reverse, and a different image needs a new approval.
   Local fingerprints are computed exactly as before, so existing approvals stay valid. The
   executor runs a command where its approval says, so a container approval can never run on
   the host. The policy's checks (schema, parameters, hard deny list, path guard, trust) are
   the same for both backends.
3. **The container command is an argv**, built by one pure function (`dockerRunArgs`):

   ```text
   docker run --rm --pull never --name devflow-<id>-<random>
     --network none --cpus <n> --memory <m> --memory-swap <m> --pids-limit <p>
     [--read-only] --tmpfs /tmp:rw,exec,nosuid,nodev
     --security-opt no-new-privileges --cap-drop ALL [--user <uid>:<gid>]
     --mount type=bind,source=<workspace>,target=/workspace --workdir /workspace/<cwd>
     --env HOME=/tmp [--env NAME ...] --entrypoint <executable> <image> <args...>
   ```

   - `--network none` is always present. The configuration has no way to give a container a
     network (`network` accepts only `none`). A command declaring `network: required` (the
     Maven and Gradle commands) runs without one: its dependencies must be in the image or
     the workspace.
   - **Images are never pulled** (`--pull never`). Before the first command, the executor
     runs `docker image inspect` on the image: it proves the daemon answers and records the
     image id in the `ExecutionRecord` (`container.imageId`). A missing image is
     `CONTAINER_IMAGE_UNAVAILABLE`; Docker not on PATH, or a daemon that does not answer, is
     `CONTAINER_RUNTIME_UNAVAILABLE`. **There is no fallback to the local backend**; the gate
     is reported `not_executed` with the reason.
   - **The command is the entry point** (`--entrypoint`), so the image's own entry point (often
     a shell script) does not run, and no shell is involved. A tool is looked up on the
     image's PATH; a wrapper runs by its path under `/workspace`.
   - **Environment:** the `docker` client gets the executor's allowlisted, credential-free
     environment plus the Docker client variables (`DOCKER_HOST`, `DOCKER_CONTEXT`,
     `DOCKER_CONFIG`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `DOCKER_API_VERSION`). Only
     `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `CI` and the command's own additions are forwarded
     into the container, by name (`--env NAME`), so values never appear on a command line.
     `PATH`, `HOME` and `JAVA_HOME` come from the image; `HOME` is `/tmp`. Commands cannot
     set `DOCKER_*` variables (they are reserved like `PATH`).
   - **Mount:** only the workspace, read-write, at `/workspace`. `--mount` is used instead of
     `-v`, whose `source:target` syntax collides with a Windows drive letter. On Windows the
     source is the drive path as Windows writes it (`D:\repo`), which Docker Desktop maps
     into its virtual machine; UNC paths and paths with a comma or a quote are refused.
   - **User:** `--user <uid>:<gid>` of the current user on POSIX, so files written in the
     workspace belong to the user; none on Windows, where Docker Desktop maps ownership.
   - **Timeouts and output caps are unchanged.** On timeout or cancellation the launcher
     calls back before killing the `docker` client's process tree, and the executor runs
     `docker kill <name>` by the generated name: killing the client alone would leave the
     container running.
   - A container that did not start (exit code 125 to 127 with a `docker:` error, such as a
     tool missing from the image) is `PROCESS_START_FAILED`: the gate is `not_executed`, not
     `failed`.

4. **Configuration** (`execution` in `.devflow/config.yaml`): `backend`, and `container` with
   `image`, `moduleImages` (per-module overrides), `cpus` (default 2), `memory` (default
   `4g`, swap disabled), `pidsLimit` (default 1024), `network` (`none` only) and
   `readOnlyRootFilesystem` (default `true`). Image references are validated so that they
   cannot be read as `docker` options. The container backend without an image is an error.
5. **Toolchain probing:** in container mode, tools come from the image, which DevFlow cannot
   inspect without running it; every tool is treated as available, and a missing one makes the
   container fail to start (`not_executed`).

## Consequences

- A build in a container cannot reach the network, cannot read the user's home directory,
  SSH keys or other repositories, gets no capabilities and cannot gain privileges, and is
  bounded in CPU, memory and processes.
- It can still read and change everything in the workspace, including `.git/` (hooks,
  configuration) and files DevFlow later reads; the container backend narrows the risk, it
  does not remove it. A kernel or Docker escape is out of scope.
- **An approval binds the image reference, not its content.** A tag can be re-pointed locally
  (`docker pull`, `docker build -t`) without a new approval. The image id that actually ran is
  recorded; pinning the image by digest (`image@sha256:...`) binds the content.
- Builds need an image with the toolchain and, for Maven and Gradle, the dependencies; there
  is no access to the user's `~/.m2` or `~/.gradle` (they may hold credentials). Dependencies
  installed in the workspace on another platform (for example native modules installed on
  Windows) may not run in a Linux container.
- The daemon decides what a mount source means: with a remote `DOCKER_HOST`, the path refers
  to the daemon's machine.
- Docker must be installed and running; users without it keep the local backend.

## Alternatives considered

- **A Docker SDK or the Engine API over its socket.** Rejected: a dependency, and the socket
  path differs per platform. The `docker` CLI is what users have, and its argv is easy to
  audit and test.
- **Podman or other runtimes.** Deferred: Podman accepts the same options, but is not tested.
- **Falling back to local when Docker is missing.** Rejected: the user asked for isolation; a
  silent fallback would run the build with more privileges than chosen.
- **Letting the configuration enable a network for commands that declare
  `network: required`.** Rejected for now: the repository would grant itself network access.
  A user-level allowance can be designed later.
- **`-v <workspace>:/workspace`.** Rejected: its colon-separated syntax is ambiguous with
  Windows drive letters and with colons in POSIX paths.
- **Mounting `~/.m2` or `~/.gradle` read-only for dependencies.** Rejected: they can contain
  credentials (`settings.xml`, `gradle.properties`).
