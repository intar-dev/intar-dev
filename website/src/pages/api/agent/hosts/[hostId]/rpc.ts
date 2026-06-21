import type { APIRoute } from "astro";
import {
  jsonResponse,
  loadHostForUser,
  requireAdminUserContext,
} from "@/lib/agent-bridge";
import {
  createHostRpcCall,
  isHostRpcMethod,
  listHostRpcCallsForHostUser,
} from "@/lib/host-rpc";
import { toErrorResponse } from "@/lib/app-error";

interface CreateRpcBody {
  method?: unknown;
  request?: unknown;
  idempotencyKey?: unknown;
  runId?: unknown;
  vmId?: unknown;
}

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const hostId = params.hostId?.trim() ?? "";
  if (!hostId) {
    return jsonResponse({ error: "hostId is required" }, { status: 400 });
  }

  const host = await loadHostForUser(hostId, authz.context.userId);
  if (!host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }

  const calls = await listHostRpcCallsForHostUser({
    hostId,
    userId: authz.context.userId,
    limit: 100,
  });
  return jsonResponse({ calls });
};

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const hostId = params.hostId?.trim() ?? "";
  if (!hostId) {
    return jsonResponse({ error: "hostId is required" }, { status: 400 });
  }

  const host = await loadHostForUser(hostId, authz.context.userId);
  if (!host) {
    return jsonResponse({ error: "host not found" }, { status: 404 });
  }

  let body: CreateRpcBody;
  try {
    body = (await request.json()) as CreateRpcBody;
  } catch {
    return jsonResponse({ error: "invalid json body" }, { status: 400 });
  }

  const method = typeof body.method === "string" ? body.method.trim() : "";
  if (!method || !isHostRpcMethod(method)) {
    return jsonResponse({ error: "invalid host RPC method" }, { status: 400 });
  }

  const payload =
    typeof body.request === "object" &&
    body.request !== null &&
    !Array.isArray(body.request)
      ? (body.request as Record<string, unknown>)
      : {};

  try {
    const call = await createHostRpcCall({
      hostId,
      userId: authz.context.userId,
      runId: typeof body.runId === "string" ? body.runId.trim() || null : null,
      vmId: typeof body.vmId === "string" ? body.vmId.trim() || null : null,
      method,
      request: payload,
      idempotencyKey:
        typeof body.idempotencyKey === "string"
          ? body.idempotencyKey.trim() || null
          : null,
    });
    return jsonResponse({ call }, { status: 202 });
  } catch (error) {
    const { status, body } = toErrorResponse(error, "failed to create host RPC call");
    return jsonResponse(body, { status });
  }
};
