# Specification: GitHub Action and the secure workflow split

- **Status:** Phase 5. [`action.yml`](../../action.yml) (a composite action) and two example
  workflows, [`devflow-verify.yml`](../examples/github-actions/devflow-verify.yml) and
  [`devflow-review.yml`](../examples/github-actions/devflow-review.yml), exist. Their security
  properties are checked statically by `tests/repo/github-action.test.ts`, and the action's
  input check runs under bash in that test. **The action and the workflows have never run on
  GitHub**: see section 7.

## 1. What the action does

The action runs `devflow verify` or `devflow review --pr` in a repository that the workflow
has checked out. DevFlow is not published to npm
([ADR 0016](../adr/0016-npm-scope-and-publication.md)), so the action builds DevFlow from its
own source, at the commit the workflow pins it to:

1. **Check the inputs** against allowlists (section 2), before anything is installed.
2. Set up pnpm (the version of `packageManager` in DevFlow's `package.json`) and Node.js 22,
   without a dependency cache.
3. Build DevFlow in the action's directory (`$GITHUB_ACTION_PATH`):
   `pnpm install --frozen-lockfile` and `pnpm build`. This step receives no credential.
4. Run `node $GITHUB_ACTION_PATH/packages/cli/dist/bin.js` (the `devflow` bin of
   `@devflowai/cli`) in `working-directory`, with `DEVFLOW_HOME` in the runner's temporary
   directory: trust and approvals last for the job only. With `trust-workspace: "true"`,
   `devflow trust --yes` runs first.

Use it pinned to a full commit SHA that you have reviewed:

```yaml
- uses: mohamedyangui/DevFlow@<40-character commit SHA>
  with:
    command: verify
```

The examples write `DEVFLOW_COMMIT_SHA` in place of the SHA: no published commit contains
the action yet, and a placeholder fails loudly where a wrong SHA might not.

## 2. Inputs and outputs

| Input               | Values (checked)                                         | Default        | Used by |
| ------------------- | -------------------------------------------------------- | -------------- | ------- |
| `command`           | `verify` or `review`                                     | required       | both    |
| `task`              | relative path, no `..`, not starting with `-`            | empty          | review  |
| `issue`             | issue number                                             | empty          | review  |
| `pr`                | pull request number (required for `review`)              | empty          | review  |
| `publish`           | `none`, `comment` or `check`                             | `none`         | review  |
| `model`             | letters, digits and `._:@/-`, at most 128 characters     | empty          | review  |
| `provider`          | empty, `anthropic` or `openai`                           | empty          | review  |
| `allow`             | 64-character lowercase hexadecimal fingerprints          | empty          | both    |
| `trust-workspace`   | `true` or `false`                                        | `false`        | both    |
| `run-fork-code`     | `true` or `false`                                        | `false`        | review  |
| `working-directory` | relative path inside the workspace, no `..`              | `.`            | both    |
| `github-token`      | token to read the pull request and issue, and to publish | `github.token` | review  |
| `anthropic-api-key` | secret                                                   | empty          | review  |
| `openai-api-key`    | secret                                                   | empty          | review  |

- `review` needs `pr` and exactly one of `task` and `issue`. `verify` refuses every
  review-only input, so that a misconfigured workflow fails instead of doing something else.
  An input that fails a check stops the action with exit code 2 before anything is
  installed; the message names the input but never prints its value.
- The task and the pull request number are passed to DevFlow with `--repo $GITHUB_REPOSITORY`.
  The pull request's head commit must be checked out ([CLI spec](cli.md), `review --pr`).
- Pass credentials as inputs, not as `env:` of the step: an `env:` on a step that uses a
  composite action reaches every step of the action, including the build.
- **Output** `exit-code`: the exit code of the `devflow` command ([CLI spec](cli.md),
  section 2). The step fails when it is not 0 (for example 5 when a command was not approved).
  The run files are in `<working-directory>/.devflow/runs/`.

## 3. The secure workflow split

A job that runs a pull request's code must not hold secrets, and a job that holds secrets must
not run a pull request's code. The examples split DevFlow into two workflows accordingly.

| Workflow             | Trigger                                                                                     | Holds                                       | Runs repository code               |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------- |
| `devflow-verify.yml` | `pull_request` (forks included)                                                             | read-only token, not given to DevFlow       | yes: the approved gates            |
| `devflow-review.yml` | `pull_request` from this repository with the `devflow-review` label, or `workflow_dispatch` | model API key, `pull-requests: write` token | no (no install, no build, no gate) |

### Why `pull_request` and never `pull_request_target`

`pull_request_target` runs in the context of the base repository: with its secrets and a
token that can write. A workflow that checks out the pull request's head under that event
and builds or tests it hands those secrets to anyone who opens a pull request. Neither
example uses it, and the test fails if one does. Under `pull_request`, a run for a fork's
pull request gets no secrets (except a read-only `GITHUB_TOKEN`), so the verify workflow can
run the fork's build safely: there is nothing to steal. GitHub may also ask a maintainer to
approve runs for first-time contributors (a repository setting).

A fork's pull request can change the workflow file itself, since `pull_request` runs the
pull request's version of the workflow; including the `allow` list of the verify workflow.
That is acceptable only because that job has no secret and no write permission.

### Gating the AI review

The review needs the model API key, so it runs only where the code under review cannot reach
the job's secrets and where a maintainer asked for it:

- **Same-repository pull requests** (`github.event.pull_request.head.repo.full_name ==
github.repository`) that carry the `devflow-review` label. Only people with triage or write
  access can add a label, so the label is a maintainer's opt-in (it also bounds the model
  cost). A label on a fork's pull request does not help: under `pull_request` that run has no
  secrets, and the job's condition skips it.
- **`workflow_dispatch`** with a pull request number, which only people with write access can
  start. The job then uses the default branch's version of the workflow, not the fork's. This
  is how a fork's pull request is reviewed: its head is checked out (`refs/pull/<n>/head`),
  read and diffed, and **never run**: DevFlow does not run the gates of a fork's pull request
  unless `run-fork-code` is set, and the review job neither installs, builds nor tests
  anything. The task file is read from that checkout, so for a fork's pull request the fork
  controls it; it is model input like the diff, and model findings always stay unverified.

`run-fork-code: "true"` runs the fork's build in a job that holds the model key and a write
token. DevFlow removes credentials from a child's environment, but on Linux a process can
read the environment of other processes of the same user (`/proc/<pid>/environ`), so the
fork's code could read them. Do not combine it with secrets; the action prints a warning when
it is set.

### Other rules both workflows follow

- **Least privilege.** `permissions:` is set at the workflow and the job level. Verify:
  `contents: read`. Review: `contents: read` and `pull-requests: write` for `publish:
comment` (`checks: write` and `pull-requests: read` for `publish: check`;
  `pull-requests: read` for `publish: none`).
- **No persisted credentials.** `actions/checkout` runs with `persist-credentials: false`, so
  the token is not left in `.git/config` for later steps or repository code.
- **Pinned actions.** Every `uses:` names a full 40-character commit SHA, with the version in
  a comment; a tag can be moved, a SHA cannot. The action reuses the SHAs of this repository's
  own CI workflow.
- **No script injection.** No `${{ }}` expression appears inside a `run:` script of the action
  or the examples. Inputs reach the scripts through `env:` and are checked against allowlists
  (section 2); arguments are passed to `node` as an array, never through `eval` or a shell
  string. Expressions remain only in `with:`, `if:`, `env:` and `concurrency:`, which are not
  shell.
- **No workflow commands from untrusted text.** DevFlow prints text from the repository, the
  pull request and the model. While DevFlow runs, the action suspends workflow commands with
  `::stop-commands::` and a random token, so a `::...::` line in that text is printed, not
  executed.
- **The token never reaches a model.** The GitHub token and the model keys are given only to
  the step that runs DevFlow, and only for `review` (never to `devflow trust` or `verify`).
  DevFlow sends the token only to `https://api.github.com`, never to a model, a run file or a
  child process ([ADR 0019](../adr/0019-github-rest-client.md)).
- **No dependency cache.** The action does not use a dependency cache: caches are shared
  between workflow runs, and a cache written by one run could be restored by another.
- **One review per pull request at a time.** The review workflow's concurrency group is per
  pull request, and a newer run cancels the older one.
- **Never merges.** Publishing posts a comment or a completed check run; it never approves,
  requests changes or merges ([CLI spec](cli.md), `--publish`).

## 4. Command approval in CI

There is no terminal in CI, so DevFlow never asks: a command that is not approved is not run
and is reported as `not_executed`, with its fingerprint in the log
([ADR 0007](../adr/0007-workspace-trust.md)). After reviewing a command, add its fingerprint
to `allow`. The workspace must be trusted for any command to run: `trust-workspace: "true"`
trusts the checked-out configuration for this job only. A changed script or wrapper changes
the fingerprint, so the command stops running until it is approved again.

DevFlow never installs dependencies: install them (and the Java toolchain) in an earlier step
of the verify workflow.

## 5. Using the examples

1. Copy the two files to `.github/workflows/`.
2. Replace `DEVFLOW_COMMIT_SHA` with the full SHA of the DevFlow commit you reviewed.
3. Verify: add the steps that install your dependencies, run once, review the commands the log
   shows, and add their fingerprints to `allow`.
4. Review: add the `ANTHROPIC_API_KEY` secret and the `DEVFLOW_MODEL` repository variable,
   write the task file the review uses (`.devflow/review-task.md`, or pass `issue:`), and
   create the `devflow-review` label.

## 6. pnpm version

`pnpm/action-setup` is given the version of DevFlow's `packageManager` (the test checks they
match). `pnpm/action-setup` also reads the `packageManager` field of the `package.json` at
the root of the workspace (the checked-out repository, not DevFlow) and, as documented,
stops when it names a different pnpm version. A repository whose `packageManager` names
another pnpm version cannot use the action as it is (not validated).

## 7. Not validated

- Neither the action nor the example workflows have run on GitHub. The test suite checks the
  files' structure and security properties and runs the input check under bash; it does not
  run the action, `pnpm/action-setup`, `actions/setup-node`, or a workflow.
- The pinned action versions (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0,
  `pnpm/action-setup` v6.1.1) are those of this repository's CI. Their inputs used here
  (`version`, `package-manager-cache: false`, `persist-credentials`, `fetch-depth`, `ref`)
  are assumed from those actions' documentation, not tested in this context.
- The `refs/pull/<n>/head` checkout, the `labels` condition and the `workflow_dispatch` number
  input follow GitHub's documented behaviour; they have not been exercised.
- Windows and macOS runners: the scripts are bash and are written to work there, but only the
  input check has run (under Git Bash on Windows, in the test suite).
