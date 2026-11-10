# GitHub API fixtures

Answers in the shape of the GitHub REST API (version `2022-11-28`), trimmed to the fields that
matter and with made-up repositories, users and ids. The field set was checked against a live
answer of the public API (`GET /repos/{owner}/{repo}/issues/{number}`) when they were written.

- `issue-142.json`: an open issue whose body is a Markdown task (CRLF line endings, as GitHub
  stores text typed in the browser).
- `pull-57.json`: the issues endpoint answering for a pull request (`pull_request` is set).
- `repo-shop.json` (`GET /repos/{owner}/{repo}`) and `pull-created-58.json` (the `201` answer
  of `POST /repos/{owner}/{repo}/pulls` with `draft: true`): written from the REST API
  documentation, not checked against a live answer.
