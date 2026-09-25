export class HttpResponseError extends Error {
  readonly status: number;
  /** The app's error code, when the response named one. */
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null = null) {
    super(message);
    this.name = "HttpResponseError";
    this.status = status;
    this.code = code;
  }

  /** The error for a refused response whose body is the app's `{ error, code }`. */
  static fromBody(
    status: number,
    body: unknown,
    fallback: string,
  ): HttpResponseError {
    const fields =
      typeof body === "object" && body !== null
        ? (body as { error?: unknown; code?: unknown })
        : {};
    return new HttpResponseError(
      status,
      typeof fields.error === "string" ? fields.error : fallback,
      typeof fields.code === "string" ? fields.code : null,
    );
  }
}

export function isAccessResponseError(
  error: unknown,
  includeNotFound = false,
): error is HttpResponseError {
  return (
    error instanceof HttpResponseError &&
    (error.status === 401 ||
      error.status === 403 ||
      (includeNotFound && error.status === 404))
  );
}

export function retryHttpResponseError(failureCount: number, error: unknown) {
  return !isAccessResponseError(error, true) && failureCount < 3;
}

export function pollingIntervalUnlessAccessError(
  error: unknown,
  interval: number | false,
): number | false {
  return isAccessResponseError(error, true) ? false : interval;
}
