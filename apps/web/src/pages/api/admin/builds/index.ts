import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuildBundles,
  imageBuilds,
} from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { serializeAdminBuildSummary } from "@/lib/admin-build-response";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const authz = await requireAdminUserContext(request);
  if (!authz.ok) {
    return authz.response;
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
      status: imageBuilds.status,
      phase: imageBuilds.phase,
      attempt: imageBuilds.attempt,
      error: imageBuilds.error,
      logR2Key: imageBuilds.logR2Key,
      timings: imageBuilds.timingsJson,
      bundleR2Key: imageBuildBundles.r2Key,
      createdAt: imageBuilds.createdAt,
      updatedAt: imageBuilds.updatedAt,
    })
    .from(imageBuilds)
    .leftJoin(agentHosts, eq(agentHosts.id, imageBuilds.hostId))
    .leftJoin(imageBuildBundles, eq(imageBuildBundles.rev, imageBuilds.rev))
    .orderBy(desc(imageBuilds.updatedAt))
    .limit(200);

  return jsonResponse({
    builds: rows.map((row) => serializeAdminBuildSummary(row)),
  });
};
