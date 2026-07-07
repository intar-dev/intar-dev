// Wire/view types for the scenario run page. These mirror the presented run
// record shape produced by lib/run-phase's presentScenarioRun.

import type { RunVmProvisioningSpec } from "@/lib/run-state";

export interface ScenarioProbeStatus {
  id: string;
  label: string;
  kind: string;
  phase: "boot" | "scenario";
  status: string;
  error: string | null;
  value: unknown;
}

export interface ScenarioReplayArtifact {
  id: string;
  hostId: string;
  runId: string;
  vmId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface ScenarioRunVmRecord {
  id: string;
  ordinal: number;
  scenarioVmId: string;
  scenarioVmName: string;
  runtimeVmName: string;
  hostname: string;
  phase:
    | "launching"
    | "booting"
    | "waiting_for_target"
    | "running"
    | "solved"
    | "deleting"
    | "archiving"
    | "completed"
    | "failed";
  phaseTitle: string;
  phaseDetail: string;
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  primaryReplayArtifactId: string | null;
  provisioning: RunVmProvisioningSpec;
  terminalTarget: {
    host: string | null;
    port: number;
    username: string;
    hostKeyOpenssh: string | null;
    checkedAt: number | null;
  };
}

export interface ScenarioRunRecord {
  id: string;
  scenarioId: string;
  scenarioName: string;
  phase:
    | "launching"
    | "booting"
    | "waiting_for_target"
    | "running"
    | "solved"
    | "deleting"
    | "archiving"
    | "completed"
    | "failed";
  phaseTitle: string;
  phaseDetail: string;
  title: string;
  tagline: string;
  briefingMarkdown: string;
  objectives: ScenarioObjective[];
  tags: string[];
  hints: ScenarioRunHint[];
  nextHintKey: string | null;
  solution: ScenarioRunSolution;
  difficulty: "easy" | "medium" | "hard";
  estimatedMinutes: number;
  solvedAt: number | null;
  solveDurationMs: number | null;
  outcome: "in_progress" | "succeeded" | "cancelled" | "failed";
  progressPercent: number;
  terminalPhase: "pending" | "ready" | "failed";
  canOpenTerminal: boolean;
  canDestroy: boolean;
  createdAt: number;
  updatedAt: number;
  bootProbes: ScenarioProbeStatus[];
  scenarioProbes: ScenarioProbeStatus[];
  replayArtifacts: ScenarioReplayArtifact[];
  primaryReplayArtifactId: string | null;
  vms: ScenarioRunVmRecord[];
}

export interface ScenarioObjective {
  probeName: string;
  vmName: string;
  label: string;
  title: string | null;
  bodyMarkdown: string | null;
  hintCount: number;
}

export interface ScenarioRunHint {
  key: string;
  scope: "scenario" | "probe";
  probeName: string | null;
  id: string;
  title: string | null;
  revealed: boolean;
  bodyMarkdown: string | null;
}

export interface ScenarioRunSolution {
  unlocked: boolean;
  revealed: boolean;
  assisted: boolean;
  revealedAt: number | null;
  bodyMarkdown: string | null;
}

export interface ScenarioRunResponse {
  run: ScenarioRunRecord;
}

export interface ScenarioDestroyAcceptedResponse {
  accepted: true;
  runId: string;
  acceptedAt: number;
}

export interface ScenarioStatusStep {
  id: string;
  label: string;
  detail: string;
  state: "done" | "active" | "pending" | "failed";
}

export const POLL_INTERVALS: Record<ScenarioRunRecord["phase"], number> = {
  launching: 1_500,
  booting: 1_500,
  waiting_for_target: 1_500,
  running: 1_500,
  solved: 1_500,
  deleting: 1_500,
  archiving: 1_500,
  completed: 20_000,
  failed: 20_000,
};
