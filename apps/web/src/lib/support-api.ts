import type { APIContext, APIRoute } from "astro";
import {
  jsonResponse,
  requireUserContext,
  type UserContext,
} from "./agent-bridge";
import { appError, toErrorResponse } from "./app-error";

export function supportRoute(
  handler: (route: APIContext, actor: UserContext) => Promise<Response>,
): APIRoute {
  return async (route) => {
    try {
      const authz = await requireUserContext(route.request);
      if (!authz.ok) return authz.response;
      return await handler(route, authz.context);
    } catch (error) {
      const { status, body } = toErrorResponse(
        error,
        "The forum request failed. Try again.",
      );
      return jsonResponse(body, { status });
    }
  };
}

export async function readSupportBody(
  request: Request,
): Promise<Record<string, unknown>> {
  const body: unknown = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw appError(400, "invalid_json", "Send a JSON object");
  }
  return body as Record<string, unknown>;
}
