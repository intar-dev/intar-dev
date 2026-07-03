import { and, eq, inArray, isNull } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  imageBuildBundles,
  imageBuilds,
  type ImageBuildBundleMeta,
  type ImageBuildTimings,
} from "@/db/schema";
import type { BuildReportV1 } from "@/generated/bridge";
import {
  buildStatusFromPhase,
  chooseLeastLoadedBuilder,
  desiredBuildFromSource,
  isDisconnectedPastDeadline,
  isSilentBuildingBuild,
  isTerminalBuildPhase,
  shouldAcceptBuildReport,
  shouldSkipExistingBuildForBundle,
  type BuilderCandidate,
} from "@/lib/build-scheduler-core";
import { removeDesiredBuild, upsertDesiredBuild } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { createAppId } from "@/lib/id";

export async function queueImageBuildsFromBundle(
  db: DrizzleD1Database,
  input: {
    rev: string;
    r2Key: string;
    kinoVersion: string;
    meta: ImageBuildBundleMeta;
    nowUnixMs: number;
  },
): Promise<{ queued: number }> {
  await db
    .insert(imageBuildBundles)
    .values({
      rev: input.rev,
      r2Key: input.r2Key,
      kinoVersion: input.kinoVersion,
      metaJson: input.meta,
      createdAt: input.nowUnixMs,
      updatedAt: input.nowUnixMs,
    })
    .onConflictDoUpdate({
      target: imageBuildBundles.rev,
      set: {
        r2Key: input.r2Key,
        kinoVersion: input.kinoVersion,
        metaJson: input.meta,
        updatedAt: input.nowUnixMs,
      },
    });

  let queued = 0;
  for (const scenario of input.meta.scenarios) {
    const timings: ImageBuildTimings = {
      queuedAt: input.nowUnixMs,
      startedAt: null,
      finishedAt: null,
      lastReportAt: null,
    };
    const existingRows = await db
      .select({
        id: imageBuilds.id,
        hostId: imageBuilds.hostId,
        status: imageBuilds.status,
      })
      .from(imageBuilds)
      .where(
        and(
          eq(imageBuilds.scenarioId, scenario.scenarioId),
          eq(imageBuilds.arch, scenario.arch),
          eq(imageBuilds.contentHash, scenario.contentHash),
        ),
      )
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (shouldSkipExistingBuildForBundle(existing.status)) {
        continue;
      }
      await db
        .update(imageBuilds)
        .set({
          rev: input.rev,
          kinoVersion: input.kinoVersion,
          hostId: null,
          status: "queued",
          phase: "queued",
          attempt: 0,
          error: null,
          logR2Key: null,
          timingsJson: timings,
          updatedAt: input.nowUnixMs,
        })
        .where(eq(imageBuilds.id, existing.id));
      if (existing.hostId) {
        await removeDesiredBuildsFromHost(
          db,
          existing.hostId,
          [existing.id],
          input.nowUnixMs,
        );
      }
      queued += 1;
      continue;
    }

    const inserted = await db
      .insert(imageBuilds)
      .values({
        id: createAppId(),
        scenarioId: scenario.scenarioId,
        arch: scenario.arch,
        rev: input.rev,
        contentHash: scenario.contentHash,
        kinoVersion: input.kinoVersion,
        hostId: null,
        status: "queued",
        phase: "queued",
        attempt: 0,
        error: null,
        logR2Key: null,
        timingsJson: timings,
        createdAt: input.nowUnixMs,
        updatedAt: input.nowUnixMs,
      })
      .onConflictDoNothing({
        target: [
          imageBuilds.scenarioId,
          imageBuilds.arch,
          imageBuilds.contentHash,
        ],
      })
      .returning({ id: imageBuilds.id });
    queued += inserted.length;
  }

  return { queued };
}

export async function assignQueuedImageBuilds(
  db: DrizzleD1Database,
  nowUnixMs: number,
): Promise<Array<{ buildId: string; hostId: string }>> {
  const [queuedBuilds, builders] = await Promise.all([
    loadQueuedBuildRows(db),
    loadBuilderCandidates(db),
  ]);
  const assigned: Array<{ buildId: string; hostId: string }> = [];
  const activeCounts = new Map(
    builders.map((builder) => [builder.hostId, builder.activeBuildCount]),
  );

  for (const build of queuedBuilds) {
    const builder = chooseLeastLoadedBuilder(
      builders.map((candidate) => ({
        ...candidate,
        activeBuildCount:
          activeCounts.get(candidate.hostId) ?? candidate.activeBuildCount,
      })),
      build.arch,
    );
    if (!builder) {
      continue;
    }

    const claimed = await db
      .update(imageBuilds)
      .set({
        hostId: builder.hostId,
        status: "assigned",
        phase: "queued",
        updatedAt: nowUnixMs,
      })
      .where(
        and(
          eq(imageBuilds.id, build.id),
          eq(imageBuilds.status, "queued"),
          isNull(imageBuilds.hostId),
        ),
      )
      .returning({ id: imageBuilds.id });
    if (!claimed.length) {
      continue;
    }

    await mutateStoredHostDesiredState(
      db,
      builder.hostId,
      nowUnixMs,
      (draft) => {
        upsertDesiredBuild(
          draft,
          desiredBuildFromSource({
            buildId: build.id,
            scenarioId: build.scenarioId,
            arch: build.arch,
            rev: build.rev,
            contentHash: build.contentHash,
            bundleRef: build.bundleRef,
            kinoVersion: build.kinoVersion,
          }),
        );
      },
    );
    await tryWakeHostRuntime(builder.hostId);

    activeCounts.set(
      builder.hostId,
      (activeCounts.get(builder.hostId) ?? 0) + 1,
    );
    assigned.push({ buildId: build.id, hostId: builder.hostId });
  }

  return assigned;
}

export async function maintainHostBuildAssignments(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<{
  requeuedAssignedBuildIds: string[];
  staleBuildIds: string[];
  reassigned: Array<{ buildId: string; hostId: string }>;
}> {
  const [requeuedAssignedBuildIds, staleBuildIds] = await Promise.all([
    requeueAssignedBuildsForDisconnectedHost(db, hostId, nowUnixMs),
    markSilentBuildingBuildsStale(db, hostId, nowUnixMs),
  ]);
  const reassigned = await assignQueuedImageBuilds(db, nowUnixMs);
  return {
    requeuedAssignedBuildIds,
    staleBuildIds,
    reassigned,
  };
}

export async function releaseBuildAssignmentsForHostRoleChange(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<{
  requeuedAssignedBuildIds: string[];
  staleBuildingBuildIds: string[];
  reassigned: Array<{ buildId: string; hostId: string }>;
}> {
  return releaseBuildAssignmentsForUnavailableBuilderHost(
    db,
    hostId,
    nowUnixMs,
    {
      assigned: "builder host role changed before starting build",
      building: "builder host role changed while build was running",
    },
    { reassign: true },
  );
}

export async function releaseBuildAssignmentsForHostRemoval(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<{
  requeuedAssignedBuildIds: string[];
  staleBuildingBuildIds: string[];
  reassigned: Array<{ buildId: string; hostId: string }>;
}> {
  return releaseBuildAssignmentsForUnavailableBuilderHost(
    db,
    hostId,
    nowUnixMs,
    {
      assigned: "builder host was deleted before starting build",
      building: "builder host was deleted while build was running",
    },
    { reassign: false },
  );
}

async function releaseBuildAssignmentsForUnavailableBuilderHost(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
  errors: {
    assigned: string;
    building: string;
  },
  options: {
    reassign: boolean;
  },
): Promise<{
  requeuedAssignedBuildIds: string[];
  staleBuildingBuildIds: string[];
  reassigned: Array<{ buildId: string; hostId: string }>;
}> {
  const [assignedRows, buildingRows] = await Promise.all([
    db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(
        and(eq(imageBuilds.hostId, hostId), eq(imageBuilds.status, "assigned")),
      ),
    db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(
        and(eq(imageBuilds.hostId, hostId), eq(imageBuilds.status, "building")),
      ),
  ]);
  const requeuedAssignedBuildIds = assignedRows.map((row) => row.id);
  const staleBuildingBuildIds = buildingRows.map((row) => row.id);

  if (requeuedAssignedBuildIds.length > 0) {
    await db
      .update(imageBuilds)
      .set({
        hostId: null,
        status: "queued",
        phase: "queued",
        error: errors.assigned,
        updatedAt: nowUnixMs,
      })
      .where(inArray(imageBuilds.id, requeuedAssignedBuildIds));
  }

  if (staleBuildingBuildIds.length > 0) {
    await db
      .update(imageBuilds)
      .set({
        status: "stale",
        error: errors.building,
        updatedAt: nowUnixMs,
      })
      .where(inArray(imageBuilds.id, staleBuildingBuildIds));
  }

  await removeDesiredBuildsFromHost(
    db,
    hostId,
    [...requeuedAssignedBuildIds, ...staleBuildingBuildIds],
    nowUnixMs,
  );
  const reassigned = options.reassign
    ? await assignQueuedImageBuilds(db, nowUnixMs)
    : [];

  return {
    requeuedAssignedBuildIds,
    staleBuildingBuildIds,
    reassigned,
  };
}

export async function recordImageBuildReport(
  db: DrizzleD1Database,
  hostId: string,
  report: BuildReportV1,
  nowUnixMs: number,
): Promise<{ updated: boolean; terminal: boolean }> {
  const rows = await db
    .select({
      hostId: imageBuilds.hostId,
      status: imageBuilds.status,
      scenarioId: imageBuilds.scenarioId,
      contentHash: imageBuilds.contentHash,
      timingsJson: imageBuilds.timingsJson,
    })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, report.build_id))
    .limit(1);
  const existing = rows[0];
  if (
    !existing ||
    !shouldAcceptBuildReport({
      assignedHostId: existing.hostId,
      assignedStatus: existing.status,
      reportingHostId: hostId,
      reportHostId: report.host_id,
      assignedScenarioId: existing.scenarioId,
      reportScenarioId: report.scenario_id,
      assignedContentHash: existing.contentHash,
      reportContentHash: report.content_hash,
    })
  ) {
    return { updated: false, terminal: false };
  }

  const timings = mergeBuildTimings(existing.timingsJson, report);
  const updated = await db
    .update(imageBuilds)
    .set({
      hostId,
      phase: report.phase,
      status: buildStatusFromPhase(report.phase),
      attempt: report.attempt,
      error: report.error ?? null,
      timingsJson: timings,
      updatedAt: nowUnixMs,
    })
    .where(
      and(eq(imageBuilds.id, report.build_id), eq(imageBuilds.hostId, hostId)),
    )
    .returning({ id: imageBuilds.id });

  return {
    updated: updated.length > 0,
    terminal: updated.length > 0 && isTerminalBuildPhase(report.phase),
  };
}

export async function recordHostBuildReports(
  db: DrizzleD1Database,
  hostId: string,
  reports: BuildReportV1[],
  nowUnixMs: number,
): Promise<{ terminalBuildIds: string[] }> {
  const terminalBuildIds: string[] = [];
  for (const report of reports) {
    const result = await recordImageBuildReport(db, hostId, report, nowUnixMs);
    if (result.terminal) {
      terminalBuildIds.push(report.build_id);
    }
  }
  return { terminalBuildIds };
}

async function loadQueuedBuildRows(db: DrizzleD1Database) {
  return db
    .select({
      id: imageBuilds.id,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      rev: imageBuilds.rev,
      contentHash: imageBuilds.contentHash,
      kinoVersion: imageBuilds.kinoVersion,
      bundleRef: imageBuildBundles.r2Key,
    })
    .from(imageBuilds)
    .innerJoin(imageBuildBundles, eq(imageBuildBundles.rev, imageBuilds.rev))
    .where(and(eq(imageBuilds.status, "queued"), isNull(imageBuilds.hostId)));
}

async function requeueAssignedBuildsForDisconnectedHost(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<string[]> {
  const hosts = await db
    .select({
      connected: agentHosts.connected,
      disconnectedAt: agentHosts.disconnectedAt,
    })
    .from(agentHosts)
    .where(eq(agentHosts.id, hostId))
    .limit(1);
  const host = hosts[0];
  if (!host || !isDisconnectedPastDeadline(host, nowUnixMs)) {
    return [];
  }

  const rows = await db
    .select({ id: imageBuilds.id })
    .from(imageBuilds)
    .where(
      and(eq(imageBuilds.hostId, hostId), eq(imageBuilds.status, "assigned")),
    );
  const buildIds = rows.map((row) => row.id);
  if (!buildIds.length) {
    return [];
  }

  await db
    .update(imageBuilds)
    .set({
      hostId: null,
      status: "queued",
      phase: "queued",
      error: "builder disconnected before starting build",
      updatedAt: nowUnixMs,
    })
    .where(inArray(imageBuilds.id, buildIds));
  await removeDesiredBuildsFromHost(db, hostId, buildIds, nowUnixMs);
  return buildIds;
}

async function markSilentBuildingBuildsStale(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<string[]> {
  const rows = await db
    .select({
      id: imageBuilds.id,
      status: imageBuilds.status,
      updatedAt: imageBuilds.updatedAt,
      timingsJson: imageBuilds.timingsJson,
    })
    .from(imageBuilds)
    .where(
      and(eq(imageBuilds.hostId, hostId), eq(imageBuilds.status, "building")),
    );
  const staleIds = rows
    .filter((row) => isSilentBuildingBuild(row, nowUnixMs))
    .map((row) => row.id);
  if (!staleIds.length) {
    return [];
  }

  await db
    .update(imageBuilds)
    .set({
      status: "stale",
      error: "builder stopped reporting build progress",
      updatedAt: nowUnixMs,
    })
    .where(inArray(imageBuilds.id, staleIds));
  await removeDesiredBuildsFromHost(db, hostId, staleIds, nowUnixMs);
  return staleIds;
}

async function removeDesiredBuildsFromHost(
  db: DrizzleD1Database,
  hostId: string,
  buildIds: string[],
  nowUnixMs: number,
): Promise<void> {
  if (!buildIds.length) {
    return;
  }
  await mutateStoredHostDesiredState(db, hostId, nowUnixMs, (draft) => {
    for (const buildId of buildIds) {
      removeDesiredBuild(draft, { buildId });
    }
  });
  await tryWakeHostRuntime(hostId);
}

async function loadBuilderCandidates(
  db: DrizzleD1Database,
): Promise<BuilderCandidate[]> {
  const [hosts, activeBuilds] = await Promise.all([
    db
      .select({
        hostId: agentHosts.id,
        role: agentHosts.role,
        connected: agentHosts.connected,
        activeSessionId: agentHosts.activeSessionId,
        lastClientHelloAt: agentHosts.lastClientHelloAt,
        disabled: agentHosts.disabled,
        stateUpdatedAt: hostActualState.updatedAt,
        reportJson: hostActualState.reportJson,
      })
      .from(agentHosts)
      .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(eq(agentHosts.role, "builder")),
    db
      .select({
        hostId: imageBuilds.hostId,
      })
      .from(imageBuilds)
      .where(inArray(imageBuilds.status, ["assigned", "building"])),
  ]);

  const activeBuildCount = new Map<string, number>();
  for (const build of activeBuilds) {
    if (!build.hostId) continue;
    activeBuildCount.set(
      build.hostId,
      (activeBuildCount.get(build.hostId) ?? 0) + 1,
    );
  }

  return hosts.map((host) => ({
    hostId: host.hostId,
    role: host.role,
    arch: host.reportJson?.capabilities.arch ?? null,
    connected: Boolean(
        host.connected &&
        host.activeSessionId &&
        host.reportJson &&
        typeof host.stateUpdatedAt === "number" &&
        typeof host.lastClientHelloAt === "number" &&
        host.stateUpdatedAt >= host.lastClientHelloAt,
    ),
    disabled: Boolean(host.disabled),
    activeBuildCount: activeBuildCount.get(host.hostId) ?? 0,
    capacity: host.reportJson?.capacity ?? null,
  }));
}

function mergeBuildTimings(
  current: ImageBuildTimings,
  report: BuildReportV1,
): ImageBuildTimings {
  return {
    ...current,
    startedAt: report.started_at_unix_ms ?? current.startedAt ?? null,
    finishedAt: report.finished_at_unix_ms ?? current.finishedAt ?? null,
    lastReportAt: report.observed_at_unix_ms,
  };
}
