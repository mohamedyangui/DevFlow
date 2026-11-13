import { DevflowError, ErrorCode } from "@devflowai/core";
import { z } from "zod";
import { type GitHubClient, apiPath } from "./client.js";
import { type GitHubRepository, isRepository, repositoryLabel } from "./repository.js";

const Sha = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const Ref = z.object({
  sha: Sha,
  ref: z.string().min(1),
  /** null when the head repository was deleted. */
  repo: z.object({ full_name: z.string().min(1) }).nullable(),
});

/** The fields of a REST API pull request DevFlow reads. */
export const GitHubPullRequest = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  merged: z.boolean().optional(),
  html_url: z.string(),
  head: Ref,
  base: Ref,
});
export type GitHubPullRequest = z.infer<typeof GitHubPullRequest>;

/** What a review needs to know about a pull request. */
export interface PullRequestInfo {
  readonly repository: GitHubRepository;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly baseRef: string;
  /** `owner/name` of the head repository, or null when it was deleted. */
  readonly headRepository: string | null;
  /** The head is in another repository (a fork), or its repository was deleted. */
  readonly fromFork: boolean;
  /** Facts a person should know: closed, merged, draft. */
  readonly warnings: readonly string[];
}

const MAX_NUMBER = 2 ** 31 - 1;

/**
 * Parses a pull request reference: `57`, `#57`, `owner/name#57` or
 * `https://github.com/owner/name/pull/57`. A bare number needs `repository`.
 */
export function parsePullRequestReference(
  text: string,
  repository: GitHubRepository | undefined,
): { readonly repository: GitHubRepository; readonly number: number } {
  const reference = text.trim();
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(reference) ??
    /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(reference);
  const bare = /^#?(\d+)$/.exec(reference);
  let target = repository;
  let digits: string | undefined;
  if (match !== null) {
    const [owner = "", name = ""] = [match[1], match[2]];
    if (!isRepository(owner, name)) {
      throw new DevflowError(
        ErrorCode.GitHubRepositoryUnknown,
        `"${`${owner}/${name}`.slice(0, 80)}" is not a GitHub repository`,
      );
    }
    target = { owner, name };
    digits = match[3];
  } else if (bare !== null) {
    digits = bare[1];
    if (target === undefined) {
      throw new DevflowError(
        ErrorCode.GitHubRepositoryUnknown,
        `pull request ${reference} needs a repository: the origin remote is not on github.com; ` +
          "use --repo owner/name or owner/name#number",
      );
    }
  }
  const number = Number(digits);
  if (target === undefined || !Number.isSafeInteger(number) || number < 1 || number > MAX_NUMBER) {
    throw new DevflowError(
      ErrorCode.GitHubPullRequestInvalid,
      `"${reference.slice(0, 80)}" is not a pull request reference; use a number, ` +
        "owner/name#number or the pull request URL",
    );
  }
  return { repository: target, number };
}

/** Reads a pull request (metadata only: DevFlow never fetches its code over the network). */
export async function getPullRequest(
  client: GitHubClient,
  reference: string,
  repository: GitHubRepository | undefined,
  signal?: AbortSignal,
): Promise<PullRequestInfo> {
  const target = parsePullRequestReference(reference, repository);
  const label = `${repositoryLabel(target.repository)}#${String(target.number)}`;
  const pull = await client.request({
    path: apiPath("repos", target.repository.owner, target.repository.name, "pulls", target.number),
    schema: GitHubPullRequest,
    signal,
  });
  if (pull.number !== target.number) {
    throw new DevflowError(
      ErrorCode.GitHubRequestFailed,
      `GitHub answered with pull request #${String(pull.number)} for ${label}`,
    );
  }
  const baseRepository = pull.base.repo?.full_name ?? repositoryLabel(target.repository);
  const headRepository = pull.head.repo?.full_name ?? null;
  const warnings: string[] = [];
  if (pull.merged === true) warnings.push(`${label} is already merged`);
  else if (pull.state === "closed") warnings.push(`${label} is closed`);
  if (pull.draft === true) warnings.push(`${label} is a draft`);
  return {
    repository: target.repository,
    number: pull.number,
    title: pull.title,
    url: pull.html_url,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    baseRef: pull.base.ref,
    headRepository,
    fromFork: headRepository?.toLowerCase() !== baseRepository.toLowerCase(),
    warnings,
  };
}
