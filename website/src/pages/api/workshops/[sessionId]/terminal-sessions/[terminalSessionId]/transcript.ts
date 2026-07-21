import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { applyArtifactDeliveryHeaders } from "@/lib/artifact-delivery";
import { loadWorkshopTerminalTranscriptForOwner } from "@/lib/workshops/artifacts";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = decodeParameter(params.sessionId);
  const terminalSessionId = decodeParameter(params.terminalSessionId);
  if (!sessionId || !terminalSessionId) return notFound();
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    const transcript = await loadWorkshopTerminalTranscriptForOwner({
      sessionId,
      userId: authz.context.userId,
      terminalSessionId,
    });
    const object = await env.VM_RUN_ARTIFACTS_BUCKET.get(transcript.r2Key);
    if (!object) return notFound();
    const headers = new Headers({ etag: object.httpEtag });
    applyArtifactDeliveryHeaders(headers, {
      contentType: "text/plain",
      filename: `terminal-session-${terminalSessionId}.txt`,
      forceDownload: false,
    });
    return new Response(object.body, { headers });
  } catch {
    return notFound();
  }
};

function decodeParameter(raw: string | undefined): string | null {
  try {
    const value = raw ? decodeURIComponent(raw).trim() : "";
    return value || null;
  } catch {
    return null;
  }
}

function notFound(): Response {
  return jsonResponse(
    { error: "terminal transcript not found" },
    { status: 404 },
  );
}
