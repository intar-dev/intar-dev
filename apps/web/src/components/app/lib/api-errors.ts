import { HttpResponseError } from "./http-response-error";

/**
 * One place that turns a failed request into a friendly sentence and says
 * where it belongs: at a field the person can fix, or on the form.
 *
 *   const failure = describeApiError(error, {
 *     fallback: "Couldn't rename the organization. Try again.",
 *     fields: { name: /name/i },
 *   });
 *   <Field error={failure?.field === "name" ? failure.message : null} />
 *   {failure && failure.field === null ? <InlineFeedback>…</InlineFeedback> : null}
 *
 * Messages are sentence case and never say "we". A refusal (4xx) keeps the
 * server's own words, which are already written for people. Network failures,
 * expired sessions, rate limits and server faults get fixed wording, because
 * what the server says there is not for the person to read.
 */
export type ApiFailureKind =
  | "network"
  | "signed-out"
  | "rejected"
  | "rate-limited"
  | "unavailable"
  | "server";

export interface ApiFailure<Field extends string = string> {
  kind: ApiFailureKind;
  message: string;
  /** The field the refusal is about; null for the form as a whole. */
  field: Field | null;
}

export interface ApiErrorOptions<Field extends string> {
  /** Used when nothing more specific can be said. Sentence case, one sentence. */
  fallback: string;
  /**
   * Fields a refusal can be about, each with a pattern for the server's
   * message or code. A refusal that matches none goes to `defaultField`.
   */
  fields?: { [K in Field]?: RegExp };
  defaultField?: Field;
  /** Friendlier wording for the app's own error codes. */
  codes?: Readonly<Record<string, string>>;
}

/** Reads as a sentence written for people: capitalized, ends in punctuation, no "name: detail" shape. */
const READABLE = /^[A-Z][^:\n]{0,200}[.!?]$/;

function mappedMessage(
  codes: Readonly<Record<string, string>> | undefined,
  code: string | null,
): string | null {
  return code && codes && Object.hasOwn(codes, code) ? codes[code]! : null;
}

const NETWORK_MESSAGE =
  /failed to fetch|networkerror|network request failed|load failed|fetch failed/i;

/** A refusal the person can act on: a field to fix, a name taken, a limit. */
const FIELD_STATUSES = new Set([400, 409, 413, 422]);

/** Sentence case, ending in a full stop; leaves everything else as written. */
export function sentence(message: string): string {
  const text = message.trim();
  if (!text) return text;
  const head = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…]$/.test(head) ? head : `${head}.`;
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof HttpResponseError) return false;
  if (error instanceof DOMException && error.name === "AbortError") return false;
  return (
    error instanceof TypeError ||
    (error instanceof Error && NETWORK_MESSAGE.test(error.message))
  );
}

function statusOf(error: unknown): number | null {
  if (error instanceof HttpResponseError) return error.status;
  return null;
}

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const { code } = error as { code?: unknown };
  return typeof code === "string" ? code : null;
}

/**
 * The failure to show for `error`, or null when there is none. Pass the
 * mutation's `error` straight in.
 */
export function describeApiError<Field extends string = string>(
  error: unknown,
  options: ApiErrorOptions<Field>,
): ApiFailure<Field> | null {
  if (error === null || error === undefined) return null;
  const { fallback, fields, defaultField, codes } = options;
  const code = codeOf(error);
  const status = statusOf(error);
  const raw = error instanceof Error ? error.message : String(error);

  if (isNetworkError(error)) {
    return {
      kind: "network",
      message: "Couldn't reach Intar. Check your connection and try again.",
      field: null,
    };
  }
  if (status === 401) {
    return {
      kind: "signed-out",
      message: "You were signed out. Sign in again, then try once more.",
      field: null,
    };
  }
  if (status === 429) {
    return {
      kind: "rate-limited",
      message: "Too many attempts. Wait a moment, then try again.",
      field: null,
    };
  }
  // A server fault is for the person to read only when the app wrote it for
  // them: it names an app code, or reads as sentences. Anything else (a stack
  // fragment, a binding name) gets fixed wording.
  if (status !== null && status >= 500) {
    const readable =
      error instanceof HttpResponseError &&
      error.fromServer &&
      (code !== null || READABLE.test(raw.trim()));
    if (!readable) {
      return status === 503
        ? {
            kind: "unavailable",
            message: "Intar is temporarily unavailable. Try again in a moment.",
            field: null,
          }
        : {
            kind: "server",
            message: "Something went wrong on the server. Try again in a moment.",
            field: null,
          };
    }
    return {
      kind: status === 503 ? "unavailable" : "server",
      message: mappedMessage(codes, code) ?? sentence(raw),
      field: null,
    };
  }

  // A refusal, or an error the page raised itself: the words are written for
  // people. An error with no words of its own (a bare status) says the
  // fallback; so does a 404 that only says "not found".
  const own =
    error instanceof HttpResponseError
      ? error.fromServer && raw.trim()
        ? raw
        : null
      : raw.trim()
        ? raw
        : null;
  const mapped = mappedMessage(codes, code);
  const message =
    mapped ??
    (own && !(status === 404 && /^not found\.?$/i.test(own.trim()))
      ? sentence(own)
      : status === 404
        ? "That no longer exists. Refresh and try again."
        : sentence(fallback));

  // Only a validation-style refusal, or an error the page raised itself, is
  // about a field.
  let field: Field | null = null;
  if (status === null || FIELD_STATUSES.has(status)) {
    const haystack = `${code ?? ""} ${raw}`;
    for (const [name, pattern] of Object.entries(fields ?? {}) as [
      Field,
      RegExp | undefined,
    ][]) {
      if (pattern?.test(haystack)) {
        field = name;
        break;
      }
    }
    if (field === null && status !== null) field = defaultField ?? null;
  }
  return { kind: "rejected", message, field };
}

/** The message alone, for a line that has no field to route to. */
export function apiErrorMessage(error: unknown, fallback: string): string | null {
  return describeApiError(error, { fallback })?.message ?? null;
}
