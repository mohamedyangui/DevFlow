import { DevflowError, type EngineeringReport, ErrorCode, SecretRedactor } from "@devflow/core";
import { z } from "zod";
import { type GitHubClient, apiPath } from "./client.js";
import { limitBody, neutralise, renderEvidence } from "./publish.js";
import { type GitHubRepository, repositoryLabel } from "./repository.js";

/** The first line of every pull request description DevFlow writes. */
export const DRAFT_MARKER = "<!-- devflow-draft -->";
/** GitHub accepts titles up to 256 characters. */
const MAX_TITLE_CHARS = 200;
const MAX_FILES = 50;

/** The fields of a repository DevFlow reads. */
export const GitHubRepositoryInfo = z.object({
  full_name: z.string().min(1),
  default_branch: z.string().min(1),
  archived: z.boolean().optional(),
});
export type GitHubRepositoryInfo = z.infer<typeof GitHubRepositoryInfo>;

/** Reads a repository's metadata (its default branch). */
export async function getRepositoryInfo(
  client: GitHubClient,
  repository: GitHubRepository,
  signal?: AbortSignal,
): Promise<GitHubRepositoryInfo> {
  return client.request({
    path: apiPath("repos", repository.owner, repository.name),
    schema: GitHubRepositoryInfo,
    signal,
  });
}

export interface DraftPullRequestInput {
  readonly repository: GitHubRepository;
  /** The branch with the changes, already pushed to the repository. */
  readonly head: string;
  /** The branch the changes are proposed for. */
  readonly base: string;
  readonly title: string;
  readonly body: string;
  /** Exact values that must never be published (tokens, keys). */
  readonly knownSecrets?: readonly string[];
}

export interface DraftPullRequest {
  readonly number: number;
  readonly url: string;
  /** False when GitHub did not create a draft (the answer is still reported). */
  readonly draft: boolean;
}

const Created = z.object({
  number: z.number().int().positive(),
  html_url: z.string().min(1),
  draft: z.boolean().optional(),
  head: z.object({ ref: z.string() }),
  base: z.object({ ref: z.string() }),
});

/**
 * Opens a draft pull request (Phase 5, `devflow pr create`). Only `POST /repos/o/r/pulls` with
 * `draft: true`: DevFlow never marks it ready, requests reviewers, approves or merges. The
 * title and body are redacted again before they are sent.
 */
export async function createDraftPullRequest(
  client: GitHubClient,
  input: DraftPullRequestInput,
  signal?: AbortSignal,
): Promise<DraftPullRequest> {
  if (!client.authenticated) {
    throw new DevflowError(
      ErrorCode.GitHubRequestFailed,
      "creating a pull request needs a token: set GITHUB_TOKEN (pull-requests: write)",
    );
  }
  if (input.head === input.base) {
    throw new DevflowError(
      ErrorCode.PullRequestTargetInvalid,
      `the pull request branch and its base are both ${input.base}`,
    );
  }
  const redactor = new SecretRedactor({ knownSecrets: input.knownSecrets ?? [] });
  const created = await client.request({
    method: "POST",
    path: apiPath("repos", input.repository.owner, input.repository.name, "pulls"),
    body: {
      title: draftTitle(redactor.redact(input.title).text),
      head: input.head,
      base: input.base,
      body: redactor.redact(input.body).text,
      draft: true,
    },
    schema: Created,
    signal,
  });
  if (created.head.ref !== input.head || created.base.ref !== input.base) {
    throw new DevflowError(
      ErrorCode.GitHubRequestFailed,
      `GitHub answered with pull request #${String(created.number)} from ${created.head.ref} ` +
        `to ${created.base.ref}, not from ${input.head} to ${input.base}`,
    );
  }
  return { number: created.number, url: created.html_url, draft: created.draft === true };
}

/** A pull request title: one line without control characters, at most 200 characters. */
export function draftTitle(title: string): string {
  // eslint-disable-next-line no-control-regex
  const flat = title.replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}

export interface DraftBodyInput {
  readonly report: EngineeringReport;
  readonly repository: GitHubRepository;
  readonly branch: string;
  readonly base: string;
  /** The commits DevFlow made on the branch, oldest first. */
  readonly commits: readonly { readonly sha: string; readonly subject: string }[];
}

/**
 * The description of a draft pull request, from the run's report: the verdict, the commits,
 * the files changed, the acceptance criteria, gates and findings. Everything that came from a
 * model, a task or a repository is neutralised as in a published review.
 */
export function renderDraftBody(input: DraftBodyInput): string {
  const { report } = input;
  const lines: string[] = [
    DRAFT_MARKER,
    `## DevFlow draft: ${neutralise(report.task.id)}: ${neutralise(report.task.title)}`,
    "",
    `**Verdict:** ${report.verdict} · **Branch:** \`${code(input.branch)}\` → ` +
      `\`${code(input.base)}\` in ${neutralise(repositoryLabel(input.repository))}`,
    "",
    "> [!IMPORTANT]",
    "> DevFlow prepared this pull request from an AI-assisted run. It is a draft: a person must " +
      "review the change, the tests and this description before it is marked ready or merged.",
    "",
  ];
  if (input.commits.length > 0) {
    lines.push("### Commits", "");
    for (const commit of input.commits) {
      lines.push(`- \`${commit.sha.slice(0, 12)}\` ${neutralise(commit.subject)}`);
    }
    lines.push("");
  }
  if (report.filesChanged.length > 0) {
    lines.push(`### Files changed (${String(report.filesChanged.length)})`, "");
    for (const file of report.filesChanged.slice(0, MAX_FILES)) {
      lines.push(`- ${file.change}: \`${code(file.path)}\``);
    }
    if (report.filesChanged.length > MAX_FILES) {
      lines.push(`- _${String(report.filesChanged.length - MAX_FILES)} more in the report_`);
    }
    lines.push("");
  }
  lines.push(...renderEvidence(report));
  lines.push(
    "---",
    `_Prepared by DevFlow AI ${neutralise(report.run.devflowVersion)} from run ` +
      `\`${code(report.run.id)}\`. AI findings are a model's suggestions and stay ` +
      "unverified until a test or a person confirms them. DevFlow never marks this pull " +
      "request ready, requests reviews or merges it._",
  );
  return limitBody(
    lines.join("\n"),
    "The description was cut here; the full report is in the run.",
  );
}

/** Text inside a code span: one line, no backtick, at most 200 characters. */
function code(value: string): string {
  const flat = value.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return flat.length > MAX_TITLE_CHARS ? `${flat.slice(0, MAX_TITLE_CHARS - 1)}…` : flat;
}
