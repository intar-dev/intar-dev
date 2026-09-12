import { tracing } from "cloudflare:workers";

/** Native spans include awaited I/O and preserve Cloudflare's request context. */
export function traceOperation<T>(
  name: string,
  operation: () => Promise<T>,
  attributes: Record<string, string | number | boolean | undefined> = {},
): Promise<T> {
  return tracing.enterSpan(name, async (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      return await operation();
    } catch (error) {
      // Exception messages can contain IdP responses, credentials, or SQL data.
      span.setAttribute("error.type", "operation_failed");
      throw error;
    }
  });
}
