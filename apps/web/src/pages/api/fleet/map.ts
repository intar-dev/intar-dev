import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { accessInviteNoStore } from "@/lib/access-invite-http";
import { toErrorResponse } from "@/lib/app-error";
import { loadFleetMap } from "@/lib/fleet-map";

export const prerender = false;

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

/**
 * The placed fleet for the signed-in fleet map. Read-only, redacted, and one
 * bounded read: the payload holds locations, host state, and capacity, never
 * a host name, a host id, or an address.
 */
export const GET: APIRoute = async ({ request }) => {
  try {
    const authz = await requireUserContext(request);
    if (!authz.ok) {
      return accessInviteNoStore(authz.response);
    }

    const snapshot = await loadFleetMap({});
    return jsonResponse(snapshot, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load the fleet map",
    );
    return jsonResponse(body, {
      status,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  }
};
