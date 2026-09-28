import { env } from "cloudflare:workers";
import { and, eq, inArray, like, notExists, notLike } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  imageBuildBundles,
  imageBuilds,
  scenarioAssignments,
  scenarioRuns,
  vmScenarios,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { requireOrganizationRole } from "@/lib/organizations";

export async function deleteOrganizationScenario(params: {
  organizationId: string;
  actorUserId: string;
  scenarioId: string;
}): Promise<void> {
  await requireOrganizationRole({
    organizationId: params.organizationId,
    userId: params.actorUserId,
    admin: true,
  });
  const db = drizzle(env.DB);
  const scenarios = await db
    .select({ scenarioId: vmScenarios.scenarioId })
    .from(vmScenarios)
    .where(
      and(
        eq(vmScenarios.scenarioId, params.scenarioId),
        eq(vmScenarios.organizationId, params.organizationId),
      ),
    )
    .limit(1);
  if (!scenarios.length) {
    throw appError(
      404,
      "scenario_not_found",
      "organization scenario not found",
    );
  }
  // Once a git source has ingested into the org, its scope changes only
  // through commits.
  const gitBundles = () =>
    db
      .select({ rev: imageBuildBundles.rev })
      .from(imageBuildBundles)
      .where(
        and(
          eq(imageBuildBundles.organizationId, params.organizationId),
          like(imageBuildBundles.rev, "git-%"),
        ),
      );
  const gitManaged = () =>
    appError(
      409,
      "scenario_managed_by_git_source",
      "organization scenarios are managed by a git source and change only through commits",
    );
  const [runs, activeBuilds, gitRevs] = await Promise.all([
    db
      .select({ id: scenarioRuns.runId })
      .from(scenarioRuns)
      .where(
        and(
          eq(scenarioRuns.organizationId, params.organizationId),
          eq(scenarioRuns.scenarioId, params.scenarioId),
        ),
      )
      .limit(1),
    db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(
        and(
          eq(imageBuilds.organizationId, params.organizationId),
          eq(imageBuilds.scenarioId, params.scenarioId),
          inArray(imageBuilds.status, ["queued", "assigned", "building"]),
        ),
      )
      .limit(1),
    gitBundles().limit(1),
  ]);
  if (gitRevs.length) throw gitManaged();
  if (runs.length) {
    throw appError(
      409,
      "scenario_has_run_history",
      "scenario has organization run history and cannot be deleted",
    );
  }
  if (activeBuilds.length) {
    throw appError(
      409,
      "scenario_has_active_builds",
      "scenario has active image builds and must be drained first",
    );
  }

  // Every statement repeats the guard, so a git ingest that lands after the
  // read above makes the whole batch delete nothing.
  const [, , deleted] = await db.batch([
    db
      .delete(scenarioAssignments)
      .where(
        and(
          eq(scenarioAssignments.organizationId, params.organizationId),
          eq(scenarioAssignments.scenarioId, params.scenarioId),
          notExists(gitBundles()),
        ),
      ),
    db
      .delete(imageBuilds)
      .where(
        and(
          eq(imageBuilds.organizationId, params.organizationId),
          eq(imageBuilds.scenarioId, params.scenarioId),
          notExists(gitBundles()),
        ),
      ),
    db
      .delete(vmScenarios)
      .where(
        and(
          eq(vmScenarios.organizationId, params.organizationId),
          eq(vmScenarios.scenarioId, params.scenarioId),
          notExists(gitBundles()),
        ),
      )
      .returning({ scenarioId: vmScenarios.scenarioId }),
  ]);
  // An empty delete is either the guard or a concurrent DELETE that already
  // removed the scenario; only the guard is a refusal.
  if (!deleted.length && (await gitBundles().limit(1)).length) {
    throw gitManaged();
  }

  const orphanedBundles = await db
    .delete(imageBuildBundles)
    .where(
      and(
        eq(imageBuildBundles.organizationId, params.organizationId),
        // A git bundle whose builds all deduped onto existing builds has no
        // build reference, but it is still the scope's source.
        notLike(imageBuildBundles.rev, "git-%"),
        notExists(
          db
            .select({ id: imageBuilds.id })
            .from(imageBuilds)
            .where(eq(imageBuilds.rev, imageBuildBundles.rev)),
        ),
      ),
    )
    .returning({ r2Key: imageBuildBundles.r2Key });
  if (orphanedBundles.length) {
    await env.VM_IMAGE_REGISTRY_BUCKET.delete(
      orphanedBundles.map((bundle) => bundle.r2Key),
    );
  }
}
