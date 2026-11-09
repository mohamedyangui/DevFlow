/**
 * The GitHub token from the environment: `GITHUB_TOKEN` (GitHub Actions), then `GH_TOKEN` (the
 * `gh` CLI convention). The token is only ever sent to the GitHub API; child processes never
 * receive it (docs/specs/security-model.md).
 */
export function githubToken(env: Readonly<Record<string, string | undefined>>): string | undefined {
  for (const name of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}
