import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import {
  getWorkshopSessionStatus,
  getWorkshopSessionStatusPreflight,
} from "@/lib/workshops/status";

export const prerender = false;

const privateNoStore = { "cache-control": "private, no-store" };

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return privateNoStoreResponse(authz.response);
  const sessionId = params.sessionId?.trim() ?? "";
  if (!sessionId) {
    return jsonResponse(
      { error: "sessionId is required" },
      { status: 400, headers: privateNoStore },
    );
  }
  const url = new URL(request.url);
  const knownVersion = url.searchParams.get("version")?.trim() || null;
  const knownManagerVersion =
    url.searchParams.get("managerVersion")?.trim() || null;
  const knownSessionVersion = parseKnownSessionVersion(
    url.searchParams.get("sessionVersion"),
  );
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    const preflight = await getWorkshopSessionStatusPreflight({
      sessionId,
      userId: authz.context.userId,
      knownSessionVersion,
      knownManagerVersion,
    });
    if (
      knownVersion &&
      knownVersion === preflight.version &&
      !preflight.requiresFullRefresh
    ) {
      return new Response(null, { status: 204, headers: privateNoStore });
    }
    const status = await getWorkshopSessionStatus({
      sessionId,
      userId: authz.context.userId,
      knownSessionVersion,
      knownManagerVersion,
      preflight,
    });
    return jsonResponse(status, { headers: privateNoStore });
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to load workshop session status",
    );
    return jsonResponse(body, { status, headers: privateNoStore });
  }
};

function privateNoStoreResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function parseKnownSessionVersion(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
