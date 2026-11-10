# @devflow/github

GitHub integration for DevFlow AI, over the GitHub REST API with the `fetch` built into Node
([ADR 0019](../../docs/adr/0019-github-rest-client.md)).

**Status: Phase 5, issue source.** Reviewing pull requests, publishing results and preparing
draft pull requests come in later Phase 5 changes.

## Issues as tasks

```ts
import {
  GitHubClient,
  GitHubIssueSource,
  githubToken,
  repositoryFromRemote,
} from "@devflow/github";
import { parseTaskText } from "@devflow/core";

const client = new GitHubClient({ token: githubToken(process.env) });
const source = new GitHubIssueSource(client, repositoryFromRemote(originUrl));
const document = await source.fetch("142", AbortSignal.timeout(60_000));
const task = parseTaskText(document.text, document.format, document.source, {
  defaults: document.defaults,
});
```

- The issue body is the task text, parsed by the core Markdown task parser exactly like a
  task file. The issue number and title are the defaults for the id (`GH-142`) and the title.
- The task's source is `github-issue` with trust `external`: the text defines the task but
  never changes DevFlow's policies, and prompts show it as untrusted data.
- Pull requests are refused as tasks. Comments are not read. Closed issues give a warning.

## Security

- The token comes from `GITHUB_TOKEN` or `GH_TOKEN`. It is sent only to the API origin,
  redirects are never followed, and it is redacted from every message. Child processes never
  receive it.
- Every answer has a timeout and a size limit and is validated against a schema.
- Path segments are encoded, so an owner, a name or a number cannot change the request path.
