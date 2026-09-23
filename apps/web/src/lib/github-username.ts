// Pure GitHub-username helpers, safe for both the client bundle and the
// worker. Stored usernames are normalized (lowercased).

export const GITHUB_USERNAME_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function normalizeGithubUsername(value?: string | null): string | null {
  const key = value?.trim().toLowerCase();
  return key ? key : null;
}

export function isValidGithubUsername(value: string): boolean {
  return GITHUB_USERNAME_PATTERN.test(value.trim());
}
