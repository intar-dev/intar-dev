import type { APIRoute } from "astro";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import {
  loadAdminRunArchivePage,
  parseAdminRunArchiveCursor,
} from "@/lib/admin-fleet-snapshot";
import { toErrorResponse } from "@/lib/app-error";

export const prerender = false;

const PRIVATE_NO_STORE_HEADERS = {
  "cache-control": "private, no-store",
};

export const GET: APIRoute = async ({ request, url }) => {
  try {
    const authz = await requireAdminUserContext(request);
    if (!authz.ok) return privateNoStore(authz.response);

    const cursor = parseAdminRunArchiveCursor(url.searchParams.get("cursor"));
    if (cursor === null) {
      return jsonResponse(
        { error: "cursor is invalid" },
        { status: 400, headers: PRIVATE_NO_STORE_HEADERS },
      );
    }

    const page = await loadAdminRunArchivePage({
      ...(cursor ? { cursor } : {}),
    });
    return jsonResponse(page, { headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load admin run archive",
    );
    return jsonResponse(body, {
      status,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
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
