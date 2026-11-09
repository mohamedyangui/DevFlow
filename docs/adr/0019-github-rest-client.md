# ADR 0019: A small GitHub REST client on Node's `fetch` instead of `@octokit/rest`

- **Status:** Accepted, 2026-11-10. Implemented in Phase 5 in `@devflow/github`
  (`src/client.ts`, `repository.ts`, `issues.ts`).
- **Deciders:** Mohamed Yangui

## Context

Phase 5 connects DevFlow to GitHub: issues as tasks, pull requests to review, and later
publishing results and preparing draft pull requests. The architecture proposal planned
`@octokit/rest` for this.

DevFlow needs a handful of REST endpoints, not the whole API. It also needs guarantees that a
general SDK does not give by default: the token must never leave for another host, every
answer needs a size limit and a timeout, every answer must be validated before use (GitHub
text is untrusted), and error messages must never contain the token. Node 22 ships `fetch`,
so the HTTP layer costs nothing.

## Decision

1. **`@devflow/github` talks to the REST API with the built-in `fetch`.** It has no runtime
   dependency beyond `@devflow/core` and `zod`. API version `2022-11-28` is requested on every
   call.
2. **Redirects are not followed** (`redirect: "manual"`, and a 3xx is an error). The token is
   sent only to the configured API origin, which must be `https`.
3. **Every answer** has a timeout (30 s), a size limit (8 MiB) and a Zod schema; an answer
   that does not match is an error, never a guess.
4. **Path segments are encoded** one by one (`apiPath`), so an owner, a repository name or a
   number taken from a remote or an issue cannot add segments or a query.
5. **The token** is read from `GITHUB_TOKEN`, then `GH_TOKEN`. It is redacted from GitHub's
   own messages before they are shown, never written to a run, and never passed to a child
   process (the child environment is an allowlist).
6. **Issues are task sources** (`IssueSource`, defined in core since Phase 1). The body is
   parsed by the core Markdown task parser, the source is `github-issue` with trust
   `external`, and the issue number and title are defaults for the id (`GH-<n>`) and title.
   Pull requests are refused as tasks; comments are not read.
7. **Only `github.com`** remotes are recognised to infer the repository. GitHub Enterprise
   Server is not supported yet.

## Consequences

- No new dependency, and the security properties above are tested in one place.
- DevFlow implements pagination, retries and rate-limit handling itself when it needs them.
  The issue source needs none of them; later endpoints (pull request files, check runs) add
  what they use.
- Tests answer from fixtures through an injected `fetch`; no test calls the network.

## Alternatives considered

- **`@octokit/rest`.** Complete and maintained, but larger than DevFlow's needs, and its
  defaults (following redirects, unbounded answers) would have to be wrapped anyway.
- **The `gh` CLI.** It is not installed everywhere, and running it would be one more external
  program to trust and resolve.
