export class HttpResponseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpResponseError";
    this.status = status;
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
