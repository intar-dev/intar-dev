import type { APIRoute } from "astro";
import { jsonResponse } from "@/lib/agent-bridge";
import {
  clientNetworkKey,
  enforceShareWatchRateLimit,
} from "@/lib/request-security";
import {
  isShareId,
  isShareWatchable,
  openShareViewer,
} from "@/lib/run-share/service";

export const prerender = false;

/**
 * The public viewer socket of a run share. Anyone with the link may watch,
 * while the run is visible and its owner's account is active. The share id
 * rides in the query string, which Worker logs redact.
 */
export const GET: APIRoute = async ({ request }) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse({ error: "expected websocket upgrade" }, { status: 426 });
  }
  const url = new URL(request.url);
  const shareId = url.searchParams.get("s") ?? "";
  if (!isShareId(shareId)) {
    return jsonResponse({ error: "share not found" }, { status: 404 });
  }
  const limited = await enforceShareWatchRateLimit(request);
  if (!limited.ok) return limited.response;
  if (!(await isShareWatchable(shareId))) {
    return jsonResponse({ error: "share not found" }, { status: 404 });
  }
  return openShareViewer(
    shareId,
    url.searchParams.get("after"),
    await clientNetworkKey(request),
  );
};
