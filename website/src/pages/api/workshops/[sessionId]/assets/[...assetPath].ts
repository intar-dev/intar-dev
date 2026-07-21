import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { workshopPublications, workshopSessions } from "@/db/schema";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { requireWorkshopsEnabledForSession } from "@/lib/workshops/feature-flag";
import { workshopProjectionReferencesAsset } from "@/lib/workshops/asset-access";
import { getWorkshopSessionProjection } from "@/lib/workshops/projection";
import { requireWorkshopSessionMember } from "@/lib/workshops/shared";
import {
  isSafeWorkshopAssetPath,
  workshopAssetObjectKey,
} from "@/control-plane/workshop-registry/assets";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) return authz.response;
  const sessionId = params.sessionId?.trim() ?? "";
  const assetPath = params.assetPath?.trim() ?? "";
  if (!sessionId || !isSafeWorkshopAssetPath(assetPath)) {
    return jsonResponse({ error: "asset not found" }, { status: 404 });
  }
  try {
    await requireWorkshopsEnabledForSession(sessionId);
    const access = await requireWorkshopSessionMember({
      sessionId,
      userId: authz.context.userId,
    });
    const projection = await getWorkshopSessionProjection({
      sessionId,
      userId: authz.context.userId,
    });
    if (
      !workshopProjectionReferencesAsset(projection, {
        sessionId,
        assetPath,
      })
    ) {
      return jsonResponse({ error: "asset not found" }, { status: 404 });
    }
    const rows = await drizzle(env.DB)
      .select({ contentHash: workshopPublications.contentHash })
      .from(workshopSessions)
      .innerJoin(
        workshopPublications,
        and(
          eq(
            workshopPublications.publishedRevisionId,
            workshopSessions.templateRevisionId,
          ),
          eq(
            workshopPublications.organizationId,
            workshopSessions.organizationId,
          ),
          eq(workshopPublications.status, "published"),
        ),
      )
      .where(eq(workshopSessions.id, sessionId))
      .limit(1);
    const publication = rows[0];
    if (!publication) {
      return jsonResponse({ error: "asset not found" }, { status: 404 });
    }
    const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(
      workshopAssetObjectKey({
        organizationId: access.organizationId,
        contentHash: publication.contentHash,
        assetPath,
      }),
    );
    if (!object) {
      return jsonResponse({ error: "asset not found" }, { status: 404 });
    }
    if (request.headers.get("if-none-match") === object.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: { etag: object.httpEtag },
      });
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=3600");
    headers.set("x-content-type-options", "nosniff");
    if (headers.get("content-type") === "image/svg+xml") {
      headers.set(
        "content-security-policy",
        "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      );
    }
    return new Response(object.body, { headers });
  } catch {
    // Asset authorization is deliberately non-enumerable.
    return jsonResponse({ error: "asset not found" }, { status: 404 });
  }
};
