import type { APIRoute } from "astro";
import {
  jsonResponse,
  loadHostForUser,
  requireAdminUserContext,
} from "@/lib/agent-bridge";
import { loadHostRpcCallForUser } from "@/lib/host-rpc";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const hostId = params.hostId?.trim() ?? "";
  const callId = params.callId?.trim() ?? "";
  if (!hostId || !callId) {
    return jsonResponse(
      { error: "hostId and callId are required" },
      { status: 400 },
    );
  }

  const host = await loadHostForUser(hostId, authz.context.userId);
  if (!host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }

  const call = await loadHostRpcCallForUser({
    hostId,
    callId,
    userId: authz.context.userId,
  });
  if (!call) {
    return jsonResponse({ error: "host RPC call not found" }, { status: 404 });
  }

  return jsonResponse({ call });
};
