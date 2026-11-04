/** Shared by the /play page and its API; no Worker imports here. */

/** M1: only the intar namespace resolves, with the scenario ID as the slug. */
export const PLAY_NAMESPACE = "intar";

/** Where sign-in returns when the requested path is not a /play page. */
export const DEFAULT_SIGN_IN_RETURN_PATH = "/courses";

/** The public /play API body. `briefing_markdown` is present only with a session. */
export interface PlayEntryResponse {
  title: string;
  summary: string;
  difficulty: string;
  minutes: number;
  credit: string | null;
  available: boolean;
  briefing_markdown?: string;
}

const REF_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;

/** The `?ref=` attribution tag, or undefined. It is never trusted. */
export function sanitizePlayRef(value: unknown): string | undefined {
  return typeof value === "string" && REF_PATTERN.test(value)
    ? value
    : undefined;
}

/** The /play page path, with its attribution tag, that sign-in returns to. */
export function playPagePath(
  namespace: string,
  slug: string,
  ref?: string,
): string {
  const path = `/play/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`;
  return ref ? `${path}?ref=${ref}` : path;
}

// An allowlist rather than a URL parse: one leading slash, plain path
// segments, and an optional plain query. No scheme, host, backslash,
// percent-encoding, whitespace or fragment can match.
const PLAY_RETURN_PATH_PATTERN =
  /^\/play\/[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*(?:\?[A-Za-z0-9_=&-]*)?$/u;

/**
 * The sign-in return path: a same-origin relative /play/ path, or
 * `/courses`. It guards the GitHub callback against open redirects.
 */
export function safeSignInReturnPath(value: unknown): string {
  return typeof value === "string" &&
    value.length <= 512 &&
    PLAY_RETURN_PATH_PATTERN.test(value)
    ? value
    : DEFAULT_SIGN_IN_RETURN_PATH;
}
