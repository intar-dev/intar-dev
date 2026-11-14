import { hostReportV3Ready } from "@/lib/personal-host-readiness";
import { env } from "cloudflare:workers";
import { capacityHostAccessForUser, metalPlacementForUser } from "@/lib/metal-placement";
import { and, desc, eq, gte, isNull, or } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import { AppError, errorChainMatches } from "@/lib/app-error";
import {
  cpuReservationForVms,
  strictCpuCapacity,
} from "@/control-plane/host-cpu-reservations";
import { agentHosts, hostActualState, scenarioRuns } from "@/db/schema";
import { markStoredDesiredVmsAbsent } from "@/lib/desired-state-store";
import { hostHealth } from "@/lib/host-health";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
  type RuntimeResourceDemand,
} from "@/lib/runtime-capacity";
import type { RuntimeVmSpec } from "@/lib/runtime-executions";
import type { ResourceCapacity } from "@/lib/resource-capacity";
import { revokeAllRoutes } from "@/lib/route-revocation";
import type { RunStateDocument, RunVmStateDocument } from "@/lib/run-state";
import {
  isAvailableScenarioLaunchHost,
} from "@/lib/scenario-hosts";
import { deleteStargateRoute, stargateRouteTtlMs } from "@/lib/stargate";
import { parseRunState } from "./storage";

export { deterministicRuntimeVmName } from "./runtime-vm-name";

export const HOST_HEARTBEAT_TTL_MS = 90_000;

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

  const names = new Set(input.vms.map((vm) => vm.runtimeVmName));
  await markStoredDesiredVmsAbsent(
    input.db ?? drizzle(env.DB),
    input.hostId,
    input.nowUnixMs,
    (vm) => vm.run_id === input.runId && names.has(vm.name),
  );
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
 * Shares host health and readiness checks between placement and catalog totals.
 * Catalog totals pass a broader access scope to combine the user's pools.
 */
async function loadEligibleScenarioLaunchHosts(
  userId: string,
  now = Date.now(),
  organizationId: string | null = null,
  hostScope = metalPlacementForUser(userId, organizationId),
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
        hostScope,
      ),
    )
    .orderBy(desc(agentHosts.updatedAt));

  const candidates = rows
    .map((row) => {
      // The state report is the live source of per-host VM load and capacity.
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
        (row.scope === "platform" || hostReportV3Ready(row.actualReport)) &&
        strictCpuCapacity(row.actualReport) !== null,
    );

  return candidates;
}

/** Compatibility entry point for callers that only need pressure. */
export async function loadScenarioCapacityPressure(
  userId: string,
  now = Date.now(),
  organizationId: string | null = null,
): Promise<number | null> {
  return (await loadScenarioCapacity(userId, now, organizationId))
    .capacityPressure;
}

/** Sums usable fleet resources after reservations; pressure still includes disk. */
export async function loadScenarioCapacity(
  userId: string,
  now = Date.now(),
  organizationId: string | null = null,
): Promise<{
  capacityPressure: number | null;
  resourceCapacity: ResourceCapacity | null;
}> {
  const hosts = await loadEligibleScenarioLaunchHosts(
    userId,
    now,
    organizationId,
    capacityHostAccessForUser(userId, organizationId),
  );
  if (!hosts.length) return { capacityPressure: null, resourceCapacity: null };

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
  let resourceCapacityValid = true;

  for (const host of hosts) {
    const report = host.actualReport;
    const cpu = strictCpuCapacity(report);
    const capacity = report?.capacity;
    if (
      !report ||
      !cpu ||
      !capacity ||
      !isPositiveSafeInteger(capacity.memory_total_mib) ||
      !isPositiveSafeInteger(capacity.disk_total_mib) ||
      !Array.isArray(report.vms)
    ) {
      continue;
    }
    // Keep the legacy pressure calculation, but do not publish resource
    // amounts derived from coerced, negative, or out-of-range availability.
    if (
      !Number.isSafeInteger(capacity.memory_available_mib) ||
      capacity.memory_available_mib < 0 ||
      capacity.memory_available_mib > capacity.memory_total_mib ||
      !Number.isSafeInteger(capacity.disk_available_mib) ||
      capacity.disk_available_mib < 0 ||
      capacity.disk_available_mib > capacity.disk_total_mib
    ) {
      resourceCapacityValid = false;
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
    return { capacityPressure: null, resourceCapacity: null };
  }

  return {
    capacityPressure: capacityPressurePercent({
      totalCpuMillis,
      availableCpuMillis,
      totalMemoryMib,
      availableMemoryMib,
      totalDiskMib,
      availableDiskMib,
    }),
    resourceCapacity: resourceCapacityValid ? {
      cpu: { availableMillis: availableCpuMillis, totalMillis: totalCpuMillis },
      memory: { availableMib: availableMemoryMib, totalMib: totalMemoryMib },
    } : null,
  };
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
