import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { imageBuilds } from "@/db/schema";
import { jsonResponse, requireUserContext } from "@/lib/agent-bridge";
import { isSafeAdminBuildId } from "@/lib/admin-build-response";
import { readAdministeredBuildLog } from "@/lib/organization-builds";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireUserContext(request);
  if (!authz.ok) {
    return authz.response;
  }

  const buildId = params.buildId?.trim() ?? "";
  if (!buildId) {
    return jsonResponse({ error: "buildId is required" }, { status: 400 });
  }
  if (!isSafeAdminBuildId(buildId)) {
    return jsonResponse({ error: "invalid build id" }, { status: 400 });
  }
  if (!authz.context.isAdmin) {
    // Only a build of an organization the caller owns or administers.
    const log = await readAdministeredBuildLog(authz.context.userId, buildId);
    return log === null
      ? jsonResponse({ error: "build log not found" }, { status: 404 })
      : new Response(log, {
          headers: {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "private, no-store",
          },
        });
  }

  const rows = await drizzle(env.DB)
    .select({ logR2Key: imageBuilds.logR2Key })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  const logR2Key = rows[0]?.logR2Key;
  if (!logR2Key) {
    return jsonResponse({ error: "build log not found" }, { status: 404 });
  }

  const object = await env.VM_IMAGE_REGISTRY_BUCKET.get(logR2Key);
  if (!object) {
    return jsonResponse({ error: "build log object not found" }, { status: 404 });
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(object.size),
      "cache-control": "private, no-store",
    },
  });
};
