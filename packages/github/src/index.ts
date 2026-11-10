/**
 * @devflow/github: GitHub integration over the REST API (Phase 5, ADR 0019).
 *
 * Issues as task sources, pull requests to review, opt-in publishing of reviews, and draft
 * pull requests created only with explicit authorization.
 * Everything read from GitHub is external, untrusted text.
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
export {
  GitHubPullRequest,
  getPullRequest,
  parsePullRequestReference,
  type PullRequestInfo,
} from "./pulls.js";
export {
  COMMENT_MARKER,
  conclusionOf,
  publishReview,
  renderReview,
  type PublishInput,
  type PublishTarget,
  type Published,
} from "./publish.js";
export {
  DRAFT_MARKER,
  GitHubRepositoryInfo,
  createDraftPullRequest,
  draftTitle,
  getRepositoryInfo,
  renderDraftBody,
  type DraftBodyInput,
  type DraftPullRequest,
  type DraftPullRequestInput,
} from "./drafts.js";
export { githubToken } from "./token.js";
