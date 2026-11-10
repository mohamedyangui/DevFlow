/**
 * @devflow/github: GitHub integration over the REST API (Phase 5, ADR 0019).
 *
 * Issues as task sources. Everything read from GitHub is external, untrusted text.
 */
export {
  DEFAULT_GITHUB_API_URL,
  GitHubClient,
  apiPath,
  type GitHubClientOptions,
  type GitHubRequest,
} from "./client.js";
export {
  GitHubIssue,
  GitHubIssueSource,
  parseIssueReference,
  type IssueReference,
} from "./issues.js";
export {
  isRepository,
  parseRepository,
  repositoryFromRemote,
  repositoryLabel,
  type GitHubRepository,
} from "./repository.js";
export { githubToken } from "./token.js";
