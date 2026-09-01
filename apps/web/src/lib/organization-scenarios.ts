import { env } from "cloudflare:workers";
import { and, eq, inArray, notExists } from "drizzle-orm";
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
  const [runs, activeBuilds] = await Promise.all([
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
  ]);
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

  await db.batch([
    db
      .delete(scenarioAssignments)
      .where(
        and(
          eq(scenarioAssignments.organizationId, params.organizationId),
          eq(scenarioAssignments.scenarioId, params.scenarioId),
        ),
      ),
    db
      .delete(imageBuilds)
      .where(
        and(
          eq(imageBuilds.organizationId, params.organizationId),
          eq(imageBuilds.scenarioId, params.scenarioId),
        ),
      ),
    db
      .delete(vmScenarios)
      .where(
        and(
          eq(vmScenarios.organizationId, params.organizationId),
          eq(vmScenarios.scenarioId, params.scenarioId),
        ),
      ),
  ]);

  const orphanedBundles = await db
    .delete(imageBuildBundles)
    .where(
      and(
        eq(imageBuildBundles.organizationId, params.organizationId),
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
