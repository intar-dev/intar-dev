import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { imageBuilds } from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { isSafeAdminBuildId } from "@/lib/admin-build-response";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) => {
  const authz = await requireAdminUserContext(request);
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
