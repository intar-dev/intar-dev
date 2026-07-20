import type { APIRoute } from "astro";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { toErrorResponse } from "@/lib/app-error";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import {
  issueWorkshopBrowserTerminalSession,
  issueWorkshopNativeSshSession,
} from "@/lib/workshops/terminal";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  const workspaceId =
    typeof body?.workspaceId === "string" ? body.workspaceId.trim() : "";
  const vmId = typeof body?.vmId === "string" ? body.vmId.trim() : "";
  const mode = body?.mode === "native" ? "native" : "browser";
  if (!sessionId || !workspaceId) {
    return jsonResponse(
      { error: "sessionId and workspaceId are required" },
      { status: 400 },
    );
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    const input = {
      sessionId,
      workspaceId,
      actorUserId: authz.context.userId,
      ...(vmId ? { vmId } : {}),
    };
    return jsonResponse(
      mode === "native"
        ? await issueWorkshopNativeSshSession(input)
        : await issueWorkshopBrowserTerminalSession(input),
    );
  } catch (error) {
    const response = toErrorResponse(
      error,
      "failed to open workshop terminal",
    );
    return jsonResponse(response.body, { status: response.status });
  }
};
