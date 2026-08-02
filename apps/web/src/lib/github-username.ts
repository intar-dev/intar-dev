// Pure GitHub-username helpers, safe for both the client bundle and the
// worker. The D1 allowlist key is the normalized (lowercased) username.

export const GITHUB_USERNAME_PATTERN =
  /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function toAllowlistKey(value?: string | null): string | null {
  const key = value?.trim().toLowerCase();
  return key ? key : null;
}

export function isValidGithubUsername(value: string): boolean {
  return GITHUB_USERNAME_PATTERN.test(value.trim());
}
