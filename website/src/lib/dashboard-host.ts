import { env } from "cloudflare:workers";
import { asc, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { scenarioRunArtifacts, scenarioRunSshKeys } from "@/db/schema";
import type { AgentHostRow } from "@/lib/agent-bridge";
import { listHostRunsForUser, type ScenarioRunRecord } from "@/lib/scenario-runs";

export interface DashboardVmProbeState {
  collection_state: string;
  collection_error: string | null;
  generated_at: string | null;
  updated_at: string | null;
  summary: {
    total: number;
    pass: number;
    fail: number;
    unknown: number;
  };
  probes: Array<{
    id: string;
    kind: string;
    status: string;
    every_seconds: number;
    last_attempt_at: string | null;
    last_success_at: string | null;
    last_duration_ms: number;
    error: string | null;
    value: unknown;
  }>;
}

export interface DashboardVmScenarioMeta {
  scenarioName: string;
  scenarioDescription: string;
  scenarioVmName: string;
  hostname: string;
  probePhaseMap: Record<string, "boot" | "scenario">;
}

export interface DashboardVmStatus {
  id: string;
  name: string;
  state: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  run_id: string | null;
  probe_state: DashboardVmProbeState | null;
  terminal_target: {
    state: "pending" | "ready";
    reason: string | null;
    host: string | null;
    port: number;
    username: string;
    checkedAt: number;
  } | null;
  scenario_meta: DashboardVmScenarioMeta | null;
  details: {
    guest_ip: string | null;
    ssh_authorized_key_openssh: string | null;
  } | null;
}

export interface DashboardRunArtifact {
  id: string;
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadStatus: string;
  uploadedAt: number | null;
}

export interface DashboardRunEvent {
  id: string;
  kind: string;
  message: string | null;
  createdAt: number;
}

export interface DashboardArchivedRun {
  id: string;
  hostId: string;
  userId: string;
  vmName: string;
  state: string;
  outcome: ScenarioRunRecord["outcome"];
  solvedAt: number | null;
  solveDurationMs: number | null;
  uploadStatus: string;
  vmCreatedAt: number;
  deleteRequestedAt: number | null;
  deletedAt: number | null;
  uploadStartedAt: number | null;
  uploadCompletedAt: number | null;
  uploadError: string | null;
  createdAt: number;
  updatedAt: number;
  events: DashboardRunEvent[];
  artifacts: DashboardRunArtifact[];
  scenarioMeta: DashboardVmScenarioMeta | null;
}

export async function loadDashboardHostRuns(params: {
  host: AgentHostRow;
  userId: string;
}): Promise<{
  liveVms: DashboardVmStatus[];
  archivedRuns: DashboardArchivedRun[];
}> {
  const runs = await listHostRunsForUser({
    hostId: params.host.id,
    userId: params.userId,
  });

  const liveRuns = runs.filter((run) => !isArchivePhase(run.phase));
  const archivedRuns = runs.filter((run) => isArchivePhase(run.phase));
  const sshKeysByRunVmId = await loadScenarioRunPublicKeys(
    liveRuns.map((run) => run.id),
  );

  return {
    liveVms: liveRuns.flatMap((run) =>
      run.vms
        .filter((vm) => vm.phase !== "archived" && vm.phase !== "completed")
        .map((vm) => {
          const probeState = buildProbeState(run, vm);
          const terminalReady = hasVmTerminalReady(vm);
          return {
            id: vm.id,
            name: vm.runtimeVmName,
            state: dashboardVmState(vm.phase, terminalReady),
            created_at: new Date(vm.vmCreatedAt ?? run.createdAt).toISOString(),
            updated_at: new Date(run.updatedAt).toISOString(),
            error: vm.phase === "failed" ? vm.phaseDetail : null,
            run_id: run.id,
            probe_state: probeState,
            terminal_target: {
              state: terminalReady ? "ready" : "pending",
              reason: terminalReady ? null : vm.phaseDetail,
              // Gate serialized routing data independently of stored state so
              // a legacy pending document cannot leak its reserved endpoint.
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
            },
            details: {
              guest_ip: readString(vm.guestIp),
              ssh_authorized_key_openssh:
                sshKeysByRunVmId.get(runVmKey(run.id, vm.id)) ?? null,
            },
          } satisfies DashboardVmStatus;
        }),
    ),
    archivedRuns: await hydrateArchivedRuns({
      hostId: params.host.id,
      userId: params.userId,
      runs: archivedRuns,
    }),
  };
}

async function loadScenarioRunPublicKeys(
  runIds: string[],
): Promise<Map<string, string>> {
  if (!runIds.length) {
    return new Map();
  }
  const db = drizzle(env.DB);
  const rows = await db
    .select({
      runId: scenarioRunSshKeys.runId,
      vmId: scenarioRunSshKeys.vmId,
      publicKeyOpenssh: scenarioRunSshKeys.publicKeyOpenssh,
    })
    .from(scenarioRunSshKeys)
    .where(inArray(scenarioRunSshKeys.runId, runIds));
  return new Map(
    rows.map((row) => [
      runVmKey(row.runId, row.vmId),
      row.publicKeyOpenssh,
    ]),
  );
}

function runVmKey(runId: string, vmId: string): string {
  return `${runId}\0${vmId}`;
}

async function hydrateArchivedRuns(params: {
  hostId: string;
  userId: string;
  runs: ScenarioRunRecord[];
}): Promise<DashboardArchivedRun[]> {
  if (!params.runs.length) {
    return [];
  }

  const db = drizzle(env.DB);
  const artifactRows = await db
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
    .where(inArray(scenarioRunArtifacts.runId, params.runs.map((run) => run.id)))
    .orderBy(
      asc(scenarioRunArtifacts.runId),
      asc(scenarioRunArtifacts.vmId),
      asc(scenarioRunArtifacts.ordinal),
    );

  const artifactsByRun = new Map<string, DashboardRunArtifact[]>();
  for (const row of artifactRows) {
    const run = params.runs.find((candidate) => candidate.id === row.runId);
    const multipleVms = (run?.vms.length ?? 0) > 1;
    const vm = run?.vms.find((candidate) => candidate.id === row.vmId) ?? null;
    const next = artifactsByRun.get(row.runId) ?? [];
    next.push({
      id: row.id,
      ordinal: next.length + 1,
      kind: row.kind,
      filename:
        multipleVms && vm ? `${vm.scenarioVmName}: ${row.filename}` : row.filename,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      sha256: row.sha256,
      uploadStatus: row.uploadStatus,
      uploadedAt: row.uploadedAt,
    });
    artifactsByRun.set(row.runId, next);
  }

  return params.runs.map((run) => {
    const artifacts = artifactsByRun.get(run.id) ?? [];
    const vmNames = run.vms.map((vm) => vm.runtimeVmName);
    const scenarioVmNames = run.vms.map((vm) => vm.scenarioVmName);
    const vmCreatedAt = run.vms
      .map((vm) => vm.vmCreatedAt)
      .filter((value): value is number => typeof value === "number");
    const uploadCompletedAt =
      artifacts
        .map((artifact) => artifact.uploadedAt)
        .filter((value): value is number => typeof value === "number")
        .sort((left, right) => right - left)[0] ??
      (run.phase === "completed" ? run.updatedAt : null);
    const uploadStartedAt =
      artifacts
        .map((artifact) => artifact.uploadedAt ?? run.updatedAt)
        .sort((left, right) => left - right)[0] ?? null;

    return {
      id: run.id,
      hostId: params.hostId,
      userId: params.userId,
      vmName: vmNames.join(", ") || run.id,
      state: run.phase,
      outcome: run.outcome,
      solvedAt: run.solvedAt,
      solveDurationMs: run.solveDurationMs,
      uploadStatus: deriveUploadStatus(run.phase, artifacts),
      vmCreatedAt: vmCreatedAt.length ? Math.min(...vmCreatedAt) : run.createdAt,
      deleteRequestedAt: null,
      deletedAt:
        run.phase === "completed" || run.phase === "failed" ? run.updatedAt : null,
      uploadStartedAt,
      uploadCompletedAt,
      uploadError: run.phase === "failed" ? run.phaseDetail : null,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      events: buildArchivedRunEvents(run, artifacts, uploadCompletedAt),
      artifacts,
      scenarioMeta: {
        scenarioName: run.title,
        scenarioDescription: run.tagline,
        scenarioVmName: scenarioVmNames.join(", ") || "Scenario VM",
        hostname: run.vms.map((vm) => vm.hostname).join(", "),
        probePhaseMap: {},
      },
    } satisfies DashboardArchivedRun;
  });
}

function buildArchivedRunEvents(
  run: ScenarioRunRecord,
  artifacts: DashboardRunArtifact[],
  uploadCompletedAt: number | null,
): DashboardRunEvent[] {
  const events: DashboardRunEvent[] = [
    {
      id: `${run.id}:created`,
      kind: "scenario.run.created",
      message: `Started ${run.title}.`,
      createdAt: run.createdAt,
    },
  ];

  if (run.outcome === "succeeded") {
    events.push({
      id: `${run.id}:solved`,
      kind: "scenario.run.solved",
      message: "Scenario objectives completed.",
      createdAt: run.solvedAt ?? run.updatedAt,
    });
  }

  if (run.outcome === "cancelled") {
    events.push({
      id: `${run.id}:cancelled`,
      kind: "scenario.run.cancelled",
      message: "Scenario run was cancelled before completion.",
      createdAt: run.updatedAt,
    });
  }

  if (run.phase === "archiving") {
    events.push({
      id: `${run.id}:archiving`,
      kind: "scenario.vm.archive.started",
      message: "Archive upload started.",
      createdAt: run.updatedAt,
    });
  }

  for (const artifact of artifacts) {
    events.push({
      id: `${run.id}:artifact:${artifact.id}`,
      kind: "scenario.vm.artifact.uploaded",
      message: `${artifact.filename} uploaded.`,
      createdAt: artifact.uploadedAt ?? run.updatedAt,
    });
  }

  if (run.phase === "completed" && uploadCompletedAt !== null) {
    events.push({
      id: `${run.id}:completed`,
      kind: "scenario.vm.archive.completed",
      message: "Archive upload completed.",
      createdAt: uploadCompletedAt,
    });
  }

  if (run.phase === "failed") {
    events.push({
      id: `${run.id}:failed`,
      kind: "scenario.run.failed",
      message: run.phaseDetail,
      createdAt: run.updatedAt,
    });
  }

  return events.sort((left, right) => left.createdAt - right.createdAt);
}

function buildProbeState(
  run: ScenarioRunRecord,
  vm: ScenarioRunRecord["vms"][number],
): DashboardVmProbeState | null {
  const probes = [...vm.bootProbes, ...vm.scenarioProbes];
  if (!probes.length || !hasReportedProbeResults(probes)) {
    return null;
  }

  return {
    collection_state: vm.phase === "failed" ? "error" : "ready",
    collection_error: vm.phase === "failed" ? vm.phaseDetail : null,
    generated_at: new Date(run.updatedAt).toISOString(),
    updated_at: new Date(run.updatedAt).toISOString(),
    summary: {
      total: probes.length,
      pass: probes.filter((probe) => probe.status === "pass").length,
      fail: probes.filter((probe) => probe.status === "fail").length,
      unknown: probes.filter((probe) => probe.status !== "pass" && probe.status !== "fail")
        .length,
    },
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


function dashboardVmState(
  phase: ScenarioRunRecord["vms"][number]["phase"],
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

function deriveUploadStatus(
  phase: ScenarioRunRecord["phase"],
  artifacts: DashboardRunArtifact[],
) {
  if (phase === "archiving") {
    return "uploading";
  }
  if (
    phase === "completed" &&
    artifacts.every((artifact) => artifact.uploadStatus === "uploaded")
  ) {
    return "complete";
  }
  if (phase === "failed") {
    return "failed";
  }
  return artifacts.some((artifact) => artifact.uploadStatus !== "uploaded")
    ? "uploading"
    : "complete";
}

function isArchivePhase(phase: ScenarioRunRecord["phase"]) {
  return phase === "archiving" || phase === "completed" || phase === "failed";
}

function hasVmTerminalReady(vm: ScenarioRunRecord["vms"][number]) {
  return (
    (vm.phase === "ready" || vm.phase === "solved") &&
    vm.terminalPhase === "ready" &&
    vm.canOpenTerminal === true &&
    Boolean(vm.terminalTarget.host && vm.terminalTarget.port > 0)
  );
}

function hasReportedProbeResults(
  probes: Array<
    | { status: string; error: string | null; value: unknown }
    | Record<string, unknown>
  >,
) {
  return probes.some((probe) => {
    const status = readString(probe.status);
    const error = readString(probe.error);
    const value = probe.value;
    return status !== null && status !== "pending"
      ? true
      : Boolean(error || value !== null);
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
