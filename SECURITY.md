# Security policy

## Supported versions

DevFlow AI is in early development and has no released versions yet. Security fixes are made
on the main branch.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Report them privately through
GitHub's [private vulnerability reporting](https://github.com/mohamedyangui/DevFlow/security/advisories/new)
("Report a vulnerability" on the repository's Security tab). Include:

- a description of the problem and its impact;
- steps to reproduce, ideally a minimal repository or task file;
- the DevFlow commit, operating system and Node.js version.

You will receive an acknowledgement within 7 days. Please allow time for a fix before public
disclosure.

## Scope

Particularly relevant reports include ways to:

- make DevFlow execute a command that is not in the adapter catalog or the trusted
  configuration, or execute anything in an untrusted workspace;
- bypass argument validation, including `cmd.exe` argument injection on Windows;
- write or read files outside the workspace, or modify protected paths;
- send secrets to a model provider, logs or reports;
- make a report claim `passed` or `verified` without execution evidence.

## Known limitations

Running a project's build or tests runs that project's code with your privileges. DevFlow
restricts this to repositories you have explicitly trusted, but cannot make a malicious build
safe. See the residual risks in the [security model](docs/specs/security-model.md).
