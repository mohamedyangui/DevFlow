import {
  DevflowError,
  ErrorCode,
  type IssueSource,
  type IssueTaskDocument,
  MAX_TASK_FILE_BYTES,
} from "@devflowai/core";
import { z } from "zod";
import { type GitHubClient, apiPath } from "./client.js";
import { type GitHubRepository, isRepository, repositoryLabel } from "./repository.js";

/** The fields of a REST API issue DevFlow reads; GitHub sends many more. */
export const GitHubIssue = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  html_url: z.string(),
  /** Present when the issue is a pull request. */
  pull_request: z.unknown().optional(),
});
export type GitHubIssue = z.infer<typeof GitHubIssue>;

export interface IssueReference {
  readonly repository: GitHubRepository;
  readonly number: number;
}

const MAX_ISSUE_NUMBER = 2 ** 31 - 1;

/**
 * Parses an issue reference: `142`, `#142`, `owner/name#142` or
 * `https://github.com/owner/name/issues/142`. A bare number needs `repository`.
 *
 * @throws DevflowError `GITHUB_ISSUE_INVALID` or `GITHUB_REPOSITORY_UNKNOWN`.
 */
export function parseIssueReference(
  text: string,
  repository: GitHubRepository | undefined,
): IssueReference {
  const reference = text.trim();
  const url = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(reference);
  const qualified = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(reference);
  const bare = /^#?(\d+)$/.exec(reference);

  let target: GitHubRepository | undefined;
  let digits: string | undefined;
  const match = url ?? qualified;
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
    target = repository;
    if (target === undefined) {
      throw new DevflowError(
        ErrorCode.GitHubRepositoryUnknown,
        `issue ${reference} needs a repository: the origin remote is not on github.com; ` +
          "use --repo owner/name or owner/name#number",
      );
    }
  }
  const number = Number(digits);
  if (target === undefined || !Number.isSafeInteger(number) || number < 1) {
    throw new DevflowError(
      ErrorCode.GitHubIssueInvalid,
      `"${reference.slice(0, 80)}" is not an issue reference; use a number, owner/name#number ` +
        "or the issue URL",
    );
  }
  if (number > MAX_ISSUE_NUMBER) {
    throw new DevflowError(
      ErrorCode.GitHubIssueInvalid,
      `issue number ${digits ?? ""} is too large`,
    );
  }
  return { repository: target, number };
}

/**
 * Reads GitHub issues as task documents (ADR 0019). The issue body is the task text, parsed by
 * the core Markdown task parser like a task file; the issue's number and title are the
 * defaults for the task id (`GH-<number>`) and title. Everything from the issue is `external`:
 * it defines the task but never changes DevFlow's policies. Comments are not read.
 */
export class GitHubIssueSource implements IssueSource {
  readonly id = "github";

  constructor(
    private readonly client: GitHubClient,
    private readonly repository: GitHubRepository | undefined,
  ) {}

  async fetch(reference: string, signal: AbortSignal): Promise<IssueTaskDocument> {
    const target = parseIssueReference(reference, this.repository);
    const label = `${repositoryLabel(target.repository)}#${String(target.number)}`;
    const issue = await this.client.request({
      path: apiPath(
        "repos",
        target.repository.owner,
        target.repository.name,
        "issues",
        target.number,
      ),
      schema: GitHubIssue,
      signal,
    });
    if (issue.number !== target.number) {
      throw new DevflowError(
        ErrorCode.GitHubRequestFailed,
        `GitHub answered with issue #${String(issue.number)} for ${label}`,
      );
    }
    if (issue.pull_request !== undefined) {
      throw new DevflowError(
        ErrorCode.GitHubIssueInvalid,
        `${label} is a pull request, not an issue; a task comes from an issue`,
        { details: { issue: label } },
      );
    }
    const text = issue.body ?? "";
    if (Buffer.byteLength(text, "utf8") > MAX_TASK_FILE_BYTES) {
      throw new DevflowError(
        ErrorCode.GitHubIssueInvalid,
        `the body of ${label} is larger than ${String(MAX_TASK_FILE_BYTES)} bytes`,
        { details: { issue: label } },
      );
    }
    const title = issue.title.trim();
    return {
      text,
      format: "markdown",
      source: { kind: "github-issue", ref: label, trust: "external" },
      defaults: {
        id: `GH-${String(issue.number)}`,
        ...(title === "" ? {} : { title }),
      },
      warnings: issue.state === "closed" ? [`${label} is closed`] : [],
    };
  }
}
