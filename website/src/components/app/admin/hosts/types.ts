// DTO types for the operator hosts console. These mirror the /api/agent and
// /api/admin responses; extracted verbatim from the old Dashboard monolith.

import type { AgentBridgeStatus } from "@/lib/agent-bridge";
import type { HostHealth } from "@/lib/host-health";
import type { HostCapacityV1 } from "@/generated/bridge";

export interface AgentHostApi {
  id: string;
  name: string;
  role: "agent" | "builder";
  disabled: boolean;
  scenarioEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  status: AgentBridgeStatus | null;
  actualState: {
    appliedDesiredVersion: number;
    observedAt: number;
    health: HostHealth;
    capacity: HostCapacityV1;
  } | null;
}

export interface VmStatus {
  id: string;
  name: string;
  state: string;
  created_at: string;
  updated_at: string;
  error: string | null;
  run_id?: string | null;
  probe_state?: VmProbeState | null;
  terminal_target?: VmTerminalTargetReadiness | null;
  scenario_meta?: VmScenarioMeta | null;
  details?: {
    guest_ip?: string | null;
  } | null;
}

export interface VmProbeSummary {
  total: number;
  pass: number;
  fail: number;
  unknown: number;
}

export interface VmProbe {
  id: string;
  kind: string;
  status: string;
  every_seconds: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_duration_ms: number;
  error: string | null;
  value: unknown;
}

export interface VmProbeState {
  collection_state: string;
  collection_error: string | null;
  generated_at: string | null;
  updated_at: string | null;
  summary: VmProbeSummary;
  probes: VmProbe[];
}

export interface VmTerminalTargetReadiness {
  state: "pending" | "ready";
  reason: string | null;
  host: string | null;
  port: number;
  username: string;
  checkedAt: number;
}

export interface VmScenarioMeta {
  scenarioName: string;
  scenarioDescription: string;
  scenarioVmName: string;
  hostname: string;
  probePhaseMap: Record<string, "boot" | "scenario">;
}

export interface AgentVmRunEvent {
  id: string;
  kind: string;
  message: string | null;
  createdAt: number;
}

export interface AgentVmRunArtifact {
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

export interface AgentVmRunRecord {
  id: string;
  hostId: string;
  userId: string;
  vmName: string;
  state: string;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
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
  events: AgentVmRunEvent[];
  artifacts: AgentVmRunArtifact[];
  scenarioMeta?: VmScenarioMeta | null;
}

export interface HostRunsResponse {
  liveVms: VmStatus[];
  archivedRuns: AgentVmRunRecord[];
}

export interface AdminScenarioSummary {
  scenarioId: string;
  description: string;
  probeCount: number;
  vmCount: number;
  enabled: boolean;
  enabledAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AdminScenarioListResponse {
  scenarios: AdminScenarioSummary[];
}

export interface HostRecord {
  host: AgentHostApi;
  hostVms: VmStatus[];
  hostRuns: AgentVmRunRecord[];
  capacity: HostCapacityV1 | null;
}

export interface LiveScenarioRunRecord {
  host: AgentHostApi;
  vm: VmStatus;
}

export interface ArchivedScenarioRunRecord {
  host: AgentHostApi;
  run: AgentVmRunRecord;
}
