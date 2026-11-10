import {
  DevflowError,
  EngineeringReport,
  ErrorCode,
  GitClient,
  credentialValuesFromEnv,
} from "@devflow/core";
import {
  type DraftPullRequest,
  createDraftPullRequest,
  draftTitle,
  getRepositoryInfo,
  githubToken,
  renderDraftBody,
  repositoryFromRemote,
  repositoryLabel,
} from "@devflow/github";
import { RunStore } from "@devflow/workflow";
import { ExitCode } from "../exit-codes.js";
import { githubClient, githubRepository } from "../github.js";
import type { CliIo } from "../io.js";
import { openWorkspace } from "../workspace.js";
import { guarded, writeJson } from "./workflow.js";

export interface PrCreateOptions {
  readonly repo?: string | undefined;
  readonly base?: string | undefined;
  readonly title?: string | undefined;
  /** The explicit authorization to push and create; without it only the plan is printed. */
  readonly yes: boolean;
  readonly json: boolean;
}

/** What `devflow pr create` does, shown before it does anything. */
export interface PrCreatePlan {
  /** `owner/name`. */
  readonly repository: string;
  readonly remote: "origin";
  readonly branch: string;
  /** The commit the branch points to: what is pushed. */
  readonly headCommit: string;
  readonly commits: number;
  readonly base: string;
  readonly title: string;
  readonly draft: true;
}

const REMOTE = "origin";
/** Base branches DevFlow accepts from `--base`: no option, no refspec syntax. */
const BASE = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

/**
 * `devflow pr create <run>` (Phase 5): pushes the DevFlow branch of a finished implement-mode
 * run to `origin` and opens a draft pull request. Without `--yes` it only prints what it would
 * do and exits 2. The push uses the user's own git credentials; the token is used only for
 * the GitHub API. DevFlow never merges, approves or requests reviews.
 */
export async function prCreateCommand(
  runId: string,
  options: PrCreateOptions,
  io: CliIo,
): Promise<ExitCode> {
  return guarded(io, options.json, async (interruption) => {
    const signal = interruption?.signal;
    const workspace = await openWorkspace(io);
    const store = await RunStore.open(workspace.root, runId);
    const record = await store.readRecord();

    if (record.mode !== "implement") {
      throw new DevflowError(
        ErrorCode.PullRequestRunInvalid,
        `run ${record.id} is a ${record.mode}-mode run; only a finished devflow implement ` +
          "(or devflow run) run can become a pull request",
      );
    }
    if (
      (record.state !== "COMPLETED" && record.state !== "FAILED") ||
      !(await store.exists("report.json"))
    ) {
      throw new DevflowError(
        ErrorCode.PullRequestRunInvalid,
        `run ${record.id} is in state ${record.state}; a pull request is prepared from a ` +
          "finished run (completed or failed)",
      );
    }
    const git = record.git;
    if (git?.status !== "branch") {
      throw new DevflowError(
        ErrorCode.PullRequestRunInvalid,
        `run ${record.id} has no DevFlow branch` +
          (git?.status === "none" ? ` (${git.reason})` : "") +
          "; commit and push the changes yourself",
      );
    }
    const last = git.commits.at(-1);
    if (last === undefined) {
      throw new DevflowError(
        ErrorCode.PullRequestRunInvalid,
        `run ${record.id} made no commit on ${git.branch}; commit the changes on it yourself`,
      );
    }
    if (githubToken(io.env) === undefined) {
      throw new DevflowError(
        ErrorCode.OptionsInvalid,
        "devflow pr create needs a GitHub token: set GITHUB_TOKEN or GH_TOKEN " +
          "(pull-requests: write); the push itself uses your own git credentials",
      );
    }
    const repository = await githubRepository(options.repo, workspace.root, io);
    if (repository === undefined) {
      throw new DevflowError(
        ErrorCode.GitHubRepositoryUnknown,
        "the origin remote is not on github.com; use --repo owner/name",
      );
    }
    const label = repositoryLabel(repository);

    // The push goes to origin: every URL it pushes to must be the target repository.
    const gitOptions = { root: workspace.root, env: io.env };
    const client = io.gitClient?.(gitOptions) ?? new GitClient(gitOptions);
    const urls = await client.pushUrls(REMOTE);
    if (urls.length === 0) {
      throw new DevflowError(
        ErrorCode.PullRequestTargetInvalid,
        `the repository has no ${REMOTE} remote; add one for github.com/${label}`,
      );
    }
    for (const url of urls) {
      const target = repositoryFromRemote(url);
      if (target === undefined || repositoryLabel(target).toLowerCase() !== label.toLowerCase()) {
        throw new DevflowError(
          ErrorCode.PullRequestTargetInvalid,
          `${REMOTE} pushes to ${withoutCredentials(url)}, not to github.com/${label}; DevFlow ` +
            "pushes only to the repository of the pull request",
        );
      }
    }

    const branch = git.branch;
    const head = await client.branchCommit(branch);
    if (head === null) {
      throw new DevflowError(
        ErrorCode.PullRequestRunInvalid,
        `branch ${branch} of run ${record.id} no longer exists`,
      );
    }
    if (!(await client.isAncestor(last.sha, head))) {
      throw new DevflowError(
        ErrorCode.PullRequestRunInvalid,
        `branch ${branch} no longer contains the run's last commit ${last.sha.slice(0, 12)}; ` +
          "it was rewritten after the run",
      );
    }

    const info = await getRepositoryInfo(githubClient(io), repository, signal);
    const base = options.base ?? git.baseBranch ?? info.default_branch;
    if (!BASE.test(base) || base.includes("..")) {
      throw new DevflowError(ErrorCode.OptionsInvalid, `"${base.slice(0, 80)}" is not a branch`);
    }
    for (const refused of new Set([base, info.default_branch])) {
      if (branch.toLowerCase() === refused.toLowerCase()) {
        throw new DevflowError(
          ErrorCode.PullRequestTargetInvalid,
          `the run's branch ${branch} is the ` +
            (refused === base ? "base" : "default branch") +
            ` of ${label}; DevFlow never pushes to it`,
        );
      }
    }
    const title = draftTitle(options.title ?? `DevFlow ${record.task.id}: ${record.task.title}`);
    if (title === "") throw new DevflowError(ErrorCode.OptionsInvalid, "--title is empty");

    const plan: PrCreatePlan = {
      repository: label,
      remote: REMOTE,
      branch,
      headCommit: head,
      commits: git.commits.length,
      base,
      title,
      draft: true,
    };
    if (!options.yes) {
      const message =
        "Nothing was pushed or created. Run the command again with --yes to authorize it.";
      if (options.json) writeJson(io, { runId: record.id, plan, done: false, message });
      else {
        printPlan(io, plan);
        io.stdout.write(`\n${message}\n`);
      }
      return ExitCode.UsageError;
    }

    if (!options.json) printPlan(io, plan);
    io.stderr.write(`Pushing ${branch} to ${REMOTE}...\n`);
    await client.push(branch, { remote: REMOTE });
    const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
    let created: DraftPullRequest;
    try {
      io.stderr.write("Creating the draft pull request...\n");
      created = await createDraftPullRequest(
        githubClient(io),
        {
          repository,
          head: branch,
          base,
          title,
          body: renderDraftBody({ report, repository, branch, base, commits: git.commits }),
          knownSecrets: credentialValuesFromEnv(io.env),
        },
        signal,
      );
    } catch (error) {
      if (error instanceof DevflowError) {
        throw new DevflowError(
          error.code,
          `${error.message} (${branch} was pushed to ${REMOTE}; no pull request was created)`,
          { details: error.details, cause: error },
        );
      }
      throw error;
    }
    if (options.json) {
      writeJson(io, { runId: record.id, plan, done: true, pullRequest: created });
    } else {
      io.stdout.write(
        `\nPushed ${branch} and opened draft pull request #${String(created.number)}: ` +
          `${created.url}\n`,
      );
      if (!created.draft) {
        io.stdout.write(
          "Warning: GitHub did not mark it as a draft; review it before anyone merges it.\n",
        );
      }
      io.stdout.write("Review the change on GitHub; DevFlow does not mark it ready or merge it.\n");
    }
    return ExitCode.Success;
  });
}

function printPlan(io: CliIo, plan: PrCreatePlan): void {
  io.stdout.write(
    [
      "devflow pr create will:",
      `  1. push branch ${plan.branch} (commit ${plan.headCommit.slice(0, 12)}, ` +
        `${String(plan.commits)} DevFlow commit${plan.commits === 1 ? "" : "s"}) to ` +
        `${plan.remote} (github.com/${plan.repository}), without force and without tags`,
      `  2. open a draft pull request in ${plan.repository}: ${plan.branch} -> ${plan.base}`,
      `     Title: ${plan.title}`,
      "It never marks the pull request ready, requests reviews or merges it.",
      "",
    ].join("\n"),
  );
}

/** A remote URL as it may be shown: without a user name or password. */
function withoutCredentials(url: string): string {
  return url.replace(/\/\/[^/@\s]*@/g, "//").slice(0, 200);
}
