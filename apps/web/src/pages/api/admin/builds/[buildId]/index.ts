import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  imageBuildBundles,
  imageBuilds,
  scenarioCatalogCandidates,
} from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import {
  isSafeAdminBuildId,
  selectAdminCandidateProof,
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
      organizationId: imageBuilds.organizationId,
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
      bundleOrganizationId: imageBuildBundles.organizationId,
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

  const candidates = await drizzle(env.DB)
    .select({
      revision: scenarioCatalogCandidates.revision,
      buildId: scenarioCatalogCandidates.buildId,
      organizationId: scenarioCatalogCandidates.organizationId,
      bundleOrganizationId: imageBuildBundles.organizationId,
      bundleMeta: imageBuildBundles.metaJson,
      updatedAt: scenarioCatalogCandidates.updatedAt,
    })
    .from(scenarioCatalogCandidates)
    .innerJoin(
      imageBuildBundles,
      eq(imageBuildBundles.rev, scenarioCatalogCandidates.revision),
    )
    .where(
      and(
        eq(scenarioCatalogCandidates.buildId, build.id),
        eq(scenarioCatalogCandidates.scenarioId, build.scenarioId),
        build.organizationId
          ? eq(scenarioCatalogCandidates.organizationId, build.organizationId)
          : isNull(scenarioCatalogCandidates.organizationId),
        build.organizationId
          ? eq(imageBuildBundles.organizationId, build.organizationId)
          : isNull(imageBuildBundles.organizationId),
      ),
    );

  return jsonResponse({
    build: serializeAdminBuildDetail({
      ...build,
      candidateProof: selectAdminCandidateProof({ build, candidates }),
    }),
  });
};
