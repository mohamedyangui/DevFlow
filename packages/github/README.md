# @devflow-ai/github

GitHub integration for DevFlow AI, over the GitHub REST API with the `fetch` built into Node
([ADR 0019](../../docs/adr/0019-github-rest-client.md)).

**Status: Phase 5, issue source, pull requests, publishing and draft pull requests.**

## Issues as tasks

```ts
import {
  GitHubClient,
  GitHubIssueSource,
  githubToken,
  repositoryFromRemote,
} from "@devflow-ai/github";
import { parseTaskText } from "@devflow-ai/core";

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

## Pull requests

```ts
import { getPullRequest, publishReview } from "@devflow-ai/github";

const pull = await getPullRequest(client, "57", repository);
// pull.headSha, pull.baseSha, pull.fromFork, pull.warnings
const published = await publishReview(client, "comment", {
  repository: pull.repository,
  number: pull.number,
  headSha: pull.headSha,
  report, // an EngineeringReport
  knownSecrets,
});
```

- `getPullRequest` reads the head and base commits; `fromFork` is true when the head is in
  another repository or a deleted fork. It never fetches code.
- `publishReview` posts a comment (`comment`) or creates a completed check run named
  `DevFlow review` on the head commit (`check`). It needs a token. `renderReview` builds the
  body: AI findings are labelled unverified suggestions, model text is cut and neutralised
  (Markdown, HTML and table syntax escaped, no `@` mention, no link), at most 50 findings,
  and the body stays under GitHub's size limit. Known secrets are redacted before sending.

## Draft pull requests

```ts
import { createDraftPullRequest, getRepositoryInfo, renderDraftBody } from "@devflow-ai/github";

const { default_branch } = await getRepositoryInfo(client, repository);
const created = await createDraftPullRequest(client, {
  repository,
  head: "devflow/TASK-7", // already pushed by the caller
  base: "main",
  title: "DevFlow TASK-7: Paginate the order list",
  body: renderDraftBody({ report, repository, branch: "devflow/TASK-7", base: "main", commits }),
  knownSecrets,
});
// created.number, created.url, created.draft
```

- `createDraftPullRequest` sends one `POST /repos/{owner}/{repo}/pulls` with `draft: true`
  and checks that the answer is for the same head and base. It needs a token and refuses a
  branch that is its own base. It never marks the pull request ready, requests reviewers,
  approves or merges. The title and body are redacted again before sending.
- `renderDraftBody` builds the description from the run's report: verdict, commits, files
  changed, criteria, gates and findings (neutralised as in `renderReview`), and a note that a
  person must review the change before it is marked ready or merged.
- This package does not push: `devflow pr create` pushes the branch with git and the user's
  own credentials (`GitClient.push` in `@devflow-ai/core`) before it creates the pull request.

## Security

- The token comes from `GITHUB_TOKEN` or `GH_TOKEN`. It is sent only to the API origin,
  redirects are never followed, and it is redacted from every message. Child processes never
  receive it.
- Every answer has a timeout and a size limit and is validated against a schema.
- Path segments are encoded, so an owner, a name or a number cannot change the request path.
- Publishing only writes a comment or a check run. It never approves, requests changes,
  merges or pushes. A draft pull request is created only by `createDraftPullRequest`, which
  the CLI calls only with `--yes`.
