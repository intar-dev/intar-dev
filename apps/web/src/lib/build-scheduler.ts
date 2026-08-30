import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  hostDesiredState,
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
  shouldAcknowledgeTerminalBuildReport,
  shouldAcceptBuildReport,
  type BuilderCandidate,
} from "@/lib/build-scheduler-core";
import { removeDesiredBuild, upsertDesiredBuild } from "@/lib/desired-state";
import {
  loadOrCreateHostDesiredState,
  mutateStoredHostDesiredState,
} from "@/lib/desired-state-store";
import { tryWakeHostRuntime } from "@/lib/host-runtime-wake";
import { hostHealth } from "@/lib/host-health";
import { createAppId } from "@/lib/id";
import {
  withImageBuildCoordinationLock,
  withImageBuildCoordinationLocks,
} from "@/lib/image-build-lock";

export async function queueImageBuildsFromBundle(
  db: DrizzleD1Database,
  input: {
    rev: string;
    r2Key: string;
    meta: ImageBuildBundleMeta;
    organizationId?: string | null;
    nowUnixMs: number;
  },
): Promise<{ queued: number }> {
  const organizationId = input.organizationId ?? null;
  await db
    .insert(imageBuildBundles)
    .values({
      rev: input.rev,
      organizationId,
      r2Key: input.r2Key,
      metaJson: input.meta,
      createdAt: input.nowUnixMs,
      updatedAt: input.nowUnixMs,
    })
    .onConflictDoUpdate({
      target: imageBuildBundles.rev,
      set: {
        r2Key: input.r2Key,
        organizationId,
        metaJson: input.meta,
        updatedAt: input.nowUnixMs,
      },
    });

  let queued = 0;
  for (const scenario of input.meta.scenarios) {
    const result = await withImageBuildCoordinationLock(
      db,
      { scenarioId: scenario.scenarioId, arch: scenario.arch },
      () =>
        queueImageBuildScenario(db, {
          scenarioId: scenario.scenarioId,
          arch: scenario.arch,
          contentHash: scenario.contentHash,
          rev: input.rev,
          organizationId,
          catalogChannel: input.meta.catalogChannel ?? "live",
          nowUnixMs: input.nowUnixMs,
        }),
    );
    queued += result.queued;
    for (const hostId of result.cleanedHostIds) {
      await tryWakeHostRuntime(hostId);
    }
  }

  return { queued };
}

async function queueImageBuildScenario(
  db: DrizzleD1Database,
  input: {
    scenarioId: string;
    arch: ImageBuildBundleMeta["scenarios"][number]["arch"];
    contentHash: string;
    rev: string;
    organizationId: string | null;
    catalogChannel: "candidate" | "live";
    nowUnixMs: number;
  },
): Promise<{ queued: number; cleanedHostIds: string[] }> {
  const timings: ImageBuildTimings = {
    queuedAt: input.nowUnixMs,
    startedAt: null,
    finishedAt: null,
    lastReportAt: null,
  };
  const cleanupBuildIds = supersessionCleanupBuildIds(input);
  const cleanedBuilds = sql`coalesce(
    (
      select json_group_array(json(desired_build.value))
      from json_each(${hostDesiredState.docJson}, '$.builds') as desired_build
      where cast(json_extract(desired_build.value, '$.build_id') as text)
        not in (${cleanupBuildIds})
    ),
    '[]'
  )`;

  // D1 batches are transactions. Keeping desired-state cleanup, retirement,
  // and insertion/revival in one batch gives each scenario/architecture pair
  // a single total order even when two bundle uploads race in different Worker
  // isolates. The later transaction retires the earlier hash before activating
  // its own, so at most one content hash can remain active.
  const [cleanedHosts, , queuedRows] = await db.batch([
    db
      .update(hostDesiredState)
      .set({
        version: sql`${hostDesiredState.version} + 1`,
        docJson: sql`json_set(
          ${hostDesiredState.docJson},
          '$.version', ${hostDesiredState.version} + 1,
          '$.generated_at_unix_ms', ${input.nowUnixMs},
          '$.builds', json(${cleanedBuilds})
        )`,
        updatedAt: input.nowUnixMs,
      })
      .where(
        sql`exists (
          select 1
          from json_each(${hostDesiredState.docJson}, '$.builds') as desired_build
          where cast(json_extract(desired_build.value, '$.build_id') as text)
            in (${cleanupBuildIds})
        )`,
      )
      .returning({ hostId: hostDesiredState.hostId }),
    db
      .update(imageBuilds)
      .set({
        status: "stale",
        error: `superseded by bundle ${input.rev}`,
        updatedAt: input.nowUnixMs,
      })
      .where(
        and(
          eq(imageBuilds.scenarioId, input.scenarioId),
          input.organizationId
            ? eq(imageBuilds.organizationId, input.organizationId)
            : isNull(imageBuilds.organizationId),
          eq(imageBuilds.arch, input.arch),
          ne(imageBuilds.contentHash, input.contentHash),
          inArray(imageBuilds.status, ["queued", "assigned", "building"]),
        ),
      ),
    db
      .insert(imageBuilds)
      .values({
        id: createAppId(),
        organizationId: input.organizationId,
        scenarioId: input.scenarioId,
        arch: input.arch,
        rev: input.rev,
        contentHash: input.contentHash,
        catalogChannel: input.catalogChannel,
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
      .onConflictDoUpdate({
        target: [
          imageBuilds.scenarioId,
          imageBuilds.arch,
          imageBuilds.contentHash,
        ],
        set: {
          rev: input.rev,
          organizationId: input.organizationId,
          catalogChannel: input.catalogChannel,
          hostId: null,
          status: "queued",
          phase: "queued",
          attempt: 0,
          error: null,
          logR2Key: null,
          timingsJson: timings,
          updatedAt: input.nowUnixMs,
        },
        setWhere: inArray(imageBuilds.status, ["failed", "stale"]),
      })
      .returning({ id: imageBuilds.id }),
  ]);

  return {
    queued: queuedRows.length,
    cleanedHostIds: cleanedHosts.map(({ hostId }) => hostId),
  };
}

function supersessionCleanupBuildIds(input: {
  scenarioId: string;
  arch: ImageBuildBundleMeta["scenarios"][number]["arch"];
  contentHash: string;
  organizationId: string | null;
}) {
  return dbBuildIds(
    and(
      eq(imageBuilds.scenarioId, input.scenarioId),
      input.organizationId
        ? eq(imageBuilds.organizationId, input.organizationId)
        : isNull(imageBuilds.organizationId),
      eq(imageBuilds.arch, input.arch),
      or(
        and(
          ne(imageBuilds.contentHash, input.contentHash),
          inArray(imageBuilds.status, [
            "queued",
            "assigned",
            "building",
            "stale",
          ]),
        ),
        and(
          eq(imageBuilds.contentHash, input.contentHash),
          inArray(imageBuilds.status, ["queued", "failed", "stale"]),
        ),
      ),
    ),
  );
}

function dbBuildIds(where: ReturnType<typeof and>) {
  return sql`select ${imageBuilds.id} from ${imageBuilds} where ${where}`;
}

export async function assignQueuedImageBuilds(
  db: DrizzleD1Database,
  nowUnixMs: number,
): Promise<Array<{ buildId: string; hostId: string }>> {
  const [queuedBuilds, builders] = await Promise.all([
    loadQueuedBuildRows(db),
    loadBuilderCandidates(db, nowUnixMs),
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
          }),
        );
      },
    );
    await tryWakeHostRuntime(builder.hostId);

    // Supersession can win after the claim but before the desired-state write.
    // Recheck after publishing desired state; if the row is no longer assigned
    // to this host, compensate immediately. If supersession happens after this
    // read, its lock-held transaction removes the desired entry instead.
    const activeAssignment = await db
      .select({ id: imageBuilds.id })
      .from(imageBuilds)
      .where(
        and(
          eq(imageBuilds.id, build.id),
          eq(imageBuilds.hostId, builder.hostId),
          inArray(imageBuilds.status, ["assigned", "building"]),
        ),
      )
      .limit(1);
    if (!activeAssignment.length) {
      await removeDesiredBuildsFromHost(
        db,
        builder.hostId,
        [build.id],
        nowUnixMs,
      );
      continue;
    }

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
  reconciledDesiredBuildIds: string[];
}> {
  const [requeuedAssignedBuildIds, staleBuildIds] = await Promise.all([
    requeueAssignedBuildsForDisconnectedHost(db, hostId, nowUnixMs),
    markSilentBuildingBuildsStale(db, hostId, nowUnixMs),
  ]);
  const reassigned = await assignQueuedImageBuilds(db, nowUnixMs);
  const reconciledDesiredBuildIds = await reconcileAssignedBuildsForHost(
    db,
    hostId,
    nowUnixMs,
  );
  return {
    requeuedAssignedBuildIds,
    staleBuildIds,
    reassigned,
    reconciledDesiredBuildIds,
  };
}

export async function reconcileAssignedBuildsForHost(
  db: DrizzleD1Database,
  hostId: string,
  nowUnixMs: number,
): Promise<string[]> {
  const assignments = await db
    .select({
      buildId: imageBuilds.id,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      rev: imageBuilds.rev,
      contentHash: imageBuilds.contentHash,
      bundleRef: imageBuildBundles.r2Key,
    })
    .from(imageBuilds)
    .innerJoin(imageBuildBundles, eq(imageBuildBundles.rev, imageBuilds.rev))
    .where(
      and(
        eq(imageBuilds.hostId, hostId),
        inArray(imageBuilds.status, ["assigned", "building"]),
      ),
    );
  if (!assignments.length) return [];

  const before = await loadOrCreateHostDesiredState(db, hostId, nowUnixMs);
  const desiredIds = new Set(before.builds.map((build) => build.build_id));
  const missingIds = assignments
    .filter((assignment) => !desiredIds.has(assignment.buildId))
    .map((assignment) => assignment.buildId);
  if (!missingIds.length) return [];

  await mutateStoredHostDesiredState(db, hostId, nowUnixMs, (draft) => {
    for (const assignment of assignments) {
      upsertDesiredBuild(
        draft,
        desiredBuildFromSource({
          buildId: assignment.buildId,
          scenarioId: assignment.scenarioId,
          arch: assignment.arch,
          rev: assignment.rev,
          contentHash: assignment.contentHash,
          bundleRef: assignment.bundleRef,
        }),
      );
    }
  });

  const stillActive = await db
    .select({ id: imageBuilds.id })
    .from(imageBuilds)
    .where(
      and(
        eq(imageBuilds.hostId, hostId),
        inArray(imageBuilds.status, ["assigned", "building"]),
        inArray(
          imageBuilds.id,
          assignments.map((assignment) => assignment.buildId),
        ),
      ),
    );
  const activeIds = new Set(stillActive.map((row) => row.id));
  const supersededIds = assignments
    .map((assignment) => assignment.buildId)
    .filter((buildId) => !activeIds.has(buildId));
  await removeDesiredBuildsFromHost(db, hostId, supersededIds, nowUnixMs, {
    wake: false,
  });

  return missingIds.filter((buildId) => activeIds.has(buildId));
}

export async function recordImageBuildReport(
  db: DrizzleD1Database,
  hostId: string,
  report: BuildReportV1,
  nowUnixMs: number,
): Promise<{ updated: boolean; terminal: boolean }> {
  const identities = await db
    .select({
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
    })
    .from(imageBuilds)
    .where(eq(imageBuilds.id, report.build_id))
    .limit(1);
  const identity = identities[0];
  if (!identity) {
    return { updated: false, terminal: false };
  }

  return withImageBuildCoordinationLock(db, identity, async (lease) => {
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
    if (!existing) {
      return { updated: false, terminal: false };
    }
    const reportIdentity = {
      assignedHostId: existing.hostId,
      assignedStatus: existing.status,
      reportingHostId: hostId,
      reportHostId: report.host_id,
      assignedScenarioId: existing.scenarioId,
      reportScenarioId: report.scenario_id,
      assignedContentHash: existing.contentHash,
      reportContentHash: report.content_hash,
    };
    if (
      shouldAcknowledgeTerminalBuildReport({
        ...reportIdentity,
        reportPhase: report.phase,
      })
    ) {
      return { updated: false, terminal: true };
    }
    if (!shouldAcceptBuildReport(reportIdentity)) {
      return { updated: false, terminal: false };
    }

    const timings = mergeBuildTimings(existing.timingsJson, report);
    await lease.assertHeld();
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
        and(
          eq(imageBuilds.id, report.build_id),
          eq(imageBuilds.hostId, hostId),
          eq(imageBuilds.scenarioId, existing.scenarioId),
          eq(imageBuilds.contentHash, existing.contentHash),
          inArray(imageBuilds.status, ["assigned", "building"]),
        ),
      )
      .returning({ id: imageBuilds.id });

    return {
      updated: updated.length > 0,
      terminal: updated.length > 0 && isTerminalBuildPhase(report.phase),
    };
  });
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

  const candidates = await db
    .select({
      id: imageBuilds.id,
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
    })
    .from(imageBuilds)
    .where(
      and(eq(imageBuilds.hostId, hostId), eq(imageBuilds.status, "assigned")),
    );
  if (!candidates.length) {
    return [];
  }

  const buildIds = await withImageBuildCoordinationLocks(
    db,
    candidates,
    async (lease) => {
      const lockedHosts = await db
        .select({
          connected: agentHosts.connected,
          disconnectedAt: agentHosts.disconnectedAt,
        })
        .from(agentHosts)
        .where(eq(agentHosts.id, hostId))
        .limit(1);
      const lockedHost = lockedHosts[0];
      if (!lockedHost || !isDisconnectedPastDeadline(lockedHost, nowUnixMs)) {
        return [];
      }

      const lockedRows = await db
        .select({ id: imageBuilds.id })
        .from(imageBuilds)
        .where(
          and(
            eq(imageBuilds.hostId, hostId),
            eq(imageBuilds.status, "assigned"),
            inArray(
              imageBuilds.id,
              candidates.map((candidate) => candidate.id),
            ),
          ),
        );
      if (!lockedRows.length) return [];

      await lease.assertHeld();
      const updated = await db
        .update(imageBuilds)
        .set({
          hostId: null,
          status: "queued",
          phase: "queued",
          error: "builder disconnected before starting build",
          updatedAt: nowUnixMs,
        })
        .where(
          and(
            eq(imageBuilds.hostId, hostId),
            eq(imageBuilds.status, "assigned"),
            inArray(
              imageBuilds.id,
              lockedRows.map((row) => row.id),
            ),
          ),
        )
        .returning({ id: imageBuilds.id });
      const updatedIds = updated.map((row) => row.id);
      await removeDesiredBuildsFromHost(db, hostId, updatedIds, nowUnixMs, {
        wake: false,
      });
      return updatedIds;
    },
  );
  if (buildIds.length) await tryWakeHostRuntime(hostId);
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
      scenarioId: imageBuilds.scenarioId,
      arch: imageBuilds.arch,
      status: imageBuilds.status,
      updatedAt: imageBuilds.updatedAt,
      timingsJson: imageBuilds.timingsJson,
    })
    .from(imageBuilds)
    .where(
      and(eq(imageBuilds.hostId, hostId), eq(imageBuilds.status, "building")),
    );
  const candidates = rows.filter((row) =>
    isSilentBuildingBuild(row, nowUnixMs),
  );
  if (!candidates.length) {
    return [];
  }

  const staleIds = await withImageBuildCoordinationLocks(
    db,
    candidates,
    async (lease) => {
      const lockedRows = await db
        .select({
          id: imageBuilds.id,
          status: imageBuilds.status,
          updatedAt: imageBuilds.updatedAt,
          timingsJson: imageBuilds.timingsJson,
        })
        .from(imageBuilds)
        .where(
          and(
            eq(imageBuilds.hostId, hostId),
            eq(imageBuilds.status, "building"),
            inArray(
              imageBuilds.id,
              candidates.map((candidate) => candidate.id),
            ),
          ),
        );
      const lockedStaleIds = lockedRows
        .filter((row) => isSilentBuildingBuild(row, nowUnixMs))
        .map((row) => row.id);
      if (!lockedStaleIds.length) return [];

      await lease.assertHeld();
      const updated = await db
        .update(imageBuilds)
        .set({
          status: "stale",
          error: "builder stopped reporting build progress",
          updatedAt: nowUnixMs,
        })
        .where(
          and(
            eq(imageBuilds.hostId, hostId),
            eq(imageBuilds.status, "building"),
            inArray(imageBuilds.id, lockedStaleIds),
          ),
        )
        .returning({ id: imageBuilds.id });
      const updatedIds = updated.map((row) => row.id);
      await removeDesiredBuildsFromHost(db, hostId, updatedIds, nowUnixMs, {
        wake: false,
      });
      return updatedIds;
    },
  );
  if (staleIds.length) await tryWakeHostRuntime(hostId);
  return staleIds;
}

async function removeDesiredBuildsFromHost(
  db: DrizzleD1Database,
  hostId: string,
  buildIds: string[],
  nowUnixMs: number,
  options?: { wake?: boolean },
): Promise<void> {
  if (!buildIds.length) {
    return;
  }
  await mutateStoredHostDesiredState(db, hostId, nowUnixMs, (draft) => {
    for (const buildId of buildIds) {
      removeDesiredBuild(draft, { buildId });
    }
  });
  if (options?.wake !== false) await tryWakeHostRuntime(hostId);
}

async function loadBuilderCandidates(
  db: DrizzleD1Database,
  nowUnixMs: number,
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
        stateReportedAt: hostActualState.updatedAt,
        reportJson: hostActualState.reportJson,
      })
      .from(agentHosts)
      .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
      .where(
        and(eq(agentHosts.role, "builder"), isNull(agentHosts.organizationId)),
      ),
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
      typeof host.stateReportedAt === "number" &&
      typeof host.lastClientHelloAt === "number" &&
      host.stateReportedAt >= host.lastClientHelloAt &&
      hostHealth(host.stateReportedAt, nowUnixMs) === "healthy",
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
