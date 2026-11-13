import {
  DevflowError,
  EngineeringReport,
  ErrorCode,
  GitClient,
  credentialValuesFromEnv,
} from "@devflowai/core";
import {
  type GitHubRepository,
  GitHubClient,
  type PublishTarget,
  type Published,
  githubToken,
  parseRepository,
  publishReview,
  repositoryFromRemote,
} from "@devflowai/github";
import type { RunStore } from "@devflowai/workflow";
import type { CliIo } from "./io.js";

/** The GitHub client of a command: the token from the environment, `fetch` from `io`. */
export function githubClient(io: CliIo): GitHubClient {
  return new GitHubClient({
    token: githubToken(io.env),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
}

/** `--repo owner/name`, or else the github.com repository of the origin remote. */
export async function githubRepository(
  repo: string | undefined,
  root: string,
  io: CliIo,
): Promise<GitHubRepository | undefined> {
  if (repo !== undefined) return parseRepository(repo);
  try {
    const url = await new GitClient({ root, env: io.env }).remoteUrl();
    return url === null ? undefined : repositoryFromRemote(url);
  } catch {
    return undefined;
  }
}

/** Stops before a run is created when `--publish` cannot work: there is no token. */
export function checkCanPublish(io: CliIo): void {
  if (githubToken(io.env) === undefined) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      "--publish needs a GitHub token: set GITHUB_TOKEN (pull-requests: write for a comment, " +
        "checks: write for a check run)",
    );
  }
}

/** Publishes the finished review of a run to its pull request. */
export async function publishRun(
  store: RunStore,
  target: PublishTarget,
  io: CliIo,
  signal?: AbortSignal,
): Promise<Published> {
  const record = await store.readRecord();
  const pull = record.review?.pullRequest;
  if (pull === undefined) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      `run ${record.id} did not review a pull request; only \`devflow review --pr\` runs can be published`,
    );
  }
  if (!(await store.exists("report.json"))) {
    throw new DevflowError(
      ErrorCode.OptionsInvalid,
      `run ${record.id} is in state ${record.state}; a review is published when the run finishes`,
    );
  }
  const report = EngineeringReport.parse(JSON.parse(await store.readText("report.json")));
  const repository = parseRepository(pull.repository);
  return publishReview(
    githubClient(io),
    target,
    {
      repository,
      number: pull.number,
      headSha: pull.headCommit,
      report,
      knownSecrets: credentialValuesFromEnv(io.env),
    },
    signal,
  );
}
