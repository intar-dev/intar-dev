import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuildBundles,
  imageBuilds,
} from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import {
  isSafeAdminBuildId,
  serializeAdminBuildDetail,
} from "@/lib/admin-build-response";

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
    .select({
      id: imageBuilds.id,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      rev: imageBuilds.rev,
      contentHash: imageBuilds.contentHash,
      hostId: imageBuilds.hostId,
      hostName: agentHosts.name,
      hostRole: agentHosts.role,
      hostConnected: agentHosts.connected,
      hostLastHeartbeatAt: agentHosts.lastHeartbeatAt,
      status: imageBuilds.status,
      phase: imageBuilds.phase,
      attempt: imageBuilds.attempt,
      error: imageBuilds.error,
      logR2Key: imageBuilds.logR2Key,
      timings: imageBuilds.timingsJson,
      bundleR2Key: imageBuildBundles.r2Key,
      bundleMeta: imageBuildBundles.metaJson,
      createdAt: imageBuilds.createdAt,
      updatedAt: imageBuilds.updatedAt,
    })
    .from(imageBuilds)
    .leftJoin(agentHosts, eq(agentHosts.id, imageBuilds.hostId))
    .leftJoin(imageBuildBundles, eq(imageBuildBundles.rev, imageBuilds.rev))
    .where(eq(imageBuilds.id, buildId))
    .limit(1);

  const build = rows[0];
  if (!build) {
    return jsonResponse({ error: "build not found" }, { status: 404 });
  }

  return jsonResponse({ build: serializeAdminBuildDetail(build) });
};
