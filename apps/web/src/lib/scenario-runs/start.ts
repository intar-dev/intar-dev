import { personalHostReportReady } from "@/lib/personal-host-readiness";
import { env } from "cloudflare:workers";
import { metalPlacementForUser } from "@/lib/metal-placement";
import { and, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { AppError, appError, errorChainMatches } from "@/lib/app-error";
import {
  cpuReservationForVms,
  strictCpuCapacity,
} from "@/control-plane/host-cpu-reservations";
import { agentHosts, hostActualState, scenarioRuns } from "@/db/schema";
import { markDesiredVmAbsent } from "@/lib/desired-state";
import { mutateStoredHostDesiredState } from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
  runtimeResourcesFit,
  type RuntimeResourceDemand,
} from "@/lib/runtime-capacity";
import type { RuntimeVmSpec } from "@/lib/runtime-executions";
import { revokeAllRoutes } from "@/lib/route-revocation";
import type { RunStateDocument, RunVmStateDocument } from "@/lib/run-state";
import {
  hostHasImagesReady,
  imageKeyIdentity,
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import {
  hostSupportsRunCliV1,
  hostSupportsSpeedRedesign,
  isAvailableScenarioLaunchHost,
  isFreshHostHeartbeat,
  isScenarioLaunchHost,
} from "@/lib/scenario-hosts";
import { learnerRunCliV1EnforcementEnabled } from "@/lib/run-cli-rollout";
import { deleteStargateRoute, stargateRouteTtlMs } from "@/lib/stargate";
import { traceOperation } from "../tracing";
import { parseRunState } from "./storage";

export { deterministicRuntimeVmName } from "./runtime-vm-name";

export const HOST_HEARTBEAT_TTL_MS = 90_000;

export type HostSelectionResult =
  | { ok: true; hostIds: string[] }
  | {
      ok: false;
      reason: "unavailable" | "image_not_ready" | "resource_capacity";
      message?: string;
    };

export type ScenarioRouteType =
  | "browser"
  | "native_profile_keys"
  | "native_issued_key";

export function scenarioRuntimeReservationResources(
  vms: RuntimeVmSpec[],
  cpuMillisByVm: readonly number[],
): RuntimeResourceDemand {
  const resources = vms.reduce<RuntimeResourceDemand>(
    (total, vm) => ({
      cpuMillis: total.cpuMillis + vm.cpuMillis,
      memoryMib: total.memoryMib + vm.memoryMib,
      worstCaseDiskMib: total.worstCaseDiskMib + vm.diskMib,
    }),
    { cpuMillis: 0, memoryMib: 0, worstCaseDiskMib: 0 },
  );
  return {
    ...resources,
    cpuMillis: cpuReservationForVms(cpuMillisByVm),
  };
}

export async function assertScenarioLaunchHostForUser(
  hostId: string,
  userId: string,
  requiredImages: RequiredScenarioImage[],
): Promise<void> {
  await loadScenarioLaunchHostForUser(hostId, userId, requiredImages);
}

/** Returns the exact host/report snapshot checked for admission. */
export async function loadScenarioLaunchHostForUser(
  hostId: string,
  userId: string,
  requiredImages: RequiredScenarioImage[],
) {
  const now = Date.now();
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      scope: agentHosts.scope,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      credentialGeneration: agentHosts.credentialGeneration,
      activeSessionId: agentHosts.activeSessionId,
      actualReportedAt: hostActualState.updatedAt,
      actualReport: hostActualState.reportJson,
      actualReportText: sql<string | null>`${hostActualState.reportJson}`,
    })
    .from(agentHosts)
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .where(
      and(
        eq(agentHosts.id, hostId),
        metalPlacementForUser(userId),
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
  if (host.scope === "personal" && !personalHostReportReady(host.actualReport, learnerRunCliV1EnforcementEnabled(env))) {
    throw appError(409, "personal_server_not_ready", "Your server is not Ready. Open Profile → My servers and run the repair action.");
  }
  if (!hostHasImagesReady(host.actualReport, requiredImages)) {
    throw appError(
      409,
      "image_not_ready",
      "scenario images are not ready on this host",
    );
  }
  if (!hostSupportsSpeedRedesign(host.actualReport)) {
    throw appError(
      409,
      "scenario_host_unavailable",
      "host does not support chunked images and pinned guest tools",
    );
  }
  if (
    learnerRunCliV1EnforcementEnabled(env) &&
    !hostSupportsRunCliV1(host.actualReport)
  ) {
    throw appError(
      409,
      "scenario_host_unavailable",
      "host does not support the learner CLI yet",
    );
  }
  if (strictCpuCapacity(host.actualReport) === null) {
    throw appError(
      409,
      "scenario_host_not_performance_ready",
      "host does not attest the required template, CPU-limit, and fast-filesystem launch path",
    );
  }
  return host;
}

export function isActiveKeyUniqueViolation(error: unknown): boolean {
  if (error instanceof AppError && error.code === "runtime_active_slot_conflict") {
    return true;
  }
  return errorChainMatches(
    error,
    /UNIQUE constraint failed.*active_key|scenario_runs_active_key_uidx|active_runtime_slots|runtime_active_slot_conflict/,
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
    case "native_issued_key":
      return "ssh-issued";
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
      buildRunVmRouteUsername(
        row.runId,
        row.state.vms,
        vm.id,
        "native_issued_key",
      ),
    ]),
  );
  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

export async function revokeScenarioNativeProfileRoutesForUser(
  userId: string,
): Promise<void> {
  await revokeScenarioRouteTypesForUser(
    userId,
    ["native_profile_keys"],
    "active-only",
  );
}

export async function revokeScenarioRoutesForUser(
  userId: string,
  now = Date.now(),
): Promise<void> {
  await revokeScenarioRouteTypesForUser(
    userId,
    ["browser", "native_profile_keys", "native_issued_key"],
    now - stargateRouteTtlMs(),
  );
}

async function revokeScenarioRouteTypesForUser(
  userId: string,
  routeTypes: readonly ScenarioRouteType[],
  scope: "active-only" | number,
): Promise<void> {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRuns.runId,
      stateJson: scenarioRuns.stateJson,
    })
    .from(scenarioRuns)
    .where(
      scope === "active-only"
        ? and(
            eq(scenarioRuns.userId, userId),
            isNull(scenarioRuns.hiddenAt),
            isNull(scenarioRuns.completedAt),
            isNull(scenarioRuns.failedAt),
          )
        : and(
            eq(scenarioRuns.userId, userId),
            or(
              and(
                isNull(scenarioRuns.completedAt),
                isNull(scenarioRuns.failedAt),
              ),
              gte(scenarioRuns.updatedAt, scope),
              gte(scenarioRuns.completedAt, scope),
              gte(scenarioRuns.failedAt, scope),
              gte(scenarioRuns.hiddenAt, scope),
            ),
          ),
    );

  const routeUsernames = new Set<string>();
  for (const row of rows) {
    const state = parseRunState(row.stateJson);
    for (const vm of state.vms) {
      for (const routeType of routeTypes) {
        routeUsernames.add(
          buildRunVmRouteUsername(row.runId, state.vms, vm.id, routeType),
        );
      }
    }
  }

  await revokeAllRoutes(routeUsernames, deleteStargateRoute);
}

/**
 * Loads hosts that can accept a learner scenario before image and resource
 * checks. Keep this shared with the catalog capacity signal so its policy
 * cannot say a host is usable when admission would reject it.
 */
async function loadEligibleScenarioLaunchHosts(
  userId: string,
  now = Date.now(),
  requireRunCli = learnerRunCliV1EnforcementEnabled(env),
) {
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      id: agentHosts.id,
      scope: agentHosts.scope,
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
        metalPlacementForUser(userId),
      ),
    )
    .orderBy(desc(agentHosts.updatedAt));

  const candidates = rows
    .map((row) => {
      // The bridge v7 state report is the live source of per-host VM load
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
        (row.scope !== "personal" || personalHostReportReady(row.actualReport, requireRunCli)) &&
        strictCpuCapacity(row.actualReport) !== null &&
        hostSupportsSpeedRedesign(row.actualReport) &&
        (!requireRunCli || hostSupportsRunCliV1(row.actualReport)),
    );

  return candidates;
}

/**
 * Sums the usable runner fleet, then reports the fullest shared resource pool.
 * A high disk allowance must not hide exhausted CPU or memory.
 */
export async function loadScenarioCapacityPressure(
  userId: string,
  now = Date.now(),
  requireRunCli = learnerRunCliV1EnforcementEnabled(env),
): Promise<number | null> {
  const hosts = await loadEligibleScenarioLaunchHosts(
    userId,
    now,
    requireRunCli,
  );
  if (!hosts.length) return null;

  const snapshot = await loadActiveRuntimeResourceSnapshot(
    now,
    hosts.map((host) => host.id),
  );
  let validHostCount = 0;
  let totalCpuMillis = 0;
  let availableCpuMillis = 0;
  let totalMemoryMib = 0;
  let availableMemoryMib = 0;
  let totalDiskMib = 0;
  let availableDiskMib = 0;

  for (const host of hosts) {
    const report = host.actualReport;
    const cpu = strictCpuCapacity(report);
    const capacity = report?.capacity;
    if (
      !report ||
      !cpu ||
      !capacity ||
      !isPositiveSafeInteger(capacity.memory_total_mib) ||
      !isPositiveSafeInteger(capacity.disk_total_mib)
    ) {
      continue;
    }
    const available = availableRuntimeHostResources({
      hostId: host.id,
      report,
      snapshot,
    });
    if (!available) continue;

    validHostCount += 1;
    totalCpuMillis += cpu.schedulableCpuMillis;
    availableCpuMillis += available.cpuMillis;
    totalMemoryMib += capacity.memory_total_mib;
    availableMemoryMib += available.memoryMib;
    totalDiskMib += capacity.disk_total_mib;
    availableDiskMib += available.worstCaseDiskMib;
  }

  if (
    validHostCount === 0 ||
    ![
      totalCpuMillis,
      availableCpuMillis,
      totalMemoryMib,
      availableMemoryMib,
      totalDiskMib,
      availableDiskMib,
    ].every(Number.isSafeInteger)
  ) {
    return null;
  }

  return capacityPressurePercent({
    totalCpuMillis,
    availableCpuMillis,
    totalMemoryMib,
    availableMemoryMib,
    totalDiskMib,
    availableDiskMib,
  });
}

function capacityPressurePercent(input: {
  totalCpuMillis: number;
  availableCpuMillis: number;
  totalMemoryMib: number;
  availableMemoryMib: number;
  totalDiskMib: number;
  availableDiskMib: number;
}): number {
  const pressure = Math.max(
    usedFraction(input.totalCpuMillis, input.availableCpuMillis),
    usedFraction(input.totalMemoryMib, input.availableMemoryMib),
    usedFraction(input.totalDiskMib, input.availableDiskMib),
  );
  return pressure >= 1 ? 100 : Math.min(99, Math.round(pressure * 100));
}

function usedFraction(total: number, available: number): number {
  if (total <= 0) return 1;
  return 1 - Math.min(1, Math.max(0, available) / total);
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export async function selectScenarioHosts(
  requiredImages: RequiredScenarioImage[],
  userId: string,
  requiredResources?: RuntimeResourceDemand,
  now = Date.now(),
  requireRunCli = learnerRunCliV1EnforcementEnabled(env),
): Promise<HostSelectionResult> {
  return traceOperation("scenario.select_host", async () => {
  const db = drizzle(env.DB);
  const candidates = await loadEligibleScenarioLaunchHosts(
    userId,
    now,
    requireRunCli,
  );

  if (!candidates.length) {
    return hostSelectionFailure(userId, "unavailable");
  }

  let imageReadyCandidates = candidates.filter((candidate) =>
    hostHasImagesReady(candidate.actualReport, requiredImages),
  );

  if (!imageReadyCandidates.length) {
    return hostSelectionFailure(userId, "image_not_ready");
  }

  const availableResourcesByHost = new Map<string, RuntimeResourceDemand>();
  if (requiredResources) {
    const snapshot = await loadActiveRuntimeResourceSnapshot(
      now,
      imageReadyCandidates.map((candidate) => candidate.id),
    );
    imageReadyCandidates = imageReadyCandidates.filter((candidate) => {
      if (!candidate.actualReport) return false;
      const available = availableRuntimeHostResources({
        hostId: candidate.id,
        report: candidate.actualReport,
        snapshot,
      });
      if (!available) return false;
      availableResourcesByHost.set(candidate.id, available);
      return runtimeResourcesFit(requiredResources, available);
    });
    if (!imageReadyCandidates.length) {
      return hostSelectionFailure(userId, "resource_capacity");
    }
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
    const leftAvailable = availableResourcesByHost.get(left.id);
    const rightAvailable = availableResourcesByHost.get(right.id);
    if (
      leftAvailable &&
      rightAvailable &&
      leftAvailable.cpuMillis !== rightAvailable.cpuMillis
    ) {
      return rightAvailable.cpuMillis - leftAvailable.cpuMillis;
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

  });
}

async function hostSelectionFailure(userId: string, reason: "unavailable" | "image_not_ready" | "resource_capacity"): Promise<HostSelectionResult> {
  const owner = await env.DB.prepare("SELECT metal_placement FROM user WHERE id = ?").bind(userId).first<{ metal_placement: string }>();
  if (owner?.metal_placement !== "personal") return { ok: false, reason };
  return { ok: false, reason, message: reason === "resource_capacity"
    ? "Your servers do not have enough free CPU, memory, or storage. Wait for a run to finish."
    : reason === "image_not_ready"
      ? "Your server is preparing the required images. Wait, then start the run again."
      : "Your servers are offline, paused, or need repair. Open Profile → My servers to restore a Ready server." };
}
