import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { applyArtifactDeliveryHeaders } from "@/lib/artifact-delivery";
import { loadWorkshopArtifactForOwner } from "@/lib/workshops/artifacts";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = decodeParameter(params.sessionId);
  const artifactId = decodeParameter(params.artifactId);
  if (!sessionId || !artifactId) {
    return notFound();
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    const artifact = await loadWorkshopArtifactForOwner({
      sessionId,
      userId: authz.context.userId,
      artifactId,
    });
    const object = await env.VM_RUN_ARTIFACTS_BUCKET.get(
      artifact.r2Key,
      request.headers.get("range") ? { range: request.headers } : undefined,
    );
    if (!object) return notFound();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("accept-ranges", "bytes");
    applyArtifactDeliveryHeaders(headers, {
      contentType: artifact.contentType,
      filename: artifact.filename,
      forceDownload: new URL(request.url).searchParams.get("download") === "1",
    });
    let status = 200;
    if (object.range && "offset" in object.range) {
      const start = object.range.offset;
      const length = object.range.length ?? Math.max(0, object.size - start);
      headers.set(
        "content-range",
        `bytes ${start}-${start + Math.max(0, length - 1)}/${artifact.sizeBytes}`,
      );
      headers.set("content-length", `${length}`);
      status = 206;
    } else {
      headers.set("content-length", `${artifact.sizeBytes}`);
    }
    return new Response(object.body, { status, headers });
  } catch {
    // Do not reveal another learner's artifact identifiers.
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
  return jsonResponse({ error: "artifact not found" }, { status: 404 });
}
