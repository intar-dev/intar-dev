import type { APIRoute } from "astro";
import { jsonResponse } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { submitAccessRequest } from "@/lib/access-requests";

export const prerender = false;

// Public endpoint — the request-access form posts here unauthenticated.
// Responses are deliberately uniform so usernames can't be enumerated.
export const POST: APIRoute = async ({ request }) => {
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
