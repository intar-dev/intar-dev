import { env } from "cloudflare:workers";
import { strictCpuCapacity } from "@/control-plane/host-cpu-reservations";
import type { HostStateReportV2, VmActualStateV2 } from "@/generated/bridge";

export const RUNTIME_PENDING_RESOURCE_RESERVATION_TTL_MS = 5 * 60_000;

export interface RuntimeResourceDemand {
  cpuMillis: number;
  memoryMib: number;
  worstCaseDiskMib: number;
}

export interface RuntimeResourceReservationSnapshot {
  execution_id: string;
  host_id: string;
  cpu_millis: number;
  memory_mib: number;
  worst_case_disk_mib: number;
  state: "pending" | "committed";
  expires_at: number | null;
}

export interface RuntimeReservedVmSnapshot {
  execution_id: string;
  runtime_vm_name: string;
  cpu_millis: number;
  memory_mib: number;
}

export interface ActiveRuntimeResourceSnapshot {
  reservations: RuntimeResourceReservationSnapshot[];
  reservedVms: RuntimeReservedVmSnapshot[];
}

/**
 * Loads the scenario reservation ledger. Expired pending rows
 * deliberately stop consuming capacity, while committed rows remain charged
 * until teardown has been observed and releases them.
 */
export async function loadActiveRuntimeResourceSnapshot(
  now: number,
  hostIds?: readonly string[],
): Promise<ActiveRuntimeResourceSnapshot> {
  const scopedHostIds = hostIds ? [...new Set(hostIds)] : null;
  if (scopedHostIds?.length === 0) {
    return { reservations: [], reservedVms: [] };
  }
  const hostPlaceholders = scopedHostIds?.map(() => "?").join(", ");
  const [reservationRows, reservedVmRows] = await Promise.all([
    env.DB.prepare(
      `SELECT
         execution_id, host_id, cpu_millis, memory_mib, worst_case_disk_mib,
         state, expires_at
       FROM host_resource_reservations
       WHERE state IN ('pending', 'committed')
         AND (state = 'committed' OR expires_at IS NULL OR expires_at > ?)
         ${hostPlaceholders ? `AND host_id IN (${hostPlaceholders})` : ""}`,
    )
      .bind(now, ...(scopedHostIds ?? []))
      .all<RuntimeResourceReservationSnapshot>(),
    env.DB.prepare(
      `SELECT
         vm.execution_id, vm.runtime_vm_name, vm.cpu_millis, vm.memory_mib
       FROM runtime_vms vm
       INNER JOIN host_resource_reservations reservation
         ON reservation.execution_id = vm.execution_id
       WHERE reservation.state IN ('pending', 'committed')
         AND (
           reservation.state = 'committed'
           OR reservation.expires_at IS NULL
           OR reservation.expires_at > ?
         )
         ${
           hostPlaceholders
             ? `AND reservation.host_id IN (${hostPlaceholders})`
             : ""
         }`,
    )
      .bind(now, ...(scopedHostIds ?? []))
      .all<RuntimeReservedVmSnapshot>(),
  ]);
  return {
    reservations: reservationRows.results,
    reservedVms: reservedVmRows.results,
  };
}

/**
 * Combines the live host report with the shared reservation ledger. CPU uses a
 * reservation top-up so a reported VM is not double counted, while a
 * scenario's larger boot quota remains fenced until its generic reservation
 * is reduced to steady state. Memory and disk remain conservatively charged
 * at their declared worst cases because host availability cannot distinguish
 * lazy guest memory or sparse/COW disk growth from unrelated host usage.
 */
export function availableRuntimeHostResources(input: {
  hostId: string;
  report: HostStateReportV2;
  snapshot: ActiveRuntimeResourceSnapshot;
}): RuntimeResourceDemand | null {
  const cpuCapacity = strictCpuCapacity(input.report);
  if (!cpuCapacity) return null;

  const reservations = input.snapshot.reservations.filter(
    (reservation) => reservation.host_id === input.hostId,
  );
  const reservationByExecution = new Map(
    reservations.map((reservation) => [reservation.execution_id, reservation]),
  );
  const reservedVms = input.snapshot.reservedVms.filter((vm) =>
    reservationByExecution.has(vm.execution_id),
  );
  const reservedVmByIdentity = new Map(
    reservedVms.map((vm) => [`${vm.execution_id}\0${vm.runtime_vm_name}`, vm]),
  );
  const reportedCpuByExecution = new Map<string, number>();
  for (const vm of input.report.vms) {
    const reservation = reservationByExecution.get(vm.run_id);
    if (!reservation) continue;
    const key = `${vm.run_id}\0${vm.vm_name}`;
    const reservedVm = reservedVmByIdentity.get(key);
    if (!reservedVm) continue;
    const effectiveCpuMillis = reportedEffectiveCpuMillis(vm);
    if (effectiveCpuMillis !== null) {
      reportedCpuByExecution.set(
        vm.run_id,
        (reportedCpuByExecution.get(vm.run_id) ?? 0) + effectiveCpuMillis,
      );
    }
  }

  const cpuTopUpMillis = reservations.reduce(
    (total, reservation) =>
      total +
      Math.max(
        0,
        reservation.cpu_millis -
          (reportedCpuByExecution.get(reservation.execution_id) ?? 0),
      ),
    0,
  );
  const reservedMemoryMib = reservations.reduce(
    (total, reservation) => total + reservation.memory_mib,
    0,
  );
  const worstCaseDiskMib = reservations.reduce(
    (total, reservation) => total + reservation.worst_case_disk_mib,
    0,
  );

  return {
    cpuMillis: Math.max(
      0,
      cpuCapacity.schedulableCpuMillis -
        cpuCapacity.reportedCommittedCpuMillis -
        cpuTopUpMillis,
    ),
    memoryMib: Math.max(
      0,
      input.report.capacity.memory_available_mib - reservedMemoryMib,
    ),
    worstCaseDiskMib: Math.max(
      0,
      input.report.capacity.disk_available_mib - worstCaseDiskMib,
    ),
  };
}

export function runtimeResourcesFit(
  required: RuntimeResourceDemand,
  available: RuntimeResourceDemand,
): boolean {
  return (
    required.cpuMillis <= available.cpuMillis &&
    required.memoryMib <= available.memoryMib &&
    required.worstCaseDiskMib <= available.worstCaseDiskMib
  );
}

function reportedEffectiveCpuMillis(vm: VmActualStateV2): number | null {
  const effective = vm.runtime_constraints?.effective_cpu_millis;
  if (Number.isSafeInteger(effective) && (effective ?? 0) > 0) {
    return effective ?? null;
  }
  const resourceCpu = vm.resource_state?.cpu_millis;
  if (Number.isSafeInteger(resourceCpu) && (resourceCpu ?? 0) > 0) {
    return resourceCpu ?? null;
  }
  return null;
}
