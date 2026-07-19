import { env } from "cloudflare:workers";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { appError, errorChainMatches } from "@/lib/app-error";
import { strictCpuCapacity } from "@/control-plane/host-cpu-reservations";
import {
  agentHosts,
  hostActualState,
  scenarioRuns,
  scenarioRunSshKeys,
} from "@/db/schema";
import {
  desiredVmFromRunVm,
  markDesiredVmAbsent,
  upsertDesiredCachedImage,
  upsertDesiredVm,
} from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import {
  commitHostCpu,
  reserveHostCpu,
  rollbackHostCpu,
} from "@/lib/host-cpu-reservation-client";
import { createAppId } from "@/lib/id";
import { revokeAllRoutes } from "@/lib/route-revocation";
import {
  RUN_PHASE_ORDER,
  buildInitialVmState,
  buildInitialRunState,
  recomputeRunState,
  type RunStateDocument,
  type RunVmStateDocument,
} from "@/lib/run-state";
import {
  hostHasImagesReady,
  imageKeyIdentity,
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import {
  isAvailableScenarioLaunchHost,
  isFreshHostHeartbeat,
  isScenarioLaunchHost,
} from "@/lib/scenario-hosts";
import { deleteStargateRoute } from "@/lib/stargate";
import {
  generateScenarioRunSshKeyDraft,
  prepareScenarioRunSshKeyRows,
} from "@/lib/scenario-run-ssh-keys";
import {
  loadEnabledScenarioRows,
  loadActiveRunRow,
  activeRunConflictError,
  activeKeyFor,
  parseRunState,
} from "./storage";
import { deterministicRuntimeVmName } from "./runtime-vm-name";

export { deterministicRuntimeVmName } from "./runtime-vm-name";

export const HOST_HEARTBEAT_TTL_MS = 90_000;

export type HostSelectionResult =
  | { ok: true; hostIds: string[] }
  | { ok: false; reason: "unavailable" | "image_not_ready" };

export type ScenarioRouteType = "browser" | "native_profile_keys";

export async function startScenarioRunInternal(params: {
  scenarioId: string;
  userId: string;
  organizationId?: string | null;
  hostId?: string;
}): Promise<{
  accepted: true;
  runId: string;
  scenarioId: string;
  acceptedAt: number;
  reused: boolean;
}> {
  const organizationId = params.organizationId ?? null;
  const [[scenario], active] = await Promise.all([
    loadEnabledScenarioRows(params.scenarioId, organizationId),
    loadActiveRunRow(params.userId),
  ]);
  if (!scenario) {
    throw appError(404, "scenario_not_found", "scenario not found");
  }
  if (active) {
    if (
      active.scenarioId === scenario.scenarioId &&
      active.organizationId === organizationId
    ) {
      if (params.hostId && active.hostId !== params.hostId) {
        throw appError(
          409,
          "scenario_run_host_conflict",
          "the active scenario run is assigned to a different host",
        );
      }
      return {
        accepted: true,
        runId: active.runId,
        scenarioId: active.scenarioId,
        acceptedAt: Date.now(),
        reused: true,
      };
    }
    throw activeRunConflictError(active.title);
  }

  const runId = createAppId();
  const createdAt = Date.now();
  const requiredImages = requiredImagesForScenarioLaunch(scenario.launchSpecs);
  const steadyCpuMillisByVm = scenario.launchSpecs.map(
    (spec) => spec.resources.cpuMillis,
  );
  const steadyCpuMillis = steadyCpuMillisByVm.reduce(
    (total, cpuMillis) => total + cpuMillis,
    0,
  );
  if (!Number.isSafeInteger(steadyCpuMillis) || steadyCpuMillis <= 0) {
    throw appError(
      500,
      "scenario_catalog_invalid",
      "scenario CPU entitlement is invalid",
    );
  }
  const runVmStates = scenario.launchSpecs.map((spec, index) => {
    const vmId = createAppId();
    const runtimeVmName = deterministicRuntimeVmName(
      spec.runtimeVmNamePrefix,
      runId,
      index,
    );
    const vm = buildInitialVmState({
      id: vmId,
      ordinal: index,
      scenarioVmId: spec.scenarioVmId,
      scenarioVmName: spec.scenarioVmName,
      runtimeVmName,
      hostname: spec.hostname,
      launchSummary: spec.summary,
    });
    return {
      ...vm,
      provisioning: {
        ...vm.provisioning,
        image: spec.image,
        imageKey: spec.imageKey,
        imageSha256: spec.imageSha256,
        resources: spec.resources,
        leaseDurationSeconds: spec.leaseDurationSeconds,
        status: "pending",
      },
    } satisfies RunVmStateDocument;
  });
  const sshKeyDrafts = runVmStates.map((vm) =>
    generateScenarioRunSshKeyDraft({
      runId,
      vmId: vm.id,
      runtimeVmName: vm.runtimeVmName,
    }),
  );
  const sshAuthorizedKeysByVmId = new Map(
    sshKeyDrafts.map((draft) => [draft.vmId, [draft.publicKeyOpenssh]]),
  );
  const sshKeyRowsPromise = prepareScenarioRunSshKeyRows(
    sshKeyDrafts,
    createdAt,
  ).then(
    (rows) => ({ ok: true as const, rows }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const initial = buildInitialRunState({
    vms: runVmStates.map((vm) => ({
      id: vm.id,
      ordinal: vm.ordinal,
      scenarioVmId: vm.scenarioVmId,
      scenarioVmName: vm.scenarioVmName,
      runtimeVmName: vm.runtimeVmName,
      hostname: vm.hostname,
      launchSummary: vm.launchSummary,
    })),
  });
  const state = recomputeRunState({
    ...initial,
    phase: "provisioning",
    phaseTitle: "Provisioning",
    phaseDetail: "Queueing launch delivery.",
    vms: runVmStates,
  });

  const provisionedState = recomputeRunState({
    ...state,
    vms: state.vms.map(
      (vm) =>
        ({
          ...vm,
          provisioning: {
            ...vm.provisioning,
            status: "queued",
            error: null,
          },
        }) satisfies RunVmStateDocument,
    ),
  });

  let hostId: string;
  if (params.hostId) {
    await assertScenarioLaunchHostForUser(
      params.hostId,
      params.userId,
      requiredImages,
      organizationId,
    );
    const reservation = await reserveScenarioBootCpuWithJitter({
      hostIds: [params.hostId],
      runId,
      steadyCpuMillisByVm,
    });
    if (!reservation.ok) {
      throw reservation.reason === "boot_capacity_pending"
        ? bootCapacityPendingError({
            scenarioId: scenario.scenarioId,
            hostId: params.hostId,
          })
        : appError(
            409,
            "scenario_host_unavailable",
            "host cannot provide strict CPU isolation",
          );
    }
    hostId = reservation.hostId;
  } else {
    const selection = await selectScenarioHosts(requiredImages, organizationId);
    if (!selection.ok) {
      if (selection.reason === "image_not_ready") {
        throw appError(
          409,
          "image_not_ready",
          "scenario images are not ready on any available host",
        );
      }
      throw appError(
        409,
        "scenario_host_unavailable",
        "no scenario host available",
      );
    }

    const reservation = await reserveScenarioBootCpuWithJitter({
      hostIds: selection.hostIds,
      runId,
      steadyCpuMillisByVm,
    });
    if (!reservation.ok) {
      throw reservation.reason === "boot_capacity_pending"
        ? bootCapacityPendingError({ scenarioId: scenario.scenarioId })
        : appError(
            409,
            "scenario_host_unavailable",
            "no scenario host can provide strict CPU isolation",
          );
    }
    hostId = reservation.hostId;
  }

  const db = drizzle(env.DB);
  try {
    const preparedSshKeys = await sshKeyRowsPromise;
    if (!preparedSshKeys.ok) {
      throw preparedSshKeys.error;
    }
    const sshKeyRows = preparedSshKeys.rows;
    if (sshKeyRows.length === 0) {
      throw new Error("scenario run has no SSH key rows");
    }
    await db.batch([
      db.insert(scenarioRuns).values({
        runId,
        userId: params.userId,
        organizationId,
        hostId,
        scenarioId: scenario.scenarioId,
        scenarioName: scenario.scenarioId,
        title: scenario.briefing.title,
        tagline: scenario.briefing.tagline,
        briefingMarkdown: scenario.briefing.briefingMarkdown,
        objectivesJson: JSON.stringify(scenario.briefing.objectives),
        difficulty: scenario.briefing.difficulty,
        estimatedMinutes: scenario.briefing.estimatedMinutes,
        tagsJson: scenario.content.tags,
        hintsJson: scenario.content.hints,
        solutionMarkdown: scenario.content.solutionMarkdown,
        revealedHintsJson: [],
        solutionRevealedAt: null,
        solutionAssisted: false,
        vmCount: provisionedState.vms.length,
        state: provisionedState.phase,
        stateRank: RUN_PHASE_ORDER[provisionedState.phase],
        activeKey: activeKeyFor(params.userId),
        stateJson: JSON.stringify(provisionedState),
        deleteRequestedAt: null,
        completedAt: null,
        solvedAt: null,
        failedAt: null,
        hiddenAt: null,
        createdAt,
        updatedAt: createdAt,
      }),
      db.insert(scenarioRunSshKeys).values(sshKeyRows),
    ]);
    await upsertRunVmsIntoDesiredState({
      hostId,
      runId,
      vms: provisionedState.vms,
      nowUnixMs: createdAt,
      sshAuthorizedKeysByVmId,
    });
    await commitHostCpu({ hostId, runId });
  } catch (error) {
    await Promise.allSettled([
      markRunVmsAbsentInDesiredState({
        hostId,
        runId,
        vms: provisionedState.vms,
        nowUnixMs: Date.now(),
        db,
      }),
    ]);
    await db.delete(scenarioRuns).where(eq(scenarioRuns.runId, runId));
    await Promise.allSettled([rollbackHostCpu({ hostId, runId })]);
    // Two concurrent starts race past the pre-check; the unique index on
    // active_key rejects the loser.
    if (isActiveKeyUniqueViolation(error)) {
      throw activeRunConflictError();
    }
    throw error;
  }

  return {
    accepted: true,
    runId,
    scenarioId: scenario.scenarioId,
    acceptedAt: createdAt,
    reused: false,
  };
}

export async function assertScenarioLaunchHostForUser(
  hostId: string,
  userId: string,
  requiredImages: RequiredScenarioImage[],
  organizationId: string | null = null,
): Promise<void> {
  const now = Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
      organizationId: agentHosts.organizationId,
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.id, hostId),
        organizationId
          ? eq(agentHosts.organizationId, organizationId)
          : and(
              eq(agentHosts.userId, userId),
              isNull(agentHosts.organizationId),
            ),
      ),
    )
    .limit(1);
  const host = rows[0];
  if (!host) {
    throw appError(404, "scenario_host_not_found", "host not found");
  }
  if (host.disabled) {
    throw appError(403, "scenario_host_disabled", "host is disabled");
  }
  if (host.role !== "agent") {
    throw appError(
      403,
      "scenario_host_not_launchable",
      "host cannot run scenarios",
    );
  }
  if (
    !isScenarioLaunchHost({
      role: host.role,
      disabled: host.disabled,
      scenarioEnabled: host.scenarioEnabled,
    })
  ) {
    throw appError(
      403,
      "scenario_host_not_launchable",
      "host cannot run scenarios",
    );
  }
  if (
    !host.connected ||
    !isFreshHostHeartbeat(host.lastHeartbeatAt, now, HOST_HEARTBEAT_TTL_MS) ||
    hostHealth(host.actualReportedAt ?? null, now) !== "healthy"
  ) {
    throw appError(409, "scenario_host_unavailable", "host is not connected");
  }
  if (!hostHasImagesReady(host.actualReport, requiredImages)) {
    throw appError(
      409,
      "image_not_ready",
      "scenario images are not ready on this host",
    );
  }
  if (strictCpuCapacity(host.actualReport) === null) {
    throw appError(
      409,
      "scenario_host_not_performance_ready",
      "host does not attest the required v2 template, boot-quota, and fast-filesystem launch path",
    );
  }
}

export const BOOT_CAPACITY_RESERVATION_ATTEMPTS = 4;

export const BOOT_CAPACITY_RETRY_MIN_MS = 15;

export const BOOT_CAPACITY_RETRY_JITTER_MS = 30;

export async function reserveScenarioBootCpuWithJitter(input: {
  hostIds: readonly string[];
  runId: string;
  steadyCpuMillisByVm: readonly number[];
}): Promise<
  | { ok: true; hostId: string }
  | { ok: false; reason: "boot_capacity_pending" | "host_unavailable" }
> {
  let sawBootCapacityPending = false;
  for (
    let attempt = 0;
    attempt < BOOT_CAPACITY_RESERVATION_ATTEMPTS;
    attempt += 1
  ) {
    for (const hostId of input.hostIds) {
      const reservation = await reserveHostCpu({
        hostId,
        runId: input.runId,
        steadyCpuMillisByVm: input.steadyCpuMillisByVm,
      });
      if (reservation.ok) {
        return { ok: true, hostId };
      }
      if (reservation.reason === "boot_capacity_pending") {
        sawBootCapacityPending = true;
        continue;
      }
      if (reservation.reason === "conflict") {
        throw new Error(`CPU reservation conflict for run ${input.runId}`);
      }
    }
    if (
      !sawBootCapacityPending ||
      attempt === BOOT_CAPACITY_RESERVATION_ATTEMPTS - 1
    ) {
      break;
    }
    await bootCapacityRetryJitter();
  }
  return {
    ok: false,
    reason: sawBootCapacityPending
      ? "boot_capacity_pending"
      : "host_unavailable",
  };
}

export async function bootCapacityRetryJitter(): Promise<void> {
  await new Promise<void>((resolve) => {
    const jitterMs =
      BOOT_CAPACITY_RETRY_MIN_MS +
      Math.floor(Math.random() * (BOOT_CAPACITY_RETRY_JITTER_MS + 1));
    setTimeout(resolve, jitterMs);
  });
}

export function bootCapacityPendingError(context?: {
  scenarioId: string;
  hostId?: string;
}) {
  console.log(
    JSON.stringify({
      event: "scenario_boot_capacity_pending",
      scenarioId: context?.scenarioId ?? null,
      hostId: context?.hostId ?? null,
    }),
  );
  return appError(
    409,
    "boot_capacity_pending",
    "scenario boot CPU capacity is pending; retry shortly",
  );
}

export function isActiveKeyUniqueViolation(error: unknown): boolean {
  return errorChainMatches(
    error,
    /UNIQUE constraint failed.*active_key|scenario_runs_active_key_uidx/,
  );
}

export async function upsertRunVmsIntoDesiredState(input: {
  hostId: string;
  runId: string;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  sshAuthorizedKeysByVmId: Map<string, string[]>;
}): Promise<void> {
  const desiredVms = input.vms.map((vm) => {
    const desiredVm = desiredVmFromRunVm({
      runId: input.runId,
      vm,
      nowUnixMs: input.nowUnixMs,
      sshAuthorizedKeysOpenssh: input.sshAuthorizedKeysByVmId.get(vm.id) ?? [],
    });
    if (!desiredVm) {
      throw appError(
        500,
        "scenario_vm_desired_state_invalid",
        `missing desired-state image metadata for ${vm.runtimeVmName}`,
      );
    }
    return desiredVm;
  });

  await mutateStoredHostDesiredState(
    drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (draft) => {
      for (const desiredVm of desiredVms) {
        upsertDesiredCachedImage(draft, {
          image_key: desiredVm.image_key,
          image_sha256: desiredVm.image_sha256,
        });
        upsertDesiredVm(draft, desiredVm);
      }
    },
  );
}

export async function markRunVmsAbsentInDesiredState(input: {
  hostId: string;
  runId: string;
  vms: RunVmStateDocument[];
  nowUnixMs: number;
  db?: DrizzleD1Database;
}): Promise<void> {
  if (!input.vms.length) {
    return;
  }

  await mutateStoredHostDesiredState(
    input.db ?? drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (draft) => {
      for (const vm of input.vms) {
        markDesiredVmAbsent(draft, {
          runId: input.runId,
          vmName: vm.runtimeVmName,
        });
      }
    },
  );
}

export function requiredImagesForScenarioLaunch(
  launchSpecs: Array<{
    imageKey: RequiredScenarioImage["imageKey"] | null;
    imageSha256: string | null;
  }>,
): RequiredScenarioImage[] {
  const byIdentity = new Map<string, RequiredScenarioImage>();
  for (const spec of launchSpecs) {
    const imageSha256 = spec.imageSha256?.trim() ?? "";
    if (!spec.imageKey || !imageSha256) {
      throw appError(
        409,
        "image_not_ready",
        "scenario image metadata is not ready",
      );
    }
    byIdentity.set(imageKeyIdentity(spec.imageKey), {
      imageKey: spec.imageKey,
      imageSha256,
    });
  }
  return [...byIdentity.values()];
}

export function buildRunVmRouteUsername(
  runId: string,
  vms: RunVmStateDocument[],
  vmId: string,
  routeType: ScenarioRouteType,
): string {
  const counts = new Map<string, number>();
  const aliases = new Map<string, string>();
  const runPrefix = slugifyVmAlias(runId) || runId.toLowerCase();
  const suffix = routeSuffixForType(routeType);

  for (const vm of [...vms].sort(
    (left, right) => left.ordinal - right.ordinal,
  )) {
    const baseSlug =
      slugifyVmAlias(vm.scenarioVmName) || `vm-${vm.ordinal + 1}`;
    const count = (counts.get(baseSlug) ?? 0) + 1;
    counts.set(baseSlug, count);
    const ordinalSuffix = count > 1 ? `-${count}` : "";
    aliases.set(
      vm.id,
      `${runPrefix}-${baseSlug}${ordinalSuffix}-${suffix}`.slice(0, 128),
    );
  }

  return aliases.get(vmId) ?? `${runPrefix}-vm-${suffix}`.slice(0, 128);
}

export function slugifyVmAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

export function routeSuffixForType(routeType: ScenarioRouteType): string {
  switch (routeType) {
    case "browser":
      return "web";
    case "native_profile_keys":
      return "ssh-profile";
  }
}

export async function revokeScenarioRunRoutes(row: {
  runId: string;
  state: RunStateDocument;
}): Promise<void> {
  const routeUsernames = new Set(
    row.state.vms.flatMap((vm) => [
      buildRunVmRouteUsername(row.runId, row.state.vms, vm.id, "browser"),
      buildRunVmRouteUsername(
        row.runId,
        row.state.vms,
        vm.id,
        "native_profile_keys",
      ),
    ]),
  );
  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

export async function revokeScenarioNativeProfileRoutesForUser(
  userId: string,
): Promise<void> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(
      and(
        eq(scenarioRuns.userId, userId),
        isNull(scenarioRuns.hiddenAt),
        isNull(scenarioRuns.completedAt),
        isNull(scenarioRuns.failedAt),
      ),
    );

  const routeUsernames = new Set<string>();
  for (const row of rows) {
    const state = parseRunState(row.stateJson);
    for (const vm of state.vms) {
      routeUsernames.add(
        buildRunVmRouteUsername(
          row.runId,
          state.vms,
          vm.id,
          "native_profile_keys",
        ),
      );
    }
  }

  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

export async function selectScenarioHosts(
  requiredImages: RequiredScenarioImage[],
  organizationId: string | null = null,
): Promise<HostSelectionResult> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const rows = await db
    .select({
      id: agentHosts.id,
      updatedAt: agentHosts.updatedAt,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      lastInventoryAt: agentHosts.lastInventoryAt,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.disabled, false),
        eq(agentHosts.role, "agent"),
        eq(agentHosts.scenarioEnabled, true),
        eq(agentHosts.connected, true),
        organizationId
          ? eq(agentHosts.organizationId, organizationId)
          : isNull(agentHosts.organizationId),
      ),
    )
    .orderBy(desc(agentHosts.updatedAt));

  const candidates = rows
    .map((row) => {
      // The bridge v6 state report is the live source of per-host VM load
      // and capacity; the legacy inventory upload no longer exists.
      const capacity = row.actualReport?.capacity ?? null;
      const inventoryVmCount = row.actualReport?.vms?.length ?? 0;
      const cpuCores = Math.max(1, (capacity?.total_cpu_millis ?? 0) / 1000);
      const loadPerCpu =
        typeof capacity?.load_avg_1m === "number" && capacity.load_avg_1m >= 0
          ? capacity.load_avg_1m / cpuCores
          : Number.POSITIVE_INFINITY;
      return {
        ...row,
        inventoryVmCount,
        loadPerCpu,
        memoryAvailableMib: capacity?.memory_available_mib ?? -1,
        reportedFreeCpuMillis: Math.max(
          0,
          (capacity?.schedulable_cpu_millis ?? 0) -
            (capacity?.committed_cpu_millis ?? 0),
        ),
      };
    })
    .filter(
      (row) =>
        isAvailableScenarioLaunchHost(
          {
            role: "agent",
            disabled: false,
            scenarioEnabled: true,
            connected: row.connected,
            lastHeartbeatAt: row.lastHeartbeatAt,
          },
          now,
          HOST_HEARTBEAT_TTL_MS,
        ) &&
        hostHealth(row.actualReportedAt ?? null, now) === "healthy" &&
        strictCpuCapacity(row.actualReport) !== null,
    );

  if (!candidates.length) {
    return { ok: false, reason: "unavailable" };
  }

  const imageReadyCandidates = candidates.filter((candidate) =>
    hostHasImagesReady(candidate.actualReport, requiredImages),
  );

  if (!imageReadyCandidates.length) {
    return { ok: false, reason: "image_not_ready" };
  }

  const activeRuns = await db
    .select({
      hostId: scenarioRuns.hostId,
    })
    .from(scenarioRuns)
    .where(
      and(
        inArray(
          scenarioRuns.hostId,
          imageReadyCandidates.map((candidate) => candidate.id),
        ),
        isNull(scenarioRuns.completedAt),
        isNull(scenarioRuns.failedAt),
      ),
    );

  const activeRunCounts = new Map<string, number>();
  for (const row of activeRuns) {
    activeRunCounts.set(row.hostId, (activeRunCounts.get(row.hostId) ?? 0) + 1);
  }

  imageReadyCandidates.sort((left, right) => {
    const leftRuns = activeRunCounts.get(left.id) ?? 0;
    const rightRuns = activeRunCounts.get(right.id) ?? 0;
    if (leftRuns !== rightRuns) {
      return leftRuns - rightRuns;
    }
    if (left.reportedFreeCpuMillis !== right.reportedFreeCpuMillis) {
      return right.reportedFreeCpuMillis - left.reportedFreeCpuMillis;
    }
    if (left.inventoryVmCount !== right.inventoryVmCount) {
      return left.inventoryVmCount - right.inventoryVmCount;
    }
    if (left.loadPerCpu !== right.loadPerCpu) {
      return left.loadPerCpu - right.loadPerCpu;
    }
    if (left.memoryAvailableMib !== right.memoryAvailableMib) {
      return right.memoryAvailableMib - left.memoryAvailableMib;
    }
    if (left.updatedAt !== right.updatedAt) {
      return right.updatedAt - left.updatedAt;
    }
    return left.id.localeCompare(right.id);
  });

  const hostIds = imageReadyCandidates.map((candidate) => candidate.id);
  return hostIds.length
    ? { ok: true, hostIds }
    : { ok: false, reason: "unavailable" };
}
