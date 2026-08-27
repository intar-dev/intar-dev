import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { loadAdminFleetSnapshot } from "@/lib/admin-fleet-snapshot";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

/** One bounded, authenticated read for the admin hosts and dashboard routes. */
export const GET: APIRoute = async ({ request, url }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) {
      return privateNoStore(authz.response);
    }

    const archiveOffset = parseArchiveOffset(
      url.searchParams.get("archiveOffset"),
    );
    if (archiveOffset === null) {
      return jsonResponse(
        { error: "archiveOffset must be a non-negative integer" },
        { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    const snapshot = await loadAdminFleetSnapshot({
      userId: authz.context.userId,
      archiveOffset,
      includeArchiveSummaries:
        url.searchParams.get("includeArchiveSummaries") !== "0",
    });
    return jsonResponse(snapshot, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load admin fleet snapshot",
    );
    return jsonResponse(body, { status, headers: PRIVATE_NO_STORE_HEADERS });
  }
};

function privateNoStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseArchiveOffset(value: string | null): number | null {
  if (value === null || value === "") return 0;
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
