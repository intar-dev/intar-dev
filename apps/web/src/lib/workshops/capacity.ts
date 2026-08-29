import { env } from "cloudflare:workers";
import { strictCpuCapacity } from "@/control-plane/host-cpu-reservations";
import type { WorkshopManifestV2 } from "@/db/schema";
import type { HostStateReportV2 } from "@/generated/bridge";
import type { ImageKey } from "@/generated/catalog";
import { appError } from "@/lib/app-error";
import { hostHealth } from "@/lib/host-health";
import {
  availableRuntimeHostResources,
  loadActiveRuntimeResourceSnapshot,
} from "@/lib/runtime-capacity";
import {
  hostHasImagesReady,
  type RequiredScenarioImage,
} from "@/lib/scenario-host-readiness";
import {
  hostSupportsRunCliV1,
  isAvailableScenarioLaunchHost,
} from "@/lib/scenario-hosts";
import { learnerRunCliV1EnforcementEnabled } from "@/lib/run-cli-rollout";
import { loadWorkshopManifestForSession } from "./shared";

const HOST_HEARTBEAT_TTL_MS = 90_000;

export interface WorkshopSeatResources {
  cpuMillis: number;
  memoryMib: number;
  worstCaseDiskMib: number;
}

export interface WorkshopRunnerCapacity {
  hostId: string;
  imagesReady: boolean;
  missingImageVmIds: string[];
  seatsTotal: number;
  seatsAvailable: number;
  available: WorkshopSeatResources;
}

export interface WorkshopCapacityPreflight {
  seatsTotal: number;
  seatsAvailable: number;
  seatsRequired: number;
  checkedIn: number;
  provisioned: number;
  imagesReady: boolean;
  healthyRunners: number;
  seatResources: WorkshopSeatResources;
  runners: WorkshopRunnerCapacity[];
  allocationFailures: Array<{
    hostId: string;
    reason:
      | "host_unavailable"
      | "host_report_stale"
      | "runtime_capabilities_missing"
      | "image_not_ready"
      | "insufficient_resources";
    detail: string;
  }>;
}

interface CandidateHost {
  id: string;
  connected: boolean;
  disabled: boolean;
  scenarioEnabled: boolean;
  lastHeartbeatAt: number | null;
  actualUpdatedAt: number | null;
  report: HostStateReportV2 | null;
}

export async function getWorkshopCapacityPreflight(input: {
  sessionId: string;
  checkpointId?: string;
  now?: number;
}): Promise<WorkshopCapacityPreflight> {
  const context = await loadWorkshopManifestForSession(input.sessionId);
  const checkpointId = input.checkpointId ?? context.manifest.workspace.initialCheckpointId;
  const now = input.now ?? Date.now();
  const [capacity, counts] = await Promise.all([
    calculateWorkshopCapacity({
      organizationId: context.organizationId,
      manifest: context.manifest,
      checkpointId,
      now,
    }),
    env.DB.prepare(
      `SELECT
         count(*) FILTER (WHERE member.workspace_enabled = 1 AND member.checked_in_at IS NOT NULL) AS checked_in,
         count(*) FILTER (
           WHERE member.workspace_enabled = 1
             AND generation.runtime_execution_id IS NOT NULL
             AND generation.state IN ('queued', 'provisioning', 'ready')
         ) AS provisioned
       FROM workshop_session_members member
       LEFT JOIN workshop_workspaces workspace
         ON workspace.session_id = member.session_id
        AND workspace.user_id = member.user_id
       LEFT JOIN workshop_workspace_generations generation
         ON generation.id = workspace.current_generation_id
       WHERE member.session_id = ?`,
    )
      .bind(input.sessionId)
      .first<{ checked_in: number; provisioned: number }>(),
  ]);
  const checkedIn = counts?.checked_in ?? 0;
  const provisioned = counts?.provisioned ?? 0;
  const additionalRequired = Math.max(0, checkedIn - provisioned);
  return {
    ...capacity,
    seatsTotal: provisioned + capacity.seatsTotal,
    seatsAvailable: provisioned + capacity.seatsAvailable,
    seatsRequired: checkedIn,
    checkedIn,
    provisioned,
    imagesReady:
      additionalRequired === 0 || capacity.seatsAvailable >= additionalRequired,
  };
}

export async function selectWorkshopRuntimeHost(input: {
  organizationId: string;
  manifest: WorkshopManifestV2;
  checkpointId: string;
  now?: number;
  excludedHostIds?: readonly string[];
}): Promise<{ hostId: string; resources: WorkshopSeatResources }> {
  const capacity = await calculateWorkshopCapacity(input);
  const excluded = new Set(input.excludedHostIds ?? []);
  const candidate = capacity.runners
    .filter(
      (runner) =>
        !excluded.has(runner.hostId) &&
        runner.imagesReady &&
        runner.seatsAvailable > 0,
    )
    .sort((left, right) => {
      if (right.seatsAvailable !== left.seatsAvailable) {
        return right.seatsAvailable - left.seatsAvailable;
      }
      if (right.available.memoryMib !== left.available.memoryMib) {
        return right.available.memoryMib - left.available.memoryMib;
      }
      return left.hostId.localeCompare(right.hostId);
    })[0];
  if (candidate) {
    return { hostId: candidate.hostId, resources: capacity.seatResources };
  }
  const imageFailure = capacity.runners.some((runner) => !runner.imagesReady);
  throw imageFailure
    ? appError(
        409,
        "workshop_images_not_ready",
        "required workshop checkpoint images are not cached on an eligible runner",
      )
    : appError(
        409,
        "workshop_capacity_unavailable",
        "organization runners do not have enough CPU, memory, and worst-case disk capacity",
      );
}

export async function calculateWorkshopCapacity(input: {
  organizationId: string;
  manifest: WorkshopManifestV2;
  checkpointId: string;
  now?: number;
  /** Test seam for the final rollout gate. Production reads the Worker var. */
  requireRunCli?: boolean;
}): Promise<Omit<WorkshopCapacityPreflight, "checkedIn" | "provisioned" | "seatsRequired">> {
  const now = input.now ?? Date.now();
  const requireRunCli =
    input.requireRunCli ?? learnerRunCliV1EnforcementEnabled(env);
  const resources = workshopSeatResources(input.manifest);
  const requiredImages = checkpointImages(input.manifest, input.checkpointId);
  const hostRows = await env.DB.prepare(
    `SELECT
       host.id,
       host.connected,
       host.disabled,
       host.scenario_enabled,
       host.last_heartbeat_at,
       actual.updated_at AS actual_updated_at,
       actual.report_json
     FROM agent_hosts host
     LEFT JOIN host_actual_state actual ON actual.host_id = host.id
     WHERE host.organization_id = ? AND host.role = 'agent'
     ORDER BY host.id ASC`,
  )
    .bind(input.organizationId)
    .all<{
      id: string;
      connected: number | boolean;
      disabled: number | boolean;
      scenario_enabled: number | boolean;
      last_heartbeat_at: number | null;
      actual_updated_at: number | null;
      report_json: string | HostStateReportV2 | null;
    }>();
  const hosts: CandidateHost[] = hostRows.results.map((row) => ({
    id: row.id,
    connected: Boolean(row.connected),
    disabled: Boolean(row.disabled),
    scenarioEnabled: Boolean(row.scenario_enabled),
    lastHeartbeatAt: row.last_heartbeat_at,
    actualUpdatedAt: row.actual_updated_at,
    report: parseHostReport(row.report_json),
  }));
  const resourceSnapshot = await loadActiveRuntimeResourceSnapshot(now);
  const runners: WorkshopRunnerCapacity[] = [];
  const allocationFailures: WorkshopCapacityPreflight["allocationFailures"] = [];

  for (const host of hosts) {
    if (
      !isAvailableScenarioLaunchHost(
        {
          role: "agent",
          disabled: host.disabled,
          scenarioEnabled: host.scenarioEnabled,
          connected: host.connected,
          lastHeartbeatAt: host.lastHeartbeatAt,
        },
        now,
        HOST_HEARTBEAT_TTL_MS,
      )
    ) {
      allocationFailures.push({
        hostId: host.id,
        reason: "host_unavailable",
        detail: "runner is disabled, disconnected, or has a stale heartbeat",
      });
      continue;
    }
    if (!host.report || hostHealth(host.actualUpdatedAt, now) !== "healthy") {
      allocationFailures.push({
        hostId: host.id,
        reason: "host_report_stale",
        detail: "runner has no fresh bridge state report",
      });
      continue;
    }
    // Direct-cloud workshops use the workspace-agent path and never reach
    // this KVM host selector. A KVM learner workspace must have the broker
    // required by the in-guest `intar` command.
    if (requireRunCli && !hostSupportsRunCliV1(host.report)) {
      allocationFailures.push({
        hostId: host.id,
        reason: "runtime_capabilities_missing",
        detail: "runner does not support the learner run CLI",
      });
      continue;
    }
    const cpuCapacity = strictCpuCapacity(host.report);
    if (!cpuCapacity) {
      allocationFailures.push({
        hostId: host.id,
        reason: "runtime_capabilities_missing",
        detail: "runner does not attest the required v2 VM launch capabilities",
      });
      continue;
    }
    const available = availableRuntimeHostResources({
      hostId: host.id,
      report: host.report,
      snapshot: resourceSnapshot,
    });
    if (!available) {
      allocationFailures.push({
        hostId: host.id,
        reason: "runtime_capabilities_missing",
        detail: "runner does not attest the required v2 VM launch capabilities",
      });
      continue;
    }
    const imagesReady = hostHasImagesReady(host.report, requiredImages);
    const missingImageVmIds = requiredImages
      .filter((image) => !hostHasImagesReady(host.report, [image]))
      .map((image) => image.imageKey.vm);
    const seatsTotal = seatsFor(resources, available);
    const seatsAvailable = imagesReady ? seatsTotal : 0;
    runners.push({
      hostId: host.id,
      imagesReady,
      missingImageVmIds,
      seatsTotal,
      seatsAvailable,
      available,
    });
    if (!imagesReady) {
      allocationFailures.push({
        hostId: host.id,
        reason: "image_not_ready",
        detail: `checkpoint images are not ready for VM(s): ${missingImageVmIds.join(", ")}`,
      });
    } else if (seatsTotal === 0) {
      allocationFailures.push({
        hostId: host.id,
        reason: "insufficient_resources",
        detail: "runner cannot reserve one full learner workspace",
      });
    }
  }

  return {
    seatsTotal: runners.reduce((total, runner) => total + runner.seatsTotal, 0),
    seatsAvailable: runners.reduce(
      (total, runner) => total + runner.seatsAvailable,
      0,
    ),
    imagesReady: runners.some((runner) => runner.imagesReady),
    healthyRunners: runners.length,
    seatResources: resources,
    runners,
    allocationFailures,
  };
}

export function workshopSeatResources(
  manifest: WorkshopManifestV2,
): WorkshopSeatResources {
  const resources = manifest.workspace.vms.reduce<WorkshopSeatResources>(
    (total, vm) => ({
      cpuMillis: total.cpuMillis + vm.cpuMillis,
      memoryMib: total.memoryMib + vm.memoryMib,
      worstCaseDiskMib: total.worstCaseDiskMib + vm.diskMib,
    }),
    { cpuMillis: 0, memoryMib: 0, worstCaseDiskMib: 0 },
  );
  if (
    resources.cpuMillis <= 0 ||
    resources.memoryMib <= 0 ||
    resources.worstCaseDiskMib <= 0
  ) {
    throw appError(
      400,
      "workshop_workspace_resources_invalid",
      "workshop workspace resources must be positive",
    );
  }
  return resources;
}

export function checkpointImages(
  manifest: WorkshopManifestV2,
  checkpointId: string,
): RequiredScenarioImage[] {
  const checkpoint = manifest.workspace.checkpoints.find(
    (candidate) => candidate.id === checkpointId,
  );
  if (!checkpoint) {
    throw appError(
      404,
      "workshop_checkpoint_not_found",
      "workshop checkpoint not found",
    );
  }
  return checkpoint.vmImages.map((image) => ({
    imageKey: requireImageKey(image.imageKey, image.vmId),
    imageSha256: image.imageSha256,
  }));
}

function requireImageKey(value: Record<string, unknown>, vmId: string): ImageKey {
  if (
    typeof value.scenario !== "string" ||
    !value.scenario.trim() ||
    typeof value.vm !== "string" ||
    !value.vm.trim() ||
    (value.arch !== "x86_64" && value.arch !== "aarch64")
  ) {
    throw appError(
      409,
      "workshop_checkpoint_image_invalid",
      `checkpoint image for VM ${vmId} is not a sealed Intar image`,
    );
  }
  return { scenario: value.scenario, vm: value.vm, arch: value.arch };
}

function parseHostReport(
  value: string | HostStateReportV2 | null,
): HostStateReportV2 | null {
  if (!value) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as HostStateReportV2;
  } catch {
    return null;
  }
}

function seatsFor(
  required: WorkshopSeatResources,
  available: WorkshopSeatResources,
): number {
  return Math.max(
    0,
    Math.min(
      Math.floor(available.cpuMillis / required.cpuMillis),
      Math.floor(available.memoryMib / required.memoryMib),
      Math.floor(available.worstCaseDiskMib / required.worstCaseDiskMib),
    ),
  );
}
