import { DevflowError, ErrorCode } from "@devflowai/core";

/** A GitHub repository, `owner/name`. */
export interface GitHubRepository {
  readonly owner: string;
  readonly name: string;
}

// GitHub's own rules: owners are letters, digits and single hyphens (at most 39 characters);
// repository names are letters, digits, ".", "_" and "-" (at most 100 characters).
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function repositoryLabel(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.name}`;
}

/** Whether `owner` and `name` are a valid repository; `.` and `..` are never names. */
export function isRepository(owner: string, name: string): boolean {
  return OWNER.test(owner) && NAME.test(name) && name !== "." && name !== "..";
}

/**
 * Parses `owner/name` (from `--repo`).
 *
 * @throws DevflowError `GITHUB_REPOSITORY_UNKNOWN` for anything else.
 */
export function parseRepository(text: string): GitHubRepository {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(text.trim());
  const owner = match?.[1] ?? "";
  const name = (match?.[2] ?? "").replace(/\.git$/, "");
  if (!isRepository(owner, name)) {
    throw new DevflowError(
      ErrorCode.GitHubRepositoryUnknown,
      `"${truncate(text)}" is not a GitHub repository; use owner/name`,
    );
  }
  return { owner, name };
}

/**
 * The repository of a git remote URL on github.com, or undefined when the remote is elsewhere
 * or not in a form DevFlow recognises. Accepted: `https://github.com/o/r(.git)`,
 * `git@github.com:o/r(.git)` and `ssh://git@github.com/o/r(.git)`. Credentials in the URL are
 * ignored and never returned.
 */
export function repositoryFromRemote(url: string): GitHubRepository | undefined {
  const text = url.trim();
  const scp = /^[A-Za-z0-9._-]+@github\.com:([^/]+)\/([^/]+?)\/?$/.exec(text);
  let owner: string | undefined;
  let name: string | undefined;
  if (scp !== null) {
    owner = scp[1];
    name = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(text);
    } catch {
      return undefined;
    }
    if (!["https:", "ssh:", "git:"].includes(parsed.protocol)) return undefined;
    if (parsed.hostname.toLowerCase() !== "github.com") return undefined;
    if (parsed.port !== "" && parsed.protocol !== "ssh:") return undefined;
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    if (parts.length !== 2) return undefined;
    [owner, name] = parts;
  }
  name = name?.replace(/\.git$/, "");
  if (owner === undefined || name === undefined || !isRepository(owner, name)) return undefined;
  return { owner, name };
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
