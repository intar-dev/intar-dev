import { env } from "cloudflare:workers";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import {
  agentHosts,
  hostActualState,
  scenarioRunArtifacts,
  scenarioRuns,
} from "@/db/schema";
import {
  buildStoredBridgeStatus,
  type AgentHostRow,
} from "@/lib/agent-bridge";
import type { HostCapacityV2 } from "@/generated/bridge";
import {
  deriveScenarioRunOutcome,
  deriveScenarioRunSolveDurationMs,
} from "@/lib/scenario-run-outcome";
import { parseObjectives, parseRunState } from "@/lib/scenario-runs/storage";
import {
  buildVerificationLabelMap,
  isVerificationPassed,
} from "@/lib/verification-copy";
import { hostHealth } from "@/lib/host-health";
import type {
  AgentHostApi,
  AgentVmRunArtifact,
  AgentVmRunEvent,
  AgentVmRunRecord,
  AgentVmRunSummary,
  HostRecord,
  VmScenarioMeta,
  VmStatus,
} from "@/components/app/admin/hosts/types";
import type { RunStateDocument } from "@/lib/run-state";

/**
 * The polling page reads/parses at most this many archive state documents.
 * Older pages are explicit operator requests, never part of the 3s poll.
 */
export const FLEET_ARCHIVE_SUMMARY_LIMIT = 100;

/**
 * Personal hosts are operationally few. Keep the fleet poll hard-bounded so
 * one unexpected account cannot turn the three-second dashboard poll into an
 * unbounded D1 read or browser payload.
 */
export const FLEET_HOST_LIMIT = 100;

/** Bound the full run-state JSON projection to the same fleet ceiling. */
export const FLEET_LIVE_RUN_LIMIT = FLEET_HOST_LIMIT;

const ARCHIVE_PHASES = ["archiving", "completed", "failed"];
const RUN_PHASES = [
  "queued",
  "provisioning",
  "active_partial",
  "active_full",
  "solved",
  "teardown_requested",
  "tearing_down",
  "archiving",
  "completed",
  "failed",
] as const;

export interface AdminFleetSnapshot {
  hostRecords: HostRecord[];
  /** Live run records carried by this bounded response. */
  liveLoadedCount: number;
  /** All live run records in the bounded host fleet. */
  liveTotalCount: number;
  /** All retained archive entries, not only the bounded summaries below. */
  archiveTotalCount: number;
  /** Offset of archive summaries in this response. The poll always uses zero. */
  archiveOffset: number;
  /** Null only after every retained archive summary has been loaded. */
  archiveNextOffset: number | null;
  hasMoreArchives: boolean;
  hasMoreLive: boolean;
}

interface FleetRunRow {
  runId: string;
  userId: string;
  hostId: string;
  title: string;
  tagline: string;
  objectivesJson: string;
  state: string;
  stateJson: string;
  deleteRequestedAt: number | null;
  solvedAt: number | null;
  failedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

interface FleetRunSource extends FleetRunRow {
  stateDocument: RunStateDocument;
  outcome: AgentVmRunSummary["outcome"];
}

interface ArtifactAggregate {
  artifactCount: number;
  pendingArtifactCount: number;
  uploadStartedAt: number | null;
  uploadCompletedAt: number | null;
}

const fleetRunFields = {
  runId: scenarioRuns.runId,
  userId: scenarioRuns.userId,
  hostId: scenarioRuns.hostId,
  title: scenarioRuns.title,
  tagline: scenarioRuns.tagline,
  objectivesJson: scenarioRuns.objectivesJson,
  state: scenarioRuns.state,
  stateJson: scenarioRuns.stateJson,
  deleteRequestedAt: scenarioRuns.deleteRequestedAt,
  solvedAt: scenarioRuns.solvedAt,
  failedAt: scenarioRuns.failedAt,
  createdAt: scenarioRuns.createdAt,
  updatedAt: scenarioRuns.updatedAt,
} as const;

/**
 * Read the operator dashboard in a fixed number of D1 queries. This is kept
 * separate from the old per-host routes so one browser poll never becomes a
 * fan-out of host or run queries.
 */
export async function loadAdminFleetSnapshot(params: {
  userId: string;
  d1?: D1Database;
  now?: number;
  archiveLimit?: number;
  archiveOffset?: number;
}): Promise<AdminFleetSnapshot> {
  const db = drizzle(params.d1 ?? env.DB);
  const now = params.now ?? Date.now();
  const archiveLimit = boundedArchiveLimit(params.archiveLimit);
  const archiveOffset = boundedArchiveOffset(params.archiveOffset);
  const fleetHostIds = boundedFleetHostIds(db, params.userId);

  const hostRows = await db
    .select({
      id: agentHosts.id,
      userId: agentHosts.userId,
      name: agentHosts.name,
      role: agentHosts.role,
      disabled: agentHosts.disabled,
      scenarioEnabled: agentHosts.scenarioEnabled,
      connected: agentHosts.connected,
      connectedAt: agentHosts.connectedAt,
      disconnectedAt: agentHosts.disconnectedAt,
      lastHeartbeatAt: agentHosts.lastHeartbeatAt,
      lastInventoryAt: agentHosts.lastInventoryAt,
      activeSessionId: agentHosts.activeSessionId,
      agentVersion: agentHosts.agentVersion,
      // Do the small JSON operation inside D1. Returning inventory_json would
      // transfer and parse every host's complete VM inventory on each poll.
      inventoryVmCount: sql<number>`case
        when ${agentHosts.inventoryJson} is null then 0
        when json_valid(${agentHosts.inventoryJson}) = 0 then 0
        when json_type(${agentHosts.inventoryJson}, '$.vms') <> 'array' then 0
        else coalesce(json_array_length(${agentHosts.inventoryJson}, '$.vms'), 0)
      end`,
      createdAt: agentHosts.createdAt,
      updatedAt: agentHosts.updatedAt,
      actualAppliedDesiredVersion: hostActualState.appliedDesiredVersion,
      actualObservedAt: hostActualState.observedAt,
      actualReportedAt: hostActualState.updatedAt,
      actualCapacityJson: sql<string | null>`case
        when ${hostActualState.reportJson} is null then null
        when json_valid(${hostActualState.reportJson}) = 0 then null
        when json_type(${hostActualState.reportJson}, '$.capacity') <> 'object' then null
        else json_extract(${hostActualState.reportJson}, '$.capacity')
      end`,
    })
    .from(agentHosts)
    .innerJoin(fleetHostIds, eq(fleetHostIds.id, agentHosts.id))
    .leftJoin(hostActualState, eq(hostActualState.hostId, agentHosts.id))
    .orderBy(desc(agentHosts.createdAt));

  if (!hostRows.length) {
    return emptyFleetSnapshot(archiveOffset);
  }

  const [liveRows, archiveRows, archiveCountRows, liveCountRows] =
    await Promise.all([
    db
      .select(fleetRunFields)
      .from(scenarioRuns)
      .innerJoin(fleetHostIds, eq(fleetHostIds.id, scenarioRuns.hostId))
      .where(
        and(
          eq(scenarioRuns.userId, params.userId),
          isNull(scenarioRuns.hiddenAt),
          notInArray(scenarioRuns.state, ARCHIVE_PHASES),
        ),
      )
      .orderBy(desc(scenarioRuns.updatedAt), desc(scenarioRuns.runId))
      .limit(FLEET_LIVE_RUN_LIMIT),
    db
      .select(fleetRunFields)
      .from(scenarioRuns)
      .innerJoin(fleetHostIds, eq(fleetHostIds.id, scenarioRuns.hostId))
      .where(
        and(
          eq(scenarioRuns.userId, params.userId),
          isNull(scenarioRuns.hiddenAt),
          inArray(scenarioRuns.state, ARCHIVE_PHASES),
        ),
      )
      .orderBy(desc(scenarioRuns.updatedAt), desc(scenarioRuns.runId))
      .limit(archiveLimit)
      .offset(archiveOffset),
    db
      .select({
        hostId: scenarioRuns.hostId,
        archiveCount: count(scenarioRuns.runId),
      })
      .from(scenarioRuns)
      .innerJoin(fleetHostIds, eq(fleetHostIds.id, scenarioRuns.hostId))
      .where(
        and(
          eq(scenarioRuns.userId, params.userId),
          isNull(scenarioRuns.hiddenAt),
          inArray(scenarioRuns.state, ARCHIVE_PHASES),
        ),
      )
      .groupBy(scenarioRuns.hostId),
    db
      .select({ liveCount: count(scenarioRuns.runId) })
      .from(scenarioRuns)
      .innerJoin(fleetHostIds, eq(fleetHostIds.id, scenarioRuns.hostId))
      .where(
        and(
          eq(scenarioRuns.userId, params.userId),
          isNull(scenarioRuns.hiddenAt),
          notInArray(scenarioRuns.state, ARCHIVE_PHASES),
        ),
      ),
  ]);

  const archiveSources = archiveRows
    .map(toFleetRunSource)
    .filter((run) => isArchivePhase(run.stateDocument.phase));
  const artifactAggregateByRun = await loadArtifactAggregates(
    db,
    archiveSources.map((run) => run.runId),
  );

  const liveVmsByHost = new Map<string, VmStatus[]>();
  for (const run of liveRows.map(toFleetRunSource)) {
    if (isArchivePhase(run.stateDocument.phase)) continue;
    const current = liveVmsByHost.get(run.hostId) ?? [];
    current.push(...buildLiveVms(run));
    liveVmsByHost.set(run.hostId, current);
  }

  const archiveRunsByHost = new Map<string, AgentVmRunSummary[]>();
  for (const run of archiveSources) {
    const current = archiveRunsByHost.get(run.hostId) ?? [];
    current.push(
      buildArchivedRunSummary(
        run,
        artifactAggregateByRun.get(run.runId) ?? emptyArtifactAggregate(),
      ),
    );
    archiveRunsByHost.set(run.hostId, current);
  }

  const archiveCountByHost = new Map(
    archiveCountRows.map((row) => [row.hostId, Number(row.archiveCount)]),
  );
  const archiveTotalCount = [...archiveCountByHost.values()].reduce(
    (total, value) => total + value,
    0,
  );
  const liveTotalCount = Number(liveCountRows[0]?.liveCount ?? 0);
  const archiveNextOffset =
    archiveOffset + archiveRows.length < archiveTotalCount
      ? archiveOffset + archiveRows.length
      : null;

  return {
    liveLoadedCount: liveRows.length,
    liveTotalCount,
    archiveTotalCount,
    archiveOffset,
    archiveNextOffset,
    hasMoreArchives: archiveNextOffset !== null,
    hasMoreLive: liveTotalCount > FLEET_LIVE_RUN_LIMIT,
    hostRecords: hostRows.map((row) => {
      const host = serializeFleetHost(row, now);
      return {
        host,
        hostVms: liveVmsByHost.get(host.id) ?? [],
        hostRuns: archiveRunsByHost.get(host.id) ?? [],
        archiveTotalCount: archiveCountByHost.get(host.id) ?? 0,
        capacity: host.actualState?.capacity ?? null,
      } satisfies HostRecord;
    }),
  };
}

/** Load the rich artifacts and event timeline only after an archive opens. */
export async function loadAdminFleetArchivedRunDetail(params: {
  userId: string;
  runId: string;
  hostId?: string | null;
  d1?: D1Database;
}): Promise<AgentVmRunRecord | null> {
  const db = drizzle(params.d1 ?? env.DB);
  const fleetHostIds = boundedFleetHostIds(db, params.userId);
  const rows = await db
    .select(fleetRunFields)
    .from(scenarioRuns)
    .innerJoin(fleetHostIds, eq(fleetHostIds.id, scenarioRuns.hostId))
    .where(
      and(
        eq(scenarioRuns.userId, params.userId),
        eq(scenarioRuns.runId, params.runId),
        isNull(scenarioRuns.hiddenAt),
        inArray(scenarioRuns.state, ARCHIVE_PHASES),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row || (params.hostId && row.hostId !== params.hostId)) {
    return null;
  }

  const source = toFleetRunSource(row);
  if (!isArchivePhase(source.stateDocument.phase)) {
    return null;
  }

  const [artifactAggregateByRun, artifactsByRun] = await Promise.all([
    loadArtifactAggregates(db, [source.runId]),
    loadArchivedArtifacts(db, [source]),
  ]);
  const aggregate =
    artifactAggregateByRun.get(source.runId) ?? emptyArtifactAggregate();
  const summary = buildArchivedRunSummary(source, aggregate);
  const artifacts = artifactsByRun.get(source.runId) ?? [];

  return {
    ...summary,
    artifacts,
    events: buildArchivedRunEvents(source, artifacts, summary.uploadCompletedAt),
  };
}

function personalActiveHostScope(userId: string) {
  return and(
    eq(agentHosts.userId, userId),
    isNull(agentHosts.organizationId),
    eq(agentHosts.disabled, false),
  );
}

function boundedFleetHostIds(
  db: ReturnType<typeof drizzle>,
  userId: string,
) {
  return db
    .select({ id: agentHosts.id })
    .from(agentHosts)
    .where(personalActiveHostScope(userId))
    .orderBy(desc(agentHosts.createdAt))
    .limit(FLEET_HOST_LIMIT)
    .as("fleet_host_ids");
}

function serializeFleetHost(
  row: {
    id: string;
    userId: string;
    name: string;
    role: AgentHostRow["role"];
    disabled: boolean;
    scenarioEnabled: boolean;
    connected: boolean;
    connectedAt: number | null;
    disconnectedAt: number | null;
    lastHeartbeatAt: number | null;
    lastInventoryAt: number | null;
    activeSessionId: string | null;
    agentVersion: string | null;
    inventoryVmCount: number | null;
    createdAt: number;
    updatedAt: number;
    actualAppliedDesiredVersion: number | null;
    actualObservedAt: number | null;
    actualReportedAt: number | null;
    actualCapacityJson: string | null;
  },
  now: number,
): AgentHostApi {
  const hostRow: AgentHostRow = {
    id: row.id,
    user_id: row.userId,
    name: row.name,
    role: row.role,
    disabled: row.disabled,
    scenario_enabled: row.scenarioEnabled,
    connected: row.connected,
    connected_at: row.connectedAt,
    disconnected_at: row.disconnectedAt,
    last_heartbeat_at: row.lastHeartbeatAt,
    last_inventory_at: row.lastInventoryAt,
    active_session_id: row.activeSessionId,
    agent_version: row.agentVersion,
    // The fleet query deliberately does not select the full inventory JSON.
    inventory_json: null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  const capacity = parseHostCapacityJson(row.actualCapacityJson);
  const actualState =
    capacity &&
    row.actualAppliedDesiredVersion !== null &&
    row.actualObservedAt !== null
      ? {
          appliedDesiredVersion: row.actualAppliedDesiredVersion,
          observedAt: row.actualObservedAt,
          health: hostHealth(row.actualReportedAt, now),
          capacity,
        }
      : null;

  return {
    id: row.id,
    name: row.name,
    role: row.role,
    disabled: row.disabled,
    scenarioEnabled: row.scenarioEnabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    status: buildStoredBridgeStatus(hostRow, numberOrZero(row.inventoryVmCount)),
    actualState,
  };
}

function parseHostCapacityJson(value: string | null): HostCapacityV2 | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isHostCapacity(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isHostCapacity(value: unknown): value is HostCapacityV2 {
  if (!isRecord(value)) return false;
  for (const key of [
    "total_cpu_millis",
    "reserved_cpu_millis",
    "schedulable_cpu_millis",
    "committed_cpu_millis",
    "memory_total_mib",
    "memory_available_mib",
    "disk_total_mib",
    "disk_available_mib",
  ] as const) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      return false;
    }
  }
  if (typeof value.disk_probe_path !== "string") return false;
  return (
    isOptionalNullableNumber(value.load_avg_1m) &&
    isOptionalNullableNumber(value.load_avg_5m) &&
    isOptionalNullableNumber(value.load_avg_15m) &&
    isOptionalNullableString(value.primary_ipv4) &&
    isOptionalNullableString(value.primary_ipv6)
  );
}

function isOptionalNullableNumber(value: unknown) {
  return value === undefined || value === null || typeof value === "number";
}

function isOptionalNullableString(value: unknown) {
  return value === undefined || value === null || typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFleetRunSource(row: FleetRunRow): FleetRunSource {
  const parsedStateDocument = parseRunState(row.stateJson);
  const stateDocument = isRunPhase(row.state)
    ? parsedStateDocument.phase === row.state
      ? parsedStateDocument
      : { ...parsedStateDocument, phase: row.state }
    : parsedStateDocument;
  return {
    ...row,
    stateDocument,
    outcome: deriveScenarioRunOutcome({
      phase: stateDocument.phase,
      solvedAt: row.solvedAt,
      deleteRequestedAt: row.deleteRequestedAt,
      failedAt: row.failedAt,
    }),
  };
}

function buildLiveVms(run: FleetRunSource): VmStatus[] {
  const objectives = parseObjectives(run.objectivesJson);
  return run.stateDocument.vms
    .filter((vm) => vm.phase !== "archived" && vm.phase !== "completed")
    .map((vm) => {
      const terminalReady = hasVmTerminalReady(vm);
      return {
        id: vm.id,
        name: vm.runtimeVmName,
        state: dashboardVmState(vm.phase, terminalReady),
        created_at: new Date(vm.vmCreatedAt ?? run.createdAt).toISOString(),
        updated_at: new Date(run.updatedAt).toISOString(),
        error: vm.phase === "failed" ? vm.phaseDetail : null,
        run_id: run.runId,
        probe_state: buildProbeState(run, vm),
        terminal_target: {
          state: terminalReady ? "ready" : "pending",
          reason: terminalReady ? null : vm.phaseDetail,
          host: terminalReady ? vm.terminalTarget.host : null,
          port: terminalReady ? vm.terminalTarget.port : 22,
          username: vm.terminalTarget.username,
          checkedAt: terminalReady
            ? (vm.terminalTarget.checkedAt ?? run.updatedAt)
            : run.updatedAt,
        },
        scenario_meta: {
          scenarioName: run.title,
          scenarioDescription: run.tagline,
          scenarioVmName: vm.scenarioVmName,
          hostname: vm.hostname,
          probePhaseMap: Object.fromEntries([
            ...vm.bootProbes.map((probe) => [probe.id, "boot"] as const),
            ...vm.scenarioProbes.map(
              (probe) => [probe.id, "scenario"] as const,
            ),
          ]),
          checkLabelMap: buildVerificationLabelMap({
            bootProbeIds: vm.bootProbes.map((probe) => probe.id),
            scenarioProbeIds: vm.scenarioProbes.map((probe) => probe.id),
            objectives,
          }),
        },
        details: { guest_ip: readString(vm.guestIp) },
      } satisfies VmStatus;
    });
}

function buildArchivedRunSummary(
  run: FleetRunSource,
  aggregate: ArtifactAggregate,
): AgentVmRunSummary {
  const vmCreatedAt = run.stateDocument.vms
    .map((vm) => vm.vmCreatedAt)
    .filter((value): value is number => typeof value === "number");
  const uploadCompletedAt =
    aggregate.uploadCompletedAt ??
    (run.stateDocument.phase === "completed" ? run.updatedAt : null);
  const uploadStartedAt =
    aggregate.uploadStartedAt ??
    (aggregate.artifactCount > 0 ? run.updatedAt : null);
  const summary = {
    id: run.runId,
    hostId: run.hostId,
    userId: run.userId,
    vmName:
      run.stateDocument.vms.map((vm) => vm.runtimeVmName).join(", ") ||
      run.runId,
    state: run.stateDocument.phase,
    outcome: run.outcome,
    solvedAt: run.solvedAt,
    solveDurationMs: deriveScenarioRunSolveDurationMs({
      createdAt: run.createdAt,
      solvedAt: run.solvedAt,
    }),
    uploadStatus: deriveUploadStatus(
      run.stateDocument.phase,
      aggregate.pendingArtifactCount,
    ),
    vmCreatedAt: vmCreatedAt.length ? Math.min(...vmCreatedAt) : run.createdAt,
    deleteRequestedAt: null,
    deletedAt: isTerminalArchivePhase(run.stateDocument.phase)
      ? run.updatedAt
      : null,
    uploadStartedAt,
    uploadCompletedAt,
    uploadError:
      run.stateDocument.phase === "failed"
        ? run.stateDocument.phaseDetail
        : null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    artifactCount: aggregate.artifactCount,
    eventCount: 0,
    scenarioMeta: buildScenarioMeta(run),
  } satisfies Omit<AgentVmRunSummary, "eventCount"> & { eventCount: number };
  return {
    ...summary,
    eventCount: archivedRunEventCount(run, summary),
  };
}

function buildScenarioMeta(run: FleetRunSource): VmScenarioMeta {
  return {
    scenarioName: run.title,
    scenarioDescription: run.tagline,
    scenarioVmName:
      run.stateDocument.vms.map((vm) => vm.scenarioVmName).join(", ") ||
      "Scenario VM",
    hostname: run.stateDocument.vms.map((vm) => vm.hostname).join(", "),
    probePhaseMap: {},
    checkLabelMap: {},
  };
}

async function loadArtifactAggregates(
  db: ReturnType<typeof drizzle>,
  runIds: string[],
): Promise<Map<string, ArtifactAggregate>> {
  if (!runIds.length) return new Map();
  const rows = await db
    .select({
      runId: scenarioRunArtifacts.runId,
      artifactCount: count(scenarioRunArtifacts.id),
      pendingArtifactCount: sql<number>`sum(case when ${scenarioRunArtifacts.uploadStatus} <> 'uploaded' then 1 else 0 end)`,
      uploadStartedAt: sql<number | null>`min(${scenarioRunArtifacts.uploadedAt})`,
      uploadCompletedAt: sql<number | null>`max(${scenarioRunArtifacts.uploadedAt})`,
    })
    .from(scenarioRunArtifacts)
    .where(inArray(scenarioRunArtifacts.runId, runIds))
    .groupBy(scenarioRunArtifacts.runId);
  return new Map(
    rows.map((row) => [
      row.runId,
      {
        artifactCount: Number(row.artifactCount),
        pendingArtifactCount: Number(row.pendingArtifactCount ?? 0),
        uploadStartedAt: numberOrNull(row.uploadStartedAt),
        uploadCompletedAt: numberOrNull(row.uploadCompletedAt),
      },
    ]),
  );
}

async function loadArchivedArtifacts(
  db: ReturnType<typeof drizzle>,
  runs: FleetRunSource[],
): Promise<Map<string, AgentVmRunArtifact[]>> {
  if (!runs.length) return new Map();
  const rows = await db
    .select({
      id: scenarioRunArtifacts.id,
      runId: scenarioRunArtifacts.runId,
      vmId: scenarioRunArtifacts.vmId,
      ordinal: scenarioRunArtifacts.ordinal,
      kind: scenarioRunArtifacts.kind,
      filename: scenarioRunArtifacts.filename,
      contentType: scenarioRunArtifacts.contentType,
      sizeBytes: scenarioRunArtifacts.sizeBytes,
      sha256: scenarioRunArtifacts.sha256,
      uploadStatus: scenarioRunArtifacts.uploadStatus,
      uploadedAt: scenarioRunArtifacts.uploadedAt,
    })
    .from(scenarioRunArtifacts)
    .where(inArray(scenarioRunArtifacts.runId, runs.map((run) => run.runId)))
    .orderBy(
      asc(scenarioRunArtifacts.runId),
      asc(scenarioRunArtifacts.vmId),
      asc(scenarioRunArtifacts.ordinal),
    );
  const runsById = new Map(runs.map((run) => [run.runId, run]));
  const artifactsByRun = new Map<string, AgentVmRunArtifact[]>();
  for (const row of rows) {
    const run = runsById.get(row.runId);
    if (!run) continue;
    const vm = run.stateDocument.vms.find((candidate) => candidate.id === row.vmId);
    const next = artifactsByRun.get(row.runId) ?? [];
    next.push({
      id: row.id,
      ordinal: next.length + 1,
      kind: row.kind,
      filename:
        run.stateDocument.vms.length > 1 && vm
          ? `${vm.scenarioVmName}: ${row.filename}`
          : row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      uploadStatus: row.uploadStatus,
      uploadedAt: row.uploadedAt,
    });
    artifactsByRun.set(row.runId, next);
  }
  return artifactsByRun;
}

function buildArchivedRunEvents(
  run: FleetRunSource,
  artifacts: AgentVmRunArtifact[],
  uploadCompletedAt: number | null,
): AgentVmRunEvent[] {
  const events: AgentVmRunEvent[] = [
    {
      id: `${run.runId}:created`,
      kind: "scenario.run.created",
      message: `Started ${run.title}.`,
      createdAt: run.createdAt,
    },
  ];
  if (run.outcome === "succeeded") {
    events.push({
      id: `${run.runId}:solved`,
      kind: "scenario.run.solved",
      message: "Scenario objectives completed.",
      createdAt: run.solvedAt ?? run.updatedAt,
    });
  }
  if (run.outcome === "cancelled") {
    events.push({
      id: `${run.runId}:cancelled`,
      kind: "scenario.run.cancelled",
      message: "Scenario run was cancelled before completion.",
      createdAt: run.updatedAt,
    });
  }
  if (run.stateDocument.phase === "archiving") {
    events.push({
      id: `${run.runId}:archiving`,
      kind: "scenario.vm.archive.started",
      message: "Archive upload started.",
      createdAt: run.updatedAt,
    });
  }
  for (const artifact of artifacts) {
    events.push({
      id: `${run.runId}:artifact:${artifact.id}`,
      kind: "scenario.vm.artifact.uploaded",
      message: `${artifact.filename} uploaded.`,
      createdAt: artifact.uploadedAt ?? run.updatedAt,
    });
  }
  if (run.stateDocument.phase === "completed" && uploadCompletedAt !== null) {
    events.push({
      id: `${run.runId}:completed`,
      kind: "scenario.vm.archive.completed",
      message: "Archive upload completed.",
      createdAt: uploadCompletedAt,
    });
  }
  if (run.stateDocument.phase === "failed") {
    events.push({
      id: `${run.runId}:failed`,
      kind: "scenario.run.failed",
      message: run.stateDocument.phaseDetail,
      createdAt: run.updatedAt,
    });
  }
  return events.sort((left, right) => left.createdAt - right.createdAt);
}

function buildProbeState(
  run: FleetRunSource,
  vm: RunStateDocument["vms"][number],
): NonNullable<VmStatus["probe_state"]> | null {
  const probes = [...vm.bootProbes, ...vm.scenarioProbes];
  if (!probes.length || !hasReportedProbeResults(probes)) return null;
  const summary = {
    total: probes.length,
    pass: probes.filter((probe) => isVerificationPassed(probe.status)).length,
    fail: probes.filter(
      (probe) => probe.status.trim().toLowerCase() === "fail",
    ).length,
    unknown: probes.filter(
      (probe) =>
        !isVerificationPassed(probe.status) &&
        probe.status.trim().toLowerCase() !== "fail",
    ).length,
  };
  return {
    collection_state: "ready",
    collection_error: null,
    generated_at: new Date(run.updatedAt).toISOString(),
    updated_at: new Date(run.updatedAt).toISOString(),
    summary,
    probes: probes.map((probe) => ({
      id: probe.id,
      kind: probe.kind,
      status: probe.status,
      every_seconds: 0,
      last_attempt_at: null,
      last_success_at: null,
      last_duration_ms: 0,
      error: probe.error,
      value: probe.value,
    })),
  };
}

function archivedRunEventCount(
  run: FleetRunSource,
  summary: Pick<
    AgentVmRunSummary,
    "artifactCount" | "uploadCompletedAt"
  >,
): number {
  let count = 1 + summary.artifactCount;
  if (run.outcome === "succeeded" || run.outcome === "cancelled") count += 1;
  if (run.stateDocument.phase === "archiving") count += 1;
  if (
    run.stateDocument.phase === "completed" &&
    summary.uploadCompletedAt !== null
  ) {
    count += 1;
  }
  if (run.stateDocument.phase === "failed") count += 1;
  return count;
}

function deriveUploadStatus(
  phase: RunStateDocument["phase"],
  pendingArtifactCount: number,
) {
  if (phase === "archiving") return "uploading";
  if (phase === "failed") return "failed";
  return pendingArtifactCount > 0 ? "uploading" : "complete";
}

function dashboardVmState(
  phase: RunStateDocument["vms"][number]["phase"],
  terminalReady: boolean,
) {
  switch (phase) {
    case "queued":
    case "launching":
      return "launching";
    case "booting":
      return "booting";
    case "ready":
      return terminalReady ? "running" : "waiting_for_target";
    case "destroying":
      return "deleting";
    case "archived":
      return "archiving";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "solved":
      return "running";
  }
}

function hasVmTerminalReady(vm: RunStateDocument["vms"][number]) {
  return (
    (vm.phase === "ready" || vm.phase === "solved") &&
    vm.terminalPhase === "ready" &&
    vm.canOpenTerminal === true &&
    Boolean(vm.terminalTarget.host && vm.terminalTarget.port > 0)
  );
}

function hasReportedProbeResults(
  probes: Array<{ status: string; error: string | null; value: unknown }>,
) {
  return probes.some((probe) => {
    const status = readString(probe.status);
    const error = readString(probe.error);
    return status !== null && status !== "pending"
      ? true
      : Boolean(error || probe.value !== null);
  });
}

function isArchivePhase(phase: RunStateDocument["phase"]) {
  return ARCHIVE_PHASES.includes(phase);
}

function isRunPhase(value: string): value is RunStateDocument["phase"] {
  return RUN_PHASES.includes(value as (typeof RUN_PHASES)[number]);
}

function isTerminalArchivePhase(phase: RunStateDocument["phase"]) {
  return phase === "completed" || phase === "failed";
}

function emptyArtifactAggregate(): ArtifactAggregate {
  return {
    artifactCount: 0,
    pendingArtifactCount: 0,
    uploadStartedAt: null,
    uploadCompletedAt: null,
  };
}

function boundedArchiveLimit(value: number | undefined) {
  if (!Number.isFinite(value)) return FLEET_ARCHIVE_SUMMARY_LIMIT;
  return Math.min(
    FLEET_ARCHIVE_SUMMARY_LIMIT,
    Math.max(1, Math.floor(value ?? FLEET_ARCHIVE_SUMMARY_LIMIT)),
  );
}

function boundedArchiveOffset(value: number | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

function emptyFleetSnapshot(archiveOffset: number): AdminFleetSnapshot {
  return {
    hostRecords: [],
    liveLoadedCount: 0,
    liveTotalCount: 0,
    archiveTotalCount: 0,
    archiveOffset,
    archiveNextOffset: null,
    hasMoreArchives: false,
    hasMoreLive: false,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
  return numberOrNull(value) ?? 0;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
