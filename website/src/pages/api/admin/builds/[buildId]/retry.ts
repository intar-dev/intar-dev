import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { imageBuilds } from "@/db/schema";
import { jsonResponse, requireAdminUserContext } from "@/lib/agent-bridge";
import { isSafeAdminBuildId } from "@/lib/admin-build-response";
import { assignQueuedImageBuilds } from "@/lib/build-scheduler";
import { canRetryImageBuild } from "@/lib/build-scheduler-core";
import { removeDesiredBuild } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";

export const prerender = false;

export const POST: APIRoute = async ({ request, params }) => {
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

  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: imageBuilds.id,
      hostId: imageBuilds.hostId,
      status: imageBuilds.status,
      timings: imageBuilds.timingsJson,
    })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, buildId))
    .limit(1);
  const build = rows[0];
  if (!build) {
    return jsonResponse({ error: "build not found" }, { status: 404 });
  }
  if (!canRetryImageBuild(build.status)) {
    return jsonResponse(
      { error: `build status ${build.status} cannot be retried` },
      { status: 409 },
    );
  }

  const now = Date.now();
  if (build.hostId) {
    await mutateStoredHostDesiredState(db, build.hostId, now, (draft) => {
      removeDesiredBuild(draft, { buildId });
    });
    await tryWakeHostRuntime(build.hostId);
  }

  await db
    .update(imageBuilds)
    .set({
      hostId: null,
      status: "queued",
      phase: "queued",
      attempt: 0,
      error: null,
      logR2Key: null,
      timingsJson: {
        ...build.timings,
        queuedAt: now,
        startedAt: null,
        finishedAt: null,
        lastReportAt: null,
      },
      updatedAt: now,
    })
    .where(eq(imageBuilds.id, buildId));

  const assigned = await assignQueuedImageBuilds(db, now);
  return jsonResponse({ ok: true, buildId, assigned });
};
