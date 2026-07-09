import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { submitAccessRequest } from "@/lib/access-requests";

export const prerender = false;

// Public endpoint — the request-access form posts here unauthenticated.
// Responses are deliberately uniform so usernames can't be enumerated.
export const POST: APIRoute = async ({ request }) => {
  const clientKey = request.headers.get("cf-connecting-ip")?.trim() || "unknown";
  try {
    const { success } = await env.ACCESS_REQUEST_RATE_LIMITER.limit({
      key: `access-request:${clientKey}`,
    });
    if (!success) {
      return jsonResponse(
        { error: "too many access requests" },
        { status: 429, headers: { "retry-after": "60" } },
      );
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "access request rate limiter failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return jsonResponse(
      { error: "access requests are temporarily unavailable" },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    username?: unknown;
    note?: unknown;
  } | null;

  const username = typeof body?.username === "string" ? body.username : "";
  const note = typeof body?.note === "string" ? body.note : null;

  try {
    await submitAccessRequest({ username, note });
    return jsonResponse({ received: true }, { status: 202 });
  } catch (error) {
    const { status, body: errorBody } = toErrorResponse(
      error,
      "failed to submit access request",
    );
    return jsonResponse(errorBody, { status });
  }
};
