import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { canonicalApplicationOrigin } from "@/lib/request-security";
import { getScenarioRunStatusStreamTargetForUser } from "@/lib/scenario-runs/status";

export const prerender = false;

const PRIVATE_STATUS_HEADERS = {
  "cache-control": "private, no-store",
};

/**
 * A short-lived, same-origin invalidation stream. The ordinary status route
 * remains the source of state and applies authorization to every fetch.
 */
export const GET: APIRoute = async ({ request, params }) => {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return jsonResponse(
      { error: "expected websocket upgrade" },
      { status: 426, headers: PRIVATE_STATUS_HEADERS },
    );
  }

  let expectedOrigin: string;
  try {
    expectedOrigin = canonicalApplicationOrigin();
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "application origin is unavailable",
    );
    return jsonResponse(body, { status, headers: PRIVATE_STATUS_HEADERS });
  }
  if (request.headers.get("origin")?.trim() !== expectedOrigin) {
    return jsonResponse(
      { error: "request origin is not allowed" },
      { status: 403, headers: PRIVATE_STATUS_HEADERS },
    );
  }
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (fetchSite && fetchSite !== "same-origin") {
    return jsonResponse(
      { error: "cross-site requests are not allowed" },
      { status: 403, headers: PRIVATE_STATUS_HEADERS },
    );
  }

  const authz = await requireUserContext(request);
  if (!authz.ok) return privateStatusResponse(authz.response);

  const runId = params.runId?.trim() ?? "";
  if (!runId) {
    return jsonResponse(
      { error: "runId is required" },
      { status: 400, headers: PRIVATE_STATUS_HEADERS },
    );
  }

  try {
    const target = await getScenarioRunStatusStreamTargetForUser({
      runId,
      userId: authz.context.userId,
    });
    const headers = new Headers({ upgrade: "websocket" });
    headers.set("x-run-status-run-id", runId);
    headers.set("x-run-status-user-id", authz.context.userId);
    headers.set("x-run-status-host-id", target.hostId);
    headers.set("x-run-status-session-id", authz.context.sessionId);
    headers.set(
      "x-run-status-beta-source-invite-id",
      authz.context.betaAdmission.sourceInviteId,
    );
    headers.set(
      "x-run-status-beta-source-lease-id",
      authz.context.betaAdmission.sourceLeaseId,
    );
    headers.set(
      "x-run-status-beta-admission-granted-at",
      String(authz.context.betaAdmission.grantedAt),
    );

    const stub = env.HOST_RUNTIME.get(
      env.HOST_RUNTIME.idFromName(target.hostId),
    );
    const response = await stub.fetch(
      new Request("https://host-runtime.internal/_internal/run-status", {
        method: "GET",
        headers,
      }),
    );
    return response.status === 101 ? response : privateStatusResponse(response);
  } catch (error) {
    const { status, body } = toErrorResponse(
      error,
      "failed to open scenario status stream",
    );
    return jsonResponse(body, { status, headers: PRIVATE_STATUS_HEADERS });
  }
};

function privateStatusResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "private, no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
