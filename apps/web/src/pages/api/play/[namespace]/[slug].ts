import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { loadPlayEntry } from "@/lib/play-entry";

export const prerender = false;

// The Worker's response hardening keeps a `public` policy only on /api/play/.
const PLAY_PUBLIC_CACHE_CONTROL = "public, max-age=60";

// Public: the /play entry page. Signed out it returns only the teaser fields
// and is cacheable; with a session it adds the briefing and is private.
export const GET: APIRoute = async ({ request, params }) => {
  try {
    // A revoked or expired session reads as signed out, never as an error.
    const signedIn = (await requireUserContext(request)).ok;
    const entry = await loadPlayEntry({
      namespace: params.namespace ?? "",
      slug: params.slug ?? "",
      signedIn,
    });
    if (!entry) {
      return jsonResponse(
        { error: "scenario not found", code: "play_not_found" },
        { status: 404 },
      );
    }
    return jsonResponse(entry, {
      headers: signedIn
        ? { "cache-control": "private, no-store" }
        : { "cache-control": PLAY_PUBLIC_CACHE_CONTROL, vary: "Cookie" },
    });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to load the lab");
    return jsonResponse(body, { status });
  }
};
